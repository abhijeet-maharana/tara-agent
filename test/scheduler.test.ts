import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import { startHttpServer } from '../src/http/server.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import { buildDigest } from '../src/scheduler/health.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { ScriptResult } from '../src/scheduler/script.js';
import { Store, type StoredRun } from '../src/store/store.js';
import { FakeChat, testHost } from './fakes.js';

const host = testHost({ concurrency: 2, catchUpHours: 6, claude: { bin: 'claude', chatTimeoutMinutes: 20 } });

function makeProject(jobs: object[], env: object = {}): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-sched-'));
  mkdirSync(path.join(dir, '.tara'));
  writeFileSync(path.join(dir, '.tara', 'jobs.json'), JSON.stringify({ env, jobs }));
  return {
    dir,
    config: {
      name: 'shop',
      slackChannel: 'C1',
      permissionMode: 'bypassPermissions',
      chatModel: 'opus',
      allowedTools: [],
      allowedUsers: [],
      billing: 'subscription',
    },
    systemPrompt: 'Project rules.',
  };
}

const ok = (text: string): RunOutcome => ({
  status: 'ok',
  text,
  sessionId: 'sid',
  model: 'claude-haiku-5-5',
  durationMs: 2000,
  toolCalls: 2,
  permissionDenials: [],
});

function setup(opts: {
  jobs: object[];
  env?: object;
  replies?: string[];
  script?: ScriptResult;
  now?: () => number;
  store?: Store;
}) {
  const chat = new FakeChat('ts');
  const store = opts.store ?? new Store(':memory:', opts.now);
  const calls: RunOptions[] = [];
  const callTimes: number[] = [];
  const scripts: { script: string; env: NodeJS.ProcessEnv }[] = [];
  const replies = [...(opts.replies ?? [])];
  const project = makeProject(opts.jobs, opts.env);
  const scheduler = new Scheduler({
    projects: [project],
    host,
    store,
    chat,
    log: { info() {}, warn() {}, error() {} },
    env: { PATH: '/bin', SLACK_BOT_TOKEN: 'secret' },
    now: opts.now,
    newSessionId: () => 'sid',
    runScript: async (script, _cwd, env) => {
      scripts.push({ script, env });
      return opts.script ?? { ok: true, output: 'STATUS: OK', exitCode: 0, timedOut: false };
    },
    run: async (o) => {
      calls.push(o);
      callTimes.push(Date.now());
      o.onEvent?.({ kind: 'init', sessionId: 'sid', model: 'claude-haiku-5-5' });
      o.onEvent?.({ kind: 'tool', id: 't1', name: 'Bash', status: 'Bash: curl' });
      return ok(replies.shift() ?? 'Headline\n---\nDetails here');
    },
  });
  return { chat, store, calls, callTimes, scripts, scheduler, project };
}

const baseJob = {
  id: 'sla',
  name: 'SLA Report',
  cron: '0 * * * *',
  tz: 'UTC',
  prompt: 'Run the report.',
  model: 'haiku',
};

describe('Scheduler', () => {
  it('runs a job on demand: script context, job prompt, headline in channel, details in thread', async () => {
    const { chat, calls, scripts, scheduler, store } = setup({
      jobs: [{ ...baseJob, preScript: 'gate.sh', skills: ['sla-report'] }],
      env: { ROOT: '~/repo' },
    });
    scheduler.start();
    expect(scheduler.trigger('shop', 'sla', 'U1')).toBe('started');
    expect(scheduler.trigger('shop', 'sla', 'U1')).toBe('running');
    await scheduler.idle();

    expect(scripts[0]?.script).toBe('gate.sh');
    expect(scripts[0]?.env.ROOT).toMatch(/\/repo$/);
    expect(scripts[0]?.env.SLACK_BOT_TOKEN).toBeUndefined();
    const call = calls[0] as RunOptions;
    expect(call.prompt).toMatch(/^## Script Output[\s\S]*Run the report\.[\s\S]*`sla-report`/);
    expect(call.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--session-id', 'sid']));
    expect(call.args.join(' ')).toContain('unattended');
    expect(call.args.join(' ')).toContain('Project rules.');

    expect(chat.log[0]).toBe('post top ts1: ⏳ *SLA Report* (run by <@U1>)');
    expect(chat.log.at(-2)).toBe(
      'update ts1: ✅ *SLA Report* (run by <@U1>) · 2s · 2 steps · claude-haiku-5-5\nHeadline',
    );
    expect(chat.log.at(-1)).toBe('post ts1 ts2: Details here');
    // Replies in the job thread resume the job's session.
    expect(store.getSession('C1:ts1')).toMatchObject({ sessionId: 'sid', model: 'haiku', started: true });
    expect(scheduler.list('shop')[0]).toMatchObject({ id: 'sla', lastStatus: 'ok', running: false });
    await scheduler.stop();
  });

  it('stays silent when the script gate says so (no model, no post)', async () => {
    const { chat, calls, scheduler } = setup({
      jobs: [{ ...baseJob, preScript: 'gate.py' }],
      script: { ok: true, output: 'checked\n{"wakeAgent": false}', exitCode: 0, timedOut: false },
    });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(calls).toHaveLength(0);
    expect(chat.log).toEqual([]);
    await scheduler.stop();
  });

  it('deletes the thread when the model replies [SILENT]', async () => {
    const { chat, scheduler, store } = setup({ jobs: [baseJob], replies: ['[SILENT]'] });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(chat.log.at(-1)).toBe('delete ts1');
    expect(store.getSession('C1:ts1')).toBeUndefined();
    await scheduler.stop();
  });

  it('marks [CRON_FAILURE] replies as failed', async () => {
    const { chat, scheduler } = setup({ jobs: [baseJob], replies: ['[CRON_FAILURE]\nPortal login expired'] });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(
      chat.log.some((l) => l.startsWith('update ts1: ❌ *SLA Report*') && l.endsWith('Portal login expired')),
    ).toBe(true);
    expect(scheduler.list('shop')[0]?.lastStatus).toBe('failed');
    await scheduler.stop();
  });

  it('posts script output as-is for script-only jobs', async () => {
    const { chat, calls, scheduler } = setup({
      jobs: [{ id: 'backup', name: 'Backup', cron: '0 2 * * *', preScript: 'b.sh', agent: false }],
      script: { ok: false, output: 'upload failed\n(exit code 1)', exitCode: 1, timedOut: false },
    });
    scheduler.start();
    scheduler.trigger('shop', 'backup', 'U1');
    await scheduler.idle();
    expect(calls).toHaveLength(0);
    expect(chat.log[0]).toMatch(/^post top ts1: ❌ \*Backup\* \(run by <@U1>\) · \d+s\n```\nupload failed/);
    await scheduler.stop();
  });

  it('catches up a missed slot once, but never for a job first seen after that slot', async () => {
    let now = Date.parse('2026-10-25T10:20:00Z');
    const store = new Store(':memory:', () => now);
    const job = { ...baseJob, cron: '0 * * * *' };

    // First start at 10:20: job is new, so the 10:00 slot is not caught up.
    const first = setup({ jobs: [job], store, now: () => now });
    first.scheduler.start();
    await first.scheduler.idle();
    expect(first.calls).toHaveLength(0);
    await first.scheduler.stop();

    // Down until 12:30: the 12:00 slot is missed and caught up once.
    now = Date.parse('2026-10-25T12:30:00Z');
    const second = setup({ jobs: [job], store, now: () => now });
    second.scheduler.start();
    await second.scheduler.idle();
    expect(second.calls).toHaveLength(1);
    expect(second.chat.log[0]).toBe('post top ts1: ⏳ *SLA Report* (catch-up)');
    await second.scheduler.stop();

    // A restart in the same hour doesn't run it again: the slot is claimed.
    const third = setup({ jobs: [job], store, now: () => now });
    third.scheduler.start();
    await third.scheduler.idle();
    expect(third.calls).toHaveLength(0);
    await third.scheduler.stop();
  });

  it('skips catch-up when disabled for the job', async () => {
    let now = Date.parse('2026-10-25T10:20:00Z');
    const store = new Store(':memory:', () => now);
    const job = { ...baseJob, catchUp: false };
    const a = setup({ jobs: [job], store, now: () => now });
    a.scheduler.start();
    await a.scheduler.stop();
    now = Date.parse('2026-10-25T12:30:00Z');
    const b = setup({ jobs: [job], store, now: () => now });
    b.scheduler.start();
    await b.scheduler.idle();
    expect(b.calls).toHaveLength(0);
    await b.scheduler.stop();
  });

  it('fires on the real clock and claims each slot once', async () => {
    const { calls, callTimes, scheduler, store } = setup({ jobs: [{ ...baseJob, cron: '*/2 * * * * *' }] });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 2_600));
    await scheduler.idle();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const slot = Math.floor((callTimes[0] as number) / 2_000) * 2_000;
    expect(store.claimSlot('shop:sla', slot)).toBe(false);
    await scheduler.stop();
  });

  it('lists jobs by next run and does not schedule disabled ones', async () => {
    const { scheduler } = setup({
      jobs: [
        { ...baseJob, id: 'later', cron: '0 0 1 1 *' },
        { ...baseJob, id: 'soon', cron: '* * * * *' },
        { ...baseJob, id: 'off', enabled: false },
      ],
    });
    scheduler.start();
    const list = scheduler.list('shop');
    expect(list.map((j) => j.id)).toEqual(['soon', 'later', 'off']);
    expect(list[2]).toMatchObject({ enabled: false, nextRun: undefined });
    expect(scheduler.trigger('shop', 'nope', 'U1')).toBe('unknown');
    await scheduler.stop();
  });

  it('keeps the old schedule and reports an invalid jobs file', async () => {
    const { chat, scheduler, project } = setup({ jobs: [baseJob] });
    scheduler.start();
    writeFileSync(path.join(project.dir, '.tara', 'jobs.json'), '{"jobs":[{"id":"Bad Id"}]}');
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the private poller for a deterministic test
    (scheduler as any).checkFiles();
    expect(chat.log[0]).toMatch(/jobs\.json` was not reloaded/);
    expect(scheduler.list('shop').map((j) => j.id)).toEqual(['sla']);
    await scheduler.stop();
  });
});

describe('HTTP API', () => {
  async function api(token?: string) {
    const ctx = setup({
      jobs: [{ ...baseJob, skills: ['sla-report'] }],
      replies: ['Done\n---\nAll details'],
    });
    ctx.scheduler.start();
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      token,
      scheduler: ctx.scheduler,
      store: ctx.store,
      projects: ['shop'],
      log: { info() {}, warn() {}, error() {} },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, init?: RequestInit) => {
      const res = await fetch(base + path, init);
      // biome-ignore lint/suspicious/noExplicitAny: JSON bodies of several shapes, checked by the assertions
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const close = async () => {
      server.close();
      await ctx.scheduler.stop();
    };
    return { ...ctx, call, close };
  }

  it('lists jobs, runs one and returns its history and output', async () => {
    const { call, close, scheduler } = await api();
    expect((await call('/health')).body).toMatchObject({ ok: true, projects: ['shop'], jobs: { total: 1 } });

    const jobs = await call('/jobs?project=shop');
    expect(jobs.body.jobs[0]).toMatchObject({
      id: 'sla',
      skills: ['sla-report'],
      enabled: true,
      lastRunAt: null,
    });

    const run = await call('/jobs/shop/sla/run', {
      method: 'POST',
      body: JSON.stringify({ by: 'job-board' }),
    });
    expect(run.body).toEqual({ result: 'started' });
    await scheduler.idle();

    const runs = await call('/jobs/shop/sla/runs?limit=5');
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0]).toMatchObject({ status: 'ok', jobId: 'sla', hasOutput: true });
    expect(runs.body.runs[0].output).toBeUndefined();

    const detail = await call(`/runs/${runs.body.runs[0].id}`);
    expect(detail.body.run).toMatchObject({ output: 'Done\n---\nAll details' });
    expect(detail.body.run.scriptOutput).toBeUndefined();
    expect((await call('/jobs?project=shop')).body.jobs[0].lastStatus).toBe('ok');
    await close();
  });

  it('labels API runs with the caller', async () => {
    const { call, close, scheduler, chat } = await api();
    await call('/jobs/shop/sla/run', { method: 'POST', body: '{"by":"job-board"}' });
    await scheduler.idle();
    expect(chat.log[0]).toBe('post top ts1: ⏳ *SLA Report* (run by job-board)');
    await close();
  });

  it('returns clear errors', async () => {
    const { call, close } = await api();
    expect((await call('/jobs?project=nope')).status).toBe(404);
    expect((await call('/jobs/shop/nope/run', { method: 'POST' })).status).toBe(404);
    expect((await call('/jobs/shop/sla/run', { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await call('/runs/999')).status).toBe(404);
    expect((await call('/reload', { method: 'POST' })).body).toEqual({ ok: true });
    await close();
  });

  it('requires the bearer token when one is set', async () => {
    const { call, close } = await api('s3cret');
    expect((await call('/health')).status).toBe(401);
    expect((await call('/health', { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200);
    await close();
  });
});

describe('health digest', () => {
  const run = (o: Partial<StoredRun>): StoredRun => ({
    id: 1,
    kind: 'job',
    project: 'shop',
    jobId: 'sla',
    startedAt: Date.parse('2026-10-25T05:00:00Z'),
    endedAt: Date.parse('2026-10-25T05:02:00Z'),
    status: 'ok',
    ...o,
  });

  it('stays quiet when nothing ran or was missed', () => {
    expect(buildDigest({ project: 'shop', runs: [], missed: [], timeZone: 'UTC' })).toBeNull();
  });

  it('summarises runs, problems, missed slots and usage', () => {
    const digest = buildDigest({
      project: 'shop',
      timeZone: 'UTC',
      runs: [
        run({ rateLimitUtilization: 0.41, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2_000_000 }),
        run({ status: 'silent' }),
        run({ status: 'failed', jobId: 'ads', error: 'Portal login expired\nmore' }),
        run({ kind: 'chat', jobId: undefined }),
      ],
      missed: [{ id: 'labels', name: 'Labels', slots: [Date.parse('2026-10-25T00:00:00Z')] }],
    });
    expect(digest?.headline).toBe(
      '⚠️ *Daily health · shop* · last 24h: 3 job runs (1 ok, 1 silent, 1 with problems), 1 chat turns · *1 missed* · peak 5h usage 41%',
    );
    expect(digest?.details).toContain('• `ads` failed at Sun 05:00: Portal login expired');
    expect(digest?.details).toContain('• `labels` Labels: Sun 00:00');
    expect(digest?.details).toContain('1.5k tokens in/out, 2.00M cache reads');
  });

  it('finds slots that were never claimed (downtime) but not slots that ran', async () => {
    let now = Date.parse('2026-10-25T00:30:00Z');
    const store = new Store(':memory:', () => now);
    const ctx = setup({ jobs: [{ ...baseJob, cron: '0 */6 * * *', catchUp: false }], store, now: () => now });
    ctx.scheduler.start(); // first seen 00:30
    await ctx.scheduler.stop();
    now = Date.parse('2026-10-25T13:00:00Z');
    store.claimSlot('shop:sla', Date.parse('2026-10-25T06:00:00Z')); // 06:00 ran, 12:00 was missed
    const later = setup({
      jobs: [{ ...baseJob, cron: '0 */6 * * *', catchUp: false }],
      store,
      now: () => now,
    });
    later.scheduler.start();
    await later.scheduler.idle();
    const digest = later.scheduler.digest('shop');
    expect(digest?.headline).toContain('*1 missed*');
    expect(digest?.details).toContain('• `sla` SLA Report: Sun 12:00');
    await later.scheduler.stop();
  });
});
