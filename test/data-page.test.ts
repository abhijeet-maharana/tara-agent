import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DataApi, loadTables, openDb } from '../packages/kit/src/index.js';
import type { Project } from '../src/config/schema.js';
import { editBody, mergePatch } from '../src/http/data.js';
import { ADMIN_COOKIE, adminCookieValue } from '../src/http/guards.js';
import { startHttpServer } from '../src/http/server.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';

const silent = { info() {}, warn() {}, error() {} };
const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A project service: the kit's data API at /api/db, answering like the job board ({ok, result}). */
async function projectService(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-data-'));
  const mig = path.join(dir, 'migrations');
  mkdirSync(mig);
  writeFileSync(
    path.join(mig, '001-leads.sql'),
    `CREATE TABLE leads (id TEXT PRIMARY KEY, status TEXT, data TEXT, updated_at TEXT);
     INSERT INTO leads VALUES ('a1', 'new', '{"company":"Acme"}', '2026-11-01'), ('a2', 'sent', NULL, '2026-11-02');`,
  );
  writeFileSync(
    path.join(dir, 'tables.json'),
    JSON.stringify({
      leads: { agentWritable: true, about: 'Scout leads' },
      seen: { agentWritable: false, about: 'Seen ids' },
    }),
  );
  writeFileSync(
    path.join(mig, '002-seen.sql'),
    "CREATE TABLE seen (id TEXT PRIMARY KEY); INSERT INTO seen VALUES ('s1');",
  );
  const api = new DataApi(
    openDb({ file: path.join(dir, 'p.db'), migrationsDir: mig }),
    loadTables(path.join(dir, 'tables.json')),
  );
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    const out = api.handle({
      method: req.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/db/, ''),
      query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(raw) : undefined,
    });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.status === 200 ? { ok: true, result: out.body } : out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/db`;
}

async function dashboard(dataUrl: string | undefined) {
  const project = {
    dir: '/tmp',
    config: { name: 'shop', title: 'Shop', slackChannel: 'C1', dataUrl },
  } as unknown as Project;
  const server = await startHttpServer({
    bind: '127.0.0.1',
    port: 0,
    scheduler: { list: () => [], plannedRuns: () => [] } as unknown as Scheduler,
    store: new Store(':memory:'),
    projects: ['shop'],
    log: silent,
    dashboard: { projects: [project], timeZone: 'UTC', agentName: 'Jarvis' },
    adminToken: 'key',
    decisionsFromLocal: true,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const unlocked = { cookie: `${ADMIN_COOKIE}=${adminCookieValue('key')}` };
  const page = (p: string, opts: { unlocked?: boolean } = {}) =>
    fetch(base + p, { headers: { accept: 'text/html', ...(opts.unlocked ? unlocked : {}) } }).then(
      async (r) => ({ status: r.status, html: await r.text() }),
    );
  /** Posts the edit form; answers the redirect target or the page shown. */
  page.post = (p: string, form: Record<string, string>, opts: { unlocked?: boolean } = {}) =>
    fetch(base + p, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.unlocked ? unlocked : {}) },
      body: new URLSearchParams(form).toString(),
    }).then(async (r) => ({ status: r.status, location: r.headers.get('location'), html: await r.text() }));
  return page;
}

describe('the Data tab', () => {
  it("lists a project's tables, shows a table's newest rows, and runs read-only SQL", async () => {
    const page = await dashboard(await projectService());
    const home = await page('/data');
    expect(home.status).toBe(200);
    expect(home.html).toContain('href="/data"'); // in the sidebar
    expect(home.html).toContain('<b>leads</b>');
    expect(home.html).toContain('Scout leads');
    expect(home.html).toContain('agents write');

    const rows = await page('/data/shop?table=leads');
    expect(rows.html).toContain('2 rows · newest first');
    expect(rows.html.indexOf('a2')).toBeLessThan(rows.html.indexOf('a1')); // newest first
    expect(rows.html).toContain('{&quot;company&quot;:&quot;Acme&quot;}');

    const sql = await page(
      `/data/shop?sql=${encodeURIComponent('select status, count(*) as n from leads group by status')}`,
    );
    expect(sql.html).toContain('<h2>Result</h2>');
    expect(sql.html).toContain('<th>status</th><th>n</th>');
    const refused = await page(`/data/shop?sql=${encodeURIComponent('delete from leads')}`);
    expect(refused.html).toContain('Only SELECT or WITH');
  });

  it("says so when the project's data API is down, and is off without one", async () => {
    const down = await dashboard('http://127.0.0.1:9/api/db');
    expect((await down('/data/shop')).html).toContain(
      'The data API at http://127.0.0.1:9/api/db did not answer',
    );
    const none = await dashboard(undefined);
    const res = await none('/data');
    expect(res.html).toContain('No project here has a data API');
    expect(res.html).not.toContain('href="/data"');
  });

  it('lets an unlocked browser edit rows of agent-writable tables, sending only what changed', async () => {
    const dataUrl = await projectService();
    const page = await dashboard(dataUrl);
    // Locked: no Edit links, and a save is refused.
    expect((await page('/data/shop?table=leads')).html).not.toContain('>Edit</a>');
    const locked = await page.post('/data/shop/edit', { _table: 'leads', _key: 'a1', status: 'x' });
    expect(locked.status).toBe(403);

    const view = await page('/data/shop?table=leads', { unlocked: true });
    expect(view.html).toContain('href="/data/shop/edit?table=leads&amp;key=a1">Edit</a>');
    expect(view.html).toContain('Add a row');
    // Service-only tables have no Edit links.
    expect((await page('/data/shop?table=seen', { unlocked: true })).html).not.toContain('>Edit</a>');

    const form = await page('/data/shop/edit?table=leads&key=a1', { unlocked: true });
    expect(form.html).toContain('name="status" value="new"');
    expect(form.html).toContain('&quot;company&quot;: &quot;Acme&quot;');

    // Change the status, and replace data: company removed, a note added.
    const saved = await page.post(
      '/data/shop/edit',
      { _table: 'leads', _key: 'a1', id: 'ignored', status: 'drafted', data: '{"note": "hi"}' },
      { unlocked: true },
    );
    expect(saved).toMatchObject({ status: 303, location: '/data/shop?table=leads&saved=a1' });
    const row = await fetch(`${dataUrl}/leads/a1`).then(
      (r) => r.json() as Promise<{ result: Record<string, unknown> }>,
    );
    expect(row.result).toMatchObject({ id: 'a1', status: 'drafted', data: { note: 'hi' } });
    expect(row.result.data).not.toHaveProperty('company');

    const same = await page.post(
      '/data/shop/edit',
      { _table: 'leads', _key: 'a1', status: 'drafted', data: '{"note":"hi"}' },
      { unlocked: true },
    );
    expect(same.location).toContain('saved=a1+%28nothing+changed%29');

    const bad = await page.post(
      '/data/shop/edit',
      { _table: 'leads', _key: 'a1', status: 'x', data: '{oops' },
      { unlocked: true },
    );
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('data is not valid JSON');
    expect(bad.html).toContain('{oops'); // what was typed stays

    const added = await page.post(
      '/data/shop/edit',
      { _table: 'leads', id: 'a3', status: 'new', data: '' },
      { unlocked: true },
    );
    expect(added.location).toBe('/data/shop?table=leads&saved=a3');
    expect(
      (await fetch(`${dataUrl}/leads/a3`).then((r) => r.json() as Promise<{ result: object }>)).result,
    ).toMatchObject({ id: 'a3', data: null });

    const refused = await page.post(
      '/data/shop/edit',
      { _table: 'seen', _key: 's1', id: 's2' },
      { unlocked: true },
    );
    expect(refused.status).toBe(400);
    expect(refused.html).toContain('seen is written by the project&#39;s own service only');
  });
});

describe('Data tab edits', () => {
  it('builds merge patches that remove keys, and sends only changed fields', () => {
    expect(mergePatch({ a: 1, b: { c: 1, d: 2 }, e: [1] }, { a: 1, b: { c: 1 }, e: [2], f: 'x' })).toEqual({
      b: { d: null },
      e: [2],
      f: 'x',
    });
    const table = {
      name: 'leads',
      about: '',
      agentWritable: true,
      rows: 1,
      columns: [
        { name: 'id', type: 'TEXT', key: true },
        { name: 'pos', type: 'INTEGER', key: false },
        { name: 'status', type: 'TEXT', key: false, required: true },
        { name: 'updated_at', type: 'TEXT', key: false },
      ],
    };
    const current = { id: 'a', pos: 3, status: 'new', updated_at: 'x' };
    expect(editBody(table, { id: 'a', pos: '3', status: 'new', updated_at: 'y' }, current)).toBeUndefined();
    expect(editBody(table, { pos: '4', status: 'new' }, current)).toEqual({ pos: 4 });
    expect(() => editBody(table, { status: ' ' }, current)).toThrow('status is required');
    expect(editBody(table, { id: 'b', pos: '', status: 'new' })).toEqual({ id: 'b', status: 'new' });
  });
});
