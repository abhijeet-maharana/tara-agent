import type { JobInfo } from '../scheduler/scheduler.js';
import type { HostSample, RunStat, StoredRun } from '../store/store.js';
import type { HealthSnapshot } from './monitor.js';
import { runResult } from './trends.js';

/**
 * `GET /metrics` in Prometheus's text format, so Grafana (or any scraper) can chart tara-agent without
 * its own collector. Counts are over the last 24 hours (the database is pruned, so no counter would
 * stay monotonic); scrape it every minute or so.
 */
export interface MetricsInput {
  uptimeSeconds: number;
  snapshot?: HealthSnapshot;
  /** Runs of the last 24 hours. */
  runs: RunStat[];
  jobs: Array<JobInfo & { project: string; recent: StoredRun[] }>;
  running: number;
  usage?: number;
  host?: HostSample;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labels = (l: Record<string, string>) =>
  `{${Object.entries(l)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(',')}}`;
const STATUS = { ok: 0, warn: 1, bad: 2 } as const;
const FAILED = ['failed', 'error', 'timeout', 'limit'];

export function prometheusText(m: MetricsInput): string {
  const out: string[] = [];
  const metric = (
    name: string,
    help: string,
    type: 'gauge' | 'counter',
    rows: Array<[Record<string, string>, number]>,
  ) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [l, v] of rows)
      if (Number.isFinite(v)) out.push(`${name}${Object.keys(l).length ? labels(l) : ''} ${v}`);
  };

  metric('tara_uptime_seconds', 'Seconds since tara-agent started.', 'gauge', [[{}, m.uptimeSeconds]]);
  metric('tara_running_runs', 'Claude runs going now.', 'gauge', [[{}, m.running]]);
  if (m.usage !== undefined)
    metric('tara_usage_window_ratio', 'Share of the Claude usage window used (0-1).', 'gauge', [
      [{}, m.usage],
    ]);

  const s = m.snapshot;
  if (s) {
    const source = (key: string) => s.sources.find((x) => key.startsWith(`${x.id}:`))?.title ?? '';
    metric(
      'tara_health_check_status',
      'Health page check: 0 fine, 1 needs a look, 2 broken (unconfirmed reds count as 1).',
      'gauge',
      s.checks.map((c) => [
        { source: source(c.key), group: c.group, name: c.name, ...(c.project && { project: c.project }) },
        c.unconfirmed ? 1 : STATUS[c.status],
      ]),
    );
    metric(
      'tara_health_checks',
      'Health page checks by status.',
      'gauge',
      (['ok', 'warn', 'bad'] as const).map((st) => [{ status: st }, s.counts[st]]),
    );
    metric('tara_health_checked_timestamp_seconds', 'When the checks last ran.', 'gauge', [
      [{}, Math.floor(s.checkedAt / 1000)],
    ]);
  }

  const counts = new Map<string, { l: Record<string, string>; n: number; cost: number; tokens: number }>();
  for (const r of m.runs) {
    const l = { project: r.project, kind: r.kind, result: runResult(r.status) };
    const k = JSON.stringify(l);
    const row = counts.get(k) ?? { l, n: 0, cost: 0, tokens: 0 };
    row.n++;
    row.cost += r.costUsd ?? 0;
    row.tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0);
    counts.set(k, row);
  }
  const rows = [...counts.values()];
  metric(
    'tara_runs_24h',
    'Runs in the last 24 hours by project, kind and result.',
    'gauge',
    rows.map((r) => [r.l, r.n]),
  );
  metric(
    'tara_cost_usd_24h',
    'API-equivalent cost of the last 24 hours.',
    'gauge',
    rows.map((r) => [r.l, Math.round(r.cost * 1e4) / 1e4]),
  );
  metric(
    'tara_tokens_24h',
    'Input, output and cache-read tokens of the last 24 hours.',
    'gauge',
    rows.map((r) => [r.l, r.tokens]),
  );

  const jobLabels = (j: { project: string; id: string; name: string }) => ({
    project: j.project,
    job: j.id,
    name: j.name,
  });
  metric(
    'tara_job_last_run_timestamp_seconds',
    "When each job's latest run started.",
    'gauge',
    m.jobs
      .filter((j) => j.lastRunAt)
      .map((j) => [jobLabels(j), Math.floor((j.lastRunAt as Date).getTime() / 1000)]),
  );
  metric(
    'tara_job_failure_streak',
    'Runs in a row each job has failed (0 when its latest run was fine).',
    'gauge',
    m.jobs.map((j) => {
      const i = j.recent.findIndex((r) => !FAILED.includes(r.status));
      return [jobLabels(j), i === -1 ? j.recent.length : i];
    }),
  );
  metric(
    'tara_job_enabled',
    '1 when the job runs on its schedule, 0 when paused.',
    'gauge',
    m.jobs.map((j) => [jobLabels(j), j.enabled ? 1 : 0]),
  );

  if (m.host) {
    metric('tara_host_load1', '1-minute load average.', 'gauge', [[{}, m.host.load]]);
    metric('tara_host_memory_used_ratio', 'Share of memory in use (0-1).', 'gauge', [[{}, m.host.memUsed]]);
    if (m.host.diskUsed !== undefined)
      metric('tara_host_disk_used_ratio', "Share of the state folder's disk in use (0-1).", 'gauge', [
        [{}, m.host.diskUsed],
      ]);
  }
  return `${out.join('\n')}\n`;
}
