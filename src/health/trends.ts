import type { HealthEvent, HealthStatus, RunStat } from '../store/store.js';

/**
 * What the Trends page shows, worked out from stored runs, health changes and host samples: pure
 * functions, so the page and the tests share them.
 */

const DAY = 86_400_000;
const FAILED = ['failed', 'error', 'timeout', 'limit'];

export type RunResult = 'worked' | 'quiet' | 'failed' | 'stopped';

/** How a run ended, in the dashboard's words: did work, nothing to do, failed, stopped. */
export function runResult(status: string): RunResult {
  if (status === 'silent') return 'quiet';
  if (FAILED.includes(status)) return 'failed';
  if (status === 'aborted') return 'stopped';
  return 'worked';
}

/** "2026-11-13" in the given time zone. */
export const dayKey = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(ms);

/** The last `days` day keys, oldest first, ending with today. */
export function lastDays(now: number, days: number, timeZone: string): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(now - i * DAY, timeZone);
    if (keys.at(-1) !== k) keys.push(k);
  }
  // A DST day can repeat or skip a key; make sure today is last and the count holds.
  return keys.slice(-days);
}

export interface DayRuns {
  day: string;
  worked: number;
  quiet: number;
  failed: number;
  stopped: number;
}

/** Chats and jobs per day by result (learning turns are tara's own upkeep, left out). */
export function runsByDay(runs: RunStat[], days: string[], timeZone: string): DayRuns[] {
  const by = new Map(days.map((d) => [d, { day: d, worked: 0, quiet: 0, failed: 0, stopped: 0 }]));
  for (const r of runs) {
    if (r.kind === 'learn') continue;
    const row = by.get(dayKey(r.startedAt, timeZone));
    if (row) row[runResult(r.status)]++;
  }
  return days.map((d) => by.get(d) as DayRuns);
}

/** Cost per day per project (the CLI's API-equivalent figure; a subscription doesn't bill it). */
export function costByDay(
  runs: RunStat[],
  days: string[],
  projects: string[],
  timeZone: string,
): Array<{ day: string; byProject: Record<string, number> }> {
  const by = new Map(
    days.map((d) => [d, Object.fromEntries(projects.map((p) => [p, 0])) as Record<string, number>]),
  );
  for (const r of runs) {
    const row = by.get(dayKey(r.startedAt, timeZone));
    if (row && r.costUsd && r.project in row) row[r.project] = (row[r.project] ?? 0) + r.costUsd;
  }
  return days.map((d) => ({ day: d, byProject: by.get(d) as Record<string, number> }));
}

/** The highest usage-window share any run reported, per hour, as points in time order. */
export function usageByHour(runs: RunStat[]): Array<{ at: number; share: number }> {
  const by = new Map<number, number>();
  for (const r of runs) {
    if (r.rateLimitUtilization === undefined) continue;
    const hour = Math.floor(r.endedAt / 3_600_000) * 3_600_000;
    by.set(hour, Math.max(by.get(hour) ?? 0, r.rateLimitUtilization));
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([at, share]) => ({ at, share }));
}

export function quantile(sorted: number[], q: number): number | undefined {
  if (!sorted.length) return undefined;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo);
}

export interface Totals {
  runs: number;
  jobRuns: number;
  jobFailed: number;
  /** Job runs that failed, 0–1 (undefined without job runs). */
  failRate?: number;
  cost: number;
  tokens: number;
  /** Median length of job runs that did something, in ms. */
  medianJobMs?: number;
}

export function totals(runs: RunStat[]): Totals {
  const kept = runs.filter((r) => r.kind !== 'learn');
  const jobs = kept.filter((r) => r.kind === 'job');
  const failed = jobs.filter((r) => runResult(r.status) === 'failed').length;
  const lengths = jobs
    .filter((r) => runResult(r.status) === 'worked')
    .map((r) => r.endedAt - r.startedAt)
    .sort((a, b) => a - b);
  return {
    runs: kept.length,
    jobRuns: jobs.length,
    jobFailed: failed,
    failRate: jobs.length ? failed / jobs.length : undefined,
    cost: runs.reduce((t, r) => t + (r.costUsd ?? 0), 0),
    tokens: runs.reduce(
      (t, r) => t + (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0),
      0,
    ),
    medianJobMs: quantile(lengths, 0.5),
  };
}

export interface JobTrend {
  project: string;
  jobId: string;
  runs: number;
  failed: number;
  quiet: number;
  failRate: number;
  /** Length of runs that did something. */
  p50?: number;
  p95?: number;
  /** Median of the last 3 days over the median before them (1.5 = half as long again); undefined without both. */
  slower?: number;
  /** Typical length of the last 3 days and of the days before, in ms. */
  recentMs?: number;
  beforeMs?: number;
  cost: number;
  lastError?: string;
}

/** Each job's runs in the window: failures, typical length (and whether it is growing), cost. */
export function jobTrends(runs: RunStat[], now: number): JobTrend[] {
  const by = new Map<string, RunStat[]>();
  for (const r of runs)
    if (r.kind === 'job' && r.jobId) {
      const k = `${r.project}\u0000${r.jobId}`;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
  const recentFrom = now - 3 * DAY;
  return [...by.entries()].map(([k, list]) => {
    const [project, jobId] = k.split('\u0000') as [string, string];
    const worked = list.filter((r) => runResult(r.status) === 'worked');
    const len = (rs: RunStat[]) => rs.map((r) => r.endedAt - r.startedAt).sort((a, b) => a - b);
    const all = len(worked);
    const recent = quantile(len(worked.filter((r) => r.startedAt >= recentFrom)), 0.5);
    const before = quantile(len(worked.filter((r) => r.startedAt < recentFrom)), 0.5);
    const failedRuns = list.filter((r) => runResult(r.status) === 'failed');
    return {
      project,
      jobId,
      runs: list.length,
      failed: failedRuns.length,
      quiet: list.filter((r) => r.status === 'silent').length,
      failRate: failedRuns.length / list.length,
      p50: quantile(all, 0.5),
      p95: quantile(all, 0.95),
      slower: recent !== undefined && before ? recent / before : undefined,
      recentMs: recent,
      beforeMs: before,
      cost: list.reduce((t, r) => t + (r.costUsd ?? 0), 0),
      lastError: failedRuns.at(-1)?.error?.split('\n')[0],
    };
  });
}

export interface Segment {
  from: number;
  to: number;
  status: HealthStatus;
}

export interface Uptime {
  key: string;
  segments: Segment[];
  /** Share of the window it wasn't red, 0–1. */
  uptime: number;
  outages: number;
}

/**
 * Each check's states over [since, now] from its changes. `events` must cover the window and may
 * start earlier (the last change before `since` gives the starting state; none = fine).
 */
export function uptimes(
  events: HealthEvent[],
  current: Map<string, HealthStatus>,
  since: number,
  now: number,
): Uptime[] {
  const keys = new Set([...events.map((e) => e.key)]);
  const span = Math.max(1, now - since);
  const out: Uptime[] = [];
  for (const key of keys) {
    const mine = events.filter((e) => e.key === key).sort((a, b) => a.at - b.at);
    let status: HealthStatus = mine.filter((e) => e.at < since).at(-1)?.status ?? 'ok';
    let from = since;
    const segments: Segment[] = [];
    let outages = 0;
    for (const e of mine.filter((x) => x.at >= since && x.at <= now)) {
      if (e.at > from) segments.push({ from, to: e.at, status });
      if (e.status === 'bad' && status !== 'bad') outages++;
      status = e.status;
      from = e.at;
    }
    segments.push({ from, to: now, status: current.get(key) ?? status });
    const down = segments.filter((s) => s.status === 'bad').reduce((t, s) => t + (s.to - s.from), 0);
    if (segments.every((s) => s.status === 'ok')) continue;
    out.push({ key, segments, uptime: 1 - down / span, outages });
  }
  return out.sort((a, b) => a.uptime - b.uptime);
}

export interface LogLine {
  at: number;
  level: 'warn' | 'error';
  message: string;
}

export interface LogGroup {
  /** The message with ids, numbers and times blanked out. */
  pattern: string;
  level: 'warn' | 'error';
  count: number;
  first: number;
  last: number;
  /** The latest message as written. */
  example: string;
}

/** Blanks what changes between otherwise identical messages: times, ids, numbers, quoted values. */
export function logPattern(message: string): string {
  return (message.split('\n')[0] ?? '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/\b[CUWG][A-Z0-9]{8,}\b/g, '<id>')
    .replace(/"[^"]{0,200}"/g, '"…"')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Lines grouped by pattern, most recent group first. */
export function groupLogs(lines: LogLine[]): LogGroup[] {
  const by = new Map<string, LogGroup>();
  for (const l of lines) {
    const pattern = logPattern(l.message);
    const g = by.get(`${l.level}|${pattern}`);
    if (!g) {
      by.set(`${l.level}|${pattern}`, {
        pattern,
        level: l.level,
        count: 1,
        first: l.at,
        last: l.at,
        example: l.message,
      });
      continue;
    }
    g.count++;
    if (l.at < g.first) g.first = l.at;
    if (l.at >= g.last) {
      g.last = l.at;
      g.example = l.message;
    }
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

/** A service log line worth showing: an error or warning, by its words (services log everything as info). */
const PROBLEM =
  /\b(errors?|failed|failure|fail|exception|uncaught|unhandled|refused|denied|timed out|timeout|warn(ings?)?|fatal|crash(ed)?)\b|⚠️|❌/i;
/** Node's error codes, in capitals only ("Engine" and "endpoints" are not errors). */
const ERRNO =
  /\b(ECONN[A-Z]+|ENOENT|EACCES|EPERM|ETIMEDOUT|EPIPE|EADDRINUSE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)\b/;
export const looksLikeProblem = (line: string) =>
  (PROBLEM.test(line) || ERRNO.test(line)) &&
  !/\b0 (errors?|failed)\b/i.test(line) &&
  !/--no-warnings/.test(line);
