import type { IncomingMessage } from 'node:http';

/** What a route's handler gets: the request, its URL, its decoded path segments and the `:name` values. */
export interface RouteRequest {
  req: IncomingMessage;
  method: string;
  url: URL;
  parts: string[];
  params: Record<string, string>;
}

/**
 * One route: `'GET /jobs/:project/:id/runs'`. A `:name` segment matches any one segment; the rest match
 * exactly. Routes are tried in order, so a literal path (`/items/bulk`) goes before a `:id` one.
 */
export interface Route<T, X = void> {
  method: string;
  segments: string[];
  run: (r: RouteRequest, extra: X) => T | Promise<T>;
}

export function makeRoute<T, X>(spec: string, run: Route<T, X>['run']): Route<T, X> {
  const [method = '', path = '/'] = spec.split(' ');
  return { method, segments: path.split('/').filter(Boolean), run };
}

/** An API route: its handler's value is sent as JSON. */
export const route = (spec: string, run: Route<unknown>['run']) => makeRoute<unknown, void>(spec, run);

/** The first route for this method and path, with its `:name` values. */
export function match<T, X>(
  routes: readonly Route<T, X>[],
  method: string,
  parts: string[],
): { route: Route<T, X>; params: Record<string, string> } | undefined {
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const fits = r.segments.every((seg, i) => {
      const part = parts[i] as string;
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = part;
        return true;
      }
      return seg === part;
    });
    if (fits) return { route: r, params };
  }
  return undefined;
}
