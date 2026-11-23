import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';

/**
 * Who may do what on the local API: cookies and secrets, this machine's own addresses, and the Host and
 * Origin checks that keep other websites out (src/http/server.ts uses them on every request).
 */

export const TOKEN_COOKIE = 'tara_token';
export const ADMIN_COOKIE = 'tara_admin';

export const cookie = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/**
 * What the unlock cookie holds: a key derived from TARA_ADMIN_TOKEN, never the token itself. Browsers
 * send a host's cookies to every port on it, so a run that opens a port and gets the dashboard's user to
 * follow a link would see the cookie; the derived key is only good for decisions here, which are refused
 * from this machine anyway, while the token would also open `x-tara-admin`.
 */
export const adminCookieValue = (adminToken: string) =>
  `v1.${createHmac('sha256', adminToken).update('tara-admin-cookie').digest('base64url')}`;
export const ADMIN_COOKIE_ATTRS = 'HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000';

/** Addresses of this machine: a request from one of them could be the agent itself. */
export function localAddress(address: string | undefined): boolean {
  const a = (address ?? '').replace(/^::ffff:/, '');
  if (!a || a === '::1' || a.startsWith('127.')) return true;
  return Object.values(networkInterfaces()).some((list) =>
    list?.some((n) => n.address.replace(/^::ffff:/, '') === a),
  );
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;

/**
 * Whether a Host header names this machine in a way a website can't take over: an IP address,
 * `localhost`, a one-word name (`jarvis`), a Tailscale name (`*.ts.net`, whose DNS Tailscale runs) or a
 * name in `extra`. A DNS-rebinding page has its own domain as the Host, so it is refused.
 */
export function trustedHost(host: string, extra: readonly string[] = []): boolean {
  if (/^\[[0-9a-f:.]+\](:\d+)?$/i.test(host)) return true;
  const name = host.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    !name.includes('.') ||
    name.endsWith('.ts.net') ||
    extra.some((h) => h.toLowerCase() === name)
  );
}

/**
 * Why a request looks like it came from another website, else undefined. A page on any site can make
 * the browser POST to 127.0.0.1 (no token is needed by default), and a DNS-rebinding page can even
 * read the answers. So: a write whose Origin is another host is refused, and a server bound to
 * loopback only answers to loopback Host names. Scripts (curl, the MCP server) send no Origin.
 */
export function crossSite(
  req: IncomingMessage,
  bind: string,
  hosts: readonly string[] = [],
): string | undefined {
  const host = req.headers.host ?? '';
  const loopback = LOOPBACK_HOST.test(bind.includes(':') ? `[${bind}]` : bind);
  if (loopback ? !LOOPBACK_HOST.test(host) : !trustedHost(host, hosts))
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
