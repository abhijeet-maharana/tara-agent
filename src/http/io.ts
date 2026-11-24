import type { IncomingMessage, ServerResponse } from 'node:http';

/** An answer with this status and `{error: message}` (or the error page, for a browser). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, 'Body too large');
  }
  return body;
}

export async function readJson(req: IncomingMessage, limit = 10_000): Promise<Record<string, unknown>> {
  const body = await readBody(req, limit);
  if (!body.trim()) return {};
  try {
    const json: unknown = JSON.parse(body);
    return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Body is not JSON');
  }
}

/** A non-empty trimmed string, else undefined. */
export const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export const arr = (v: unknown) => (Array.isArray(v) ? v : []);

/** A whole-number query parameter, `fallback` when missing or 0, kept within [min, max]. */
export const numParam = (url: URL, name: string, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number(url.searchParams.get(name)) || fallback));

export const iso = (d?: Date) => d?.toISOString() ?? null;

export const DAY_MS = 86_400_000;

/** A URL path's segments, decoded (`/jobs/a%20b/x` → `['jobs', 'a b', 'x']`). */
export const pathParts = (pathname: string) => pathname.split('/').filter(Boolean).map(decodeURIComponent);

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export const sendHtml = (res: ServerResponse, status: number, html: string) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
};

export const sendText = (res: ServerResponse, status: number, text: string) => {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(text);
};

export const redirect = (res: ServerResponse, status: number, location: string) => {
  res.writeHead(status, { location });
  res.end();
};
