import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { networkInterfaces } from 'node:os';
import { Cron } from 'croner';
import { ApprovalError, type Approvals, type ProposeInput } from '../approvals/approvals.js';
import { type Bridge, BridgeError } from '../bridge/bridge.js';
import { loadQueues } from '../config/load.js';
import type { Project, QueueConfig } from '../config/schema.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { Logger } from '../sessions/manager.js';
import {
  ITEM_STATUSES,
  type ItemStatus,
  type Store,
  TASK_LEVELS,
  type TaskInput,
  type TaskLevel,
} from '../store/store.js';
import { addDays, dayKey, midnight } from '../util/time.js';
import { allowList } from './access.js';
import { type ApprovalsTab, approvalsPage, unlockPage } from './approvals.js';
import {
  type DashboardContext,
  errorPage,
  homePage,
  type JobView,
  jobState,
  jobsPage,
  runPage,
  sessionPage,
  sessionsPage,
} from './dashboard.js';
import { inboxPage } from './inbox.js';
import { isDayKey, MAX_RUNS_PER_DAY, type PlanJob, planDay, schedulePage } from './schedule.js';
import { readTranscript } from './transcript.js';

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
  /** Enables the HTML pages (sessions, transcripts, jobs) for browsers. */
  dashboard?: {
    projects: Project[];
    timeZone: string;
    agentName: string;
    slackUrl?: () => string | undefined;
    /** This machine's host name (see DashboardContext.hostName). */
    hostName?: string;
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
 *   GET  /runs/<id>
 *   POST /reload                       re-read every .tara/jobs.json now
 *   GET  /inbox?project=<name>&done=<hours>   open tasks (or the ones done in the last <hours>)
 *   POST /inbox                        {project, title, level, key?, details?, source?, link?, dueAt?} → {task}
 *   POST /inbox/close                  {project, key} or {project, suffix} → {tasks}
 *   POST /inbox/<id>/done | /reopen    → {task}
 *   GET  /schedule?day=YYYY-MM-DD&project=<name>   one day's planned runs, overlaps and free windows
 *   GET  /schedule/conflicts?days=7    overlapping and back-to-back jobs over the next days
 * and, for tara's own MCP server (header `x-tara-run: <run token>`):
 *   POST /internal/approval            {title, details, options?}
 *   POST /internal/file                {path, comment?}
 *   POST /internal/permission          {tool_name, input}  → {id}
 *   GET  /internal/permission/<id>?wait=45                 → {decision | null}
 *   GET  /internal/jobs, POST /internal/run-job {id}        (chat turns only)
 *   POST /internal/task {title, level, …}, GET /internal/tasks, POST /internal/task-done {key | id}
 *                                      (the run's own project only)
 */
/** Paths tara-agent serves itself; with a fallback, everything else is passed through. */
const OWN_PATH =
  /^\/(?:$|(?:health|reload|jobs|runs|sessions|inbox|schedule|approvals|items|unlock|internal)(?:\/|$))/;
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
  return {
    kind: need(body.kind, 'kind').slice(0, 40),
    key: str(body.key)?.slice(0, 120),
    title: need(body.title, 'title'),
    body: str(body.body)?.slice(0, 8_000),
    queue: need(body.queue, 'queue'),
    window: str(body.window),
    runAfter,
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
      .map((m: Record<string, unknown>) => ({
        type: m?.type === 'video' || m?.type === 'file' ? (m.type as 'video' | 'file') : ('image' as const),
        url: need(m?.url, 'media[].url'),
        caption: str(m?.caption),
        poster: str(m?.poster),
      })),
  };
}

/** Checks a task from the API or a run; returns the input or throws 400. */
export function taskInput(body: Record<string, unknown>, project: string): TaskInput {
  const title = str(body.title);
  if (!title) throw new HttpError(400, '"title" is required');
  const level = body.level as TaskLevel;
  if (!TASK_LEVELS.includes(level))
    throw new HttpError(400, `"level" must be one of ${TASK_LEVELS.join(', ')}`);
  const dueAt = str(body.dueAt) ? Date.parse(body.dueAt as string) : undefined;
  if (Number.isNaN(dueAt)) throw new HttpError(400, '"dueAt" must be an ISO date');
  for (const field of ['key', 'details', 'source', 'link'])
    if (body[field] !== undefined && typeof body[field] !== 'string')
      throw new HttpError(400, `"${field}" must be a string`);
  return {
    project,
    title: title.slice(0, 200),
    level,
    key: str(body.key),
    details: str(body.details)?.slice(0, 4_000),
    source: str(body.source)?.slice(0, 80),
    link: str(body.link),
    dueAt,
  };
}

export function startHttpServer(options: HttpOptions): Promise<Server> {
  const now = options.now ?? Date.now;
  const started = now();
  const timeZone = options.dashboard?.timeZone ?? 'UTC';
  const knownProject = (name: string | null) => {
    if (!name || !options.projects.includes(name))
      throw new HttpError(404, `Unknown project "${name ?? ''}"`);
    return name;
  };

  /** One calendar day of every (or one) project's planned runs, matched with the runs that happened. */
  const dayPlan = (day: string, project?: string) => {
    const start = midnight(day, timeZone);
    const end = midnight(addDays(day, 1), timeZone);
    const jobs: PlanJob[] = (project ? [project] : options.projects).flatMap((p) => {
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
      jobs,
      options.store.runsSince(start - 3_600_000).filter((r) => r.kind === 'job'),
      start,
      end,
    );
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
      return {
        ok: true,
        uptimeSeconds: Math.floor((now() - started) / 1000),
        projects: options.projects,
        jobs: {
          total: jobs.length,
          enabled: jobs.filter((j) => j.enabled).length,
          running: jobs.filter((j) => j.running).length,
        },
      };
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
        // needs a person to approve it.
        const body = await readJson(req, ITEM_BODY_LIMIT);
        const project = approvals.project(knownProject(str(body.project) ?? null));
        return { item: await approvals.propose(project, itemInput(body), { source: str(body.source) }) };
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
        const decided: string[] = [];
        const failed: Array<{ id: string; error: string }> = [];
        for (const id of ids) {
          try {
            await approvals.decide(id, { option, by: owner(id) ?? by, via: 'dashboard' });
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
          }),
        };
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
    }
    if (parts[0] === 'inbox') {
      if (method === 'GET' && parts.length === 1) {
        const project = url.searchParams.get('project')
          ? knownProject(url.searchParams.get('project'))
          : undefined;
        const hours = Number(url.searchParams.get('done'));
        return {
          tasks: options.store.tasks({
            project,
            doneSince: hours > 0 ? now() - hours * 3_600_000 : undefined,
          }),
        };
      }
      if (method === 'POST' && parts.length === 1) {
        const body = await readJson(req);
        return { task: options.store.addTask(taskInput(body, knownProject(str(body.project) ?? null))) };
      }
      if (method === 'POST' && parts[1] === 'close' && parts.length === 2) {
        const body = await readJson(req);
        const project = knownProject(str(body.project) ?? null);
        if (!str(body.key) && !str(body.suffix)) throw new HttpError(400, '"key" or "suffix" is required');
        return { tasks: options.store.closeTasks(project, { key: str(body.key), suffix: str(body.suffix) }) };
      }
      if (method === 'POST' && parts.length === 3 && (parts[2] === 'done' || parts[2] === 'reopen')) {
        const task = options.store.setTaskDone(parts[1] as string, parts[2] === 'done');
        if (!task) throw new HttpError(404, 'No such task');
        return { task };
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
    throw new HttpError(404, 'Not found');
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
      const body = await readJson(req);
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
    if (req.method === 'POST' && parts[1] === 'file' && parts.length === 2) {
      const body = await readJson(req);
      const comment = typeof body.comment === 'string' ? body.comment : undefined;
      return bridge.sendFile(token, { path: required(body.path, 'path'), comment });
    }
    if (req.method === 'POST' && parts[1] === 'permission' && parts.length === 2) {
      const body = await readJson(req);
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
      return bridge.proposeItem(token, itemInput(body));
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
      const status = body.status === 'done' || body.status === 'failed' ? body.status : undefined;
      if (!status) throw new HttpError(400, '"status" must be done or failed');
      return bridge.finishItem(token, {
        id: required(body.id, 'id'),
        status,
        result: typeof body.result === 'string' ? body.result : undefined,
      });
    }
    if (req.method === 'POST' && parts[1] === 'task' && parts.length === 2) {
      const body = await readJson(req);
      const project = bridge.run(token).project.config.name;
      return { task: options.store.addTask(taskInput(body, project)) };
    }
    if (req.method === 'GET' && parts[1] === 'tasks' && parts.length === 2) {
      return { tasks: options.store.tasks({ project: bridge.run(token).project.config.name }) };
    }
    if (req.method === 'POST' && parts[1] === 'task-done' && parts.length === 2) {
      const body = await readJson(req);
      const project = bridge.run(token).project.config.name;
      const key = typeof body.key === 'string' ? body.key : undefined;
      const id = typeof body.id === 'string' ? body.id : undefined;
      if (!key && !id) throw new HttpError(400, '"key" or "id" is required');
      // A run only closes its own project's tasks.
      const task = id ? options.store.getTask(id) : undefined;
      if (id && task?.project !== project) throw new HttpError(404, 'No such task in this project');
      return {
        tasks: id ? [options.store.setTaskDone(id, true)] : options.store.closeTasks(project, { key }),
      };
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
      urgent: options.store.tasks().filter((t) => t.level === 'urgent').length,
      waiting: options.approvals
        ? options.store.items({ statuses: ['pending'], limit: 500 }).length
        : undefined,
      failing: options.projects
        .flatMap((p) => options.scheduler.list(p))
        .filter((j) => jobState(j) === 'failing').length,
    };
  };

  /** Browser pages; undefined when this request should get JSON instead. */
  const canDecide = (req: IncomingMessage) => {
    try {
      human(req);
      return true;
    } catch {
      return false;
    }
  };

  const page = (req: IncomingMessage, ctx: DashboardContext): string | undefined => {
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
      return sessionsPage(ctx, options.store.sessionsOverview({ project, limit: 200 }), jobNames(), {
        project,
        kind: url.searchParams.get('kind') ?? undefined,
      });
    }
    const jobViews = (): JobView[] =>
      names.flatMap((project) =>
        options.scheduler.list(project).map((job) => ({
          ...job,
          project,
          recent: options.store.jobRuns(project, job.id, RECENT_RUNS),
        })),
      );
    if (parts.length === 0) {
      const at = now();
      return homePage(ctx, {
        jobs: jobViews(),
        urgent: options.store.tasks().filter((t) => t.level === 'urgent'),
        // Each job's latest run only, so a job that ran three times doesn't fill the list.
        latest: options.store
          .recentJobRuns(60)
          .filter((r, i, all) => all.findIndex((x) => x.project === r.project && x.jobId === r.jobId) === i)
          .slice(0, 8),
        uptimeSeconds: Math.floor((at - started) / 1000),
        now: at,
      });
    }
    if (parts[0] === 'approvals' && parts.length === 1 && options.approvals) {
      const at = now();
      const project = projectParam();
      const tabParam = url.searchParams.get('tab');
      const tab: ApprovalsTab = tabParam === 'scheduled' || tabParam === 'done' ? tabParam : 'waiting';
      const STATUSES: Record<ApprovalsTab, ItemStatus[]> = {
        waiting: ['pending'],
        scheduled: ['approved', 'running'],
        done: ['done', 'failed', 'rejected', 'expired', 'cancelled'],
      };
      const since = (t: ApprovalsTab) => (t === 'done' ? at - DONE_DAYS * 86_400_000 : undefined);
      const list = (t: ApprovalsTab) =>
        options.store.items({ project, statuses: STATUSES[t], since: since(t), limit: 500 });
      const items = list(tab);
      const configs = new Map<string, Record<string, QueueConfig>>();
      return approvalsPage(ctx, {
        tab,
        project,
        kind: url.searchParams.get('kind') ?? undefined,
        items:
          tab === 'scheduled' ? [...items].sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0)) : items,
        counts: {
          waiting: list('waiting').length,
          scheduled: list('scheduled').length,
          done: list('done').length,
        },
        queues: (name) => {
          if (!configs.has(name)) {
            const p = ctx.projects.find((x) => x.config.name === name);
            let q: Record<string, QueueConfig> = {};
            try {
              q = p ? (options.queueConfig ?? loadQueues)(p) : {};
            } catch {}
            configs.set(name, q);
          }
          return configs.get(name) ?? {};
        },
        canDecide: canDecide(req),
        now: at,
      });
    }
    if (parts[0] === 'unlock' && parts.length === 1) return unlockPage(ctx);
    if (parts[0] === 'inbox' && parts.length === 1) {
      const at = now();
      return inboxPage(ctx, options.store.tasks(), options.store.tasks({ doneSince: at - 86_400_000 }), {
        project: projectParam(),
        now: at,
      });
    }
    if (parts[0] === 'schedule' && parts.length === 1) {
      const at = now();
      const today = dayKey(at, timeZone);
      const day = url.searchParams.get('day');
      const project = projectParam();
      const chosen = isDayKey(day) ? day : today;
      return schedulePage(ctx, dayPlan(chosen, project), { day: chosen, today, project, now: at });
    }
    if (parts[0] === 'sessions' && parts.length === 2) {
      const id = parts[1] as string;
      const session = options.store.sessionsOverview({ sessionId: id, limit: 1 })[0];
      const dir = ctx.projects.find((p) => p.config.name === session?.project)?.dir;
      // Sessions whose thread was cleared are still on disk: look in every project.
      const entries = dir
        ? readTranscript(dir, id)
        : ctx.projects.map((p) => readTranscript(p.dir, id)).find(Boolean);
      const last = session?.lastRun;
      const jobName = last?.jobId ? jobNames().get(`${last.project}:${last.jobId}`) : undefined;
      return sessionPage(ctx, session, id, entries, jobName);
    }
    if (parts[0] === 'jobs' && parts.length === 1) return jobsPage(ctx, jobViews(), now());
    if (parts[0] === 'runs' && parts.length === 2) {
      const run = options.store.getRun(Number(parts[1]));
      if (!run) return errorPage(ctx, 404);
      const job = run.jobId ? options.scheduler.list(run.project).find((j) => j.id === run.jobId) : undefined;
      return runPage(ctx, run, job);
    }
    return undefined;
  };

  const fallback = options.fallback ? new URL(options.fallback) : undefined;
  /** Streams a request to the fallback service and its answer back. */
  const passThrough = (req: IncomingMessage, res: ServerResponse) => {
    const target = new URL(req.url ?? '/', fallback);
    const upstream = httpRequest(
      target,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: target.host,
          'x-forwarded-for': req.socket.remoteAddress ?? '',
          'x-forwarded-host': req.headers.host ?? '',
        },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      options.log.warn(`fallback ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Fallback service unreachable: ${err.message}`);
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
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (fallback && !OWN_PATH.test(url.pathname)) {
      passThrough(req, res);
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
        const html = page(req, ctx);
        if (html) return sendHtml(res, 200, html);
      } catch (err) {
        options.log.error(`http page ${req.url}: ${(err as Error).stack ?? err}`);
        return sendHtml(res, 500, errorPage(ctx, 500));
      }
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
        err instanceof HttpError || err instanceof BridgeError || err instanceof ApprovalError
          ? err.status
          : 500;
      payload = { error: (err as Error).message };
      if (status === 500) options.log.error(`http ${req.method} ${req.url}: ${(err as Error).stack ?? err}`);
    }
    if (wantsHtml && ctx && status === 404) return sendHtml(res, 404, errorPage(ctx, 404));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => void handle(req, res));
    server.once('error', reject);
    server.listen(options.port, options.bind, () => {
      options.log.info(`HTTP API on http://${options.bind}:${options.port}`);
      resolve(server);
    });
  });
}
