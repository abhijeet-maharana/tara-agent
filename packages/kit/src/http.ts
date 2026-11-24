import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { hostname as machineName } from 'node:os';
import { TaraError } from './tara.js';

/**
 * HTTP helpers for a project service (Express or anything with the same `req`/`res` shape): an error
 * with a status, a JSON route wrapper, and the access rules a service on a Jarvis-style host needs.
 *
 * The model: the service listens on 0.0.0.0 with no user accounts. People reach it through tara-agent's
 * dashboard, which proxies `/app/<project>/*` to it from this machine with the browser's address in
 * `x-forwarded-for`, the host it asked for in `x-forwarded-host` and `x-tara-prefix: /app/<project>`.
 * Forwarded headers are trusted only from loopback, and only to narrow access.
 * - `hostAndOrigin` (every request, optional): the Host must be a name we serve (blocks DNS rebinding),
 *   and a browser write must come from the same origin (blocks CSRF).
 * - `tailnetOnly` / `writeGuard` (writes): only this machine and the tailnet (100.64.0.0/10,
 *   fd7a:115c:a1e0::/48), and a browser write only from a page on a known host.
 * - `adminCookie(...).humanOnly` (approve, edit, ...): also needs a cookie holding a token the agents
 *   can't read, so an agent can report results but never approve its own drafts.
 */

/** The parts of a request these helpers read (Express's `Request` fits). */
export interface HttpRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}

/** The parts of a response these helpers use (Express's `Response` fits). */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
}

export type Next = (err?: unknown) => void;
export type Middleware = (req: HttpRequest, res: HttpResponse, next: Next) => void;

/** An error with the HTTP status the service answers with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The status to answer an error with: an `HttpError` (or any error with a 4xx/5xx `status`) keeps its
 * own; tara-agent's 400 and 404 pass through, any other tara-agent failure is 502; anything else 500.
 */
export function errorStatus(err: unknown): number {
  if (err instanceof TaraError) return err.status === 400 || err.status === 404 ? err.status : 502;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

/**
 * A JSON route: what `fn` returns (or resolves to) is sent as JSON; a thrown error is
 * `{ error: message }` with `errorStatus(err)`. `onError` sees errors that became a 500.
 */
export function handle<Req extends HttpRequest>(
  fn: (req: Req) => unknown,
  onError?: (err: unknown, req: Req) => void,
) {
  return (req: Req, res: HttpResponse): Promise<void> =>
    Promise.resolve()
      .then(() => fn(req))
      .then(
        (body) => void res.json(body),
        (err: unknown) => {
          const status = errorStatus(err);
          if (status === 500) onError?.(err, req);
          res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
        },
      );
}

const normIp = (ip: string) => ip.trim().replace(/^::ffff:/, '').toLowerCase();
const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1';

/** This machine or the tailnet (Tailscale's 100.64.0.0/10 and fd7a:115c:a1e0::/48). */
export function isLocalOrTailnet(address: string): boolean {
  const ip = normIp(address);
  const v4 = ip.match(/^100\.(\d+)\./);
  return isLoopback(ip) || (!!v4 && +v4[1]! >= 64 && +v4[1]! <= 127) || ip.startsWith('fd7a:115c:a1e0:');
}

function header(req: HttpRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A forwarded header, only when the request came from this machine (tara-agent's proxy). */
function forwarded(req: HttpRequest, name: 'x-forwarded-for' | 'x-forwarded-host' | 'x-tara-prefix') {
  const value = header(req, name);
  return value && isLoopback(normIp(req.socket.remoteAddress || '')) ? value : undefined;
}

/** The browser's address: the socket, or behind tara-agent's proxy the address it forwarded (last entry). */
export function clientIp(req: HttpRequest): string {
  return normIp(forwarded(req, 'x-forwarded-for')?.split(',').pop() || req.socket.remoteAddress || '');
}

/**
 * The path the browser reached the app under (`/app/<project>`) when the request came through
 * tara-agent's proxy, else ''. For redirects and server-rendered HTML, so only a plain path is accepted.
 */
export function uiPrefix(req: HttpRequest): string {
  const prefix = forwarded(req, 'x-tara-prefix');
  return prefix && /^\/app\/[a-z0-9-]+$/.test(prefix) ? prefix : '';
}

const hostname = (host: string) => host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();

/**
 * Names a person or a local caller uses for this host: IP literals, localhost, this machine's hostname,
 * the names in `$TARA_HOST_NAMES` (comma-separated) and MagicDNS names (`*.ts.net`). Never an
 * attacker's domain.
 */
export function knownHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = hostname(host);
  if (isIP(name) || name === 'localhost' || name.endsWith('.ts.net')) return true;
  const names = [machineName(), ...(process.env.TARA_HOST_NAMES || '').split(',')];
  return names.some((n) => n.trim().toLowerCase() === name);
}

function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

const isRead = (req: HttpRequest) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';

/** Every request: a known Host, and a browser write only from the same origin. */
export const hostAndOrigin: Middleware = (req, res, next) => {
  // Behind tara-agent's proxy the browser asked for the dashboard's host, so its pages' Origin is that.
  const browserHost = forwarded(req, 'x-forwarded-host') ?? header(req, 'host');
  if (!knownHost(header(req, 'host')) || !knownHost(browserHost)) {
    res.status(403).json({ error: 'Unknown Host header' });
    return;
  }
  const origin = header(req, 'origin');
  if (!isRead(req) && origin && originHost(origin) !== browserHost) {
    res.status(403).json({ error: 'Cross-origin write refused' });
    return;
  }
  next();
};

/** Only this machine and the tailnet; a browser request only from a page on a known host. */
export const tailnetOnly: Middleware = (req, res, next) => {
  if (!isLocalOrTailnet(clientIp(req))) {
    res.status(403).json({ error: 'Writes are only allowed over Tailscale' });
    return;
  }
  const origin = header(req, 'origin');
  if (origin && !knownHost(originHost(origin))) {
    res.status(403).json({ error: `Writes from ${origin} are not allowed` });
    return;
  }
  next();
};

/** `tailnetOnly` for every request that can change something; reads stay open. */
export const writeGuard: Middleware = (req, res, next) => (isRead(req) ? next() : tailnetOnly(req, res, next));

export interface AdminCookieOptions {
  /** The cookie's name, e.g. `board_admin`. */
  cookie: string;
  /** The token (read on every request, so a changed env file needs only a restart). Unset: approvals off. */
  token: () => string | undefined;
  /** Where a locked browser unlocks (`<uiPrefix>/unlock` by default). */
  unlockPath?: string;
  /** Says what to set when the token is missing, e.g. `BOARD_ADMIN_TOKEN is not set (see README)`. */
  missing?: string;
}

/**
 * A person-only gate: a cookie that holds a token kept where agents can't read it (an env file only the
 * service's user reads). `humanOnly` = `tailnetOnly` + that cookie; `matches` checks a token typed into an
 * unlock form (constant time).
 */
export function adminCookie(o: AdminCookieOptions) {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const matches = (candidate: string | undefined) => {
    const token = o.token();
    return !!token && !!candidate && timingSafeEqual(digest(candidate), digest(token));
  };
  const cookieValue = (req: HttpRequest) => {
    for (const part of (header(req, 'cookie') || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === o.cookie) {
        try {
          return decodeURIComponent(v.join('='));
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };
  const isAdmin = (req: HttpRequest) => matches(cookieValue(req));
  const humanOnly: Middleware = (req, res, next) =>
    tailnetOnly(req, res, () => {
      if (!o.token()) {
        res.status(503).json({ error: o.missing ?? 'The admin token is not set, so approvals are off' });
        return;
      }
      if (!isAdmin(req)) {
        res.status(401).json({ error: 'This device is not unlocked for approvals', unlock: `${uiPrefix(req)}${o.unlockPath ?? '/unlock'}` });
        return;
      }
      next();
    });
  return { matches, isAdmin, humanOnly };
}
