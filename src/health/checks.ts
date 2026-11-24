import { readdirSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import path from 'node:path';
import type { HostConfig, Project } from '../config/schema.js';
import type { BrowserStatus } from '../http/browser-usage.js';
import { MEMORY_MAX, MEMORY_MAX_LINES } from '../memory/memory.js';
import type { Task } from '../runner/activity.js';
import type { RateLimit } from '../runner/stream.js';
import { SKILL_MAX_CHARS } from '../scheduler/prompt.js';
import type { JobInfo } from '../scheduler/scheduler.js';
import type { RunStat, StoredRun } from '../store/store.js';
import type { ClaudeLogin } from './claude-login.js';
import { ago, type Check, type HealthSource, type HealthStatus, parseProjectChecks } from './monitor.js';
import { type OffsiteOptions, type OffsiteStatus, offsiteChecks } from './offsite.js';
import { type VmHostSample, vmHostChecks } from './vmhost.js';

/** Run results that count as failures (as on the dashboard). */
const FAILED = ['failed', 'error', 'timeout', 'limit', 'blocked', 'over-budget'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Days before the Claude login ends that it shows amber (the Slack reminder starts then too). */
const LOGIN_WARN_DAYS = 3;
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
  /** The VM host's latest report (src/health/vmhost.ts), however old; undefined = it never reported. */
  vmHost?: () => VmHostSample | undefined;
  /** The runs' Claude login (src/health/claude-login.ts); undefined = nothing to watch. */
  claudeLogin?: () => Promise<ClaudeLogin | undefined>;
  /** Projects left out at start because their config didn't load. */
  skippedProjects?: () => Array<{ dir: string; message: string }>;
  /** Writes to the state database: undefined when it works, else the error (a read-only disk, damage). */
  dbWrite?: () => string | undefined;
  /** Pinned settings (host `trusted`) a repo's config tried to change, by project. */
  pinDrift?: () => Array<{ project: string; keys: string[] }>;
  /** The daily database copy (store/backup.ts): the local day of the latest good one, or the last error. */
  backup?: () => { day?: string; error?: string };
  /** The off-site backup's status file (src/health/offsite.ts), read now; undefined = not set up. */
  offsite?: () => { status: OffsiteStatus | { error: string }; options: OffsiteOptions } | undefined;
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

/** This machine now: disk use of the state folder's disk, free memory, swap, load, CPUs, database size. */
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
  // Swap in use, 0–1 (Linux only; includes zram, which is compressed RAM rather than disk).
  let swapUsed: number | undefined;
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1]);
    const total = kb('SwapTotal');
    const used = 1 - kb('SwapFree') / total;
    if (total > 0 && Number.isFinite(used)) swapUsed = used;
  } catch {}
  return {
    diskUsed,
    swapUsed,
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

  const skipped = d.skippedProjects?.() ?? [];
  if (skipped.length)
    add(
      'projects',
      'Projects',
      'bad',
      `Left out at start (fix the config, then restart): ${skipped.map((p) => `${p.dir}: ${firstLine(p.message)}`).join(' · ')}`,
    );

  const dbError = d.dbWrite?.();
  if (dbError !== undefined)
    add(
      'database',
      'Database',
      'bad',
      `Writes fail, so runs, cards and claims aren't saved: ${firstLine(dbError)}`,
    );

  const drift = d.pinDrift?.() ?? [];
  if (drift.length)
    add(
      'pinned',
      'Pinned settings',
      'warn',
      `Ignored in the repo's .tara/config.json (host trusted wins): ${drift.map((p) => `${p.project}: ${p.keys.join(', ')}`).join(' · ')}`,
    );

  const backup = d.backup?.();
  if (backup) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: d.timeZone }).format(at);
    if (backup.error)
      add('backup', 'Database backup', 'bad', `The last copy failed: ${firstLine(backup.error)}`);
    else if (backup.day === today)
      add('backup', 'Database backup', 'ok', `Today's copy is written and checked`);
    else
      add(
        'backup',
        'Database backup',
        'warn',
        backup.day ? `Latest copy is from ${backup.day}` : 'No copy yet',
      );
  }

  const offsite = d.offsite?.();
  if (offsite)
    for (const c of offsiteChecks(offsite.status, offsite.options, at)) add(c.id, c.name, c.status, c.detail);

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
  // Shown here only (`quiet`): Slack hears about it from the daily reminder (health/login-reminder.ts).
  const login = await d.claudeLogin?.();
  if (login) {
    const fix = `log in again as ${login.user ?? 'the run user'}: claude auth login`;
    const add = (status: HealthStatus, detail: string) =>
      out.push({ key: 'tara:login', group, name: 'Claude login', status, detail, quiet: true });
    if (login.error) add('warn', `Can't read the login file: ${login.error}`);
    else if (!login.loggedIn) add('bad', `Not logged in · ${fix}`);
    else if (login.endsAt === undefined) add('ok', 'Logged in');
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
      if (left <= 0) add('bad', `Ended ${ago(-left)} ago (${when}) · ${fix}`);
      else if (left <= LOGIN_WARN_DAYS * DAY) add('warn', `Ends in ${ago(left)} (${when}) · ${fix}`);
      else add('ok', `Logged in · ends in ${ago(left)} (${when})`);
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
  if (d.vmHost) out.push(...vmHostChecks(d.vmHost(), at));
  return out;
}

/**
 * A project's skills whose SKILL.md is over `max` characters, longest first. Every run of a job reads
 * its whole skill, and learning turns tend to grow them. Only files already over `max` bytes are read
 * (a character is at least a byte), so the scan stays cheap. A skill with its own LICENSE file is a
 * third-party one kept as published: not ours to shorten, so not listed.
 */
export function oversizedSkills(
  projectDir: string,
  max = SKILL_MAX_CHARS,
): Array<{ name: string; chars: number }> {
  const dir = path.join(projectDir, '.claude', 'skills');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; chars: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name, 'SKILL.md');
    try {
      if (statSync(file).size <= max) continue;
      if (readdirSync(path.join(dir, name)).some((f) => /^LICEN[CS]E(\.|$)/i.test(f))) continue;
      const chars = readFileSync(file, 'utf8').length;
      if (chars > max) out.push({ name, chars });
    } catch {}
  }
  return out.sort((a, b) => b.chars - a.chars);
}

export interface JobsDeps {
  project: Project;
  /** Its skills over the size limit (`oversizedSkills`); unset: not checked. */
  skills?: () => Array<{ name: string; chars: number }>;
  /** Its `.tara/memory.md` when over the limit (`oversizedMemory`); unset: not checked. */
  memory?: () => { lines: number; chars: number } | undefined;
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
    else if (claim.status === 'skipped') {
      // The slot's status is the run's: a gate that found nothing to do also ends `skipped`, and that
      // run is recorded. Only a slot with no run of its own was skipped by a pause or a busy job.
      const gated = d.recent(s.id).some((r) => r.status === 'skipped' && r.startedAt >= s.slot);
      if (!gated) add('warn', `Skipped ${when}: paused, or the run before was still going`, true);
    } else if (claim.status === 'aborted') {
      // Made up for by a later run (Run now, or the next slot): nothing is missing any more.
      const madeUp = d.recent(s.id).some((r) => r.startedAt > claim.claimedAt && !FAILED.includes(r.status));
      if (!madeUp) add('warn', `The ${when} run was stopped by a restart`, true);
    } else if (claim.status === 'held')
      add('warn', `Held at ${when}: usage limit reached; it runs once the limit resets`, true);
  }

  const long = d.skills?.() ?? [];
  if (long.length) {
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    const shown = long.slice(0, 5).map((s) => `${s.name} ${k(s.chars)}`);
    out.push({
      key: key('skills'),
      project,
      group,
      name: 'Skill size',
      status: 'warn',
      detail: `${long.length} ${long.length === 1 ? 'skill is' : 'skills are'} over ${k(SKILL_MAX_CHARS)} characters, and every run reads all of it: ${shown.join(', ')}${long.length > 5 ? `, +${long.length - 5} more` : ''}. Tidy it: rules in place, detail in references/`,
      quiet: true, // a slow problem: the page shows it, Slack doesn't need to
    });
  }

  const mem = d.memory?.();
  if (mem)
    out.push({
      key: key('memory'),
      project,
      group,
      name: 'Project memory',
      status: 'warn',
      detail: `.tara/memory.md is ${mem.lines} lines, ${Math.round(mem.chars / 1000)}k characters: a new session gets only the first ${MEMORY_MAX / 1000}k, so the rest is never read. Tidy it: drop what skills or the repo already say and facts no longer true (keep under ${MEMORY_MAX_LINES} lines)`,
      quiet: true,
    });

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
