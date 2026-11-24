import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Logger } from '../sessions/manager.js';
import { ADMIN_COOKIE, TOKEN_COOKIE } from './guards.js';

/**
 * Streams a request to another service (the fallback, or a project's app) and its answer back. `path`
 * is resolved against `base`'s origin only: a path like `//evil.com/x` or an absolute URL would
 * otherwise point the proxy at another host, serving its pages on the dashboard's origin.
 * tara-agent's own keys never leave it: its bearer token (`token`), admin and run headers, and its cookies.
 */
export function passThrough(
  { token, log }: { token?: string; log: Logger },
  req: IncomingMessage,
  res: ServerResponse,
  base: URL,
  path: string,
  extraHeaders: Record<string, string> = {},
  /** A script put into every uncompressed HTML page of the answer (the app tab's location reporter). */
  inject?: string,
) {
  let target: URL | undefined;
  try {
    if (path.startsWith('/')) target = new URL(base.origin + path);
  } catch {}
  if (!target || target.origin !== base.origin) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad path');
    return;
  }
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  delete headers['x-tara-admin'];
  delete headers['x-tara-run'];
  if (token && headers.authorization === `Bearer ${token}`) delete headers.authorization;
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
      const html =
        inject &&
        /^text\/html/i.test(String(answer.headers['content-type'] ?? '')) &&
        !answer.headers['content-encoding'];
      if (!html) {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      answer.on('data', (c: Buffer) => chunks.push(c));
      answer.on('end', () => {
        const page = Buffer.concat(chunks).toString('utf8');
        const tag = `<script>${inject}</script>`;
        const at = page.search(/<head[^>]*>/i);
        const out = at === -1 ? tag + page : page.replace(/<head[^>]*>/i, (head) => head + tag);
        const outHeaders = { ...answer.headers };
        delete outHeaders['content-length'];
        res.writeHead(answer.statusCode ?? 502, outHeaders);
        res.end(out);
      });
    },
  );
  upstream.on('error', (err) => {
    log.warn(`proxy ${req.method} ${req.url} → ${target.origin}: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`${target.origin} is unreachable: ${err.message}`);
  });
  req.pipe(upstream);
}

/** Told to the app tab's parent page on every navigation, so its address and tab follow the app. */
export const locationReporter = (parent: string) =>
  `(()=>{if(window.parent===window)return;const post=()=>window.parent.postMessage({type:'tara:location',path:location.pathname,search:location.search,hash:location.hash,title:document.title},${JSON.stringify(parent)});for(const m of['pushState','replaceState']){const o=history[m];history[m]=function(...a){const r=o.apply(this,a);post();return r}}addEventListener('popstate',post);addEventListener('hashchange',post);addEventListener('load',post);post()})()`;
