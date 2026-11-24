import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approvals } from '../src/approvals/approvals.js';
import type { Bridge } from '../src/bridge/bridge.js';
import { ADMIN_COOKIE, adminCookieValue } from '../src/http/guards.js';
import { match, route } from '../src/http/router.js';
import { type HttpOptions, startHttpServer } from '../src/http/server.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';

const silent = { info() {}, warn() {}, error() {} };

describe('router', () => {
  const routes = [
    route('POST /items/bulk', () => 'bulk'),
    route('POST /items/:id', () => 'one'),
    route('GET /items/:id/:action', () => 'action'),
    route('GET /', () => 'home'),
  ];
  it('takes the first route that fits, literal before :param when listed first', () => {
    expect(match(routes, 'POST', ['items', 'bulk'])?.params).toEqual({});
    expect(match(routes, 'POST', ['items', 'x1'])?.params).toEqual({ id: 'x1' });
    expect(match(routes, 'GET', ['items', 'x1', 'note'])?.params).toEqual({ id: 'x1', action: 'note' });
  });
  it('needs the method and the number of segments to match', () => {
    expect(match(routes, 'GET', ['items', 'bulk'])).toBeUndefined();
    expect(match(routes, 'POST', ['items'])).toBeUndefined();
    expect(match(routes, 'GET', [])?.route.segments).toEqual([]);
  });
});

/** An object whose every method records its call and answers `{called: name}`. */
function recorder<T>() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const fake = new Proxy(
    {},
    {
      get: (_t, name) =>
        typeof name === 'string' && name !== 'then'
          ? (...args: unknown[]) => {
              calls.push({ name, args });
              return { called: name };
            }
          : undefined,
    },
  ) as T;
  return { fake, calls };
}

describe('HTTP routes', () => {
  const servers: Array<{ close(): void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const start = async (extra: Partial<HttpOptions>) => {
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: {
        list: () => [],
        plannedRuns: () => [],
        setDuration: (_p: string, id: string) => (id === 'known' ? 'ok' : 'unknown'),
      } as unknown as Scheduler,
      store: new Store(':memory:'),
      projects: ['shop'],
      log: silent,
      ...extra,
    });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const call = async (base: string, method: string, path: string, body?: unknown, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('passes each /internal call to the bridge with the run token', async () => {
    const { fake, calls } = recorder<Bridge>();
    const base = await start({ bridge: fake });
    const run = { 'x-tara-run': 'tok' };
    const cases: Array<[string, string, unknown, string, unknown[]]> = [
      [
        'POST',
        '/internal/approval',
        { title: 'T', details: 'D', options: ['a', 1], kind: 'k' },
        'requestApproval',
        [{ title: 'T', details: 'D', options: ['a'], kind: 'k', handoff: undefined }],
      ],
      [
        'POST',
        '/internal/privileged',
        { action: 'fix', args: { path: 1 }, reason: 'why' },
        'requestPrivileged',
        [{ action: 'fix', args: { path: '1' }, command: undefined, reason: 'why', title: undefined }],
      ],
      ['POST', '/internal/file', { path: '/x' }, 'sendFile', [{ path: '/x', comment: undefined }]],
      [
        'POST',
        '/internal/permission',
        { tool_name: 'Bash', input: { command: 'ls' } },
        'askPermission',
        [{ tool_name: 'Bash', input: { command: 'ls' } }],
      ],
      ['GET', '/internal/permission/p1?wait=2', undefined, 'waitPermission', ['p1', 2000]],
      ['GET', '/internal/jobs', undefined, 'listJobs', []],
      ['POST', '/internal/run-job', { id: 'j' }, 'runJob', ['j']],
      [
        'GET',
        '/internal/items?status=pending',
        undefined,
        'listItems',
        [{ status: 'pending', kind: undefined }],
      ],
      [
        'POST',
        '/internal/item-done',
        { id: 'i1', status: 'later', retryAt: '2026-01-01T00:00:00Z' },
        'finishItem',
        [{ id: 'i1', status: 'later', result: undefined, retryAt: Date.parse('2026-01-01T00:00:00Z') }],
      ],
      ['POST', '/internal/pr-start', { branch: 'b' }, 'startPullRequest', [{ branch: 'b' }]],
      ['POST', '/internal/ci-job', { job: '42' }, 'readCiJob', [{ job: '42' }]],
      [
        'POST',
        '/internal/pr-open',
        { branch: 'b', title: 'T' },
        'openPullRequest',
        [{ branch: 'b', title: 'T', body: undefined }],
      ],
      ['POST', '/internal/withdraw', { id: 'i1' }, 'withdrawCard', [{ id: 'i1', reason: undefined }]],
      ['GET', '/internal/reminders', undefined, 'listReminders', []],
      ['POST', '/internal/reminder-cancel', { id: 'r1' }, 'cancelReminder', ['r1']],
    ];
    for (const [method, path, body, name, args] of cases) {
      calls.length = 0;
      const res = await call(base, method, path, body, run);
      expect(res.status, path).toBe(200);
      expect(calls, path).toEqual([{ name, args: ['tok', ...args] }]);
    }
    const item = await call(base, 'POST', '/internal/item', { kind: 'post', title: 'T', queue: 'q' }, run);
    expect(item.status).toBe(200);
    expect(calls.at(-1)?.name).toBe('proposeItem');
    expect((await call(base, 'POST', '/internal/approval', { title: 'T' }, run)).json).toEqual({
      error: '"details" is required',
    });
    expect((await call(base, 'POST', '/internal/nope', {}, run)).status).toBe(404);
  });

  it('says the bridge is off when there is none', async () => {
    const base = await start({});
    expect(await call(base, 'GET', '/internal/jobs')).toEqual({
      status: 404,
      json: { error: 'MCP bridge is not enabled' },
    });
  });

  it('sets a job duration, and plans conflicts over the next days', async () => {
    const base = await start({});
    expect((await call(base, 'POST', '/jobs/shop/known/duration', { minutes: 20 })).json).toEqual({
      ok: true,
      minutes: 20,
    });
    expect((await call(base, 'POST', '/jobs/shop/known/duration', { minutes: 0 })).status).toBe(400);
    expect((await call(base, 'POST', '/jobs/shop/gone/duration', { minutes: 5 })).status).toBe(404);
    expect((await call(base, 'POST', '/jobs/other/known/duration', { minutes: 5 })).status).toBe(404);
    const plan = await call(base, 'GET', '/schedule/conflicts?days=3');
    expect((plan.json.days as unknown[]).length).toBe(3);
  });

  it('decides items in bulk from an unlocked browser, and withdraws one', async () => {
    const { fake, calls } = recorder<Approvals>();
    const base = await start({ approvals: fake, adminToken: 'key', decisionsFromLocal: true });
    const unlocked = { cookie: `${ADMIN_COOKIE}=${adminCookieValue('key')}` };
    expect((await call(base, 'POST', '/items/bulk', { ids: ['a'], option: 'Approve' })).status).toBe(403);
    const bulk = await call(base, 'POST', '/items/bulk', { ids: ['a', 'b', 3], option: 'Approve' }, unlocked);
    expect(bulk.json).toEqual({ decided: ['a', 'b'], failed: [] });
    expect(calls.map((x) => x.name)).toEqual(['decide', 'decide']);
    const withdrawn = await call(base, 'POST', '/items/a/withdraw', { reason: 'stale' });
    expect(withdrawn.json).toEqual({ item: { called: 'withdraw' } });
    expect(calls.at(-1)?.args).toEqual(['a', 'stale']);
  });
});
