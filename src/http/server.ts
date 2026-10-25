import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { Logger } from '../sessions/manager.js';
import type { Store } from '../store/store.js';

export interface HttpOptions {
  bind: string;
  port: number;
  /** When set, every request needs `Authorization: Bearer <token>`. */
  token?: string;
  scheduler: Scheduler;
  store: Store;
  projects: string[];
  log: Logger;
  now?: () => number;
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
 *   GET  /jobs/<project>/<id>/runs?limit=15
 *   GET  /runs/<id>
 *   POST /reload                       re-read every .tara/jobs.json now
 */
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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    let status = 200;
    let payload: unknown;
    try {
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        throw new HttpError(401, 'Missing or wrong bearer token');
      }
      payload = await route(req);
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500;
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
