import type { IncomingMessage } from 'node:http';
import type { QueueConfig } from '../../config/schema.js';
import { threadKey } from '../../sessions/manager.js';
import type { ItemStatus } from '../../store/store.js';
import { dayKey } from '../../util/time.js';
import { isWebChannel } from '../../web/chat.js';
import { type ApprovalsTab, approvalsPage, ITEMS_LIMIT, isNotice, unlockPage } from '../approvals.js';
import { probeBrowser, projectNeeds, SiteScanner } from '../browser-usage.js';
import { browsersPage } from '../browsers.js';
import {
  codeDiffPage,
  codeFilePage,
  codeHomePage,
  codeRepoPage,
  codeSearchPage,
  codeTreePage,
} from '../code.js';
import { FREQUENT_MS, type ServerContext } from '../context.js';
import {
  anchor,
  type DashboardContext,
  errorPage,
  homePage,
  type JobView,
  jobsPage,
  jobWeeks,
  modelUses,
  runPage,
  sessionPage,
  sessionsPage,
} from '../dashboard.js';
import { type DataPageView, type DataTable, dataCall, dataPage, editPage, withData } from '../data.js';
import { healthPage } from '../health.js';
import { DAY_MS } from '../io.js';
import { logsPage, trendsPage } from '../observe.js';
import { queuePage } from '../queue.js';
import { loadQuotes, pickQuote } from '../quotes.js';
import { remindersPage } from '../reminders-page.js';
import { makeRoute, type Route, type RouteRequest } from '../router.js';
import { isDayKey, schedulePage } from '../schedule.js';

/** A dashboard page: its HTML, or undefined to fall through to the JSON API of the same path. */
export type PageRoute = Route<string | undefined, DashboardContext>;

const route = (spec: string, run: PageRoute['run']) => makeRoute(spec, run);

/** Sessions per page of the Sessions list. */
const SESSIONS_PAGE = 50;
/** Runs per job shown on the dashboard (recent-runs strip and history). */
const RECENT_RUNS = 10;
/** Finished items shown on the Done tab. */
const DONE_DAYS = 30;
/** The Browsers page looks at this many days of transcripts. */
const BROWSER_DAYS = 30;

/** The dashboard's HTML pages (`GET` with `Accept: text/html`), in the order they are tried. */
export function pageRoutes(c: ServerContext): PageRoute[] {
  const { options, now, timeZone } = c;
  const { store, scheduler } = options;
  const { reminders, health, observe, approvals, browsers, code } = options;
  const namesOf = (ctx: DashboardContext) => ctx.projects.map((p) => p.config.name);
  /** `?project=` when it is one of the dashboard's projects. */
  const projectParam = (url: URL, ctx: DashboardContext) => {
    const p = url.searchParams.get('project') ?? undefined;
    return p && namesOf(ctx).includes(p) ? p : undefined;
  };

  const jobViews = (ctx: DashboardContext): JobView[] =>
    namesOf(ctx).flatMap((project) => {
      const runBy = c.queueExecutors(project);
      return scheduler.list(project).map((job) => ({
        ...job,
        project,
        recent: store.jobRuns(project, job.id, RECENT_RUNS),
        queues: runBy.get(job.id),
      }));
    });

  const sessionsList = ({ url }: RouteRequest, ctx: DashboardContext) => {
    const project = url.searchParams.get('project') || undefined;
    const kindParam = url.searchParams.get('kind');
    const kind = kindParam === 'job' || kindParam === 'chat' ? kindParam : undefined;
    const total = store.sessionsCount({ project, kind });
    const pages = Math.max(1, Math.ceil(total / SESSIONS_PAGE));
    const pageNo = Math.min(pages, Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1)));
    // Threads with a run working in them, and the job when it is one (its run isn't recorded yet).
    const runningThreads = new Map(
      (options.activity?.tasks() ?? [])
        .filter((t) => t.status === 'running' && t.thread)
        .map((t) => [threadKey(t.thread?.channel ?? '', t.thread?.ts ?? ''), t.jobId] as const),
    );
    return sessionsPage(
      ctx,
      store.sessionsOverview({ project, kind, limit: SESSIONS_PAGE, offset: (pageNo - 1) * SESSIONS_PAGE }),
      c.jobNames(namesOf(ctx)),
      { project, kind },
      { preview: c.preview, runningThreads, now: now(), page: { at: pageNo, of: pages, total } },
    );
  };

  /** A session's page: its transcript, live steps while it runs, its files and a reply box. */
  const sessionView = (req: IncomingMessage, ctx: DashboardContext, id: string): string => {
    const session = store.sessionsOverview({ sessionId: id, limit: 1 })[0];
    // Its latest run, even when the session's thread was cleared (a silent job run).
    const run = store.latestSessionRun(id) ?? session?.lastRun;
    const project = session?.project ?? run?.project;
    const dir = c.project(project)?.dir;
    // Sessions whose thread was cleared are still on disk: look in every project.
    const entries = c.transcript(id, dir);
    // A job's first run is recorded when it ends: until then the live task names the job.
    const task = c.liveTask(id);
    const jobId = run?.jobId ?? task?.jobId;
    const jobName = jobId
      ? c.jobNames(namesOf(ctx)).get(`${run?.project ?? task?.project}:${jobId}`)
      : undefined;
    const running = task?.status === 'running';
    const key = session?.threadKey;
    const at = key?.indexOf(':') ?? -1;
    const channel = key && at > 0 ? key.slice(0, at) : undefined;
    const onDashboard = isWebChannel(channel);
    const files =
      key && onDashboard && options.web
        ? options.web
            .files(channel, key.slice(at + 1))
            .map((f) => ({ id: f.id, name: f.name, comment: f.comment }))
        : undefined;
    const aliases = key && onDashboard ? store.aliasesOf(key) : [];
    return sessionPage(ctx, session, id, entries, {
      jobName,
      run,
      running,
      canStop: running && c.canDecide(req),
      canSay: session && options.continueThread ? c.canDecide(req) : undefined,
      files,
      // The newest summary that isn't a card's copy (the run's result).
      slackSummary: aliases.filter((a) => !store.isMirror(a)).at(-1),
    });
  };

  const home = async (r: RouteRequest, ctx: DashboardContext) => {
    // `/?project=…` and `/?kind=…` were the sessions list before it moved to /sessions.
    if (r.url.searchParams.has('project') || r.url.searchParams.has('kind')) return sessionsList(r, ctx);
    const staleRepos = await c.staleRepos(now());
    const at = now();
    const runs = store.recentJobRuns(400);
    // Jobs every half hour or more often: one line under "Coming up" instead of filling it.
    const every = new Map<string, number>();
    for (const p of namesOf(ctx))
      for (const { id, starts } of scheduler.plannedRuns(p, at, at + DAY_MS, 2)) {
        const gap = (starts[1] ?? Infinity) - (starts[0] ?? 0);
        if (gap <= FREQUENT_MS) every.set(`${p}:${id}`, gap);
      }
    const views = jobViews(ctx);
    const live = options.activity
      ?.tasks()
      .filter((t) => t.status === 'running')
      .map((t) => ({
        kind: t.kind,
        project: t.project,
        title: t.title,
        jobId: t.jobId,
        // Its session; a job step (a session of its own, no thread) links to its job.
        href: t.thread
          ? `/t/${encodeURIComponent(t.thread.channel)}/${encodeURIComponent(t.thread.ts)}`
          : t.jobId
            ? `/jobs#${anchor({ project: t.project, id: t.jobId })}`
            : undefined,
      }));
    const snap = health?.snapshot();
    const sources = new Map((snap?.sources ?? []).map((x) => [x.id, x.title]));
    const where = (key: string) => [...sources.entries()].find(([id]) => key.startsWith(`${id}:`))?.[1] ?? '';
    return homePage(ctx, {
      live,
      quote: pickQuote(loadQuotes(ctx.projects.map((p) => p.dir))),
      models: modelUses(ctx.projects, views, options.dashboard?.models),
      effort: options.dashboard?.models?.effort,
      jobs: views.map((j) => ({
        ...j,
        everyMs: every.get(`${j.project}:${j.id}`),
        liveSessionId: j.startedAt ? c.liveJobSession(j.project, j.id, j.startedAt) : undefined,
      })),
      // Each job's latest run that did something, so a job that ran three times doesn't fill the list.
      latest: runs
        .filter((run) => run.status !== 'silent' && run.status !== 'skipped')
        .filter(
          (run, i, all) => all.findIndex((x) => x.project === run.project && x.jobId === run.jobId) === i,
        )
        .slice(0, 8),
      quietRuns: runs.filter(
        (run) => (run.status === 'silent' || run.status === 'skipped') && run.startedAt >= at - DAY_MS,
      ).length,
      pending: approvals ? store.items({ statuses: ['pending'], limit: ITEMS_LIMIT }) : [],
      usage: c.usageNow(at),
      health: health
        ? {
            problems: c
              .redChecks()
              .filter((check) => !check.key.startsWith('jobs:'))
              .map((check) => ({ name: check.name, where: where(check.key) })),
            watch: (snap?.checks ?? []).filter((check) => check.status === 'warn').length,
          }
        : undefined,
      staleRepos,
      uptimeSeconds: Math.floor((at - c.started) / 1000),
      now: at,
    });
  };

  /** Each project's queues, read once per page. */
  const queueReader = () => {
    const configs = new Map<string, Record<string, QueueConfig>>();
    return (name: string) => {
      if (!configs.has(name)) configs.set(name, c.queuesOrNone(name) ?? {});
      return configs.get(name) ?? {};
    };
  };

  const approvalsList = ({ req, url }: RouteRequest, ctx: DashboardContext) => {
    const at = now();
    const project = projectParam(url, ctx);
    const tab: ApprovalsTab = url.searchParams.get('tab') === 'done' ? 'done' : 'waiting';
    const STATUSES: Record<ApprovalsTab, ItemStatus[]> = {
      waiting: ['pending', 'uncertain'],
      done: ['done', 'failed', 'rejected', 'expired', 'cancelled'],
    };
    const since = (t: ApprovalsTab) => (t === 'done' ? at - DONE_DAYS * DAY_MS : undefined);
    const list = (t: ApprovalsTab) =>
      store.items({ project, statuses: STATUSES[t], since: since(t), limit: ITEMS_LIMIT });
    const items = list(tab);
    return approvalsPage(ctx, {
      tab,
      project,
      kind: url.searchParams.get('kind') ?? undefined,
      items,
      // Live advice; a card whose message says otherwise by now is edited to match (Slack too).
      advice:
        tab === 'waiting' && approvals
          ? new Map(items.map((i) => [i.id, approvals.syncAdvice(i).choice]))
          : undefined,
      counts: { waiting: list('waiting').filter((i) => !isNotice(i)).length, done: list('done').length },
      jobNames: c.jobNames(namesOf(ctx)),
      queues: queueReader(),
      canDecide: c.canDecide(req),
      now: at,
    });
  };

  const queueList = ({ req, url }: RouteRequest, ctx: DashboardContext) => {
    const at = now();
    const project = projectParam(url, ctx);
    return queuePage(ctx, {
      project,
      approved: store.items({ project, statuses: ['approved'], limit: 1000 }),
      running: store.items({ project, statuses: ['running'], limit: 100 }),
      pending: store.items({ project, statuses: ['pending'], limit: 500 }),
      // What went out lately, for each queue's "last out".
      finished: store.items({
        project,
        statuses: ['done', 'failed'],
        since: at - 14 * DAY_MS,
        limit: ITEMS_LIMIT,
      }),
      queues: queueReader(),
      canDecide: c.canDecide(req),
      now: at,
    });
  };

  const schedule = ({ url }: RouteRequest, ctx: DashboardContext) => {
    const at = now();
    const today = dayKey(at, timeZone);
    const day = url.searchParams.get('day');
    const project = projectParam(url, ctx);
    const chosen = isDayKey(day) ? day : today;
    // Running jobs, each with the session to watch it in; busy ones not started yet wait.
    const running = new Map<string, string | undefined>();
    const waiting = new Set<string>();
    for (const p of namesOf(ctx))
      for (const j of scheduler.list(p))
        if (j.waitingFor) waiting.add(`${p}:${j.id}`);
        else if (j.running) running.set(`${p}:${j.id}`, c.liveJobSession(p, j.id, j.startedAt));
    return schedulePage(ctx, c.dayPlan(chosen, project), {
      day: chosen,
      today,
      project,
      now: at,
      running,
      waiting,
      projectsWithJobs: namesOf(ctx).filter((p) => scheduler.list(p).length > 0),
    });
  };

  /** The Browsers page reads transcripts and asks each Chrome. */
  const sites = new SiteScanner({ readAs: options.readAs, days: BROWSER_DAYS, now });
  const browsersView = async (ctx: DashboardContext, list: NonNullable<typeof browsers>) => {
    const at = now();
    const scan = sites.scan(ctx.projects.map((p) => p.dir));
    // The first scan reads every recent transcript: show what is read so far rather than wait long.
    await Promise.race([scan, new Promise((r) => setTimeout(r, 4_000).unref())]);
    const jobOf = store.sessionJobs(at - BROWSER_DAYS * DAY_MS);
    return browsersPage(ctx, {
      browsers: await Promise.all(list.map(probeBrowser)),
      needs: projectNeeds(
        ctx.projects,
        (p) => sites.sessions(p.dir),
        (sid) => jobOf.get(sid),
        (p) => scheduler.list(p),
        undefined,
        list,
      ),
      jobNames: c.jobNames(options.projects),
      scanning: sites.scanning,
      days: BROWSER_DAYS,
      now: at,
    });
  };

  /** The Code pages (they read git). */
  const codePages = (): PageRoute[] => {
    if (!code) return [];
    const reader = (r: RouteRequest) => c.codeReader(r.params.repo);
    const file = (r: RouteRequest) => r.url.searchParams.get('path') ?? '';
    const changes = async (r: RouteRequest) => (await reader(r).status()).changes;
    return [
      route('GET /code', async ({ url }, ctx) => {
        const query = url.searchParams.get('q')?.trim();
        if (query) return codeSearchPage(ctx, query, await c.searchAll(query));
        return codeHomePage(
          ctx,
          await Promise.all(code.readers.map(async (r) => ({ repo: r.repo, status: await r.status() }))),
          now(),
        );
      }),
      route('GET /code/:repo', async (r, ctx) => {
        const { repo } = reader(r);
        const query = r.url.searchParams.get('q')?.trim();
        if (query) return codeSearchPage(ctx, query, [{ repo, result: await reader(r).search(query) }], repo);
        return codeRepoPage(ctx, repo, await reader(r).status(), now(), c.canDecide(r.req));
      }),
      route('GET /code/:repo/diff', async (r, ctx) => {
        const { repo } = reader(r);
        const all = await changes(r);
        const diff = await reader(r).diff(file(r));
        const change = all.find((ch) => ch.path === file(r));
        return change && codeDiffPage(ctx, repo, change, diff, c.canDecide(r.req));
      }),
      route('GET /code/:repo/file', async (r, ctx) => {
        const all = await changes(r);
        return codeFilePage(
          ctx,
          reader(r).repo,
          file(r),
          await reader(r).read(file(r)),
          all.find((ch) => ch.path === file(r)),
          c.canDecide(r.req),
          r.url.searchParams.get('view') === 'source' ? 'source' : 'formatted',
        );
      }),
      route('GET /code/:repo/files', async (r, ctx) => {
        const all = await changes(r);
        return codeTreePage(ctx, reader(r).repo, file(r), await reader(r).tree(file(r)), all);
      }),
    ];
  };

  return [
    route('GET /', home),
    route('GET /sessions', sessionsList),
    route('GET /sessions/:id', ({ req, params }, ctx) => sessionView(req, ctx, params.id ?? '')),
    // A dashboard thread's link (Slack summaries link here): its session's page.
    route('GET /t/:channel/:ts', ({ req, params }, ctx) => {
      const id = store.getSession(`${params.channel}:${params.ts}`)?.sessionId;
      if (!id) return errorPage(ctx, 404, 'This run has no session yet, or it was cleared.');
      return sessionView(req, ctx, id);
    }),
    route('GET /jobs', ({ url }, ctx) => {
      const at = now();
      const weeks = jobWeeks(store.runsSince(at - 7 * DAY_MS));
      return jobsPage(
        ctx,
        jobViews(ctx).map((j) => ({ ...j, week: weeks.get(`${j.project}:${j.id}`) })),
        at,
        url.searchParams.get('view') === 'on-demand' ? 'ondemand' : 'list',
      );
    }),
    route('GET /runs/:id', ({ params }, ctx) => {
      const run = store.getRun(Number(params.id));
      if (!run) return errorPage(ctx, 404);
      const job = run.jobId ? scheduler.list(run.project).find((j) => j.id === run.jobId) : undefined;
      return runPage(ctx, run, job);
    }),
    route('GET /schedule', schedule),
    route('GET /unlock', (_r, ctx) => unlockPage(ctx)),
    ...(approvals ? [route('GET /approvals', approvalsList), route('GET /queue', queueList)] : []),
    ...(reminders
      ? [
          route('GET /reminders', (_r, ctx) =>
            remindersPage(ctx, { reminders: (p) => reminders.list(p), now: now() }),
          ),
        ]
      : []),
    ...(health
      ? [
          route('GET /health', (_r, ctx) =>
            healthPage(ctx, {
              snapshot: health.snapshot(),
              history: health.history(7),
              label: (key) => health.label(key),
              uptimeSeconds: Math.floor((now() - c.started) / 1000),
              now: now(),
            }),
          ),
        ]
      : []),
    ...(observe
      ? [
          route('GET /health/trends', ({ url }, ctx) => {
            const days = Number(url.searchParams.get('days'));
            return trendsPage(ctx, observe.trends([7, 14, 30].includes(days) ? days : 14));
          }),
          route('GET /health/logs', async ({ url }, ctx) => {
            const hours = Number(url.searchParams.get('hours'));
            return logsPage(ctx, await observe.logs([1, 24, 168].includes(hours) ? hours : 24));
          }),
        ]
      : []),
    ...(browsers ? [route('GET /browsers', (_r, ctx) => browsersView(ctx, browsers))] : []),
    route('GET /data', ({ url, req }, ctx) => dataView(undefined, url, ctx, c.canDecide(req))),
    route('GET /data/:project', ({ url, params, req }, ctx) =>
      dataView(params.project, url, ctx, c.canDecide(req)),
    ),
    route('GET /data/:project/edit', async ({ url, params, req }, ctx) => {
      const p = withData(ctx.projects).find((x) => x.config.name === params.project);
      if (!p?.config.dataUrl) return errorPage(ctx, 404);
      try {
        const tables = (await dataCall(p.config.dataUrl, '/tables')) as DataTable[];
        const table = tables.find((t) => t.name === url.searchParams.get('table'));
        if (!table) return errorPage(ctx, 404, 'No such table.');
        const key = url.searchParams.get('key') ?? undefined;
        const values =
          key === undefined
            ? {}
            : ((await dataCall(
                p.config.dataUrl,
                `/${encodeURIComponent(table.name)}/${encodeURIComponent(key)}`,
              )) as Record<string, unknown>);
        return editPage(ctx, { project: p.config.name, table, key, values, canEdit: c.canDecide(req) });
      } catch (err) {
        return errorPage(ctx, 500, (err as Error).message);
      }
    }),
    ...codePages(),
  ];
}

/** Rows per page of a table on the Data tab. */
const DATA_PAGE = 50;

/** The Data tab for one project (the first with a `dataUrl` when none is named). */
async function dataView(
  name: string | undefined,
  url: URL,
  ctx: DashboardContext,
  canEdit: boolean,
): Promise<string> {
  const list = withData(ctx.projects);
  const p = name ? list.find((x) => x.config.name === name) : list[0];
  if (!p?.config.dataUrl)
    return errorPage(ctx, 404, 'No project here has a data API (`dataUrl` in .tara/config.json).');
  const base = p.config.dataUrl;
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const view: DataPageView = {
    project: p.config.name,
    projects: list.map((x) => ({ name: x.config.name, title: x.config.title ?? x.config.name })),
    tables: [],
    offset,
    pageSize: DATA_PAGE,
    canEdit,
    saved: url.searchParams.get('saved') ?? undefined,
  };
  try {
    view.tables = (await dataCall(base, '/tables')) as DataTable[];
  } catch (err) {
    view.error = `The data API at ${base} did not answer: ${(err as Error).message}`;
    return dataPage(ctx, view);
  }
  const table = url.searchParams.get('table') ?? undefined;
  view.table = view.tables.some((t) => t.name === table) ? table : undefined;
  const sql = url.searchParams.get('sql')?.trim();
  try {
    if (sql) {
      view.sql = sql;
      view.result = (await dataCall(base, '/sql', {
        method: 'POST',
        body: { sql },
      })) as DataPageView['result'];
    } else if (view.table) {
      const got = (await dataCall(
        base,
        `/${encodeURIComponent(view.table)}?limit=${DATA_PAGE}&offset=${offset}`,
      )) as { rows: Array<Record<string, unknown>> };
      view.rows = got.rows;
    }
  } catch (err) {
    view.error = (err as Error).message;
  }
  return dataPage(ctx, view);
}
