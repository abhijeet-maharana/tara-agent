import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Project, projectConfigSchema } from '../src/config/schema.js';
import {
  type AgentDeps,
  agentChecks,
  healthSources,
  type JobsDeps,
  jobChecks,
  projectChecks,
} from '../src/health/checks.js';
import { type ClaudeLogin, claudeLoginReader, parseCredentials } from '../src/health/claude-login.js';
import {
  type Check,
  HealthMonitor,
  type HealthSource,
  type MonitorDeps,
  parseProjectChecks,
} from '../src/health/monitor.js';
import { gatherAttention } from '../src/http/attention.js';
import { startHttpServer } from '../src/http/server.js';
import type { Task } from '../src/runner/activity.js';
import type { JobInfo, Scheduler } from '../src/scheduler/scheduler.js';
import { Store, type StoredRun } from '../src/store/store.js';
import { FakeChat, testHost } from './fakes.js';

const quiet = { info() {}, warn() {}, error() {} };
const project = (over: Record<string, unknown> = {}): Project => ({
  dir: '/repo',
  config: projectConfigSchema.parse({
    name: 'shop',
    title: 'Shop',
    slackChannel: 'C0SHOP',
    owner: 'U0OWNER',
    ...over,
  }),
});

describe('parseProjectChecks', () => {
  it('reads {checks} or a bare list, keeps keys unique and drops unsafe links', () => {
    const checks = parseProjectChecks(
      {
        checks: [
          {
            group: 'Services',
            name: 'WhatsApp',
            ok: false,
            detail: 'session FAILED',
            link: 'http://jarvis:3000/',
          },
          { name: 'Disk', ok: true, warn: true, detail: '88% used', link: 'javascript:alert(1)' },
          { name: 'Disk', ok: true, detail: 'second' },
          { name: 'Status words', status: 'warn', detail: '' },
          { nope: true },
        ],
      },
      'project:shop',
      'shop',
    );
    expect(checks.map((c) => [c.key, c.status, c.link])).toEqual([
      ['project:shop:Services:WhatsApp', 'bad', 'http://jarvis:3000/'],
      ['project:shop:Checks:Disk', 'warn', undefined],
      ['project:shop:Checks:Disk#2', 'ok', undefined],
      ['project:shop:Checks:Status words', 'warn', undefined],
    ]);
    expect(parseProjectChecks([{ name: 'A', ok: true, detail: 'x' }], 's', 'shop')).toHaveLength(1);
    expect(
      parseProjectChecks(
        { ok: true, result: { checks: [{ name: 'Gmail API', ok: true, detail: 'x' }] } },
        's',
        'shop',
      ),
    ).toHaveLength(1);
    expect(() => parseProjectChecks({ hello: 1 }, 's', 'shop')).toThrow(/checks/);
  });
});

describe('HealthMonitor', () => {
  const setup = (opts: { store?: Store; alerts?: boolean; t?: { now: number } } = {}) => {
    const t = opts.t ?? { now: Date.parse('2026-11-13T09:00:00Z') };
    const store = opts.store ?? new Store(':memory:', () => t.now);
    const chat = new FakeChat();
    let checks: Check[] = [];
    let fail: string | undefined;
    const source: HealthSource = {
      id: 'project:shop',
      title: 'Shop',
      project: 'shop',
      run: async () => {
        if (fail) throw new Error(fail);
        return checks;
      },
    };
    const deps: MonitorDeps = {
      sources: () => [source],
      store,
      chat,
      target: (p) =>
        p === 'shop' || !p ? { name: 'shop', title: 'Shop', channel: 'C0SHOP', owner: 'U0OWNER' } : undefined,
      alerts: opts.alerts ?? true,
      timeZone: 'UTC',
      log: quiet,
      intervalMs: 60_000,
      now: () => t.now,
    };
    const monitor = new HealthMonitor(deps);
    const set = (status: Check['status'], detail = '', extra: Partial<Check> = {}) => {
      checks = [
        {
          key: 'project:shop:Services:WhatsApp',
          project: 'shop',
          group: 'Services',
          name: 'WhatsApp',
          status,
          detail,
          ...extra,
        },
      ];
    };
    return {
      t,
      store,
      chat,
      monitor,
      set,
      clear: () => {
        checks = [];
      },
      failWith: (m?: string) => {
        fail = m;
      },
      tick: async (ms = 300_000) => {
        t.now += ms;
        return monitor.check();
      },
    };
  };

  it("alerts once after two red checks in a row, in the day's Run Health Alert thread, and once when fixed", async () => {
    const h = setup();
    h.set('ok', 'WORKING');
    await h.tick();
    h.set('bad', 'session FAILED');
    const first = await h.tick();
    expect(first.checks[0]).toMatchObject({ status: 'bad', unconfirmed: true });
    expect(h.chat.posts).toEqual([]);
    expect(first.counts.bad).toBe(1);

    await h.tick();
    await h.tick();
    expect(h.chat.texts()).toEqual([
      'Run Health Alert',
      '<@U0OWNER> ❌ *WhatsApp* (Services): session FAILED',
    ]);
    expect(h.chat.posts[1]?.thread).toBe(h.chat.posts[0]?.ts);

    h.set('ok', 'WORKING');
    await h.tick();
    expect(h.chat.texts().at(-1)).toBe('✅ *WhatsApp* (Services) is fine again after 10m: WORKING');
    // One root message for the day, in the channel's `Run <Name>` format; everything else in its thread.
    expect(h.chat.posts.filter((p) => p.thread === '').map((p) => p.text)).toEqual(['Run Health Alert']);
    expect(h.monitor.history().map((e) => e.status)).toEqual(['ok', 'bad']);
    expect(h.monitor.label('project:shop:Services:WhatsApp')).toBe('WhatsApp (Services)');
  });

  it('does not alert for one blip, for quiet checks, or when alerts are off', async () => {
    const h = setup();
    h.set('ok');
    await h.tick();
    h.set('bad', 'blip');
    await h.tick();
    h.set('ok');
    await h.tick();
    h.set('bad', 'known', { quiet: true });
    await h.tick();
    await h.tick();
    expect((await h.tick()).checks[0]).toMatchObject({ status: 'bad' });
    expect(h.chat.posts).toEqual([]);

    const off = setup({ alerts: false });
    off.set('bad');
    await off.tick();
    await off.tick();
    expect(off.chat.posts).toEqual([]);
  });

  it('remembers across a restart: no second alert, and the recovery still comes', async () => {
    const h = setup();
    h.set('bad', 'down');
    await h.tick();
    await h.tick();
    expect(h.chat.posts).toHaveLength(2);

    const again = setup({ store: h.store, t: h.t });
    again.set('bad', 'down');
    await again.tick();
    await again.tick();
    expect(again.chat.posts).toEqual([]);
    again.set('ok', 'up');
    await again.tick();
    // Same day: the thread opened before the restart is reused.
    expect(again.chat.posts.map((p) => [p.thread, p.text])).toEqual([
      [h.chat.posts[0]?.ts, '✅ *WhatsApp* (Services) is fine again after 15m: up'],
    ]);
  });

  it("treats a check its source stops listing as fixed, but not when the source can't be read", async () => {
    const h = setup();
    h.set('bad', 'down');
    await h.tick();
    await h.tick();
    h.failWith('ECONNREFUSED');
    const unreachable = await h.tick();
    expect(unreachable.sources[0]?.error).toBe('ECONNREFUSED');
    expect(unreachable.checks.map((c) => c.key)).toEqual(['project:shop:unreachable']);
    expect(h.chat.texts().some((t) => t.includes('fine again'))).toBe(false);

    h.failWith(undefined);
    h.clear();
    await h.tick();
    expect(h.chat.texts().at(-1)).toBe('✅ *WhatsApp (Services)* is fine again after 10m');
    expect(h.store.healthStates().has('project:shop:Services:WhatsApp')).toBe(false);
  });

  it('gives a slow source a timeout instead of hanging', async () => {
    const monitor = new HealthMonitor({
      sources: () => [{ id: 'slow', title: 'Slow', run: () => new Promise(() => {}) }],
      store: new Store(':memory:'),
      target: () => undefined,
      alerts: false,
      timeZone: 'UTC',
      log: quiet,
      intervalMs: 60_000,
      timeoutMs: 20,
    });
    const s = await monitor.check();
    expect(s.checks[0]).toMatchObject({
      key: 'slow:unreachable',
      status: 'bad',
      detail: 'Could not check: no answer in 0s',
    });
  });
});

const run = (status: string, endedAt: number, over: Partial<StoredRun> = {}): StoredRun => ({
  id: endedAt,
  kind: 'job',
  project: 'shop',
  jobId: 'sync',
  startedAt: endedAt - 60_000,
  endedAt,
  status,
  ...over,
});

describe('jobChecks', () => {
  const now = Date.parse('2026-11-13T09:30:00Z');
  const job = (over: Partial<JobInfo> = {}): JobInfo => ({
    id: 'sync',
    name: 'Payments Sync',
    enabled: true,
    running: false,
    cron: '0 9 * * *',
    tz: 'UTC',
    skills: [],
    model: 'haiku',
    ...over,
  });
  const deps = (over: Partial<JobsDeps> = {}): JobsDeps => ({
    project: project(),
    jobs: () => [job()],
    recent: () => [],
    latestSlots: () => [
      { id: 'sync', key: 'shop:sync', slot: Date.parse('2026-11-13T09:00:00Z'), firstSeen: 0 },
    ],
    slotClaim: () => ({ status: 'ok', claimedAt: 0 }),
    fileError: () => undefined,
    started: 0,
    failingAfter: 3,
    timeZone: 'UTC',
    now: () => now,
    ...over,
  });

  it('is one summary row when all is well', () => {
    expect(jobChecks(deps())).toEqual([
      expect.objectContaining({
        key: 'jobs:shop:summary',
        status: 'ok',
        detail: '1 job on · 0 ran in the last 24h · all on track',
      }),
    ]);
  });

  it('marks a failing streak amber, then red at failingAfter', () => {
    const once = jobChecks(
      deps({ recent: () => [run('failed', now - 600_000, { output: '❌ Portal login expired' })] }),
    );
    expect(once[0]).toMatchObject({
      status: 'warn',
      quiet: true,
      detail: 'Failed its last run (10m ago): Portal login expired',
    });
    const three = jobChecks(
      deps({
        recent: () => [
          run('error', now),
          run('timeout', now - 1),
          run('failed', now - 2),
          run('ok', now - 3),
        ],
      }),
    );
    expect(three[0]).toMatchObject({ status: 'bad', quiet: false });
    expect(three[0]?.detail).toMatch(/^Failed 3 runs in a row/);
  });

  it('finds a slot that never started, and tells downtime from a broken scheduler', () => {
    const slot = Date.parse('2026-11-13T09:00:00Z');
    const missed = jobChecks(deps({ slotClaim: () => undefined, started: slot - 3_600_000 }));
    expect(missed[0]).toMatchObject({
      key: 'jobs:shop:slot:sync',
      status: 'bad',
      detail: "Didn't start at 09:00 (30m ago)",
    });
    const down = jobChecks(deps({ slotClaim: () => undefined, started: slot + 60_000 }));
    expect(down[0]).toMatchObject({ status: 'warn', quiet: true });
    const tomorrow = jobChecks(
      deps({
        jobs: () => [job({ nextRun: new Date('2026-11-14T09:00:00Z') })],
        slotClaim: () => undefined,
        started: slot + 60_000,
      }),
    );
    expect(tomorrow[0]?.detail).toBe('Missed 09:00 while tara-agent was stopped; next run Sat 09:00');
    const lost = jobChecks(deps({ slotClaim: () => ({ status: 'running', claimedAt: slot - 60_000 }) }));
    expect(lost[0]?.detail).toMatch(/never finished/);
    const young = jobChecks(
      deps({
        latestSlots: () => [{ id: 'sync', key: 'shop:sync', slot, firstSeen: slot + 1 }],
        slotClaim: () => undefined,
      }),
    );
    expect(young).toHaveLength(1); // added after that slot: not missed
  });

  it("reports a jobs file that didn't load", () => {
    const c = jobChecks(
      deps({ fileError: () => ({ message: 'jobs.0.cron: not a valid cron expression', at: now }) }),
    );
    expect(c[0]).toMatchObject({ key: 'jobs:shop:file', status: 'bad', quiet: true });
  });
});

describe('agentChecks', () => {
  const now = Date.parse('2026-11-13T09:00:00Z');
  const deps = (over: Partial<AgentDeps> = {}): AgentDeps => ({
    agentName: 'Jarvis',
    host: testHost(),
    slack: () => ({ state: 'connected', since: now - 3_600_000, lastEventAt: now - 120_000 }),
    tasks: () => [],
    usage: () => ({ status: 'allowed', utilization: 0.42 }),
    runsSince: () => [],
    timeZone: 'UTC',
    now: () => now,
    machine: () => ({ diskUsed: 0.5, memFree: 0.4, load: 0.5, cpus: 4, dbBytes: 12e6 }),
    ...over,
  });
  const byName = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.name, [c.status, c.detail]]));

  it('is all green on a quiet, healthy host', async () => {
    expect(byName(await agentChecks(deps()))).toEqual({
      Slack: ['ok', 'Connected for 1h · last message 2m ago'],
      'Claude runs': ['ok', 'No runs in the last 6h'],
      'Usage limit': ['ok', '42% of the window used'],
      'Running now': ['ok', 'Nothing running'],
      Disk: ['ok', '50% used · database 12 MB'],
      'Memory and load': ['ok', '40% memory free · load 0.5 on 4 CPUs'],
    });
  });

  it('turns red for a lost Slack link, failing CLI, usage limit, stuck runs and a full disk', async () => {
    const stuck = {
      id: 't',
      project: 'shop',
      kind: 'job',
      title: 'Payments Sync',
      status: 'running',
      startedAt: now - 4 * 3_600_000,
      steps: [],
      stepCount: 0,
    } as unknown as Task;
    const c = byName(
      await agentChecks(
        deps({
          slack: () => ({ state: 'reconnecting', since: now - 600_000 }),
          runsSince: () => [
            run('error', now, { error: 'Not logged in' }),
            run('error', now - 1),
            run('limit', now - 2),
            run('error', now - 3),
          ],
          tasks: () => [stuck],
          machine: () => ({ diskUsed: 0.97, memFree: 0.03, load: 9, cpus: 4 }),
        }),
      ),
    );
    expect(c.Slack).toEqual(['bad', 'Reconnecting for 10m']);
    // Two errors in a row (then a limit) isn't the CLI failing yet; the limit is its own row.
    expect(c['Claude runs']).toEqual(['ok', '4 in the last 6h, 3 errors']);
    expect(c['Usage limit']?.[0]).toBe('bad');
    expect(c['Running now']).toEqual(['bad', 'Payments Sync (4h) still running']);
    expect(c.Disk?.[0]).toBe('bad');
    expect(c['Memory and load']?.[0]).toBe('bad');
  });

  it('warns a week before the Claude login ends and turns red three days before', async () => {
    const login = (over: Partial<ClaudeLogin>) => async (): Promise<ClaudeLogin> => ({
      loggedIn: true,
      user: 'tara',
      ...over,
    });
    const check = async (over: Partial<ClaudeLogin>) =>
      byName(await agentChecks(deps({ claudeLogin: login(over) })))['Claude login'];
    const DAY = 86_400_000;
    expect(await check({ endsAt: now + 9 * DAY })).toEqual([
      'ok',
      'Logged in · ends in 9d (Sun 22 Nov, 09:00)',
    ]);
    expect(await check({ endsAt: now + 6 * DAY })).toEqual([
      'warn',
      'Ends in 6d (Thu 19 Nov, 09:00) · log in again as tara: claude auth login',
    ]);
    expect((await check({ endsAt: now + 2 * DAY }))?.[0]).toBe('bad');
    expect(await check({ endsAt: now - 3_600_000 })).toEqual([
      'bad',
      'Ended 1h ago (Fri 13 Nov, 08:00) · log in again as tara: claude auth login',
    ]);
    expect(await check({ loggedIn: false })).toEqual([
      'bad',
      'Not logged in · log in again as tara: claude auth login',
    ]);
    expect(await check({})).toEqual(['ok', 'Logged in']);
    expect(await check({ loggedIn: false, error: 'sudo: a password is required' })).toEqual([
      'warn',
      "Can't read the login file: sudo: a password is required",
    ]);
    // No file to read (keychain, API key): no row at all.
    expect(
      byName(await agentChecks(deps({ claudeLogin: async () => undefined })))['Claude login'],
    ).toBeUndefined();
  });

  it("uses the latest run's usage figure until the CLI reports one", async () => {
    const c = byName(
      await agentChecks(
        deps({
          usage: () => undefined,
          runsSince: () => [run('ok', now - 60_000, { rateLimitUtilization: 0.93 })],
        }),
      ),
    );
    expect(c['Usage limit']).toEqual(['warn', '93% of the window used']);
  });

  it('reports three errors in a row as the CLI failing', async () => {
    const c = byName(
      await agentChecks(
        deps({
          runsSince: () => [
            run('error', now, { error: 'Not logged in' }),
            run('error', now - 1),
            run('error', now - 2),
          ],
        }),
      ),
    );
    expect(c['Claude runs']).toEqual(['bad', 'The last 3 runs ended in an error: Not logged in']);
  });

  it('checks each Chrome', async () => {
    const checks = await agentChecks(
      deps({ probeBrowser: async (b) => ({ lock: b.lock, cdpUrl: b.cdpUrl, up: false }) }),
    );
    expect(checks.at(-1)).toMatchObject({ key: 'tara:browser:chrome', group: 'Browsers', status: 'bad' });
  });
});

describe('projectChecks and sources', () => {
  it("reads a project's healthUrl, or only pings its dashboard", async () => {
    const fetcher = (async (url: string) =>
      url.endsWith('/checks')
        ? new Response(JSON.stringify({ checks: [{ name: 'Chrome', ok: true, detail: 'Reachable' }] }))
        : new Response('', { status: 502 })) as typeof fetch;
    const own = await projectChecks(project({ healthUrl: 'http://127.0.0.1:1/checks' }), fetcher);
    expect(own).toEqual([expect.objectContaining({ key: 'project:shop:Checks:Chrome', status: 'ok' })]);
    const ping = await projectChecks(project({ dashboardUrl: 'http://127.0.0.1:1/' }), fetcher);
    expect(ping[0]).toMatchObject({ status: 'bad', name: 'Dashboard app' });
    expect(await projectChecks(project())).toEqual([]);
    await expect(
      projectChecks(
        project({ healthUrl: 'http://127.0.0.1:1/x' }),
        (async () => new Response('', { status: 401 })) as typeof fetch,
      ),
    ).rejects.toThrow(/401/);
  });

  it('lists tara-agent first, then each project its jobs and own checks', () => {
    const sources = healthSources({
      agentName: 'Jarvis',
      agent: async () => [],
      projects: [
        project({ healthUrl: 'http://127.0.0.1:1/c' }),
        { dir: '/b', config: projectConfigSchema.parse({ name: 'blog', slackChannel: 'C0BLOG' }) },
      ],
      jobs: () => [],
    });
    expect(sources.map((s) => s.id)).toEqual(['tara', 'jobs:shop', 'project:shop', 'jobs:blog']);
  });
});

describe('Health in the dashboard', () => {
  it('serves the page, the JSON and Check again; Home and attention show red checks', async () => {
    const store = new Store(':memory:');
    let status: Check['status'] = 'ok';
    const monitor = new HealthMonitor({
      sources: () => [
        {
          id: 'project:shop',
          title: 'Shop',
          project: 'shop',
          run: async () => [
            {
              key: 'project:shop:Services:WhatsApp',
              project: 'shop',
              group: 'Services',
              name: 'WhatsApp',
              status,
              detail: status === 'ok' ? 'WORKING' : 'FAILED <x>',
            },
          ],
        },
      ],
      store,
      target: () => undefined,
      alerts: false,
      timeZone: 'UTC',
      log: quiet,
      intervalMs: 60_000,
      confirmAfter: 1,
    });
    const scheduler = { list: () => [], plannedRuns: () => [] } as unknown as Scheduler;
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler,
      store,
      projects: ['shop'],
      log: quiet,
      health: monitor,
      dashboard: { projects: [project()], timeZone: 'UTC', agentName: 'Jarvis' },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const first = await fetch(`${base}/health`, { headers: { accept: 'text/html' } }).then((r) => r.text());
      expect(first).toContain('first checks are still running');

      status = 'bad';
      const posted = await fetch(`${base}/health/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(await posted.json()).toMatchObject({ counts: { bad: 1, ok: 0, warn: 0 } });

      const page = await fetch(`${base}/health`, { headers: { accept: 'text/html' } }).then((r) => r.text());
      expect(page).toContain('❌ 1 problem');
      expect(page).toContain('FAILED &lt;x&gt;');
      expect(page).toMatch(/href="\/health" class="nav-item on".*<span class="badge"[^>]*>1</s);

      expect(await fetch(`${base}/health`).then((r) => r.json())).toMatchObject({
        ok: true,
        checks: { bad: 1 },
      });
      const snap = (await fetch(`${base}/health/checks`).then((r) => r.json())) as { checks: Check[] };
      expect(snap.checks[0]).toMatchObject({ name: 'WhatsApp', status: 'bad' });

      const home = await fetch(`${base}/`, { headers: { accept: 'text/html' } }).then((r) => r.text());
      expect(home).toContain('WhatsApp has a problem');
    } finally {
      server.close();
    }

    const { items } = await gatherAttention({
      approvals: () => [],
      jobs: () => [],
      health: () => [{ key: 'k', project: 'shop', name: 'WhatsApp', detail: 'FAILED', since: 5 }],
    });
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'health',
        tier: 'waiting',
        title: 'WhatsApp has a problem',
        url: '/health',
      }),
    ]);
  });
});

describe('Claude login file', () => {
  it('keeps only whether there is a login and when it ends', () => {
    const file = (oauth: object) => JSON.stringify({ claudeAiOauth: oauth, mcpOAuth: {} });
    expect(
      parseCredentials(file({ accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: 1795833099905 })),
    ).toEqual({ loggedIn: true, endsAt: 1795833099905 });
    expect(parseCredentials(file({ refreshToken: 'r', refreshTokenExpiresAt: 1795833099 }))).toEqual({
      loggedIn: true,
      endsAt: 1795833099000,
    });
    expect(parseCredentials(file({ refreshToken: 'r' }))).toEqual({ loggedIn: true });
    expect(parseCredentials(file({ accessToken: 'a' }))).toEqual({ loggedIn: false });
    expect(parseCredentials('{}')).toEqual({ loggedIn: false });
  });

  it('reads the file, re-reads it only after the cache time, and has nothing to say without one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'login-'));
    let at = 0;
    const read = claudeLoginReader({ configDir: dir, cacheMs: 1000, now: () => at });
    expect(await read()).toBeUndefined();
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'r', refreshTokenExpiresAt: 1795833099905 } }),
    );
    expect(await read()).toBeUndefined();
    at = 1000;
    expect(await read()).toEqual({ loggedIn: true, endsAt: 1795833099905, user: undefined });
    writeFileSync(path.join(dir, '.credentials.json'), 'not json');
    at = 2000;
    expect((await read())?.error).toBeTruthy();
  });
});
