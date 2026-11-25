import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adminCookie,
  DataApi,
  errorStatus,
  HttpError,
  type HttpRequest,
  type HttpResponse,
  handle,
  hostAndOrigin,
  loadTables,
  openDb,
  TaraError,
  tailnetOnly,
  taraClient,
  taraThread,
  uiPrefix,
  writeGuard,
} from '../packages/kit/src/index.js';

function project(migrations: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-kit-'));
  const mig = path.join(dir, '.tara', 'db', 'migrations');
  mkdirSync(mig, { recursive: true });
  for (const [f, sql] of Object.entries(migrations)) writeFileSync(path.join(mig, f), sql);
  return { dir, mig, file: path.join(dir, 'state', 'project.db') };
}

const SCHEMA = {
  '001-leads.sql': `CREATE TABLE leads (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'new', data TEXT,
     created_at TEXT, updated_at TEXT);`,
  '002-seen.sql':
    'CREATE TABLE seen (track TEXT, id TEXT, PRIMARY KEY (track, id)); CREATE TABLE secret (x);',
};

describe('kit db', () => {
  it('applies numbered migrations once, in order, and refuses gaps and a newer database', () => {
    const p = project(SCHEMA);
    const logs: string[] = [];
    const store = openDb({ file: p.file, migrationsDir: p.mig, log: (m) => logs.push(m) });
    expect(store.db().prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(logs).toEqual(['[db] applied migration 001-leads.sql', '[db] applied migration 002-seen.sql']);
    store.close();
    expect(openDb({ file: p.file, migrationsDir: p.mig }).db()).toBeDefined(); // nothing to apply

    writeFileSync(path.join(p.mig, '004-oops.sql'), 'SELECT 1;');
    expect(() => openDb({ file: p.file, migrationsDir: p.mig }).db()).toThrow(
      /expected 003-\*\.sql, found 004-oops\.sql/,
    );

    const older = project({ '001-leads.sql': SCHEMA['001-leads.sql'] });
    expect(() => openDb({ file: p.file, migrationsDir: older.mig }).db()).toThrow(
      /newer than the 1 migrations/,
    );
  });

  it('rolls a failed migration back whole', () => {
    const p = project({ '001-bad.sql': 'CREATE TABLE a (x); CREATE TABLE a (x);' });
    const store = openDb({ file: p.file, migrationsDir: p.mig });
    expect(() => store.db()).toThrow(/001-bad\.sql failed/);
    const again = openDb({ file: p.file, migrationsDir: project(SCHEMA).mig });
    expect(again.db().prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeUndefined();
  });
});

describe('kit data API', () => {
  function setup() {
    const p = project(SCHEMA);
    const tables = path.join(p.dir, '.tara', 'db', 'tables.json');
    writeFileSync(
      tables,
      JSON.stringify({
        leads: { agentWritable: true, about: 'Leads' },
        seen: { agentWritable: false, about: 'Seen ids' },
      }),
    );
    const store = openDb({ file: p.file, migrationsDir: p.mig });
    return { store, api: new DataApi(store, loadTables(tables)) };
  }

  it('lists only the tables in the rules, with columns and row counts', () => {
    const { api } = setup();
    const res = api.handle({ method: 'GET', path: '/tables' });
    expect(res.status).toBe(200);
    expect((res.body as Array<{ name: string }>).map((t) => t.name)).toEqual(['leads', 'seen']);
    expect(
      (res.body as Array<{ columns: Array<{ name: string; key: boolean }> }>)[0]?.columns[0],
    ).toMatchObject({
      name: 'id',
      key: true,
    });
    expect(api.handle({ method: 'GET', path: '/secret' })).toMatchObject({ status: 404 });
  });

  it('writes agent-writable tables, merges data, and keeps service-only tables read-only', () => {
    const { api, store } = setup();
    const put = api.handle({
      method: 'POST',
      path: '/leads',
      body: { id: 'a1', data: { company: 'Acme', score: 7 } },
    });
    expect(put).toMatchObject({
      status: 200,
      body: { id: 'a1', status: 'new', data: { company: 'Acme', score: 7 } },
    });
    const patched = api.handle({
      method: 'PATCH',
      path: '/leads/a1',
      body: { status: 'sent', data: { score: null, note: 'hi' } },
    });
    expect(patched.body).toMatchObject({ status: 'sent', data: { company: 'Acme', note: 'hi' } });
    expect((patched.body as { data: object }).data).not.toHaveProperty('score');
    expect(api.handle({ method: 'PATCH', path: '/leads/nope', body: { status: 'x' } })).toMatchObject({
      status: 404,
    });
    expect(api.handle({ method: 'POST', path: '/leads', body: { id: 'a2', nope: 1 } })).toMatchObject({
      status: 400,
      body: { error: 'Unknown column "nope"' },
    });
    expect(api.handle({ method: 'POST', path: '/seen', body: { track: 't', id: '1' } })).toMatchObject({
      status: 403,
    });

    store.db().exec("INSERT INTO seen VALUES ('jobs', 'x|y'), ('jobs', 'z')");
    expect(api.handle({ method: 'GET', path: '/seen/jobs|z' })).toMatchObject({
      status: 200,
      body: { track: 'jobs', id: 'z' },
    });
    expect(api.handle({ method: 'GET', path: '/seen/jobs' })).toMatchObject({ status: 400 });
    expect(api.handle({ method: 'GET', path: '/leads', query: { limit: '1' } }).body).toMatchObject({
      limit: 1,
    });
  });

  it('runs read-only SQL only', () => {
    const { api } = setup();
    api.handle({ method: 'POST', path: '/leads', body: { id: 'a1' } });
    expect(
      api.handle({
        method: 'POST',
        path: '/sql',
        body: { sql: 'select id from leads where status = ?', params: ['new'] },
      }).body,
    ).toEqual({
      rows: [{ id: 'a1' }],
      truncated: false,
    });
    for (const [sql, error] of [
      ["update leads set status = 'x'", 'Only SELECT or WITH'],
      ['select 1; select 2', 'One statement only'],
      ["select load_extension('x')", 'not allowed'],
      ['with x as (select 1) delete from leads', 'readonly'],
    ] as const)
      expect(JSON.stringify(api.handle({ method: 'POST', path: '/sql', body: { sql } }).body)).toMatch(
        new RegExp(error, 'i'),
      );
  });
});

describe('kit tara client', () => {
  const recorder = (status = 200, body: object = { item: { id: 'i1', status: 'pending' } }) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fake };
  };

  it('asks with the project, adds the run thread inside taraThread, and sends the token', async () => {
    const { calls, fake } = recorder();
    const tara = taraClient({ project: 'shop', url: 'http://t:4000/', token: 'tok', fetch: fake });
    await tara.ask('login:portal', 'Log in again', 'The session expired.', ['Done', 'Skip']);
    await taraThread.run('C1:99.1', () => tara.ask('k', 'T', 'D', ['A', 'B'], 'notice'));
    await taraThread.run('C1:99.1', () => tara.call('/jobs', { method: 'POST', body: '{}' }));
    expect(calls[0]?.url).toBe('http://t:4000/items/ask');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      project: 'shop',
      key: 'login:portal',
      title: 'Log in again',
      details: 'The session expired.',
      options: ['Done', 'Skip'],
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ kind: 'notice', thread: 'C1:99.1' });
    expect(JSON.parse(String(calls[2]?.init.body))).not.toHaveProperty('thread'); // only card requests
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer tok');
  });

  it('reports refusals with their status, and an unreachable agent as status 0', async () => {
    const refused = taraClient({ project: 'shop', fetch: recorder(400, { error: 'bad kind' }).fake });
    await expect(refused.ask('k', 'T', 'D', ['A'])).rejects.toMatchObject({
      status: 400,
      message: 'tara-agent /items/ask: bad kind',
    });
    const down = taraClient({
      project: 'shop',
      url: 'http://127.0.0.1:9',
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const err = await down.jobs().catch((e: TaraError) => e);
    expect(err).toBeInstanceOf(TaraError);
    expect(err).toMatchObject({ status: 0 });
  });

  it('starts a job now, naming the caller', async () => {
    const { calls, fake } = recorder(200, { result: 'started' });
    const tara = taraClient({ project: 'my shop', url: 'http://t:4000', fetch: fake });
    expect(await tara.runJob('label-recheck', 'label-upload')).toBe('started');
    expect(calls[0]?.url).toBe('http://t:4000/jobs/my%20shop/label-recheck/run');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ by: 'label-upload' });
  });
});

describe('kit http', () => {
  const req = (
    over: Partial<HttpRequest> & { ip?: string; h?: Record<string, string> } = {},
  ): HttpRequest => ({
    method: over.method ?? 'POST',
    headers: { host: '100.100.1.2:4001', ...over.h },
    socket: { remoteAddress: over.ip ?? '100.100.1.9' },
  });
  const res = () => {
    const r = { code: 200, body: undefined as unknown };
    const out: HttpResponse & { r: typeof r } = {
      r,
      status(code) {
        r.code = code;
        return out;
      },
      json(body) {
        r.body = body;
        return out;
      },
    };
    return out;
  };
  /** Runs a middleware: true when it called next. */
  const passes = (mw: (q: HttpRequest, s: HttpResponse, n: () => void) => void, q: HttpRequest) => {
    let ok = false;
    const s = res();
    mw(q, s, () => {
      ok = true;
    });
    return { ok, code: s.r.code, body: s.r.body };
  };

  it('lets writes in only from this machine and the tailnet, reads from anywhere', () => {
    expect(passes(tailnetOnly, req({ ip: '127.0.0.1' })).ok).toBe(true);
    expect(passes(tailnetOnly, req({ ip: '::ffff:100.64.0.1' })).ok).toBe(true);
    expect(passes(tailnetOnly, req({ ip: 'fd7a:115c:a1e0::5' })).ok).toBe(true);
    expect(passes(tailnetOnly, req({ ip: '192.168.0.50' }))).toMatchObject({ ok: false, code: 403 });
    expect(passes(tailnetOnly, req({ ip: '100.128.0.1' })).ok).toBe(false); // outside 100.64/10
    expect(passes(writeGuard, req({ method: 'GET', ip: '192.168.0.50' })).ok).toBe(true);
    expect(passes(writeGuard, req({ method: 'DELETE', ip: '192.168.0.50' })).ok).toBe(false);
  });

  it("trusts the dashboard proxy's forwarded address only from loopback", () => {
    // Behind the proxy (loopback) the browser's address decides.
    const proxied = (ff: string) => req({ ip: '127.0.0.1', h: { 'x-forwarded-for': ff } });
    expect(passes(tailnetOnly, proxied('100.101.2.3')).ok).toBe(true);
    expect(passes(tailnetOnly, proxied('192.168.0.50')).ok).toBe(false);
    // A LAN client can't claim a tailnet address.
    expect(passes(tailnetOnly, req({ ip: '192.168.0.50', h: { 'x-forwarded-for': '127.0.0.1' } })).ok).toBe(
      false,
    );
    expect(uiPrefix(req({ ip: '127.0.0.1', h: { 'x-tara-prefix': '/app/shop' } }))).toBe('/app/shop');
    expect(uiPrefix(req({ ip: '100.101.2.3', h: { 'x-tara-prefix': '/app/shop' } }))).toBe('');
    expect(uiPrefix(req({ ip: '127.0.0.1', h: { 'x-tara-prefix': '/app/x"><script>' } }))).toBe('');
  });

  it('refuses browser writes from pages on unknown hosts, and checks Host and same origin', () => {
    expect(passes(tailnetOnly, req({ h: { origin: 'https://evil.example' } }))).toMatchObject({
      ok: false,
      code: 403,
    });
    expect(passes(tailnetOnly, req({ h: { origin: 'https://desk.example.ts.net' } })).ok).toBe(true);
    expect(passes(tailnetOnly, req({ h: { origin: 'http://localhost:5173' } })).ok).toBe(true);
    expect(passes(hostAndOrigin, req({ h: { host: 'evil.example' } }))).toMatchObject({
      ok: false,
      code: 403,
    });
    expect(passes(hostAndOrigin, req({ h: { origin: 'http://100.100.1.2:4000' } })).ok).toBe(false); // other port
    expect(passes(hostAndOrigin, req({ h: { origin: 'http://100.100.1.2:4001' } })).ok).toBe(true);
    const viaProxy = req({
      ip: '127.0.0.1',
      h: {
        host: '127.0.0.1:4001',
        'x-forwarded-host': 'desk.example.ts.net',
        origin: 'https://desk.example.ts.net',
      },
    });
    expect(passes(hostAndOrigin, viaProxy).ok).toBe(true);
    process.env.TARA_HOST_NAMES = 'desk, box';
    expect(passes(hostAndOrigin, req({ h: { host: 'box:4001' } })).ok).toBe(true);
    delete process.env.TARA_HOST_NAMES;
    expect(passes(hostAndOrigin, req({ h: { host: 'box:4001' } })).ok).toBe(false);
  });

  it('gates person-only routes on a cookie token', () => {
    let token: string | undefined = 's3cret';
    const admin = adminCookie({ cookie: 'shop_admin', token: () => token, missing: 'SHOP_TOKEN is not set' });
    expect(passes(admin.humanOnly, req({ h: { cookie: 'a=1; shop_admin=s3cret' } })).ok).toBe(true);
    expect(passes(admin.humanOnly, req({ h: { cookie: 'shop_admin=wrong' } }))).toMatchObject({
      ok: false,
      code: 401,
      body: { unlock: '/unlock' },
    });
    expect(
      passes(admin.humanOnly, req({ ip: '192.168.0.50', h: { cookie: 'shop_admin=s3cret' } })).code,
    ).toBe(403);
    expect(admin.matches('s3cret')).toBe(true);
    token = undefined;
    expect(admin.matches('s3cret')).toBe(false);
    expect(passes(admin.humanOnly, req({ h: { cookie: 'shop_admin=s3cret' } }))).toMatchObject({
      code: 503,
      body: { error: 'SHOP_TOKEN is not set' },
    });
  });

  it('answers JSON routes, with the status an error carries', async () => {
    const run = async (fn: () => unknown) => {
      const s = res();
      await handle(fn)(req(), s);
      return s.r;
    };
    expect(await run(() => ({ ok: 1 }))).toEqual({ code: 200, body: { ok: 1 } });
    expect(await run(async () => [1])).toEqual({ code: 200, body: [1] });
    expect(
      await run(() => {
        throw new HttpError(409, 'taken');
      }),
    ).toEqual({ code: 409, body: { error: 'taken' } });
    expect(
      await run(async () => {
        throw new Error('boom');
      }),
    ).toEqual({ code: 500, body: { error: 'boom' } });
    expect(errorStatus(new TaraError(404, 'no job'))).toBe(404);
    expect(errorStatus(new TaraError(0, 'down'))).toBe(502);
    expect(errorStatus(new TaraError(500, 'oops'))).toBe(502);
    expect(errorStatus(Object.assign(new Error('x'), { status: 422 }))).toBe(422);
    expect(errorStatus(Object.assign(new Error('x'), { status: 'nope' }))).toBe(500);
    const seen: unknown[] = [];
    await handle(
      () => {
        throw new Error('kept');
      },
      (err) => seen.push(err),
    )(req(), res());
    expect(seen).toHaveLength(1);
  });
});
