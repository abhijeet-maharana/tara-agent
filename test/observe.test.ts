import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { projectConfigSchema } from '../src/config/schema.js';
import { readJournal } from '../src/health/journal.js';
import { HealthMonitor } from '../src/health/monitor.js';
import { Observability } from '../src/health/observability.js';
import { prometheusText } from '../src/health/prometheus.js';
import {
  costByDay,
  groupLogs,
  jobTrends,
  lastDays,
  logPattern,
  looksLikeProblem,
  runsByDay,
  totals,
  uptimes,
  usageByHour,
} from '../src/health/trends.js';
import { niceMax } from '../src/http/observe.js';
import { startHttpServer } from '../src/http/server.js';
import type { JobInfo, Scheduler } from '../src/scheduler/scheduler.js';
import { type RunStat, Store } from '../src/store/store.js';

const quiet = { info() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');
const run = (over: Partial<RunStat>): RunStat => ({
  kind: 'job',
  project: 'shop',
  jobId: 'sync',
  startedAt: NOW - 3_600_000,
  endedAt: NOW - 3_000_000,
  status: 'ok',
  ...over,
});

describe('trends', () => {
  it('counts runs per day by result, leaving learning turns out', () => {
    const days = lastDays(NOW, 3, 'UTC');
    expect(days).toEqual(['2026-11-11', '2026-11-12', '2026-11-13']);
    const rows = runsByDay(
      [
        run({}),
        run({ status: 'silent' }),
        run({ status: 'timeout', startedAt: NOW - DAY }),
        run({ status: 'aborted', kind: 'chat' }),
        run({ kind: 'learn' }),
        run({ startedAt: NOW - 9 * DAY }),
      ],
      days,
      'UTC',
    );
    expect(rows).toEqual([
      { day: '2026-11-11', worked: 0, quiet: 0, failed: 0, stopped: 0 },
      { day: '2026-11-12', worked: 0, quiet: 0, failed: 1, stopped: 0 },
      { day: '2026-11-13', worked: 1, quiet: 1, failed: 0, stopped: 1 },
    ]);
  });

  it('adds up cost per project and the hourly usage peak', () => {
    const days = lastDays(NOW, 2, 'UTC');
    const runs = [
      run({ costUsd: 0.5 }),
      run({ costUsd: 0.25, project: 'blog' }),
      run({ costUsd: 1, startedAt: NOW - DAY }),
    ];
    expect(costByDay(runs, days, ['shop', 'blog'], 'UTC')).toEqual([
      { day: '2026-11-12', byProject: { shop: 1, blog: 0 } },
      { day: '2026-11-13', byProject: { shop: 0.5, blog: 0.25 } },
    ]);
    const hour = Math.floor((NOW - 3_000_000) / 3_600_000) * 3_600_000;
    expect(
      usageByHour([run({ rateLimitUtilization: 0.2 }), run({ rateLimitUtilization: 0.6 }), run({})]),
    ).toEqual([{ at: hour, share: 0.6 }]);
  });

  it('gives totals and spots a job that fails or grows slower', () => {
    const long = (daysAgo: number, mins: number, status = 'ok') =>
      run({
        startedAt: NOW - daysAgo * DAY,
        endedAt: NOW - daysAgo * DAY + mins * 60_000,
        status,
        costUsd: 0.1,
      });
    const runs = [
      long(6, 10),
      long(5, 10),
      long(4, 12),
      long(1, 30),
      long(0.5, 30, 'failed'),
      long(0.2, 1, 'silent'),
    ];
    expect(totals(runs)).toMatchObject({ runs: 6, jobRuns: 6, jobFailed: 1, medianJobMs: 11 * 60_000 });
    const [t] = jobTrends(runs, NOW);
    expect(t).toMatchObject({ project: 'shop', jobId: 'sync', runs: 6, failed: 1, quiet: 1, slower: 3 });
    expect(t?.cost).toBeCloseTo(0.6);
  });

  it('turns health changes into uptime strips, leaving checks that were always fine out', () => {
    const since = NOW - 10 * 3_600_000;
    const events = [
      { key: 'a', status: 'bad' as const, at: NOW - 20 * 3_600_000 },
      { key: 'a', status: 'ok' as const, at: NOW - 9 * 3_600_000 },
      { key: 'b', status: 'ok' as const, at: NOW - 30 * 3_600_000 },
      { key: 'c', status: 'bad' as const, at: NOW - 2 * 3_600_000 },
    ];
    const ups = uptimes(events, new Map([['c', 'bad']]), since, NOW);
    expect(ups.map((u) => [u.key, Math.round(u.uptime * 100), u.outages])).toEqual([
      ['c', 80, 1],
      ['a', 90, 0],
    ]);
  });

  it('groups log lines that differ only in numbers, ids and times', () => {
    expect(logPattern('[abtara:daily-sync] trigger not posted: slot 1794583735108 "C0C56T18287"')).toBe(
      '[abtara:daily-sync] trigger not posted: slot # "…"',
    );
    const groups = groupLogs([
      { at: 1, level: 'warn', message: 'Tab sweep: closed 3 tabs in 9222' },
      { at: 5, level: 'warn', message: 'Tab sweep: closed 12 tabs in 9223' },
      { at: 3, level: 'error', message: 'http GET /x: boom' },
    ]);
    expect(groups.map((g) => [g.level, g.count, g.first, g.last, g.example])).toEqual([
      ['warn', 2, 1, 5, 'Tab sweep: closed 12 tabs in 9223'],
      ['error', 1, 3, 3, 'http GET /x: boom'],
    ]);
    expect(looksLikeProblem('POST /api failed with 502')).toBe(true);
    expect(looksLikeProblem('89 runs, 0 errors')).toBe(false);
    expect(looksLikeProblem('Server listening on 4001')).toBe(false);
    // Words starting with "e" aren't error codes; real ones are.
    expect(looksLikeProblem('vite building client environment for production')).toBe(false);
    expect(looksLikeProblem('Shipping: Amazon endpoints active')).toBe(false);
    expect(looksLikeProblem('connect ECONNREFUSED 127.0.0.1:3000')).toBe(true);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(37)).toBe(50);
    expect(niceMax(0.003, 0.0001)).toBe(0.005);
  });
});

describe('readJournal', () => {
  it('keeps problem lines with their unit, level and blanked secrets', async () => {
    const line = (o: Record<string, unknown>) => JSON.stringify(o);
    const logs = await readJournal(['abtara-dashboard', 'remote-job-board'], 0, async (cmd, args) => {
      expect(cmd).toBe('journalctl');
      expect(args).toContain('--unit');
      return {
        stdout: [
          line({
            MESSAGE: 'Listening on 4001',
            PRIORITY: '6',
            __REALTIME_TIMESTAMP: '1000000',
            _SYSTEMD_UNIT: 'abtara-dashboard.service',
          }),
          line({
            MESSAGE: 'Upload failed: token=sk-ant-api03-SECRETSECRETSECRET',
            PRIORITY: '6',
            __REALTIME_TIMESTAMP: '2000000',
            _SYSTEMD_UNIT: 'abtara-dashboard.service',
          }),
          line({
            MESSAGE: 'GET https://x.io/a.pdf?X-Goog-Signature=abc123&b=1 timed out',
            PRIORITY: '6',
            __REALTIME_TIMESTAMP: '2500000',
            _SYSTEMD_UNIT: 'abtara-dashboard.service',
          }),
          line({
            MESSAGE: 'slow answer',
            PRIORITY: '3',
            __REALTIME_TIMESTAMP: '3000000',
            _SYSTEMD_UNIT: 'remote-job-board.service',
          }),
          line({ MESSAGE: [1, 2], PRIORITY: '3' }),
          'not json',
        ].join('\n'),
        stderr: '',
      };
    });
    expect(logs.error).toBeUndefined();
    expect(logs.lines.map((l) => [l.unit, l.level, l.at])).toEqual([
      ['abtara-dashboard', 'error', 2000],
      ['abtara-dashboard', 'warn', 2500],
      ['remote-job-board', 'error', 3000],
    ]);
    expect(logs.lines[1]?.message).toBe('GET https://x.io/a.pdf?X-Goog-Signature=…&b=1 timed out');
    expect(logs.lines[0]?.message).not.toContain('SECRETSECRET');
  });

  it("says how to allow it when the journal can't be read", async () => {
    const denied = await readJournal(['x'], 0, async () => ({
      stdout: '',
      stderr: 'No journal files were opened due to insufficient permissions.',
    }));
    expect(denied.error).toMatch(/usermod -aG systemd-journal/);
    const missing = await readJournal(['x'], 0, async () => {
      throw new Error('spawn journalctl ENOENT');
    });
    expect(missing.error).toBe('spawn journalctl ENOENT');
    expect(await readJournal([], 0)).toEqual({ lines: [] });
  });
});

describe('prometheusText', () => {
  it('writes gauges with escaped labels', () => {
    const text = prometheusText({
      uptimeSeconds: 42,
      running: 1,
      usage: 0.25,
      runs: [run({ costUsd: 0.5, inputTokens: 10, outputTokens: 5 }), run({ status: 'failed' })],
      jobs: [
        {
          id: 'sync',
          name: 'Payments "Sync"',
          enabled: true,
          running: false,
          tz: 'UTC',
          skills: [],
          model: 'haiku',
          project: 'shop',
          lastRunAt: new Date(NOW),
          recent: [
            { ...run({ status: 'failed' }), id: 1 },
            { ...run({}), id: 2 },
          ],
        },
      ],
      host: { at: NOW, load: 0.7, memUsed: 0.3, diskUsed: 0.28 },
    });
    expect(text).toContain('tara_uptime_seconds 42');
    expect(text).toContain('tara_runs_24h{project="shop",kind="job",result="worked"} 1');
    expect(text).toContain('tara_runs_24h{project="shop",kind="job",result="failed"} 1');
    expect(text).toContain('tara_cost_usd_24h{project="shop",kind="job",result="worked"} 0.5');
    expect(text).toContain('tara_job_failure_streak{project="shop",job="sync",name="Payments \\"Sync\\""} 1');
    expect(text).toContain('tara_host_disk_used_ratio 0.28');
    expect(text).toContain('# TYPE tara_usage_window_ratio gauge');
  });
});

describe('Trends, Logs and /metrics in the dashboard', () => {
  it('serves them, behind the token, with charts that have tips and tables', async () => {
    const store = new Store(':memory:');
    store.recordRun({
      kind: 'job',
      project: 'shop',
      jobId: 'sync',
      startedAt: Date.now() - 600_000,
      endedAt: Date.now() - 300_000,
      status: 'failed',
      error: 'login expired',
      costUsd: 0.4,
      rateLimitUtilization: 0.5,
    });
    store.addHostSample({ at: Date.now() - 600_000, load: 0.5, memUsed: 0.4, diskUsed: 0.3 });
    store.addHostSample({ at: Date.now() - 300_000, load: 0.9, memUsed: 0.45, diskUsed: 0.3 });
    store.addLog({ at: Date.now() - 60_000, level: 'error', message: 'http GET /x: boom 1' });
    store.addLog({ at: Date.now() - 30_000, level: 'error', message: 'http GET /x: boom 2' });
    const project = {
      dir: '/r',
      config: projectConfigSchema.parse({ name: 'shop', title: 'Shop', slackChannel: 'C0SHOP' }),
    };
    const job: JobInfo = {
      id: 'sync',
      name: 'Payments Sync',
      enabled: true,
      running: false,
      tz: 'UTC',
      skills: [],
      model: 'haiku',
    };
    const monitor = new HealthMonitor({
      sources: () => [],
      store,
      target: () => undefined,
      alerts: false,
      timeZone: 'UTC',
      log: quiet,
      intervalMs: 60_000,
    });
    await monitor.check();
    const observe = new Observability({
      store,
      projects: [project],
      jobs: () => [job],
      monitor,
      running: () => 0,
      usage: () => 0.5,
      agentName: 'Jarvis',
      timeZone: 'UTC',
      logUnits: ['abtara-dashboard'],
      started: Date.now() - 1000,
      journal: async () => ({
        lines: [
          { unit: 'abtara-dashboard', at: Date.now() - 1000, level: 'warn', message: 'WAHA slow: 5000ms' },
        ],
      }),
    });
    const scheduler = { list: () => [job], plannedRuns: () => [] } as unknown as Scheduler;
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      token: 'tok',
      scheduler,
      store,
      projects: ['shop'],
      log: quiet,
      health: monitor,
      observe,
      dashboard: { projects: [project], timeZone: 'UTC', agentName: 'Jarvis' },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: 'Bearer tok' };
    try {
      const trends = await fetch(`${base}/health/trends?days=7`, {
        headers: { accept: 'text/html', ...auth },
      }).then((r) => r.text());
      expect(trends).toContain('Runs per day');
      expect(trends).toContain('Payments Sync');
      expect(trends).toContain('login expired');
      expect(trends).toMatch(/data-tip="[^"]*Failed: 1/);
      expect(trends).toContain('<summary>Table</summary>');
      expect(trends).toContain('Memory used');
      expect(trends).toMatch(/class="chip on" href="\/health\/trends\?days=7"/);

      const logs = await fetch(`${base}/health/logs`, { headers: { accept: 'text/html', ...auth } }).then(
        (r) => r.text(),
      );
      expect(logs).toContain('Jarvis (tara-agent)');
      expect(logs).toContain('http GET /x: boom 2');
      expect(logs).toContain('Grouped as: http GET /x: boom #');
      expect(logs).toContain('2×');
      expect(logs).toContain('WAHA slow: 5000ms');

      const now = await fetch(`${base}/health`, { headers: { accept: 'text/html', ...auth } }).then((r) =>
        r.text(),
      );
      expect(now).toContain('href="/health/trends"');

      expect((await fetch(`${base}/metrics`)).status).toBe(401);
      const metrics = await fetch(`${base}/metrics`, { headers: auth });
      expect(metrics.headers.get('content-type')).toMatch(/^text\/plain/);
      const text = await metrics.text();
      expect(text).toContain('tara_runs_24h{project="shop",kind="job",result="failed"} 1');
      expect(text).toContain('tara_usage_window_ratio 0.5');
      expect(text).toContain('tara_host_load1 0.9');
    } finally {
      server.close();
    }
  });
});
