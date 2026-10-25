import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type Bridge, BridgeError } from '../bridge/bridge.js';
import type { Project } from '../config/schema.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { Logger } from '../sessions/manager.js';
import type { Store } from '../store/store.js';
import { allowList } from './access.js';
import { homePage, type JobView, jobsPage, runPage, sessionPage, sessionsPage } from './dashboard.js';
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
  /** Enables the HTML pages (sessions, transcripts, jobs) for browsers. */
  dashboard?: {
    projects: Project[];
    timeZone: string;
    agentName: string;
    slackUrl?: () => string | undefined;
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new HttpError(413, 'Body too large');
  }
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
 *   GET  /jobs?project=<name>
 *   POST /jobs/<project>/<id>/run      {"by": "who asked"}
 *   POST /jobs/<project>/<id>/pause    flips `enabled` off in the repo's .tara/jobs.json → {ok, enabled}
 *   POST /jobs/<project>/<id>/resume   flips it back on, effective at once
 *   GET  /jobs/<project>/<id>/runs?limit=15
 *   GET  /runs/<id>
 *   POST /reload                       re-read every .tara/jobs.json now
 * and, for tara's own MCP server (header `x-tara-run: <run token>`):
 *   POST /internal/approval            {title, details, options?}
 *   POST /internal/file                {path, comment?}
 *   POST /internal/permission          {tool_name, input}  → {id}
 *   GET  /internal/permission/<id>?wait=45                 → {decision | null}
 *   GET  /internal/jobs, POST /internal/run-job {id}        (chat turns only)
 */
/** Paths tara-agent serves itself; with a fallback, everything else is passed through. */
const OWN_PATH = /^\/(?:$|(?:health|reload|jobs|runs|sessions|internal)(?:\/|$))/;

export function startHttpServer(options: HttpOptions): Promise<Server> {
  const started = (options.now ?? Date.now)();
  const knownProject = (name: string | null) => {
    if (!name || !options.projects.includes(name))
      throw new HttpError(404, `Unknown project "${name ?? ''}"`);
    return name;
  };

  const route = async (req: IncomingMessage): Promise<unknown> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      const jobs = options.projects.flatMap((p) => options.scheduler.list(p));
      return {
        ok: true,
        uptimeSeconds: Math.floor(((options.now ?? Date.now)() - started) / 1000),
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
      return {
        jobs: options.scheduler.list(project).map((j) => ({
          ...j,
          nextRun: iso(j.nextRun),
          lastRunAt: iso(j.lastRunAt),
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
    throw new HttpError(404, 'Not found');
  };

  const internal = async (req: IncomingMessage): Promise<unknown> => {
    const bridge = options.bridge;
    if (!bridge) throw new HttpError(404, 'MCP bridge is not enabled');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const token = req.headers['x-tara-run'] as string | undefined;
    const str = (v: unknown, name: string) => {
      if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${name}" is required`);
      return v;
    };
    if (req.method === 'POST' && parts[1] === 'approval' && parts.length === 2) {
      const body = await readJson(req);
      const options = Array.isArray(body.options)
        ? body.options.filter((o) => typeof o === 'string')
        : undefined;
      return bridge.requestApproval(token, {
        title: str(body.title, 'title'),
        details: str(body.details, 'details'),
        options,
      });
    }
    if (req.method === 'POST' && parts[1] === 'file' && parts.length === 2) {
      const body = await readJson(req);
      const comment = typeof body.comment === 'string' ? body.comment : undefined;
      return bridge.sendFile(token, { path: str(body.path, 'path'), comment });
    }
    if (req.method === 'POST' && parts[1] === 'permission' && parts.length === 2) {
      const body = await readJson(req);
      const input =
        typeof body.input === 'object' && body.input !== null ? (body.input as Record<string, unknown>) : {};
      return bridge.askPermission(token, { tool_name: str(body.tool_name, 'tool_name'), input });
    }
    if (req.method === 'GET' && parts[1] === 'jobs' && parts.length === 2) {
      return { jobs: bridge.listJobs(token) };
    }
    if (req.method === 'POST' && parts[1] === 'run-job' && parts.length === 2) {
      const body = await readJson(req);
      return bridge.runJob(token, str(body.id, 'id'));
    }
    if (req.method === 'GET' && parts[1] === 'permission' && parts.length === 3) {
      const waitMs = Math.min(55, Math.max(0, Number(url.searchParams.get('wait')) || 0)) * 1000;
      return { decision: (await bridge.waitPermission(token, parts[2] as string, waitMs)) ?? null };
    }
    throw new HttpError(404, 'Not found');
  };

  const allowed = options.allowFrom ? allowList(options.allowFrom) : () => true;

  /** Browser pages; undefined when this request should get JSON instead. */
  const page = (req: IncomingMessage): string | undefined => {
    const dash = options.dashboard;
    if (!dash || req.method !== 'GET' || !(req.headers.accept ?? '').includes('text/html')) return undefined;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const ctx = {
      projects: dash.projects,
      timeZone: dash.timeZone,
      agentName: dash.agentName,
      slackUrl: dash.slackUrl?.(),
    };
    const names = dash.projects.map((p) => p.config.name);
    const jobNames = () =>
      new Map(names.flatMap((n) => options.scheduler.list(n).map((j) => [`${n}:${j.id}`, j.name] as const)));
    // `/?project=…` and `/?kind=…` were the sessions list before it moved to /sessions.
    const oldSessionsLink =
      parts.length === 0 && (url.searchParams.has('project') || url.searchParams.has('kind'));
    if ((parts[0] === 'sessions' && parts.length === 1) || oldSessionsLink) {
      const project = url.searchParams.get('project') ?? undefined;
      return sessionsPage(ctx, options.store.sessionsOverview({ project, limit: 300 }), jobNames(), {
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
      const now = (options.now ?? Date.now)();
      return homePage(ctx, {
        jobs: jobViews(),
        latest: options.store.recentJobRuns(8),
        runsToday: options.store.runsSince(now - 86_400_000).filter((r) => r.kind === 'job').length,
        uptimeSeconds: Math.floor((now - started) / 1000),
        now,
      });
    }
    if (parts[0] === 'sessions' && parts.length === 2) {
      const id = parts[1] as string;
      const session = options.store.sessionsOverview({ sessionId: id, limit: 1 })[0];
      const dir = dash.projects.find((p) => p.config.name === session?.project)?.dir;
      // Sessions whose thread was cleared are still on disk: look in every project.
      const entries = dir
        ? readTranscript(dir, id)
        : dash.projects.map((p) => readTranscript(p.dir, id)).find(Boolean);
      return sessionPage(ctx, session, id, entries);
    }
    if (parts[0] === 'jobs' && parts.length === 1)
      return jobsPage(ctx, jobViews(), (options.now ?? Date.now)());
    if (parts[0] === 'runs' && parts.length === 2)
      return runPage(ctx, options.store.getRun(Number(parts[1])), jobNames());
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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!allowed(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden: not on the allowed networks');
      return;
    }
    if (fallback && !OWN_PATH.test(new URL(req.url ?? '/', 'http://localhost').pathname)) {
      passThrough(req, res);
      return;
    }
    try {
      const html = page(req);
      if (html) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
    } catch (err) {
      options.log.error(`http page ${req.url}: ${(err as Error).stack ?? err}`);
    }
    let status = 200;
    let payload: unknown;
    try {
      if (req.url?.startsWith('/internal/')) {
        payload = await internal(req);
      } else {
        if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
          throw new HttpError(401, 'Missing or wrong bearer token');
        }
        payload = await route(req);
      }
    } catch (err) {
      status = err instanceof HttpError || err instanceof BridgeError ? err.status : 500;
      payload = { error: (err as Error).message };
      if (status === 500) options.log.error(`http ${req.method} ${req.url}: ${(err as Error).stack ?? err}`);
    }
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
