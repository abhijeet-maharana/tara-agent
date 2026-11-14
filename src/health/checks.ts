import { statfsSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { HostConfig, Project } from '../config/schema.js';
import type { BrowserStatus } from '../http/browser-usage.js';
import type { Task } from '../runner/activity.js';
import type { RateLimit } from '../runner/stream.js';
import type { JobInfo } from '../scheduler/scheduler.js';
import type { RunStat, StoredRun } from '../store/store.js';
import type { ClaudeLogin } from './claude-login.js';
import { ago, type Check, type HealthSource, type HealthStatus, parseProjectChecks } from './monitor.js';

/** Run results that count as failures (as on the dashboard). */
const FAILED = ['failed', 'error', 'timeout', 'limit'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Days before the Claude login ends: on the Health page (warn), then posted to Slack (bad). */
const LOGIN_WARN_DAYS = 7;
const LOGIN_BAD_DAYS = 3;
/** A slot this recent may still be starting (trigger posted, waiting for a job slot or a lock). */
const SLOT_GRACE_MS = 15 * 60_000;

const worst = (...s: HealthStatus[]): HealthStatus =>
  s.includes('bad') ? 'bad' : s.includes('warn') ? 'warn' : 'ok';
const pct = (n: number) => `${Math.round(n * 100)}%`;
const size = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e6)} MB`
      : `${Math.round(bytes / 1e3)} KB`;
const firstLine = (s: string | undefined, max = 160) => {
  const line =
    (s ?? '')
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export interface SlackLink {
  state: string;
  since: number;
  /** When the last Slack event arrived. */
  lastEventAt?: number;
}

export interface AgentDeps {
  agentName: string;
  host: Pick<HostConfig, 'concurrency' | 'jobConcurrency' | 'stateDir' | 'browsers'> & {
    health: Pick<HostConfig['health'], 'stuckMinutes' | 'diskWarnPercent' | 'diskBadPercent'>;
  };
  slack?: () => SlackLink;
  tasks: () => Task[];
  usage: () => RateLimit | undefined;
  runsSince: (since: number) => RunStat[];
  dbFile?: string;
  probeBrowser?: (b: HostConfig['browsers'][number]) => Promise<BrowserStatus>;
  /** The runs' Claude login (src/health/claude-login.ts); undefined = nothing to watch. */
  claudeLogin?: () => Promise<ClaudeLogin | undefined>;
  timeZone: string;
  now: () => number;
  /** Tests: stand-ins for the machine's figures. */
  machine?: () => { diskUsed?: number; memFree: number; load: number; cpus: number; dbBytes?: number };
}

const clock = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(ms);

/** "20:50" today, "Sat 20:50" on another day. */
function dayClock(ms: number, now: number, timeZone: string): string {
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(t);
  const time = clock(ms, timeZone);
  if (day(ms) === day(now)) return time;
  return `${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(ms)} ${time}`;
}

/** This machine now: disk use of the state folder's disk, free memory, load, CPUs, database size. */
export function machine(stateDir: string | undefined, dbFile?: string) {
  let diskUsed: number | undefined;
  try {
    const fs = statfsSync(stateDir ?? '/');
    diskUsed = fs.blocks ? 1 - fs.bavail / fs.blocks : undefined;
  } catch {}
  let dbBytes: number | undefined;
  if (dbFile)
    for (const f of [dbFile, `${dbFile}-wal`])
      try {
        dbBytes = (dbBytes ?? 0) + statSync(f).size;
      } catch {}
  return {
    diskUsed,
    memFree: freemem() / totalmem(),
    load: loadavg()[0] ?? 0,
    cpus: cpus().length || 1,
    dbBytes,
  };
}

/** tara-agent itself: Slack, Claude runs, usage, stuck runs, the machine, browsers. */
export async function agentChecks(d: AgentDeps): Promise<Check[]> {
  const at = d.now();
  const group = d.agentName;
  const out: Check[] = [];
  const add = (id: string, name: string, status: HealthStatus, detail: string, extra: Partial<Check> = {}) =>
    out.push({ key: `tara:${id}`, group, name, status, detail, ...extra });

  if (d.slack) {
    const s = d.slack();
    const last = s.lastEventAt ? ` · last message ${ago(at - s.lastEventAt)} ago` : '';
    if (s.state === 'connected') add('slack', 'Slack', 'ok', `Connected for ${ago(at - s.since)}${last}`);
    else
      add(
        'slack',
        'Slack',
        'bad',
        `${s.state[0]?.toUpperCase()}${s.state.slice(1)} for ${ago(at - s.since)}${last}`,
      );
  }

  // Claude runs: the CLI failing outright (not a job reporting ❌) shows as `error` runs in a row.
  const runs = d.runsSince(at - 6 * HOUR).sort((a, b) => b.endedAt - a.endedAt);
  const errorsInRow = runs.findIndex((r) => r.status !== 'error');
  const streak = errorsInRow === -1 ? runs.length : errorsInRow;
  const errors = runs.filter((r) => r.status === 'error').length;
  if (streak >= 3)
    add(
      'runs',
      'Claude runs',
      'bad',
      `The last ${streak} runs ended in an error: ${firstLine(runs[0]?.error) || 'no message'}`,
    );
  else
    add(
      'runs',
      'Claude runs',
      errors >= 5 ? 'warn' : 'ok',
      runs.length
        ? `${runs.length} in the last 6h, ${errors} ${errors === 1 ? 'error' : 'errors'}`
        : 'No runs in the last 6h',
    );

  // Usage window: hitting the limit stops every run until it resets.
  // Right after a restart the CLI hasn't reported yet: the latest run's figure from the last 5 hours.
  const lastShare = runs.find((r) => r.rateLimitUtilization !== undefined && r.endedAt >= at - 5 * HOUR);
  const usage =
    d.usage() ?? (lastShare && { status: 'allowed', utilization: lastShare.rateLimitUtilization as number });
  const limited = runs.find((r) => r.status === 'limit' && r.endedAt >= at - HOUR);
  const resetsAt = usage?.resetsAt ? usage.resetsAt * (usage.resetsAt < 1e12 ? 1000 : 1) : undefined;
  const share = usage?.utilization;
  const resets = resetsAt && resetsAt > at ? `, resets ${clock(resetsAt, d.timeZone)}` : '';
  if (limited)
    add('usage', 'Usage limit', 'bad', `A run hit the usage limit ${ago(at - limited.endedAt)} ago${resets}`);
  else if (share !== undefined && (!resetsAt || resetsAt > at))
    add('usage', 'Usage limit', share >= 0.9 ? 'warn' : 'ok', `${pct(share)} of the window used${resets}`);
  else add('usage', 'Usage limit', 'ok', 'No limit reported lately');

  // Claude login: it renews itself until a hard end about 30 days after logging in, then every run fails.
  const login = await d.claudeLogin?.();
  if (login) {
    const fix = `log in again as ${login.user ?? 'the run user'}: claude auth login`;
    if (login.error) add('login', 'Claude login', 'warn', `Can't read the login file: ${login.error}`);
    else if (!login.loggedIn) add('login', 'Claude login', 'bad', `Not logged in · ${fix}`);
    else if (login.endsAt === undefined) add('login', 'Claude login', 'ok', 'Logged in');
    else {
      const left = login.endsAt - at;
      const when = new Intl.DateTimeFormat('en-GB', {
        timeZone: d.timeZone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(login.endsAt);
      if (left <= 0) add('login', 'Claude login', 'bad', `Ended ${ago(-left)} ago (${when}) · ${fix}`);
      else if (left <= LOGIN_WARN_DAYS * DAY)
        add(
          'login',
          'Claude login',
          left <= LOGIN_BAD_DAYS * DAY ? 'bad' : 'warn',
          `Ends in ${ago(left)} (${when}) · ${fix}`,
        );
      else add('login', 'Claude login', 'ok', `Logged in · ends in ${ago(left)} (${when})`);
    }
  }

  // Stuck runs: the runner kills a run at its timeout, so one going far longer has lost its process.
  const running = d.tasks().filter((t) => t.status === 'running');
  const stuckMs = d.host.health.stuckMinutes * 60_000;
  const stuck = running.filter((t) => at - t.startedAt > stuckMs);
  const jobs = running.filter((t) => t.kind === 'job').length;
  add(
    'stuck',
    'Running now',
    stuck.length ? 'bad' : 'ok',
    stuck.length
      ? `${stuck.map((t) => `${t.title} (${ago(at - t.startedAt)})`).join(' · ')} still running`
      : running.length
        ? `${running.length} running (${jobs} of ${d.host.jobConcurrency} job slots), none stuck`
        : 'Nothing running',
    stuck[0]?.url ? { link: stuck[0].url } : {},
  );

  const m = d.machine?.() ?? machine(d.host.stateDir, d.dbFile);
  if (m.diskUsed !== undefined) {
    const used = m.diskUsed * 100;
    add(
      'disk',
      'Disk',
      used >= d.host.health.diskBadPercent ? 'bad' : used >= d.host.health.diskWarnPercent ? 'warn' : 'ok',
      `${Math.round(used)}% used${m.dbBytes !== undefined ? ` · database ${size(m.dbBytes)}` : ''}`,
    );
  }
  add(
    'machine',
    'Memory and load',
    worst(m.memFree < 0.05 ? 'bad' : m.memFree < 0.1 ? 'warn' : 'ok', m.load > m.cpus * 2 ? 'warn' : 'ok'),
    `${pct(m.memFree)} memory free · load ${m.load.toFixed(1)} on ${m.cpus} CPUs`,
  );

  if (d.probeBrowser)
    for (const b of await Promise.all(
      d.host.browsers.map((b) => d.probeBrowser?.(b) as Promise<BrowserStatus>),
    ))
      out.push({
        key: `tara:browser:${b.lock}`,
        group: 'Browsers',
        name: `Chrome (${b.lock})`,
        status: b.up ? 'ok' : 'bad',
        detail: b.up
          ? `${b.version ?? 'Answers'}${b.tabs !== undefined ? ` · ${b.tabs} ${b.tabs === 1 ? 'tab' : 'tabs'} open` : ''}`
          : `Not answering on ${b.cdpUrl}`,
      });
  return out;
}

export interface JobsDeps {
  project: Project;
  jobs: () => JobInfo[];
  recent: (jobId: string) => StoredRun[];
  latestSlots: (at: number) => Array<{ id: string; key: string; slot: number; firstSeen: number }>;
  slotClaim: (key: string, slot: number) => { status: string; claimedAt: number } | undefined;
  fileError: () => { message: string; at: number } | undefined;
  /** When the scheduler started: earlier slots were missed by a stopped tara-agent, not a broken one. */
  started: number;
  failingAfter: number;
  timeZone: string;
  now: () => number;
}

/**
 * A project's jobs: its jobs file loads, no job keeps failing, and each scheduled job started at its
 * latest slot. Only problems get a row, plus one summary row.
 */
export function jobChecks(d: JobsDeps): Check[] {
  const at = d.now();
  const name = d.project.config.name;
  const project = name;
  const group = 'Jobs';
  const out: Check[] = [];
  const key = (kind: string, id = '') => `jobs:${name}:${kind}${id ? `:${id}` : ''}`;
  const jobs = d.jobs();
  const byId = new Map(jobs.map((j) => [j.id, j]));

  const fileError = d.fileError();
  if (fileError)
    out.push({
      key: key('file'),
      project,
      group,
      name: 'Jobs file',
      status: 'bad',
      detail: `.tara/jobs.json didn't load (the previous jobs keep running): ${firstLine(fileError.message, 300)}`,
      quiet: true, // in the logs and on the dashboard; nothing goes to Slack for it
    });

  let failing = 0;
  for (const job of jobs.filter((j) => j.enabled)) {
    const recent = d.recent(job.id);
    const i = recent.findIndex((r) => !FAILED.includes(r.status));
    const streak = i === -1 ? recent.length : i;
    if (!streak) continue;
    failing++;
    const last = recent[0] as StoredRun;
    const why = firstLine(last.error) || firstLine(last.output?.replace(/^❌\s*/, ''));
    out.push({
      key: key('failing', job.id),
      project,
      group,
      name: job.name,
      status: streak >= d.failingAfter ? 'bad' : 'warn',
      detail: `${streak === 1 ? 'Failed its last run' : `Failed ${streak} runs in a row`} (${ago(at - last.endedAt)} ago)${why ? `: ${why}` : ''}`,
      // One failure already has its ❌ reply in the job's thread; a streak is worth its own alert.
      quiet: streak < d.failingAfter,
    });
  }

  let missed = 0;
  for (const s of d.latestSlots(at - SLOT_GRACE_MS)) {
    const job = byId.get(s.id);
    if (!job || s.slot < s.firstSeen) continue;
    const claim = d.slotClaim(s.key, s.slot);
    const when = dayClock(s.slot, at, d.timeZone);
    const add = (status: HealthStatus, detail: string, quiet = false) => {
      missed++;
      out.push({ key: key('slot', s.id), project, group, name: job.name, status, detail, quiet });
    };
    if (!claim) {
      if (s.slot >= d.started) add('bad', `Didn't start at ${when} (${ago(at - s.slot)} ago)`);
      // Missed during downtime: worth a note for a day, not for a weekly job's whole week.
      else if (at - s.slot < 24 * HOUR)
        add(
          'warn',
          `Missed ${when} while tara-agent was stopped; next run ${job.nextRun ? dayClock(job.nextRun.getTime(), at, d.timeZone) : 'not planned'}`,
          true,
        );
    } else if (claim.status === 'running' && !job.running && at - claim.claimedAt > 30 * 60_000)
      add('warn', `Started at ${when} but never finished (lost in a restart?)`);
    else if (claim.status === 'skipped')
      add('warn', `Skipped ${when}: paused, or the run before was still going`, true);
    else if (claim.status === 'aborted') add('warn', `The ${when} run was stopped by a restart`, true);
  }

  const enabled = jobs.filter((j) => j.enabled);
  const ran = enabled.filter((j) => j.lastRunAt && at - j.lastRunAt.getTime() < 24 * HOUR).length;
  const paused = jobs.length - enabled.length;
  const problems = failing + missed + (fileError ? 1 : 0);
  out.push({
    key: key('summary'),
    project,
    group,
    name: 'All jobs',
    status: 'ok',
    detail: jobs.length
      ? `${enabled.length} ${enabled.length === 1 ? 'job' : 'jobs'} on${paused ? `, ${paused} paused` : ''} · ${ran} ran in the last 24h${
          problems ? ` · ${problems} listed here` : ' · all on track'
        }`
      : 'No jobs',
  });
  return out;
}

/** A project's own checks (`healthUrl`), or whether its dashboard answers. */
export async function projectChecks(
  project: Project,
  fetcher: typeof fetch = fetch,
  timeoutMs = 12_000,
): Promise<Check[]> {
  const { name, healthUrl, dashboardUrl } = project.config;
  const sourceId = `project:${name}`;
  if (healthUrl) {
    const res = await fetcher(healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${healthUrl} answered ${res.status}`);
    return parseProjectChecks(await res.json(), sourceId, name);
  }
  if (!dashboardUrl) return [];
  const started = Date.now();
  let status: HealthStatus = 'ok';
  let detail: string;
  try {
    const res = await fetcher(dashboardUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (res.status >= 500) status = 'bad';
    detail = `Answers ${res.status} in ${Date.now() - started} ms`;
  } catch (err) {
    status = 'bad';
    detail = `Not answering: ${(err as Error).message}`;
  }
  return [
    {
      key: `${sourceId}:dashboard`,
      project: name,
      group: 'Dashboard',
      name: 'Dashboard app',
      status,
      detail,
    },
  ];
}

/** Every source the Health page checks, in page order. */
export function healthSources(opts: {
  agentName: string;
  agent: () => Promise<Check[]>;
  projects: Project[];
  jobs: (project: Project) => Check[];
  fetcher?: typeof fetch;
}): HealthSource[] {
  return [
    { id: 'tara', title: opts.agentName, run: opts.agent },
    ...opts.projects.flatMap((p): HealthSource[] => {
      const title = p.config.title ?? p.config.name;
      const own =
        p.config.healthUrl || p.config.dashboardUrl
          ? [
              {
                id: `project:${p.config.name}`,
                title,
                project: p.config.name,
                run: () => projectChecks(p, opts.fetcher),
              },
            ]
          : [];
      return [
        {
          id: `jobs:${p.config.name}`,
          title: `${title} jobs`,
          project: p.config.name,
          run: async () => opts.jobs(p),
        },
        ...own,
      ];
    }),
  ];
}
