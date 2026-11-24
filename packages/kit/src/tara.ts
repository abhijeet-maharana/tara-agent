import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A project service's client for tara-agent's local API: approval cards (`ask`, `propose`) and the
 * project's jobs. One per service: `taraClient({ project: 'shop' })`.
 *
 * Cards land in the right thread: a service handling a request for a Jarvis run (the run passes its
 * `TARA_THREAD` as the `x-tara-thread` header) wraps the work in `taraThread.run(thread, …)`, and every
 * card it proposes meanwhile carries that thread, so it shows in the run's thread instead of a day thread.
 */

/** The Jarvis run thread the current request works for (see above). */
export const taraThread = new AsyncLocalStorage<string>();

/** tara-agent refused or couldn't be reached: `status` is its HTTP status, 0 when it didn't answer. */
export class TaraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TaraJob {
  id: string;
  name: string;
  enabled: boolean;
  running: boolean;
  cron?: string;
  tz?: string;
  skills: string[];
  model: string;
  nextRun: string | null;
  lastStatus?: string;
  lastRunAt: string | null;
  lastError?: string;
}

export interface TaraClientOptions {
  project: string;
  /** Default: $TARA_URL, else http://127.0.0.1:4000. */
  url?: string;
  /** Default: $TARA_HTTP_TOKEN (sent as a bearer token when set). */
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Adds the current run thread to a card request that has none. */
function withThread(path: string, init: RequestInit): RequestInit {
  const thread = taraThread.getStore();
  const route = path.split('?')[0];
  if (!thread || init.method !== 'POST' || (route !== '/items' && route !== '/items/ask') || typeof init.body !== 'string')
    return init;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return body.thread ? init : { ...init, body: JSON.stringify({ ...body, thread }) };
  } catch {
    return init;
  }
}

export function taraClient(o: TaraClientOptions) {
  const base = (o.url ?? process.env.TARA_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;

  /** Any tara-agent API call (JSON in and out). */
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const req = withThread(path, init);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = o.token ?? process.env.TARA_HTTP_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { ...req, headers, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    } catch (err) {
      throw new TaraError(0, `tara-agent is not reachable at ${base}: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new TaraError(res.status, `tara-agent ${path}: ${body.error || res.status}`);
    return body;
  }

  return {
    url: base,
    project: o.project,
    call,
    /**
     * Asks a person from code that has no run: a card on the Approvals page (`POST /items/ask`). A
     * waiting card with the same `key` is updated in place instead of a duplicate. `options`: 2 to 5
     * labels, the recommended one first. `kind: 'notice'` tells instead of asks: its first option closes
     * it without waking the agent.
     */
    ask(key: string, title: string, details: string, options: string[], kind?: string) {
      return call<{ item?: { id: string; status: string } }>('/items/ask', {
        method: 'POST',
        body: JSON.stringify({
          project: o.project,
          key,
          title: title.slice(0, 150),
          details,
          options,
          ...(kind ? { kind } : {}),
        }),
      });
    },
    /** A draft for a queue (`POST /items`): it waits for approval, then the queue's executor runs it. */
    propose(item: Record<string, unknown>) {
      return call<{ item: { id: string; status: string } }>('/items', {
        method: 'POST',
        body: JSON.stringify({ project: o.project, ...item }),
      });
    },
    /**
     * Starts one of the project's jobs now (`POST /jobs/<project>/<id>/run`), as Run now does. `by` names
     * the caller in the logs. `running`: a run of it is already going (nothing new started).
     */
    async runJob(id: string, by = 'service'): Promise<'started' | 'running'> {
      const path = `/jobs/${encodeURIComponent(o.project)}/${encodeURIComponent(id)}/run`;
      return (await call<{ result: 'started' | 'running' }>(path, { method: 'POST', body: JSON.stringify({ by }) })).result;
    },
    /** The project's jobs, as the Jobs page shows them. */
    async jobs(): Promise<TaraJob[]> {
      return (await call<{ jobs: TaraJob[] }>(`/jobs?project=${encodeURIComponent(o.project)}`)).jobs;
    },
  };
}

export type TaraClient = ReturnType<typeof taraClient>;
