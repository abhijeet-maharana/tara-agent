import type { IncomingMessage } from 'node:http';
import { Cron } from 'croner';
import { CodeError, MIN_QUERY } from '../code/repo.js';
import { loadQueues } from '../config/load.js';
import type { Project, QueueConfig } from '../config/schema.js';
import { threadKey } from '../sessions/manager.js';
import { addDays, midnight } from '../util/time.js';
import { ITEMS_LIMIT, isNotice } from './approvals.js';
import { staleWork } from './code.js';
import { type DashboardContext, type HomeUsage, jobState, type StaleRepo, tabbed } from './dashboard.js';
import type { NextRun } from './glance.js';
import { ADMIN_COOKIE, adminCookieValue, cookie, localAddress, sameSecret } from './guards.js';
import { DAY_MS, HttpError } from './io.js';
import { MAX_RUNS_PER_DAY, type PlanJob, planDay } from './schedule.js';
import type { HttpOptions } from './server.js';
import { firstPromptOf, readTranscript } from './transcript.js';

/** Jobs that start this often or more are left out of the home page's "Coming up" list. */
export const FREQUENT_MS = 30 * 60_000;

/**
 * What the routes share: the server's options plus the lookups several of them need (a project by
 * name, a session's transcript, a day's plan, who may decide). Built once per server.
 */
export type ServerContext = ReturnType<typeof serverContext>;

export function serverContext(options: HttpOptions) {
  const now = options.now ?? Date.now;
  const started = now();
  const timeZone = options.dashboard?.timeZone ?? 'UTC';
  const projects = options.dashboard?.projects ?? [];

  /** A project's config by name (the dashboard's projects). */
  const project = (name: string | null | undefined): Project | undefined =>
    name ? projects.find((p) => p.config.name === name) : undefined;
  const projectTitle = (name: string) => project(name)?.config.title ?? name;
  /** A project shown in a tab of its own (`/p/<name>`, `/app/<name>`). */
  const tabProject = (name: string) => tabbed(projects).find((p) => p.config.name === name);

  /** A project the scheduler knows, or 404. */
  const knownProject = (name: string | null) => {
    if (!name || !options.projects.includes(name))
      throw new HttpError(404, `Unknown project "${name ?? ''}"`);
    return name;
  };

  /** `?project=` when given (404 when unknown), else undefined: every project. */
  const optionalProject = (url: URL) =>
    url.searchParams.get('project') ? knownProject(url.searchParams.get('project')) : undefined;

  /** A project's queues (`.tara/queues.json`); throws on a broken file. */
  const queuesOf = (p: Project): Record<string, QueueConfig> => (options.queueConfig ?? loadQueues)(p);
  /** A project's queues, none when it is unknown or its file is broken. */
  const queuesOrNone = (name: string): Record<string, QueueConfig> | undefined => {
    const p = project(name);
    if (!p) return undefined;
    try {
      return queuesOf(p);
    } catch {
      return undefined;
    }
  };

  /** `project:jobId` → job name, over these projects. */
  const jobNames = (names: string[]) =>
    new Map(names.flatMap((n) => options.scheduler.list(n).map((j) => [`${n}:${j.id}`, j.name] as const)));

  /**
   * How much of Claude's usage window is used: what the CLI reported last in this process, else the
   * latest run's figure from the last 5 hours (one window), so a restart doesn't blank it. The 7-day
   * window comes only from this process's reports (runs don't store it).
   */
  const usageNow = (at: number): HomeUsage | undefined => {
    const live = options.activity?.usage();
    const ms = (t?: number) => (t ? t * (t < 1e12 ? 1000 : 1) : undefined);
    const seven = live?.windows?.seven_day;
    const weekResets = ms(seven?.resetsAt);
    const week =
      seven?.utilization !== undefined && (!weekResets || weekResets > at)
        ? { share: seven.utilization, ...(weekResets && { resetsAt: weekResets }) }
        : undefined;
    if (live?.utilization !== undefined) {
      const resetsAt = ms(live.resetsAt);
      if (!resetsAt || resetsAt > at)
        return { share: live.utilization, window: live.window, resetsAt, ...(week && { week }) };
    }
    const last = options.store
      .runsSince(at - 5 * 3_600_000)
      .filter((r) => r.rateLimitUtilization !== undefined)
      .at(-1);
    return last
      ? { share: last.rateLimitUtilization as number, asOf: last.endedAt, ...(week && { week }) }
      : undefined;
  };

  /** The next few scheduled runs today, leaving out jobs that start every half hour or more often. */
  const nextUp = (at: number): NextRun[] =>
    options.projects
      .flatMap((p) => {
        const jobs = new Map(options.scheduler.list(p).map((j) => [j.id, j]));
        return options.scheduler.plannedRuns(p, at, at + DAY_MS, 2).flatMap(({ id, starts }) => {
          const [first, second = Number.POSITIVE_INFINITY] = starts;
          const job = jobs.get(id);
          if (first === undefined || !job || second - first <= FREQUENT_MS) return [];
          return [{ project: projectTitle(p), name: job.name, at: first }];
        });
      })
      .sort((a, b) => a.at - b.at)
      .slice(0, 3);

  /** A session's transcript: from its project's folder, or (thread cleared) whichever project has it. */
  const transcript = (id: string, dir?: string) => {
    const dirs = dir ? [dir] : projects.map((p) => p.dir);
    for (const d of dirs) {
      const entries = readTranscript(d, id, undefined, options.readAs);
      if (entries) return entries;
    }
    return undefined;
  };

  /** First messages of sessions, for the Sessions list: a session's first prompt never changes. */
  const previews = new Map<string, string>();
  const preview = (projectName: string, sessionId: string) => {
    const known = previews.get(sessionId);
    if (known !== undefined) return known;
    const dir = project(projectName)?.dir;
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
    for (const [queue, q] of Object.entries(queuesOrNone(name) ?? {}))
      if ('job' in q.executor) byJob.set(q.executor.job, [...(byJob.get(q.executor.job) ?? []), queue]);
    return byJob;
  };

  /**
   * A project's queue slots in [start, end) as planned runs of the queue's job: a queue with `slots`
   * runs its executor job at each one when something is approved (its own items or those of a queue
   * that `fills` it). Queues with windows, or run elsewhere, have no fixed times to draw.
   */
  const queueSlots = (name: string, start: number, end: number): PlanJob[] => {
    const configs = queuesOrNone(name);
    if (!configs) return [];
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
  const dayPlan = (day: string, projectName?: string) => {
    const start = midnight(day, timeZone);
    const end = midnight(addDays(day, 1), timeZone);
    const names = projectName ? [projectName] : options.projects;
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

  /**
   * The session a started job works in: its running Claude run, else (finishing up, e.g. its learning
   * turn) the latest one since it started.
   */
  const liveJobSession = (projectName: string, jobId: string, since?: Date) => {
    const task = options.activity
      ?.tasks()
      .find(
        (t) =>
          t.kind === 'job' &&
          t.project === projectName &&
          t.jobId === jobId &&
          (t.status === 'running' || (since !== undefined && t.startedAt >= since.getTime())),
      );
    return task?.thread
      ? options.store.getSession(threadKey(task.thread.channel, task.thread.ts))?.sessionId
      : undefined;
  };

  /**
   * The task working in a session's thread now, else the latest finished one there (newest first). A
   * reply under a dashboard run's Slack summary (or a card's copy) runs in this session but its task names
   * the Slack thread, so those aliases count as this session's thread too.
   */
  const liveTask = (sessionId: string) => {
    const key = options.store.sessionsOverview({ sessionId, limit: 1 })[0]?.threadKey;
    if (!key) return undefined;
    const keys = new Set([key, ...options.store.aliasesOf(key)]);
    return options.activity
      ?.tasks()
      .find((t) => t.thread && keys.has(threadKey(t.thread.channel, t.thread.ts)));
  };

  /** The owner of an item's project: who a dashboard decision is recorded as. */
  const owner = (itemId: string) => project(options.store.getItem(itemId)?.project)?.config.owner;

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
    // The raw token is still taken from a browser unlocked before the cookie held the derived key; any
    // page it opens swaps it (see `handle` in server.ts).
    if (
      !given ||
      !(sameSecret(given, adminCookieValue(options.adminToken)) || sameSecret(given, options.adminToken))
    )
      throw new HttpError(403, 'This browser is not unlocked for decisions: open /unlock');
    return 'dashboard';
  };

  /** Whether this browser may decide (unlocked, from another device). */
  const canDecide = (req: IncomingMessage) => {
    try {
      human(req);
      return true;
    } catch {
      return false;
    }
  };

  /** The `x-tara-admin` header (scripts run by a person or the deploy, never by runs). */
  const adminHeader = (req: IncomingMessage) => {
    const given = req.headers['x-tara-admin'];
    if (!options.adminToken || typeof given !== 'string' || !sameSecret(given, options.adminToken))
      throw new HttpError(403, 'Needs the x-tara-admin header with TARA_ADMIN_TOKEN');
  };

  /** Confirmed red Health checks. */
  const redChecks = () =>
    (options.health?.snapshot()?.checks ?? []).filter((c) => c.status === 'bad' && !c.unconfirmed);

  const codeReader = (name: string | undefined) => {
    const reader = options.code?.readers.find((r) => r.repo.name === name);
    if (!reader) throw new HttpError(404, `Unknown repo "${name ?? ''}"`);
    return reader;
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

  /** The context every page needs, with the sidebar badge counts; undefined without the dashboard. */
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
      reminders: Boolean(options.reminders),
      vault: Boolean(options.vault),
      data: dash.projects.some((p) => p.config.dataUrl),
      unhealthy: options.health ? redChecks().length : undefined,
    };
  };

  return {
    options,
    now,
    started,
    timeZone,
    project,
    projectTitle,
    tabProject,
    knownProject,
    optionalProject,
    queuesOf,
    queuesOrNone,
    jobNames,
    usageNow,
    nextUp,
    transcript,
    preview,
    queueExecutors,
    dayPlan,
    liveJobSession,
    liveTask,
    owner,
    human,
    canDecide,
    adminHeader,
    redChecks,
    codeReader,
    searchAll,
    staleRepos,
    pageContext,
  };
}
