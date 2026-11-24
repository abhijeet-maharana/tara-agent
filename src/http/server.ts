import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import path from 'node:path';
import { ApprovalError, type Approvals } from '../approvals/approvals.js';
import { type Bridge, BridgeError } from '../bridge/bridge.js';
import { CodeError, type CodeRepo, type RepoReader } from '../code/repo.js';
import type { HostConfig, Project, QueueConfig } from '../config/schema.js';
import type { HealthMonitor } from '../health/monitor.js';
import type { Observability } from '../health/observability.js';
import { ReminderError, type Reminders } from '../reminders/reminders.js';
import type { Activity } from '../runner/activity.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { IncomingMessage as ChatMessage, Logger } from '../sessions/manager.js';
import type { Store } from '../store/store.js';
import type { WebChat } from '../web/chat.js';
import { allowList } from './access.js';
import { unlockPage } from './approvals.js';
import type { Attention } from './attention.js';
import { serverContext } from './context.js';
import { type DashboardContext, errorPage, type HostModels, tabPage } from './dashboard.js';
import { editPage, saveEdit, withData } from './data.js';
import { Glance, type QuietHours } from './glance.js';
import {
  ADMIN_COOKIE,
  ADMIN_COOKIE_ATTRS,
  adminCookieValue,
  cookie,
  crossSite,
  localAddress,
  sameSecret,
  TOKEN_COOKIE,
} from './guards.js';
import { HttpError, pathParts, readBody, redirect, sendHtml, sendJson, sendText } from './io.js';
import { locationReporter, passThrough } from './proxy.js';
import { match, type Route } from './router.js';
import { codeRoutes } from './routes/code.js';
import { internalRoutes } from './routes/internal.js';
import { itemRoutes } from './routes/items.js';
import { jobRoutes } from './routes/jobs.js';
import { pageRoutes } from './routes/pages.js';
import { reminderRoutes } from './routes/reminders.js';
import { sessionRoutes } from './routes/sessions.js';
import { systemRoutes } from './routes/system.js';

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
  /** Extra Host names accepted when bound beyond loopback (see `trustedHost`). */
  hosts?: string[];
  /** Draining before a restart (`POST /drain`), and what still runs, for `/health`'s `idle`. */
  drain?: {
    set(on: boolean): void;
    state(): { draining: boolean; liveRuns: number; queueBatches: number };
  };
  /**
   * Requests for paths tara-agent doesn't serve are passed through to this URL, e.g. the service that
   * owned the port before (so its callers keep working while they move).
   */
  fallback?: string;
  /** Approval items: the Approvals page and its API. */
  approvals?: Approvals;
  /** Reminders and their API. */
  reminders?: Reminders;
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
  /** Dashboard threads (src/web/): what a session page shows of one, and where a reply typed there goes. */
  web?: WebChat;
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
  activity?: Pick<Activity, 'tasks' | 'usage' | 'stop'> & Partial<Pick<Activity, 'subscribe'>>;
  /** A second, HTTPS listener on the same address. The certificate is re-read when its file changes. */
  tls?: { port: number; cert: string; key: string; appPort?: number };
  /** Project apps (`/app/<name>/…`) on their own port, so on another origin (see host `http.appPort`). */
  appPort?: number;
  /** The glance's quiet hours (`GET /glance`, default 23:00–07:00): desk panels hold notifications then. */
  quietHours?: QuietHours;
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

/**
 * tara-agent's HTTP server: the local API for other tools on the same host (dashboards, boards,
 * scripts), `/internal/*` for tara's own MCP server, the dashboard's pages, and project apps in tabs.
 * The routes live in `routes/` (each file lists its paths): system (health, drain, metrics), jobs (jobs,
 * runs, queues, schedule), sessions, items (approval cards), reminders, code, internal, and pages (HTML).
 * This file is the front door: who may connect, tokens and cookies, the fallback and app proxies.
 */
/** Paths tara-agent serves itself; with a fallback, everything else is passed through. */
const OWN_PATH =
  /^\/(?:$|(?:health|metrics|reload|drain|attention|jobs|runs|sessions|schedule|approvals|queue|items|reminders|unlock|code|internal|p|app|glance)(?:\/|$))/;

// Kept importable from here (tests and older callers).
export { adminCookieValue, crossSite, trustedHost } from './guards.js';
export { itemInput } from './routes/items.js';

/** Errors that carry their own HTTP status. */
const statusOf = (err: unknown) =>
  err instanceof HttpError ||
  err instanceof BridgeError ||
  err instanceof ApprovalError ||
  err instanceof ReminderError ||
  err instanceof CodeError
    ? err.status
    : 500;

/** Runs the route for this request; `undefined` as `found` when none matches. */
async function dispatch<T, X>(
  routes: readonly Route<T, X>[],
  req: IncomingMessage,
  url: URL,
  extra: X,
): Promise<{ found: boolean; value?: T }> {
  const method = req.method ?? 'GET';
  const parts = pathParts(url.pathname);
  const hit = match(routes, method, parts);
  if (!hit) return { found: false };
  return { found: true, value: await hit.route.run({ req, method, url, parts, params: hit.params }, extra) };
}

export async function startHttpServer(options: HttpOptions): Promise<Server> {
  const c = serverContext(options);
  const { now } = c;
  // The glance for desk panels (GET /glance).
  const glance = new Glance({
    attention: options.attention,
    pending: () => (options.approvals ? options.store.items({ statuses: ['pending'], limit: 200 }) : []),
    tasks: options.activity && (() => options.activity?.tasks() ?? []),
    next: c.nextUp,
    usage: c.usageNow,
    projectTitle: c.projectTitle,
    timeZone: c.timeZone,
    quietHours: options.quietHours,
    now,
    log: options.log,
  });

  const api: Route<unknown>[] = [
    ...systemRoutes(c),
    ...jobRoutes(c),
    ...sessionRoutes(c),
    ...(options.approvals ? itemRoutes(c, options.approvals) : []),
    ...(options.reminders ? reminderRoutes(c, options.reminders) : []),
    ...(options.code ? codeRoutes(c, options.code) : []),
  ];
  const internal = options.bridge ? internalRoutes(options.bridge) : undefined;
  const pages = pageRoutes(c);

  const allowed = options.allowFrom ? allowList(options.allowFrom) : () => true;
  const fallback = options.fallback ? new URL(options.fallback) : undefined;
  const proxy = (
    req: IncomingMessage,
    res: ServerResponse,
    base: URL,
    to: string,
    extraHeaders?: Record<string, string>,
    inject?: string,
  ) => passThrough({ token: options.token, log: options.log }, req, res, base, to, extraHeaders, inject);

  /** Bearer header, or (for browsers) the cookie set by opening any page once with `?token=…`. */
  const tokenHolder = (req: IncomingMessage) => {
    if (!options.token) return true;
    if (req.headers.authorization === `Bearer ${options.token}`) return true;
    const held = (req.headers.cookie ?? '').split(/;\s*/).find((x) => x.startsWith(`${TOKEN_COOKIE}=`));
    return held?.slice(TOKEN_COOKIE.length + 1) === options.token;
  };
  const NEEDS_TOKEN = 'Open the dashboard once with ?token=<TARA_HTTP_TOKEN> added to the address.';

  /** Who may connect at all: the allowed networks, and no cross-site requests. False: refused. */
  const admitted = (req: IncomingMessage, res: ServerResponse, logRefusal: boolean) => {
    if (!allowed(req.socket.remoteAddress)) {
      sendText(res, 403, 'Forbidden: not on the allowed networks');
      return false;
    }
    const refused = crossSite(req, options.bind, options.hosts);
    if (refused) {
      if (logRefusal) options.log.warn(`refused ${req.method} ${req.url}: ${refused}`);
      sendText(res, 403, `Forbidden: ${refused}`);
      return false;
    }
    return true;
  };

  /**
   * Where a request's page sits and where the project apps are served (`http.appPort`, or
   * `tls.appPort` over HTTPS): same host name, other port. Undefined app origin: apps stay on this one.
   */
  // The ports as bound (a configured 0 means any free port).
  const bound = { http: options.port, https: options.tls?.port };
  const origins = (req: IncomingMessage) => {
    const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    const hostname = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
    const scheme = encrypted ? 'https' : 'http';
    const mainPort = encrypted ? bound.https : bound.http;
    const appPort = encrypted ? options.tls?.appPort : options.appPort;
    return {
      main: `${scheme}://${hostname}:${mainPort}`,
      app: appPort ? `${scheme}://${hostname}:${appPort}` : undefined,
    };
  };

  /**
   * The app port: only `/app/<name>/…` of tabbed projects, proxied like on the dashboard's port, with the
   * location reporter in each page. Anything else goes to the dashboard. Nothing of tara-agent's own API
   * is served here, and its cookies never reach the app.
   */
  const handleApp = (req: IncomingMessage, res: ServerResponse) => {
    if (!admitted(req, res, false)) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { main } = origins(req);
    const tab = /^\/app\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
    const project = tab && c.tabProject(tab[1] as string);
    if (!tab || !project) return redirect(res, 302, main + url.pathname + url.search);
    if (!tokenHolder(req)) return sendText(res, 401, NEEDS_TOKEN);
    proxy(
      req,
      res,
      new URL(project.config.dashboardUrl as string),
      (tab[2] || '/') + url.search,
      { 'x-tara-prefix': `/app/${project.config.name}` },
      locationReporter(main),
    );
  };

  /**
   * A project's app, shown in a tab: `/app/<name>/<rest>` is proxied to `<dashboardUrl>/<rest>`, and
   * `/p/<name>/<rest>` is the dashboard page that frames it. False: not a tab path.
   */
  const tabRoute = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const tab = /^\/(app|p)\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
    const project = tab && c.tabProject(tab[2] as string);
    if (!tab || !project) return false;
    const name = project.config.name;
    const rest = tab[3] ?? '';
    if (!tokenHolder(req)) {
      sendText(res, 401, NEEDS_TOKEN);
      return true;
    }
    const appOrigin = origins(req).app;
    if (tab[1] === 'app') {
      // With an app port the app lives there, on another origin (old links are sent on).
      if (appOrigin) redirect(res, 302, appOrigin + url.pathname + url.search);
      // The app gets its own cookies, never tara-agent's keys (passThrough strips them).
      else
        proxy(req, res, new URL(project.config.dashboardUrl as string), (rest || '/') + url.search, {
          'x-tara-prefix': `/app/${name}`,
        });
      return true;
    }
    if (!rest || rest === '/') {
      redirect(res, 302, `/p/${name}${project.config.tabs?.[0]?.path ?? '/'}`);
      return true;
    }
    const ctx = c.pageContext();
    if (req.method !== 'GET' || !ctx) return false;
    sendHtml(res, 200, tabPage(ctx, project, rest + url.search, appOrigin));
    return true;
  };

  /** `POST /unlock`: the admin key typed into the Unlock page becomes this browser's decisions cookie. */
  const unlock = async (req: IncomingMessage, res: ServerResponse, ctx: DashboardContext) => {
    const form = new URLSearchParams(await readBody(req, 2_000).catch(() => ''));
    const given = form.get('token') ?? '';
    if (!options.adminToken)
      return sendHtml(
        res,
        403,
        unlockPage(ctx, 'Deciding on the dashboard is off: TARA_ADMIN_TOKEN is not set.'),
      );
    if (!options.decisionsFromLocal && localAddress(req.socket.remoteAddress))
      return sendHtml(
        res,
        403,
        unlockPage(ctx, 'Unlock from your own phone or computer, not from this machine.'),
      );
    if (!given || !sameSecret(given, options.adminToken)) {
      options.log.warn(`unlock with a wrong key from ${req.socket.remoteAddress}`);
      return sendHtml(res, 403, unlockPage(ctx, 'That key is not right.'));
    }
    res.writeHead(303, {
      location: '/approvals',
      'set-cookie': `${ADMIN_COOKIE}=${adminCookieValue(options.adminToken)}; ${ADMIN_COOKIE_ATTRS}`,
    });
    res.end();
  };

  /** `POST /data/<project>/edit`: saves the Data tab's edit form, then back to the table. */
  const saveDataEdit = async (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: DashboardContext,
    name: string,
  ) => {
    const project = withData(ctx.projects).find((p) => p.config.name === name);
    if (!project?.config.dataUrl) return sendHtml(res, 404, errorPage(ctx, 404));
    const form = new URLSearchParams(await readBody(req, 512_000).catch(() => ''));
    const table = form.get('_table') ?? '';
    try {
      c.human(req);
    } catch (err) {
      return sendHtml(res, 403, errorPage(ctx, 404, (err as Error).message));
    }
    const result = await saveEdit(project.config.dataUrl, form);
    if (result.ok) {
      options.log.info(
        `data: ${name}/${table} ${result.key} ${result.changed ? 'saved' : 'unchanged'} from the dashboard`,
      );
      const q = new URLSearchParams({
        table,
        saved: result.changed ? result.key : `${result.key} (nothing changed)`,
      });
      return redirect(res, 303, `/data/${encodeURIComponent(name)}?${q}`);
    }
    if (!result.table) return sendHtml(res, 400, errorPage(ctx, 404, result.error));
    sendHtml(
      res,
      400,
      editPage(ctx, {
        project: name,
        table: result.table,
        key: result.key,
        values: result.values,
        canEdit: true,
        error: result.error,
      }),
    );
  };

  /** A file a dashboard run sent (`send_file`), from its session page. */
  const webFile = async (req: IncomingMessage, res: ServerResponse, id: number) => {
    const m = tokenHolder(req) ? options.store.webMessageById(id) : undefined;
    const file = m?.kind === 'file' ? (m.data as { name: string; path: string }) : undefined;
    if (!options.web || !file?.path?.startsWith(options.web.filesDir + path.sep))
      return sendText(res, 404, 'No such file');
    try {
      const data = await readFile(file.path);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch {
      sendText(res, 410, 'The file is gone (deleted after the retention period)');
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!admitted(req, res, true)) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (fallback && !OWN_PATH.test(url.pathname)) return proxy(req, res, fallback, req.url ?? '/');
    const internalPath = url.pathname.startsWith('/internal/');
    // A browser still holding the raw admin token in its cookie gets the derived key instead.
    const adminCookie = cookie(req, ADMIN_COOKIE);
    if (options.adminToken && adminCookie && sameSecret(adminCookie, options.adminToken))
      res.setHeader(
        'set-cookie',
        `${ADMIN_COOKIE}=${adminCookieValue(options.adminToken)}; ${ADMIN_COOKIE_ATTRS}`,
      );
    if (options.token && !internalPath && url.searchParams.get('token') === options.token) {
      url.searchParams.delete('token');
      res.writeHead(303, {
        location: url.pathname + url.search,
        'set-cookie': `${TOKEN_COOKIE}=${options.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
      res.end();
      return;
    }
    // `GET /glance` (http/glance.ts): JSON for desk panels.
    if (url.pathname.replace(/\/$/, '') === '/glance') {
      if (!tokenHolder(req)) sendJson(res, 401, { error: 'Missing or wrong bearer token' });
      else if (req.method !== 'GET' && req.method !== 'HEAD') sendJson(res, 405, { error: 'Use GET' });
      else sendJson(res, 200, await glance.read());
      return;
    }
    if (tabRoute(req, res, url)) return;
    if (req.method === 'POST' && url.pathname === '/unlock' && tokenHolder(req)) {
      const ctx = c.pageContext();
      if (ctx) return unlock(req, res, ctx);
    }
    // The Data tab's edit form: a person (unlocked browser) changes a row through the project's data API.
    const dataEdit = /^\/data\/([^/]+)\/edit$/.exec(url.pathname);
    if (req.method === 'POST' && dataEdit && tokenHolder(req)) {
      const ctx = c.pageContext();
      if (ctx) return saveDataEdit(req, res, ctx, decodeURIComponent(dataEdit[1] as string));
    }
    // Approved items moved from the Approvals page's Scheduled tab to the Queue page.
    if (
      req.method === 'GET' &&
      url.pathname === '/approvals' &&
      url.searchParams.get('tab') === 'scheduled'
    ) {
      const project = url.searchParams.get('project');
      return redirect(res, 301, `/queue${project ? `?project=${encodeURIComponent(project)}` : ''}`);
    }
    const ctx = c.pageContext();
    const wantsHtml =
      Boolean(ctx) && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml && ctx && !tokenHolder(req) && !internalPath)
      return sendHtml(
        res,
        401,
        '<!doctype html><meta charset="utf-8"><title>Sign in</title><p style="font:16px sans-serif;padding:24px">Open this page once with <code>?token=&lt;TARA_HTTP_TOKEN&gt;</code> added to the address.</p>',
      );
    if (wantsHtml && ctx) {
      try {
        const html = (await dispatch(pages, req, url, ctx)).value;
        if (html) return sendHtml(res, 200, html);
      } catch (err) {
        if (err instanceof CodeError || err instanceof HttpError)
          return sendHtml(res, err.status, errorPage(ctx, 404, err.status === 404 ? undefined : err.message));
        options.log.error(`http page ${req.url}: ${(err as Error).stack ?? err}`);
        return sendHtml(res, 500, errorPage(ctx, 500));
      }
    }
    const fileId = /^\/web-files\/(\d+)$/.exec(url.pathname)?.[1];
    if (req.method === 'GET' && fileId && options.web) return webFile(req, res, Number(fileId));
    if (req.method === 'GET' && url.pathname === '/metrics' && options.observe) {
      if (!tokenHolder(req)) return sendText(res, 401, 'Missing or wrong bearer token');
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(options.observe.metrics());
      return;
    }
    let status = 200;
    let payload: unknown;
    try {
      // `/internal/*` is for runs: the bridge checks their run token instead of the HTTP token.
      if (internalPath && !internal) throw new HttpError(404, 'MCP bridge is not enabled');
      if (!internalPath && !tokenHolder(req)) throw new HttpError(401, 'Missing or wrong bearer token');
      const result = await dispatch((internalPath && internal) || api, req, url, undefined);
      if (!result.found) throw new HttpError(404, 'Not found');
      payload = result.value;
    } catch (err) {
      status = statusOf(err);
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
  bound.http = (server.address() as { port: number }).port;
  const extra: Array<Server | HttpsServer> = [];
  server.on('close', () => {
    for (const s of extra) s.close();
  });
  if (options.appPort)
    try {
      extra.push(await listen(createServer(handleApp), options.appPort, 'Project apps'));
    } catch (err) {
      server.close();
      throw err;
    }
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
      bound.https = (secure.address() as { port: number }).port;
    } catch (err) {
      server.close();
      throw err;
    }
    let secureApps: HttpsServer | undefined;
    if (tls.appPort)
      try {
        secureApps = await listen(createHttpsServer(read(), handleApp), tls.appPort, 'HTTPS');
        extra.push(secureApps);
      } catch (err) {
        server.close();
        throw err;
      }
    // Certificates are renewed in place (`tailscale cert` every month or two): pick up the new one.
    watchFile(tls.cert, { interval: 60_000 }, () => {
      try {
        secure.setSecureContext(read());
        secureApps?.setSecureContext(read());
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
