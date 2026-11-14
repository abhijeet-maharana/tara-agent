import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { Cron } from 'croner';
import { ApprovalError, type Approvals, type ProposeInput } from '../approvals/approvals.js';
import { type Bridge, BridgeError } from '../bridge/bridge.js';
import { CodeError, type CodeRepo, MIN_QUERY, type RepoReader } from '../code/repo.js';
import { loadQueues } from '../config/load.js';
import type { HostConfig, Project, QueueConfig } from '../config/schema.js';
import type { HealthMonitor } from '../health/monitor.js';
import type { Observability } from '../health/observability.js';
import type { Activity } from '../runner/activity.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { type IncomingMessage as ChatMessage, type Logger, threadKey } from '../sessions/manager.js';
import { ITEM_STATUSES, type ItemStatus, type Store } from '../store/store.js';
import { addDays, dayKey, midnight } from '../util/time.js';
import { allowList } from './access.js';
import {
  type ApprovalsTab,
  approvalsPage,
  ITEMS_LIMIT,
  isNotice,
  safeMediaUrl,
  unlockPage,
} from './approvals.js';
import type { Attention } from './attention.js';
import { probeBrowser, projectNeeds, SiteScanner } from './browser-usage.js';
import { browsersPage } from './browsers.js';
import {
  codeDiffPage,
  codeFilePage,
  codeHomePage,
  codeRepoPage,
  codeSearchPage,
  codeTreePage,
  staleWork,
} from './code.js';
import {
  type DashboardContext,
  errorPage,
  type HomeUsage,
  type HostModels,
  homePage,
  type JobView,
  jobState,
  jobsPage,
  jobWeeks,
  modelUses,
  runPage,
  type StaleRepo,
  sessionPage,
  sessionsPage,
  tabbed,
  tabPage,
} from './dashboard.js';
import { healthPage } from './health.js';
import { logsPage, trendsPage } from './observe.js';
import { queuePage } from './queue.js';
import { isDayKey, MAX_RUNS_PER_DAY, type PlanJob, planDay, schedulePage } from './schedule.js';
import { firstPromptOf, readTranscript } from './transcript.js';

export interface HttpOptions {
  bind: string;
  port: number;
  /** When set, every request needs `Authorization: Bearer <token>`. */
  token?: string;
  scheduler: Scheduler;
  store: Store;
  /** Serves `/internal/*` for tara's MCP server (authenticated by the run token, not `token`). */
  bridge?: Bridge;
  projects: string[];
  log: Logger;
  now?: () => number;
  /** Who may connect, as CIDR ranges. Unset: anyone who can reach `bind`. */
  allowFrom?: string[];
  /**
   * Requests for paths tara-agent doesn't serve are passed through to this URL, e.g. the service that
   * owned the port before (so its callers keep working while they move).
   */
  fallback?: string;
  /** Approval items: the Approvals page and its API. */
  approvals?: Approvals;
  /**
   * TARA_ADMIN_TOKEN: the key a browser presents (as a cookie, set on /unlock) to decide approvals.
   * Unset = dashboard decisions are off (Slack buttons still work).
   */
  adminToken?: string;
  /** Tests only: accept decisions from this machine too (normally refused, since the agent runs here). */
  decisionsFromLocal?: boolean;
  /** Queue config per project (defaults to reading `.tara/queues.json`). */
  queueConfig?: (project: Project) => Record<string, QueueConfig>;
  /**
   * The run user (`claude.runAs`): Claude writes its transcripts readable by that user only, so they
   * are read as that user through sudo when tara-agent can't open them itself.
   */
  readAs?: string;
  /** Puts a message into a session's thread as if its owner had typed it (SessionManager.handle). */
  continueThread?: (msg: ChatMessage) => Promise<void>;
  /** The Code page: repos' uncommitted changes and files, read-only. */
  code?: {
    readers: RepoReader[];
    /** Starts a Slack conversation in the repo's `askIn` project; returns the thread's link. */
    ask?: (repo: CodeRepo, title: string, prompt: string) => Promise<{ url?: string }>;
  };
  /** What needs the owner (`GET /attention`). */
  attention?: () => Promise<Attention>;
  /**
   * Live Claude runs: a running session's steps (and Stop) on its page, links to a running job's
   * transcript, and the usage figure on the home page.
   */
  activity?: Pick<Activity, 'tasks' | 'usage' | 'stop'>;
  /** A second, HTTPS listener on the same address. The certificate is re-read when its file changes. */
  tls?: { port: number; cert: string; key: string };
  /** The Health page (`/health` in a browser) and `GET /health/checks`, `POST /health/check`. */
  health?: Pick<HealthMonitor, 'snapshot' | 'check' | 'history' | 'label'>;
  /** The Health page's Trends and Logs views, and `GET /metrics` (Prometheus text). */
  observe?: Pick<Observability, 'trends' | 'logs' | 'metrics'>;
  /** The shared Chromes (host `browsers`): the Browsers page shows them and what each project needs. */
  browsers?: HostConfig['browsers'];
  /** Enables the HTML pages (sessions, transcripts, jobs) for browsers. */
  dashboard?: {
    projects: Project[];
    timeZone: string;
    agentName: string;
    slackUrl?: () => string | undefined;
    /** This machine's host name (see DashboardContext.hostName). */
    hostName?: string;
    /** Host-level models for the home page's Models section. */
    models?: HostModels;
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const iso = (d?: Date) => d?.toISOString() ?? null;
/** Runs per job shown on the dashboard (recent-runs strip and history). */
const RECENT_RUNS = 10;
const DAY_MS = 86_400_000;
/** The Browsers page looks at this many days of transcripts. */
const BROWSER_DAYS = 30;
/** Jobs that start this often or more are left out of the home page's "Coming up" list. */
const FREQUENT_MS = 30 * 60_000;
/** Most start times `GET /jobs?upcoming=` returns per job. */
const MAX_UPCOMING = 60;

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, 'Body too large');
  }
  return body;
}

async function readJson(req: IncomingMessage, limit = 10_000): Promise<Record<string, unknown>> {
  const body = await readBody(req, limit);
  if (!body.trim()) return {};
  try {
    const json: unknown = JSON.parse(body);
    return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Body is not JSON');
  }
}

/**
 * Local control API for other tools on the same host (dashboards, boards, scripts):
 *   GET  /health
 *   GET  /jobs?project=<name>[&upcoming=<days>]   with `upcoming`, each job's start times over the next days
 *   POST /jobs/<project>/<id>/run      {"by": "who asked"}
 *   POST /jobs/<project>/<id>/pause    flips `enabled` off in the repo's .tara/jobs.json → {ok, enabled}
 *   POST /jobs/<project>/<id>/resume   flips it back on, effective at once
 *   POST /jobs/<project>/<id>/duration {"minutes": 20} sets `durationMinutes` in the jobs file
 *   GET  /jobs/<project>/<id>/runs?limit=15
 *   GET  /runs?limit=30                latest job runs of every project (no outputs)
 *   GET  /runs/<id>
 *   GET  /sessions?project=<name>&limit=30   latest sessions with their last run
 *   GET  /sessions/<id>/transcript     the conversation as JSON (prompts, replies, tool calls and results)
 *   POST /sessions/<id>/message        {text} continues that session's thread as its owner; needs the
 *                                      header `x-tara-admin: <TARA_ADMIN_TOKEN>` (for a person's own Claude
 *                                      fixing a run, never for runs)
 *   POST /reload                       re-read every .tara/jobs.json now
 *   GET  /schedule?day=YYYY-MM-DD&project=<name>   one day's planned runs, overlaps and free windows
 *   GET  /schedule/conflicts?days=7    overlapping and back-to-back jobs over the next days
 *   GET  /code                         each repo's branch, last commit and uncommitted changes
 *   GET  /code/<repo>                  one repo's changes; /diff?path=, /file?path=, /files?path= (a folder)
 *   GET  /code?q=, /code/<repo>?q=     search file names and text (every repo, or one)
 *   POST /code/<repo>/ask              {path, question} asks in Slack; needs the unlocked browser
 * and, for tara's own MCP server (header `x-tara-run: <run token>`):
 *   POST /internal/approval            {title, details, options?}
 *   POST /internal/file                {path, comment?}
 *   POST /internal/privileged          {action, args?, reason} | {command, reason} → {ran, ok, result} | {id}
 *   POST /internal/permission          {tool_name, input}  → {id}
 *   GET  /internal/permission/<id>?wait=45                 → {decision | null}
 *   GET  /internal/jobs, POST /internal/run-job {id}        (chat turns only)
 *   POST /internal/withdraw            {id, reason?}  closes a waiting card of the run's project
 */
/** Paths tara-agent serves itself; with a fallback, everything else is passed through. */
const OWN_PATH =
  /^\/(?:$|(?:health|metrics|reload|attention|jobs|runs|sessions|schedule|approvals|queue|items|unlock|code|internal|p|app)(?:\/|$))/;
const TOKEN_COOKIE = 'tara_token';
const ADMIN_COOKIE = 'tara_admin';
/** Finished items shown on the Done tab. */
const DONE_DAYS = 30;

const cookie = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Addresses of this machine: a request from one of them could be the agent itself. */
function localAddress(address: string | undefined): boolean {
  const a = (address ?? '').replace(/^::ffff:/, '');
  if (!a || a === '::1' || a.startsWith('127.')) return true;
  return Object.values(networkInterfaces()).some((list) =>
    list?.some((n) => n.address.replace(/^::ffff:/, '') === a),
  );
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Approval items carry drafts (emails, posts), so they may be bigger than other requests. */
const ITEM_BODY_LIMIT = 200_000;
const PERMISSION_BODY_LIMIT = 5_000_000;
/** Enough for a job application form: the note, every question and the resume. */
const MAX_FIELDS = 40;

const arr = (v: unknown) => (Array.isArray(v) ? v : []);

/** Checks a proposed item from the API or a run; returns the input or throws 400. */
export function itemInput(body: Record<string, unknown>): ProposeInput {
  const need = (v: unknown, name: string) => {
    const s = str(v);
    if (!s) throw new HttpError(400, `"${name}" is required`);
    return s;
  };
  const runAfter =
    typeof body.runAfter === 'number'
      ? body.runAfter
      : str(body.runAfter)
        ? Date.parse(body.runAfter as string)
        : undefined;
  if (Number.isNaN(runAfter)) throw new HttpError(400, '"runAfter" must be a time');
  if (body.priority !== undefined && body.priority !== null && !Number.isFinite(body.priority))
    throw new HttpError(400, '"priority" must be a number');
  return {
    kind: need(body.kind, 'kind').slice(0, 40),
    key: str(body.key)?.slice(0, 120),
    title: need(body.title, 'title'),
    body: str(body.body)?.slice(0, 8_000),
    queue: need(body.queue, 'queue'),
    window: str(body.window),
    runAfter,
    priority: typeof body.priority === 'number' ? body.priority : undefined,
    options: arr(body.options).filter((o): o is string => typeof o === 'string'),
    fields: arr(body.fields)
      .slice(0, MAX_FIELDS)
      .map((f: Record<string, unknown>) => ({
        key: need(f?.key, 'fields[].key'),
        label: str(f?.label) ?? String(f?.key),
        type: f?.type === 'text' || f?.type === 'list' ? f.type : 'textarea',
        value: Array.isArray(f?.value) ? (f.value as unknown[]).map(String) : String(f?.value ?? ''),
        maxLength: typeof f?.maxLength === 'number' ? f.maxLength : undefined,
        required: f?.required === true || undefined,
        readOnly: f?.readOnly === true || undefined,
      })),
    checks: arr(body.checks)
      .slice(0, 20)
      .map((c: Record<string, unknown>) => ({ text: String(c?.text ?? ''), blocking: c?.blocking === true })),
    media: arr(body.media)
      .slice(0, 20)
      .map((m: Record<string, unknown>) => {
        const url = need(m?.url, 'media[].url');
        const poster = str(m?.poster);
        if (!safeMediaUrl(url) || (poster && !safeMediaUrl(poster)))
          throw new HttpError(400, 'media[].url and poster must be http(s) URLs or paths starting with /');
        return {
          type: m?.type === 'video' || m?.type === 'file' ? (m.type as 'video' | 'file') : ('image' as const),
          url,
          caption: str(m?.caption),
          poster,
        };
      }),
  };
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;

/**
 * Why a request looks like it came from another website, else undefined. A page on any site can make
 * the browser POST to 127.0.0.1 (no token is needed by default), and a DNS-rebinding page can even
 * read the answers. So: a write whose Origin is another host is refused, and a server bound to
 * loopback only answers to loopback Host names. Scripts (curl, the MCP server) send no Origin.
 */
export function crossSite(req: IncomingMessage, bind: string): string | undefined {
  const host = req.headers.host ?? '';
  if (LOOPBACK_HOST.test(bind.includes(':') ? `[${bind}]` : bind) && !LOOPBACK_HOST.test(host))
    return `unexpected Host "${host.slice(0, 100)}"`;
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return undefined;
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  let from: string | undefined;
  try {
    from = new URL(origin).host;
  } catch {}
  return from === host ? undefined : `cross-site ${method} from ${origin.slice(0, 100)}`;
}

export async function startHttpServer(options: HttpOptions): Promise<Server> {
  const now = options.now ?? Date.now;
  const started = now();
  /**
   * How much of Claude's usage window is used: what the CLI reported last in this process, else the
   * latest run's figure from the last 5 hours (one window), so a restart doesn't blank it.
   */
  const usageNow = (at: number): HomeUsage | undefined => {
    const live = options.activity?.usage();
    if (live?.utilization !== undefined) {
      const resetsAt = live.resetsAt ? live.resetsAt * (live.resetsAt < 1e12 ? 1000 : 1) : undefined;
      if (!resetsAt || resetsAt > at) return { share: live.utilization, window: live.window, resetsAt };
    }
    const last = options.store
      .runsSince(at - 5 * 3_600_000)
      .filter((r) => r.rateLimitUtilization !== undefined)
      .at(-1);
    return last ? { share: last.rateLimitUtilization as number, asOf: last.endedAt } : undefined;
  };
  const timeZone = options.dashboard?.timeZone ?? 'UTC';
  const knownProject = (name: string | null) => {
    if (!name || !options.projects.includes(name))
      throw new HttpError(404, `Unknown project "${name ?? ''}"`);
    return name;
  };

  /** A session's transcript: from its project's folder, or (thread cleared) whichever project has it. */
  const transcript = (id: string, dir?: string) => {
    const dirs = dir ? [dir] : (options.dashboard?.projects ?? []).map((p) => p.dir);
    for (const d of dirs) {
      const entries = readTranscript(d, id, undefined, options.readAs);
      if (entries) return entries;
    }
    return undefined;
  };

  /** First messages of sessions, for the Sessions list: a session's first prompt never changes. */
  const previews = new Map<string, string>();
  const preview = (project: string, sessionId: string) => {
    const known = previews.get(sessionId);
    if (known !== undefined) return known;
    const dir = options.dashboard?.projects.find((p) => p.config.name === project)?.dir;
    const found = dir ? firstPromptOf(dir, sessionId, undefined, options.readAs) : undefined;
    if (found !== undefined) {
      if (previews.size >= 5000) previews.clear(); // transcripts are kept 14 days: far fewer sessions
      previews.set(sessionId, found);
    }
    return found;
  };

  /** The queues each job is the executor of, so the jobs page can tell queue jobs from on-demand ones. */
  const queueExecutors = (name: string): Map<string, string[]> => {
    const byJob = new Map<string, string[]>();
    const project = options.dashboard?.projects.find((x) => x.config.name === name);
    if (!project) return byJob;
    let configs: Record<string, QueueConfig>;
    try {
      configs = (options.queueConfig ?? loadQueues)(project);
    } catch {
      return byJob;
    }
    for (const [queue, q] of Object.entries(configs))
      if ('job' in q.executor) byJob.set(q.executor.job, [...(byJob.get(q.executor.job) ?? []), queue]);
    return byJob;
  };

  /**
   * A project's queue slots in [start, end) as planned runs of the queue's job: a queue with `slots`
   * runs its executor job at each one when something is approved (its own items or those of a queue
   * that `fills` it). Queues with windows, or run elsewhere, have no fixed times to draw.
   */
  const queueSlots = (name: string, start: number, end: number): PlanJob[] => {
    const project = options.dashboard?.projects.find((x) => x.config.name === name);
    if (!project) return [];
    let configs: Record<string, QueueConfig>;
    try {
      configs = (options.queueConfig ?? loadQueues)(project);
    } catch {
      return [];
    }
    const info = new Map(options.scheduler.list(name).map((j) => [j.id, j]));
    const approved = options.store.items({ project: name, statuses: ['approved'], limit: 1000 });
    return Object.entries(configs).flatMap(([queue, q]): PlanJob[] => {
      if (!q.slots || q.fills || !('job' in q.executor)) return [];
      const id = q.executor.job;
      const clock = new Cron(q.slots, { timezone: q.tz ?? timeZone, paused: true });
      const starts: number[] = [];
      for (
        let next = clock.nextRun(new Date(start - 1));
        next && next.getTime() < end;
        next = clock.nextRun(next)
      ) {
        starts.push(next.getTime());
        if (starts.length > MAX_RUNS_PER_DAY) break;
      }
      const waiting = approved.filter(
        (i) => i.queue === queue || configs[i.queue ?? '']?.fills === queue,
      ).length;
      return starts.length
        ? [
            {
              project: name,
              id,
              name: info.get(id)?.name ?? id,
              durationMinutes: info.get(id)?.durationMinutes,
              starts,
              queue,
              waiting,
            },
          ]
        : [];
    });
  };

  /** One calendar day of every (or one) project's planned runs, matched with the runs that happened. */
  const dayPlan = (day: string, project?: string) => {
    const start = midnight(day, timeZone);
    const end = midnight(addDays(day, 1), timeZone);
    const names = project ? [project] : options.projects;
    const jobs: PlanJob[] = names.flatMap((p) => {
      const info = new Map(options.scheduler.list(p).map((j) => [j.id, j]));
      return options.scheduler.plannedRuns(p, start, end, MAX_RUNS_PER_DAY).map(({ id, starts }) => ({
        project: p,
        id,
        name: info.get(id)?.name ?? id,
        durationMinutes: info.get(id)?.durationMinutes,
        starts,
      }));
    });
    return planDay(
      [...jobs, ...names.flatMap((p) => queueSlots(p, start, end))],
      options.store.runsSince(start - 3_600_000).filter((r) => r.kind === 'job'),
      start,
      end,
    );
  };

  /** The session a running job works in (from its live task's thread), for a link to its transcript. */
  const liveJobSession = (project: string, jobId: string) => {
    const task = options.activity
      ?.tasks()
      .find((t) => t.status === 'running' && t.kind === 'job' && t.project === project && t.jobId === jobId);
    return task?.thread
      ? options.store.getSession(threadKey(task.thread.channel, task.thread.ts))?.sessionId
      : undefined;
  };

  /** The task working in a session's thread now, else the latest finished one there (newest first). */
  const liveTask = (sessionId: string) => {
    const key = options.store.sessionsOverview({ sessionId, limit: 1 })[0]?.threadKey;
    if (!key) return undefined;
    return options.activity
      ?.tasks()
      .find((t) => t.thread && threadKey(t.thread.channel, t.thread.ts) === key);
  };

  const approvals = options.approvals;
  /** The owner of an item's project: who a dashboard decision is recorded as. */
  const owner = (id: string) => {
    const item = options.store.getItem(id);
    return options.dashboard?.projects.find((p) => p.config.name === item?.project)?.config.owner;
  };
  /**
   * Decisions need a person: the browser's approvals cookie, from another device. The agent runs on
   * this machine as another user, so it can neither read the key nor call from outside.
   */
  const human = (req: IncomingMessage): string => {
    if (!options.adminToken)
      throw new HttpError(403, 'Deciding on the dashboard is off: set TARA_ADMIN_TOKEN');
    if (!options.decisionsFromLocal && localAddress(req.socket.remoteAddress))
      throw new HttpError(403, 'Decisions are only taken from another device, not from this machine');
    const given = cookie(req, ADMIN_COOKIE);
    if (!given || !sameSecret(given, options.adminToken))
      throw new HttpError(403, 'This browser is not unlocked for decisions: open /unlock');
    return 'dashboard';
  };

  const route = async (req: IncomingMessage): Promise<unknown> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      const jobs = options.projects.flatMap((p) => options.scheduler.list(p));
      const counts = options.health?.snapshot()?.counts;
      return {
        ok: true,
        ...(counts && { checks: counts }),
        uptimeSeconds: Math.floor((now() - started) / 1000),
        projects: options.projects,
        jobs: {
          total: jobs.length,
          enabled: jobs.filter((j) => j.enabled).length,
          running: jobs.filter((j) => j.running).length,
        },
      };
    }
    if (method === 'GET' && url.pathname === '/health/checks' && options.health) {
      return options.health.snapshot() ?? (await options.health.check());
    }
    if (method === 'POST' && url.pathname === '/health/check' && options.health) {
      const { counts, checkedAt } = await options.health.check();
      return { counts, checkedAt };
    }
    if (method === 'GET' && url.pathname === '/attention' && options.attention) {
      return options.attention();
    }
    if (method === 'GET' && url.pathname === '/jobs') {
      const project = knownProject(url.searchParams.get('project'));
      // `upcoming=<days>` adds each job's start times over the next days (for planning views).
      const days = Math.min(31, Math.max(0, Number(url.searchParams.get('upcoming')) || 0));
      const upcoming = days
        ? new Map(
            options.scheduler
              .plannedRuns(project, now(), now() + days * 86_400_000, MAX_UPCOMING)
              .map(({ id, starts }) => [
                id,
                starts.slice(0, MAX_UPCOMING).map((t) => new Date(t).toISOString()),
              ]),
          )
        : undefined;
      return {
        jobs: options.scheduler.list(project).map((j) => ({
          ...j,
          nextRun: iso(j.nextRun),
          lastRunAt: iso(j.lastRunAt),
          ...(upcoming && { upcoming: upcoming.get(j.id) ?? [] }),
        })),
      };
    }
    if (method === 'POST' && url.pathname === '/reload') {
      options.scheduler.reloadAll();
      return { ok: true };
    }
    if (parts[0] === 'jobs' && parts.length === 4) {
      const [, projectName = '', id = '', action] = parts;
      const project = knownProject(projectName);
      if (method === 'POST' && action === 'run') {
        const body = await readJson(req);
        const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, 60) : 'api';
        const result = options.scheduler.trigger(project, id, by);
        if (result === 'unknown') throw new HttpError(404, `No job "${id}" in ${project}`);
        return { result };
      }
      if (method === 'POST' && (action === 'pause' || action === 'resume')) {
        const enabled = action === 'resume';
        if (options.scheduler.setEnabled(project, id, enabled) === 'unknown')
          throw new HttpError(404, `No job "${id}" in ${project}`);
        return { ok: true, enabled };
      }
      if (method === 'POST' && action === 'duration') {
        const minutes = Number((await readJson(req)).minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600)
          throw new HttpError(400, '"minutes" must be a whole number from 1 to 600');
        if (options.scheduler.setDuration(project, id, minutes) === 'unknown')
          throw new HttpError(404, `No job "${id}" in ${project}`);
        return { ok: true, minutes };
      }
      if (method === 'GET' && action === 'runs') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 15));
        return {
          runs: options.store.jobRuns(project, id, limit).map(({ output, scriptOutput, ...run }) => ({
            ...run,
            hasOutput: Boolean(output || scriptOutput),
          })),
        };
      }
    }
    if (method === 'GET' && parts[0] === 'runs' && parts.length === 1) {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      return {
        runs: options.store.recentJobRuns(limit).map(({ output, scriptOutput, ...run }) => ({
          ...run,
          hasOutput: Boolean(output || scriptOutput),
        })),
      };
    }
    if (parts[0] === 'sessions') {
      if (method === 'GET' && parts.length === 1) {
        const project = url.searchParams.get('project')
          ? knownProject(url.searchParams.get('project'))
          : undefined;
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        return { sessions: options.store.sessionsOverview({ project, limit }) };
      }
      const id = parts[1] as string;
      if (method === 'GET' && parts.length === 3 && parts[2] === 'transcript') {
        const entries = transcript(id);
        if (!entries) throw new HttpError(404, 'No transcript for this session on this host');
        return { sessionId: id, entries };
      }
      if (method === 'GET' && parts.length === 3 && parts[2] === 'live') {
        const task = liveTask(id);
        return { running: task?.status === 'running', task: task ?? null };
      }
      // The session page's Stop: ends the run as "stop" in its Slack thread would.
      if (method === 'POST' && parts.length === 3 && parts[2] === 'stop') {
        human(req);
        const task = liveTask(id);
        if (task?.status !== 'running' || !options.activity?.stop(task.id))
          throw new HttpError(409, 'Nothing is running in this session');
        return { ok: true };
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'message') {
        const given = req.headers['x-tara-admin'];
        if (!options.adminToken || typeof given !== 'string' || !sameSecret(given, options.adminToken))
          throw new HttpError(403, 'Needs the x-tara-admin header with TARA_ADMIN_TOKEN');
        if (!options.continueThread) throw new HttpError(404, 'Chat is not running');
        const body = await readJson(req);
        const text = str(body.text)?.trim();
        if (!text) throw new HttpError(400, '"text" is required');
        const session = options.store.sessionsOverview({ sessionId: id, limit: 1 })[0];
        const [channel, threadTs] = session?.threadKey.split(':') ?? [];
        if (!session || !channel || !threadTs) throw new HttpError(404, 'No thread for this session');
        const owner = options.dashboard?.projects.find((p) => p.config.name === session.project)?.config
          .owner;
        void options.continueThread({ channel, threadTs, ts: threadTs, user: owner ?? 'admin', text });
        return { ok: true, threadKey: session.threadKey };
      }
    }
    if (method === 'GET' && parts[0] === 'runs' && parts.length === 2) {
      const run = options.store.getRun(Number(parts[1]));
      if (!run) throw new HttpError(404, 'No such run');
      return { run };
    }
    if (method === 'GET' && parts[0] === 'queues' && parts.length === 1) {
      // A project's queues for its own pages (a content calendar): the next slot times and the kind
      // that went last (slot queues take turns between kinds).
      const name = knownProject(url.searchParams.get('project'));
      const project = options.dashboard?.projects.find((x) => x.config.name === name);
      if (!project) throw new HttpError(404, 'No such project');
      const upcoming = Math.min(30, Number(url.searchParams.get('upcoming')) || 10);
      const configs = (options.queueConfig ?? loadQueues)(project);
      return {
        queues: Object.entries(configs).map(([queue, q]) => ({
          name: queue,
          executor: 'job' in q.executor ? 'job' : 'url' in q.executor ? 'url' : 'external',
          slots: q.slots,
          alternate: q.alternate,
          fills: q.fills,
          windows: q.windows,
          nextSlots: q.slots
            ? new Cron(q.slots, { timezone: q.tz ?? timeZone, paused: true })
                .nextRuns(upcoming)
                .map((d) => d.getTime())
            : [],
          lastKind: options.store.lastQueueStart(name, queue)?.kind ?? null,
        })),
      };
    }
    if (parts[0] === 'items' && approvals) {
      if (method === 'GET' && parts.length === 1) {
        const project = url.searchParams.get('project')
          ? knownProject(url.searchParams.get('project'))
          : undefined;
        const statuses = (url.searchParams.get('status') ?? '')
          .split(',')
          .filter((x): x is ItemStatus => (ITEM_STATUSES as readonly string[]).includes(x));
        const since = Number(url.searchParams.get('since')) || undefined;
        return {
          items: options.store.items({
            project,
            kind: url.searchParams.get('kind') ?? undefined,
            statuses: statuses.length ? statuses : undefined,
            since,
            limit: Math.min(500, Number(url.searchParams.get('limit')) || 200),
          }),
        };
      }
      if (method === 'POST' && parts.length === 1) {
        // A project server proposing a draft (e.g. the next follow-up). Proposing is harmless: it still
        // needs a person to approve it, unless the host's `autoApprove` lets the project's own server
        // say no person is needed (approvals.ts askAutoApprove).
        const body = await readJson(req, ITEM_BODY_LIMIT);
        const project = approvals.project(knownProject(str(body.project) ?? null));
        const input = { ...itemInput(body), autoApprove: body.autoApprove === true };
        // `thread`: the TARA_THREAD of the run the server works for; the card goes in that run's thread.
        const thread = approvals.runThread(project, str(body.thread));
        return {
          item: await approvals.propose(project, input, {
            source: str(body.source),
            channel: thread?.channel,
            threadTs: thread?.threadTs,
          }),
        };
      }
      if (method === 'POST' && parts.length === 2 && parts[1] === 'ask') {
        // A project server asking a person outside any run (a login expired, a send bounced). It only
        // asks: whatever the person picks goes to the agent in the card's thread.
        const body = await readJson(req);
        const project = approvals.project(knownProject(str(body.project) ?? null));
        const title = str(body.title);
        if (!title) throw new HttpError(400, '"title" is required');
        return {
          item: await approvals.ask(
            project,
            {
              title,
              details: str(body.details) ?? '',
              options: arr(body.options).filter((o): o is string => typeof o === 'string'),
              kind: str(body.kind)?.slice(0, 40),
              key: str(body.key)?.slice(0, 120),
            },
            approvals.runThread(project, str(body.thread)),
          ),
        };
      }
      if (method === 'GET' && parts.length === 2) {
        const item = options.store.getItem(parts[1] as string);
        if (!item) throw new HttpError(404, 'No such item');
        return { item };
      }
      if (method === 'POST' && parts.length === 2 && parts[1] === 'bulk') {
        const by = human(req);
        const body = await readJson(req);
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((i): i is string => typeof i === 'string').slice(0, 200)
          : [];
        const option = str(body.option);
        if (!option) throw new HttpError(400, '"option" is required');
        const seen = body.seen && typeof body.seen === 'object' ? (body.seen as Record<string, unknown>) : {};
        const decided: string[] = [];
        const failed: Array<{ id: string; error: string }> = [];
        for (const id of ids) {
          try {
            await approvals.decide(id, {
              option,
              by: owner(id) ?? by,
              via: 'dashboard',
              seen: typeof seen[id] === 'number' ? seen[id] : undefined,
            });
            decided.push(id);
          } catch (err) {
            failed.push({ id, error: (err as Error).message });
          }
        }
        return { decided, failed };
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'decide') {
        const by = human(req);
        const id = parts[1] as string;
        const body = await readJson(req, ITEM_BODY_LIMIT);
        const fields =
          body.fields && typeof body.fields === 'object'
            ? (body.fields as Record<string, string | string[]>)
            : undefined;
        return {
          item: await approvals.decide(id, {
            option: str(body.option) ?? '',
            by: owner(id) ?? by,
            via: 'dashboard',
            fields,
            reply: str(body.reply),
            runNow: body.runNow === true,
            seen: typeof body.seen === 'number' ? body.seen : undefined,
          }),
        };
      }
      // A note about a waiting card without deciding it: to Jarvis in the card's Slack thread.
      if (method === 'POST' && parts.length === 3 && parts[2] === 'note') {
        const by = human(req);
        const id = parts[1] as string;
        const text = str((await readJson(req)).text)
          ?.trim()
          .slice(0, 4_000);
        if (!text) throw new HttpError(400, '"text" is required');
        await approvals.note(id, text, owner(id) ?? by);
        return { ok: true };
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'withdraw') {
        const body = await readJson(req);
        return { item: approvals.withdraw(parts[1] as string, str(body.reason)) };
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'report') {
        // A project server reporting an item it runs itself (an `external` queue). Not a decision: the
        // item was approved by a person already, and the project acts on its own records.
        const body = await readJson(req);
        const status = body.status;
        if (status !== 'done' && status !== 'failed' && status !== 'waiting')
          throw new HttpError(400, '"status" must be done, failed or waiting');
        return { item: approvals.report(parts[1] as string, status, str(body.result)) };
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
        const by = human(req);
        return { item: approvals.cancel(parts[1] as string, owner(parts[1] as string) ?? by) };
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'move') {
        human(req);
        const to = (await readJson(req)).to;
        if (
          !(typeof to === 'number' && Number.isInteger(to) && to >= 0) &&
          to !== 'up' &&
          to !== 'down' &&
          to !== 'top' &&
          to !== 'bottom'
        )
          throw new HttpError(400, '"to" must be up, down, top, bottom or a place (0 is first)');
        return { item: approvals.move(parts[1] as string, to) };
      }
    }
    if (method === 'GET' && parts[0] === 'schedule' && parts.length === 1) {
      const project = url.searchParams.get('project')
        ? knownProject(url.searchParams.get('project'))
        : undefined;
      const day = url.searchParams.get('day');
      return dayPlan(isDayKey(day) ? day : dayKey(now(), timeZone), project);
    }
    if (method === 'GET' && parts[0] === 'schedule' && parts[1] === 'conflicts' && parts.length === 2) {
      const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const today = dayKey(now(), timeZone);
      return {
        days: Array.from({ length: days }, (_, i) => {
          const day = addDays(today, i);
          const plan = dayPlan(day);
          const slot = ({ project, id, name, start, minutes }: (typeof plan.slots)[number]) => ({
            project,
            id,
            name,
            start: new Date(start).toISOString(),
            minutes,
          });
          return {
            day,
            runs: plan.slots.length,
            overlaps: plan.overlaps.map(({ a, b }) => ({ a: slot(a), b: slot(b) })),
            tight: plan.tight.map(({ a, b, gapMinutes }) => ({ a: slot(a), b: slot(b), gapMinutes })),
            free: plan.free.map((f) => ({
              start: new Date(f.start).toISOString(),
              end: new Date(f.end).toISOString(),
            })),
          };
        }),
      };
    }
    if (parts[0] === 'code' && options.code) {
      const query = url.searchParams.get('q');
      if (method === 'GET' && parts.length === 1 && query !== null)
        return { results: await searchAll(query) };
      if (method === 'GET' && parts.length === 1)
        return {
          repos: await Promise.all(
            options.code.readers.map(async (r) => ({
              name: r.repo.name,
              title: r.repo.title,
              ...(await r.status()),
            })),
          ),
        };
      const reader = codeReader(parts[1]);
      const file = url.searchParams.get('path') ?? '';
      if (method === 'GET' && parts.length === 2 && query !== null) return reader.search(query);
      if (method === 'GET' && parts.length === 2) return reader.status();
      if (method === 'GET' && parts[2] === 'diff' && parts.length === 3) return reader.diff(file);
      if (method === 'GET' && parts[2] === 'file' && parts.length === 3) return reader.read(file);
      if (method === 'GET' && parts[2] === 'files' && parts.length === 3) return reader.tree(file);
      if (method === 'POST' && parts[2] === 'ask' && parts.length === 3) {
        human(req);
        const ask = options.code.ask;
        if (!ask || !reader.repo.askIn) throw new HttpError(404, 'Asking is off for this repo');
        const body = await readJson(req);
        const question = str(body.question)?.slice(0, 4_000);
        if (!question) throw new HttpError(400, '"question" is required');
        const target = str(body.path) ?? '';
        const change = (await reader.status()).changes.find((c) => c.path === target);
        // The diff goes to Claude only: the thread shows the question.
        const diff = change ? (await reader.diff(target)).text.split('\n').slice(0, 400).join('\n') : '';
        const where = target ? `\`${target}\` in ${reader.repo.title}` : reader.repo.title;
        // About the whole repo: the list of what changed (Claude reads the diffs itself, read-only).
        if (!target) {
          const all = (await reader.status()).changes;
          const lines = all
            .slice(0, 300)
            .map((c) => `${c.state.padEnd(9)} ${c.path} (+${c.added} −${c.removed})`)
            .join('\n');
          return ask(
            reader.repo,
            `📄 ${reader.repo.title}: ${question}`,
            `${question}\n\nAbout the uncommitted changes in the repo ${reader.repo.dir} (${all.length} files${
              all.length > 300 ? ', the first 300 listed' : ''
            }; run \`git diff\` there to read them). Only read and answer: don't commit, stage or change files.\n\`\`\`\n${lines}\n\`\`\``,
          );
        }
        return ask(
          reader.repo,
          `📄 ${where}: ${question}`,
          `${question}\n\nAbout ${target ? `the file \`${path.join(reader.repo.dir, target)}\`` : `the repo ${reader.repo.dir}`}${
            change
              ? `, which has an uncommitted change (${change.state}). The diff against the last commit:\n\`\`\`diff\n${diff}\n\`\`\``
              : '.'
          }`,
        );
      }
    }
    throw new HttpError(404, 'Not found');
  };

  /** One search over every repo; a repo that fails says why instead of failing the rest. */
  const searchAll = async (query: string) => {
    if (query.trim().length < MIN_QUERY)
      throw new CodeError(400, `Search for at least ${MIN_QUERY} characters`);
    return Promise.all(
      (options.code?.readers ?? []).map((r) =>
        r.search(query).then(
          (result) => ({ repo: r.repo, result }),
          (err: Error) => ({ repo: r.repo, error: err.message.split('\n')[0] }),
        ),
      ),
    );
  };

  const codeReader = (name: string | undefined) => {
    const reader = options.code?.readers.find((r) => r.repo.name === name);
    if (!reader) throw new HttpError(404, `Unknown repo "${name ?? ''}"`);
    return reader;
  };

  const internal = async (req: IncomingMessage): Promise<unknown> => {
    const bridge = options.bridge;
    if (!bridge) throw new HttpError(404, 'MCP bridge is not enabled');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const token = req.headers['x-tara-run'] as string | undefined;
    const required = (v: unknown, name: string) => {
      if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${name}" is required`);
      return v;
    };
    if (req.method === 'POST' && parts[1] === 'approval' && parts.length === 2) {
      // Long details are split into several Slack messages, so they may be long here too.
      const body = await readJson(req, ITEM_BODY_LIMIT);
      const options = Array.isArray(body.options)
        ? body.options.filter((o) => typeof o === 'string')
        : undefined;
      return bridge.requestApproval(token, {
        title: required(body.title, 'title'),
        details: required(body.details, 'details'),
        options,
        kind: str(body.kind)?.slice(0, 40),
      });
    }
    if (req.method === 'POST' && parts[1] === 'privileged' && parts.length === 2) {
      const body = await readJson(req);
      const args =
        body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? Object.fromEntries(Object.entries(body.args).map(([k, v]) => [k, String(v)]))
          : undefined;
      return bridge.requestPrivileged(token, {
        action: str(body.action),
        args,
        command: str(body.command),
        reason: required(body.reason, 'reason'),
        title: str(body.title)?.slice(0, 150),
      });
    }
    if (req.method === 'POST' && parts[1] === 'file' && parts.length === 2) {
      const body = await readJson(req);
      const comment = typeof body.comment === 'string' ? body.comment : undefined;
      return bridge.sendFile(token, { path: required(body.path, 'path'), comment });
    }
    if (req.method === 'POST' && parts[1] === 'permission' && parts.length === 2) {
      // The input of a Write or Edit holds the whole file: a small cap would silently deny every large write.
      const body = await readJson(req, PERMISSION_BODY_LIMIT);
      const input =
        typeof body.input === 'object' && body.input !== null ? (body.input as Record<string, unknown>) : {};
      return bridge.askPermission(token, { tool_name: required(body.tool_name, 'tool_name'), input });
    }
    if (req.method === 'GET' && parts[1] === 'jobs' && parts.length === 2) {
      return { jobs: bridge.listJobs(token) };
    }
    if (req.method === 'POST' && parts[1] === 'run-job' && parts.length === 2) {
      const body = await readJson(req);
      return bridge.runJob(token, required(body.id, 'id'));
    }
    if (req.method === 'POST' && parts[1] === 'item' && parts.length === 2) {
      const body = await readJson(req, ITEM_BODY_LIMIT);
      // A run may ask too; the host `autoApprove` rule and the project's server still decide.
      return bridge.proposeItem(token, { ...itemInput(body), autoApprove: body.autoApprove === true });
    }
    if (req.method === 'GET' && parts[1] === 'items' && parts.length === 2) {
      return {
        items: bridge.listItems(token, {
          status: url.searchParams.get('status') ?? undefined,
          kind: url.searchParams.get('kind') ?? undefined,
        }),
      };
    }
    if (req.method === 'POST' && parts[1] === 'item-done' && parts.length === 2) {
      const body = await readJson(req);
      const status =
        body.status === 'done' || body.status === 'failed' || body.status === 'later'
          ? body.status
          : undefined;
      if (!status) throw new HttpError(400, '"status" must be done, failed or later');
      const retryAt =
        typeof body.retryAt === 'number'
          ? body.retryAt
          : typeof body.retryAt === 'string'
            ? Date.parse(body.retryAt)
            : undefined;
      return bridge.finishItem(token, {
        id: required(body.id, 'id'),
        status,
        result: typeof body.result === 'string' ? body.result : undefined,
        ...(retryAt !== undefined && Number.isFinite(retryAt) && { retryAt }),
      });
    }
    if (req.method === 'POST' && parts[1] === 'pr-start' && parts.length === 2) {
      const body = await readJson(req);
      return bridge.startPullRequest(token, { branch: required(body.branch, 'branch') });
    }
    if (req.method === 'POST' && parts[1] === 'ci-job' && parts.length === 2) {
      const body = await readJson(req);
      return bridge.readCiJob(token, { job: required(body.job, 'job') });
    }
    if (req.method === 'POST' && parts[1] === 'pr-open' && parts.length === 2) {
      const body = await readJson(req, 70_000);
      return bridge.openPullRequest(token, {
        branch: required(body.branch, 'branch'),
        title: required(body.title, 'title'),
        body: typeof body.body === 'string' ? body.body.slice(0, 60_000) : undefined,
      });
    }
    if (req.method === 'POST' && parts[1] === 'withdraw' && parts.length === 2) {
      const body = await readJson(req);
      return bridge.withdrawCard(token, { id: required(body.id, 'id'), reason: str(body.reason) });
    }
    if (req.method === 'GET' && parts[1] === 'permission' && parts.length === 3) {
      const waitMs = Math.min(55, Math.max(0, Number(url.searchParams.get('wait')) || 0)) * 1000;
      return { decision: (await bridge.waitPermission(token, parts[2] as string, waitMs)) ?? null };
    }
    throw new HttpError(404, 'Not found');
  };

  const allowed = options.allowFrom ? allowList(options.allowFrom) : () => true;

  /** The context every page needs, with the sidebar badge counts. */
  const pageContext = (): DashboardContext | undefined => {
    const dash = options.dashboard;
    if (!dash) return undefined;
    return {
      projects: dash.projects,
      timeZone: dash.timeZone,
      agentName: dash.agentName,
      slackUrl: dash.slackUrl?.(),
      hostName: dash.hostName,
      // Notices only tell: they aren't waiting for a decision.
      waiting: options.approvals
        ? options.store.items({ statuses: ['pending'], limit: ITEMS_LIMIT }).filter((i) => !isNotice(i))
            .length
        : undefined,
      failing: options.projects
        .flatMap((p) => options.scheduler.list(p))
        .filter((j) => jobState(j) === 'failing').length,
      code: Boolean(options.code),
      browsers: Boolean(options.browsers),
      unhealthy: options.health ? redChecks().length : undefined,
    };
  };

  /** Confirmed red Health checks. */
  const redChecks = () =>
    (options.health?.snapshot()?.checks ?? []).filter((c) => c.status === 'bad' && !c.unconfirmed);

  /** Browser pages; undefined when this request should get JSON instead. */
  const canDecide = (req: IncomingMessage) => {
    try {
      human(req);
      return true;
    } catch {
      return false;
    }
  };

  /** Repos whose uncommitted changes have waited a while (the Code page's readers, cached), for Home. */
  const staleRepos = async (at: number): Promise<StaleRepo[]> => {
    const readers = options.code?.readers ?? [];
    const statuses = await Promise.all(readers.map((r) => r.status().catch(() => undefined)));
    return readers.flatMap((r, i) => {
      const s = statuses[i];
      return s && staleWork(s, at) && s.head
        ? [{ name: r.repo.name, title: r.repo.title, files: s.changes.length, lastCommit: s.head.at }]
        : [];
    });
  };

  const page = (
    req: IncomingMessage,
    ctx: DashboardContext,
    extra: { staleRepos?: StaleRepo[] } = {},
  ): string | undefined => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const names = ctx.projects.map((p) => p.config.name);
    const jobNames = () =>
      new Map(names.flatMap((n) => options.scheduler.list(n).map((j) => [`${n}:${j.id}`, j.name] as const)));
    const projectParam = () => {
      const p = url.searchParams.get('project') ?? undefined;
      return p && names.includes(p) ? p : undefined;
    };
    // `/?project=…` and `/?kind=…` were the sessions list before it moved to /sessions.
    const oldSessionsLink =
      parts.length === 0 && (url.searchParams.has('project') || url.searchParams.has('kind'));
    if ((parts[0] === 'sessions' && parts.length === 1) || oldSessionsLink) {
      const project = url.searchParams.get('project') ?? undefined;
      const runningThreads = new Set(
        (options.activity?.tasks() ?? [])
          .filter((t) => t.status === 'running' && t.thread)
          .map((t) => threadKey(t.thread?.channel ?? '', t.thread?.ts ?? '')),
      );
      return sessionsPage(
        ctx,
        options.store.sessionsOverview({ project, limit: 200 }),
        jobNames(),
        { project, kind: url.searchParams.get('kind') ?? undefined },
        { preview, runningThreads, now: now() },
      );
    }
    const jobViews = (): JobView[] =>
      names.flatMap((project) => {
        const runBy = queueExecutors(project);
        return options.scheduler.list(project).map((job) => ({
          ...job,
          project,
          recent: options.store.jobRuns(project, job.id, RECENT_RUNS),
          queues: runBy.get(job.id),
        }));
      });
    if (parts[0] === 'health' && parts[1] === 'trends' && parts.length === 2 && options.observe) {
      const days = [7, 14, 30].includes(Number(url.searchParams.get('days')))
        ? Number(url.searchParams.get('days'))
        : 14;
      return trendsPage(ctx, options.observe.trends(days));
    }
    if (parts[0] === 'health' && parts.length === 1 && options.health) {
      const health = options.health;
      return healthPage(ctx, {
        snapshot: health.snapshot(),
        history: health.history(7),
        label: (key) => health.label(key),
        uptimeSeconds: Math.floor((now() - started) / 1000),
        now: now(),
      });
    }
    if (parts.length === 0) {
      const at = now();
      const runs = options.store.recentJobRuns(400);
      // Jobs every half hour or more often: one line under "Coming up" instead of filling it.
      const every = new Map<string, number>();
      for (const p of names)
        for (const { id, starts } of options.scheduler.plannedRuns(p, at, at + DAY_MS, 2)) {
          const gap = (starts[1] ?? Infinity) - (starts[0] ?? 0);
          if (gap <= FREQUENT_MS) every.set(`${p}:${id}`, gap);
        }
      const views = jobViews();
      return homePage(ctx, {
        models: modelUses(ctx.projects, views, options.dashboard?.models),
        effort: options.dashboard?.models?.effort,
        jobs: views.map((j) => ({
          ...j,
          everyMs: every.get(`${j.project}:${j.id}`),
          liveSessionId: j.running ? liveJobSession(j.project, j.id) : undefined,
        })),
        // Each job's latest run that did something, so a job that ran three times doesn't fill the list.
        latest: runs
          .filter((r) => r.status !== 'silent')
          .filter((r, i, all) => all.findIndex((x) => x.project === r.project && x.jobId === r.jobId) === i)
          .slice(0, 8),
        quietRuns: runs.filter((r) => r.status === 'silent' && r.startedAt >= at - DAY_MS).length,
        pending: options.approvals ? options.store.items({ statuses: ['pending'], limit: ITEMS_LIMIT }) : [],
        usage: usageNow(at),
        health: options.health
          ? (() => {
              const snap = options.health.snapshot();
              const sources = new Map((snap?.sources ?? []).map((x) => [x.id, x.title]));
              const where = (key: string) =>
                [...sources.entries()].find(([id]) => key.startsWith(`${id}:`))?.[1] ?? '';
              return {
                problems: redChecks()
                  .filter((c) => !c.key.startsWith('jobs:'))
                  .map((c) => ({ name: c.name, where: where(c.key) })),
                watch: (snap?.checks ?? []).filter((c) => c.status === 'warn').length,
              };
            })()
          : undefined,
        staleRepos: extra.staleRepos,
        uptimeSeconds: Math.floor((at - started) / 1000),
        now: at,
      });
    }
    if ((parts[0] === 'approvals' || parts[0] === 'queue') && parts.length === 1 && options.approvals) {
      const at = now();
      const project = projectParam();
      const configs = new Map<string, Record<string, QueueConfig>>();
      const queues = (name: string) => {
        if (!configs.has(name)) {
          const p = ctx.projects.find((x) => x.config.name === name);
          let q: Record<string, QueueConfig> = {};
          try {
            q = p ? (options.queueConfig ?? loadQueues)(p) : {};
          } catch {}
          configs.set(name, q);
        }
        return configs.get(name) ?? {};
      };
      if (parts[0] === 'queue')
        return queuePage(ctx, {
          project,
          approved: options.store.items({ project, statuses: ['approved'], limit: 1000 }),
          running: options.store.items({ project, statuses: ['running'], limit: 100 }),
          pending: options.store.items({ project, statuses: ['pending'], limit: 500 }),
          // What went out lately, for each queue's "last out".
          finished: options.store.items({
            project,
            statuses: ['done', 'failed'],
            since: at - 14 * DAY_MS,
            limit: ITEMS_LIMIT,
          }),
          queues,
          canDecide: canDecide(req),
          now: at,
        });
      const tab: ApprovalsTab = url.searchParams.get('tab') === 'done' ? 'done' : 'waiting';
      const STATUSES: Record<ApprovalsTab, ItemStatus[]> = {
        waiting: ['pending'],
        done: ['done', 'failed', 'rejected', 'expired', 'cancelled'],
      };
      const since = (t: ApprovalsTab) => (t === 'done' ? at - DONE_DAYS * 86_400_000 : undefined);
      const list = (t: ApprovalsTab) =>
        options.store.items({ project, statuses: STATUSES[t], since: since(t), limit: ITEMS_LIMIT });
      return approvalsPage(ctx, {
        tab,
        project,
        kind: url.searchParams.get('kind') ?? undefined,
        items: list(tab),
        counts: { waiting: list('waiting').filter((i) => !isNotice(i)).length, done: list('done').length },
        jobNames: jobNames(),
        queues,
        canDecide: canDecide(req),
        now: at,
      });
    }
    if (parts[0] === 'unlock' && parts.length === 1) return unlockPage(ctx);
    if (parts[0] === 'schedule' && parts.length === 1) {
      const at = now();
      const today = dayKey(at, timeZone);
      const day = url.searchParams.get('day');
      const project = projectParam();
      const chosen = isDayKey(day) ? day : today;
      // Running jobs, each with the session to watch it in.
      const running = new Map<string, string | undefined>();
      for (const p of names)
        for (const j of options.scheduler.list(p))
          if (j.running) running.set(`${p}:${j.id}`, liveJobSession(p, j.id));
      return schedulePage(ctx, dayPlan(chosen, project), {
        day: chosen,
        today,
        project,
        now: at,
        running,
        projectsWithJobs: names.filter((p) => options.scheduler.list(p).length > 0),
      });
    }
    if (parts[0] === 'sessions' && parts.length === 2) {
      const id = parts[1] as string;
      const session = options.store.sessionsOverview({ sessionId: id, limit: 1 })[0];
      // Its latest run, even when the session's thread was cleared (a silent job run).
      const run = options.store.latestSessionRun(id) ?? session?.lastRun;
      const project = session?.project ?? run?.project;
      const dir = ctx.projects.find((p) => p.config.name === project)?.dir;
      // Sessions whose thread was cleared are still on disk: look in every project.
      const entries = transcript(id, dir);
      const jobName = run?.jobId ? jobNames().get(`${run.project}:${run.jobId}`) : undefined;
      const running = liveTask(id)?.status === 'running';
      return sessionPage(ctx, session, id, entries, {
        jobName,
        run,
        running,
        canStop: running && canDecide(req),
      });
    }
    if (parts[0] === 'jobs' && parts.length === 1) {
      const at = now();
      const weeks = jobWeeks(options.store.runsSince(at - 7 * DAY_MS));
      return jobsPage(
        ctx,
        jobViews().map((j) => ({ ...j, week: weeks.get(`${j.project}:${j.id}`) })),
        at,
        url.searchParams.get('view') === 'on-demand' ? 'ondemand' : 'list',
      );
    }
    if (parts[0] === 'runs' && parts.length === 2) {
      const run = options.store.getRun(Number(parts[1]));
      if (!run) return errorPage(ctx, 404);
      const job = run.jobId ? options.scheduler.list(run.project).find((j) => j.id === run.jobId) : undefined;
      return runPage(ctx, run, job);
    }
    return undefined;
  };

  /** The Browsers page (reads transcripts and asks each Chrome, so it is async); undefined for other paths. */
  const sites = new SiteScanner({ readAs: options.readAs, days: BROWSER_DAYS, now });
  const browsersPageFor = async (
    req: IncomingMessage,
    ctx: DashboardContext,
  ): Promise<string | undefined> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.replace(/\/$/, '') !== '/browsers' || !options.browsers) return undefined;
    const at = now();
    const scan = sites.scan(ctx.projects.map((p) => p.dir));
    // The first scan reads every recent transcript: show what is read so far rather than wait long.
    await Promise.race([scan, new Promise((r) => setTimeout(r, 4_000).unref())]);
    const jobOf = options.store.sessionJobs(at - BROWSER_DAYS * DAY_MS);
    const jobNames = new Map<string, string>();
    for (const p of options.projects)
      for (const j of options.scheduler.list(p)) jobNames.set(`${p}:${j.id}`, j.name);
    return browsersPage(ctx, {
      browsers: await Promise.all(options.browsers.map(probeBrowser)),
      needs: projectNeeds(
        ctx.projects,
        (p) => sites.sessions(p.dir),
        (sid) => jobOf.get(sid),
        (p) => options.scheduler.list(p),
        undefined,
        options.browsers,
      ),
      jobNames,
      scanning: sites.scanning,
      days: BROWSER_DAYS,
      now: at,
    });
  };

  /** The Code pages (they read git, so they are async); undefined for other paths. */
  const codePage = async (req: IncomingMessage, ctx: DashboardContext): Promise<string | undefined> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'code' || !options.code) return undefined;
    const at = now();
    const query = url.searchParams.get('q')?.trim();
    if (parts.length === 1 && query) return codeSearchPage(ctx, query, await searchAll(query));
    if (parts.length === 1)
      return codeHomePage(
        ctx,
        await Promise.all(
          options.code.readers.map(async (r) => ({ repo: r.repo, status: await r.status() })),
        ),
        at,
      );
    const reader = codeReader(parts[1]);
    const file = url.searchParams.get('path') ?? '';
    if (parts.length === 2 && query)
      return codeSearchPage(
        ctx,
        query,
        [{ repo: reader.repo, result: await reader.search(query) }],
        reader.repo,
      );
    if (parts.length === 2) return codeRepoPage(ctx, reader.repo, await reader.status(), at, canDecide(req));
    const changes = parts.length === 3 ? (await reader.status()).changes : [];
    if (parts[2] === 'diff') {
      const diff = await reader.diff(file);
      const change = changes.find((c) => c.path === file);
      return change && codeDiffPage(ctx, reader.repo, change, diff, canDecide(req));
    }
    if (parts[2] === 'file') {
      const view = await reader.read(file);
      return codeFilePage(
        ctx,
        reader.repo,
        file,
        view,
        changes.find((c) => c.path === file),
        canDecide(req),
      );
    }
    if (parts[2] === 'files') return codeTreePage(ctx, reader.repo, file, await reader.tree(file), changes);
    return undefined;
  };

  const fallback = options.fallback ? new URL(options.fallback) : undefined;
  /**
   * Streams a request to another service (the fallback, or a project's app) and its answer back. `path`
   * is resolved against `base`'s origin only: a path like `//evil.com/x` or an absolute URL would
   * otherwise point the proxy at another host, serving its pages on the dashboard's origin.
   */
  const passThrough = (
    req: IncomingMessage,
    res: ServerResponse,
    base: URL,
    path: string,
    extraHeaders: Record<string, string> = {},
  ) => {
    let target: URL | undefined;
    try {
      if (path.startsWith('/')) target = new URL(base.origin + path);
    } catch {}
    if (!target || target.origin !== base.origin) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad path');
      return;
    }
    // tara-agent's own keys never leave it: its bearer token, admin and run headers, and its cookies.
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers['x-tara-admin'];
    delete headers['x-tara-run'];
    if (options.token && headers.authorization === `Bearer ${options.token}`) delete headers.authorization;
    const cookies = (req.headers.cookie ?? '')
      .split(/;\s*/)
      .filter((c) => c && !c.startsWith(`${TOKEN_COOKIE}=`) && !c.startsWith(`${ADMIN_COOKIE}=`))
      .join('; ');
    if (cookies) headers.cookie = cookies;
    else delete headers.cookie;
    const upstream = httpRequest(
      target,
      {
        method: req.method,
        headers: {
          ...headers,
          host: target.host,
          'x-forwarded-for': req.socket.remoteAddress ?? '',
          'x-forwarded-host': req.headers.host ?? '',
          ...extraHeaders,
        },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      options.log.warn(`proxy ${req.method} ${req.url} → ${target.origin}: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`${target.origin} is unreachable: ${err.message}`);
    });
    req.pipe(upstream);
  };

  /** Bearer header, or (for browsers) the cookie set by opening any page once with `?token=…`. */
  const authorized = (req: IncomingMessage) => {
    if (!options.token) return true;
    if (req.headers.authorization === `Bearer ${options.token}`) return true;
    const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${TOKEN_COOKIE}=`));
    return cookie?.slice(TOKEN_COOKIE.length + 1) === options.token;
  };

  const sendHtml = (res: ServerResponse, status: number, html: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!allowed(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden: not on the allowed networks');
      return;
    }
    const refused = crossSite(req, options.bind);
    if (refused) {
      options.log.warn(`refused ${req.method} ${req.url}: ${refused}`);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`Forbidden: ${refused}`);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (fallback && !OWN_PATH.test(url.pathname)) {
      passThrough(req, res, fallback, req.url ?? '/');
      return;
    }
    const internalPath = url.pathname.startsWith('/internal/');
    if (options.token && !internalPath && url.searchParams.get('token') === options.token) {
      url.searchParams.delete('token');
      res.writeHead(303, {
        location: url.pathname + url.search,
        'set-cookie': `${TOKEN_COOKIE}=${options.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
      res.end();
      return;
    }
    // A project's app, shown in a tab: `/app/<name>/<rest>` is proxied to `<dashboardUrl>/<rest>`, and
    // `/p/<name>/<rest>` is the dashboard page that frames it.
    const tab = /^\/(app|p)\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
    const tabProject = tab && tabbed(options.dashboard?.projects ?? []).find((p) => p.config.name === tab[2]);
    if (tab && tabProject) {
      const name = tabProject.config.name;
      const rest = tab[3] ?? '';
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Open the dashboard once with ?token=<TARA_HTTP_TOKEN> added to the address.');
        return;
      }
      if (tab[1] === 'app') {
        // The app gets its own cookies, never tara-agent's keys (passThrough strips them).
        passThrough(req, res, new URL(tabProject.config.dashboardUrl as string), (rest || '/') + url.search, {
          'x-tara-prefix': `/app/${name}`,
        });
        return;
      }
      if (!rest || rest === '/') {
        const first = tabProject.config.tabs?.[0]?.path ?? '/';
        res.writeHead(302, { location: `/p/${name}${first}` });
        res.end();
        return;
      }
      const ctxTab = pageContext();
      if (req.method === 'GET' && ctxTab)
        return sendHtml(res, 200, tabPage(ctxTab, tabProject, rest + url.search));
    }
    if (req.method === 'POST' && url.pathname === '/unlock' && options.dashboard && authorized(req)) {
      const ctxUnlock = pageContext() as DashboardContext;
      const form = new URLSearchParams(await readBody(req, 2_000).catch(() => ''));
      const given = form.get('token') ?? '';
      if (!options.adminToken)
        return sendHtml(
          res,
          403,
          unlockPage(ctxUnlock, 'Deciding on the dashboard is off: TARA_ADMIN_TOKEN is not set.'),
        );
      if (!options.decisionsFromLocal && localAddress(req.socket.remoteAddress))
        return sendHtml(
          res,
          403,
          unlockPage(ctxUnlock, 'Unlock from your own phone or computer, not from this machine.'),
        );
      if (!given || !sameSecret(given, options.adminToken)) {
        options.log.warn(`unlock with a wrong key from ${req.socket.remoteAddress}`);
        return sendHtml(res, 403, unlockPage(ctxUnlock, 'That key is not right.'));
      }
      res.writeHead(303, {
        location: '/approvals',
        'set-cookie': `${ADMIN_COOKIE}=${given}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
      res.end();
      return;
    }
    // Approved items moved from the Approvals page's Scheduled tab to the Queue page.
    if (
      req.method === 'GET' &&
      url.pathname === '/approvals' &&
      url.searchParams.get('tab') === 'scheduled'
    ) {
      const project = url.searchParams.get('project');
      res.writeHead(301, { location: `/queue${project ? `?project=${encodeURIComponent(project)}` : ''}` });
      res.end();
      return;
    }
    const ctx = pageContext();
    const wantsHtml =
      Boolean(ctx) && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml && ctx && !authorized(req) && !internalPath)
      return sendHtml(
        res,
        401,
        '<!doctype html><meta charset="utf-8"><title>Sign in</title><p style="font:16px sans-serif;padding:24px">Open this page once with <code>?token=&lt;TARA_HTTP_TOKEN&gt;</code> added to the address.</p>',
      );
    if (wantsHtml && ctx) {
      try {
        const home = new URL(req.url ?? '/', 'http://localhost').pathname === '/';
        const logsPath =
          new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/$/, '') === '/health/logs';
        const hours = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('hours'));
        const html =
          (logsPath && options.observe
            ? logsPage(ctx, await options.observe.logs([1, 24, 168].includes(hours) ? hours : 24))
            : undefined) ??
          (await codePage(req, ctx)) ??
          (await browsersPageFor(req, ctx)) ??
          page(req, ctx, home ? { staleRepos: await staleRepos(now()) } : {});
        if (html) return sendHtml(res, 200, html);
      } catch (err) {
        if (err instanceof CodeError || err instanceof HttpError)
          return sendHtml(res, err.status, errorPage(ctx, 404, err.status === 404 ? undefined : err.message));
        options.log.error(`http page ${req.url}: ${(err as Error).stack ?? err}`);
        return sendHtml(res, 500, errorPage(ctx, 500));
      }
    }
    if (req.method === 'GET' && url.pathname === '/metrics' && options.observe) {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Missing or wrong bearer token');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(options.observe.metrics());
      return;
    }
    let status = 200;
    let payload: unknown;
    try {
      if (internalPath) {
        payload = await internal(req);
      } else {
        if (!authorized(req)) throw new HttpError(401, 'Missing or wrong bearer token');
        payload = await route(req);
      }
    } catch (err) {
      status =
        err instanceof HttpError ||
        err instanceof BridgeError ||
        err instanceof ApprovalError ||
        err instanceof CodeError
          ? err.status
          : 500;
      payload = { error: (err as Error).message };
      if (status === 500) options.log.error(`http ${req.method} ${req.url}: ${(err as Error).stack ?? err}`);
    }
    if (wantsHtml && ctx && status === 404) return sendHtml(res, 404, errorPage(ctx, 404));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const listen = <S extends Server | HttpsServer>(server: S, port: number, label: string) =>
    new Promise<S>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, options.bind, () => {
        options.log.info(`${label} on ${label === 'HTTPS' ? 'https' : 'http'}://${options.bind}:${port}`);
        resolve(server);
      });
    });

  const server = await listen(
    createServer((req, res) => void handle(req, res)),
    options.port,
    'HTTP API',
  );
  const tls = options.tls;
  if (tls) {
    const read = () => ({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) });
    let secure: HttpsServer;
    try {
      secure = await listen(
        createHttpsServer(read(), (req, res) => void handle(req, res)),
        tls.port,
        'HTTPS',
      );
    } catch (err) {
      server.close();
      throw err;
    }
    // Certificates are renewed in place (`tailscale cert` every month or two): pick up the new one.
    watchFile(tls.cert, { interval: 60_000 }, () => {
      try {
        secure.setSecureContext(read());
        options.log.info('HTTPS: loaded the renewed certificate');
      } catch (err) {
        options.log.warn(`HTTPS: could not load the certificate: ${(err as Error).message}`);
      }
    });
    server.on('close', () => {
      unwatchFile(tls.cert);
      secure.close();
    });
  }
  return server;
}
