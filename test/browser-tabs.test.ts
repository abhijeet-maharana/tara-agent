import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Conversations,
  keptTabUrls,
  openTabs,
  type SweptBrowser,
  TabSweeper,
} from '../src/runner/browser-tabs.js';
import { fakeChrome } from './fakes.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const MIN = 60_000;

async function setup(pages: Record<string, string>, opts: { oldestRun?: number; keep?: unknown } = {}) {
  const chrome = await fakeChrome(pages);
  servers.push(chrome.server);
  const keepUrls: string[] = [];
  if (opts.keep !== undefined) {
    const keep = createServer((_req, res) => res.end(JSON.stringify(opts.keep)));
    servers.push(keep);
    await new Promise<void>((r) => keep.listen(0, '127.0.0.1', r));
    keepUrls.push(`http://127.0.0.1:${(keep.address() as { port: number }).port}/kept`);
  }
  let now = 0;
  const logs: string[] = [];
  const browser: SweptBrowser = { cdpUrl: chrome.url, staleMs: 30 * MIN, projects: ['shop'], keepUrls };
  const sweeper = new TabSweeper({
    browsers: () => [browser],
    oldestRun: () => opts.oldestRun,
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { chrome, sweeper, logs, at: (minutes: number) => (now = minutes * MIN) };
}

describe('TabSweeper', () => {
  it('closes tabs open past staleMinutes and keeps one blank page', async () => {
    const { chrome, sweeper, at } = await setup({
      a: 'chrome://new-tab-page/',
      b: 'https://seller.example/',
    });
    expect(await sweeper.sweep()).toBe(0); // first seen now
    at(29);
    expect(await sweeper.sweep()).toBe(0);
    at(30);
    expect(await sweeper.sweep()).toBe(1);
    expect(chrome.pages()).toEqual(['a chrome://new-tab-page/']);
    at(90);
    expect(await sweeper.sweep()).toBe(0); // the last blank page stays
  });

  it('opens a blank page before closing every tab', async () => {
    const { chrome, sweeper, at } = await setup({ a: 'https://seller.example/' });
    await sweeper.sweep();
    at(31);
    expect(await sweeper.sweep()).toBe(1);
    expect(chrome.pages()).toEqual(['new1 chrome://newtab/']);
  });

  it('never closes a tab a run still going may own', async () => {
    const { chrome, sweeper, at } = await setup(
      { a: 'chrome://new-tab-page/', b: 'https://seller.example/' },
      { oldestRun: 0 },
    );
    await sweeper.sweep(); // both first seen at 0, when the run started
    at(120);
    expect(await sweeper.sweep()).toBe(0);
    expect(chrome.pages()).toHaveLength(2);
  });

  it('leaves kept tabs open, matched without query or fragment', async () => {
    const { chrome, sweeper, at } = await setup(
      { a: 'chrome://new-tab-page/', b: 'https://acme.recruitee.com/o/dev/c/new/', c: 'https://x.example/' },
      { keep: { ok: true, result: [{ url: 'https://acme.recruitee.com/o/dev/c/new?tara=app7#top' }] } },
    );
    await sweeper.sweep();
    at(45);
    expect(await sweeper.sweep()).toBe(2);
    expect(chrome.pages()).toEqual(['b https://acme.recruitee.com/o/dev/c/new/']);
  });

  it('closes nothing when a keepTabsUrl does not answer', async () => {
    const chrome = await fakeChrome({ a: 'chrome://new-tab-page/', b: 'https://x.example/' });
    servers.push(chrome.server);
    let now = 0;
    const logs: string[] = [];
    const sweeper = new TabSweeper({
      browsers: () => [
        { cdpUrl: chrome.url, staleMs: MIN, projects: [], keepUrls: ['http://127.0.0.1:9/kept'] },
      ],
      oldestRun: () => undefined,
      now: () => now,
      log: (m) => logs.push(m),
    });
    await sweeper.sweep();
    now = 5 * MIN;
    expect(await sweeper.sweep()).toBe(0);
    expect(chrome.pages()).toHaveLength(2);
    expect(logs.join()).toMatch(/did not answer/);
  });

  it('does nothing when the browser does not answer', async () => {
    expect(await openTabs('http://127.0.0.1:9')).toBeUndefined();
    const sweeper = new TabSweeper({
      browsers: () => [{ cdpUrl: 'http://127.0.0.1:9', staleMs: 0, projects: [], keepUrls: [] }],
      oldestRun: () => undefined,
      log: () => {},
    });
    expect(await sweeper.sweep()).toBe(0);
  });
});

describe('keptTabUrls', () => {
  it('reads {url} objects or strings, bare or under result', async () => {
    const bodies = [{ ok: true, result: [{ id: 1, url: 'https://a.example/f' }] }, ['https://b.example/g']];
    const server = createServer((req, res) => res.end(JSON.stringify(bodies[Number(req.url?.slice(1))])));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(await keptTabUrls(`${base}/0`)).toEqual(['https://a.example/f']);
    expect(await keptTabUrls(`${base}/1`)).toEqual(['https://b.example/g']);
    expect(await keptTabUrls('http://127.0.0.1:9/')).toBeUndefined();
  });
});

describe('Conversations', () => {
  const thread = { channel: 'C1', ts: '1.0' };
  const run = (id: string, startedAt: number, endedAt?: number, t: typeof thread | null = thread) => ({
    id,
    project: 'shop',
    thread: t ?? undefined,
    startedAt,
    endedAt,
    status: endedAt === undefined ? 'running' : 'ok',
  });

  it('keeps a chat going from its first turn, across turns and between them', () => {
    const c = new Conversations(30 * MIN);
    c.update(run('t1', 0));
    c.update(run('t1', 0, 5 * MIN));
    expect(c.oldest(['shop'], 20 * MIN)).toBe(0); // between turns
    c.update(run('t2', 25 * MIN));
    expect(c.oldest(['shop'], 50 * MIN)).toBe(0); // turn 2 still owns turn 1's tabs
    c.update(run('t2', 25 * MIN, 52 * MIN));
    expect(c.oldest(['shop'], 81 * MIN)).toBe(0);
    expect(c.oldest(['shop'], 82 * MIN)).toBeUndefined(); // idle for 30 minutes
    expect(c.oldest(['other'], 10 * MIN)).toBeUndefined();
  });

  it('starts a chat over after it was idle, and forgets a job when it ends', () => {
    const c = new Conversations(30 * MIN);
    c.update(run('t1', 0, 5 * MIN));
    c.update(run('t2', 60 * MIN));
    expect(c.oldest(['shop'], 61 * MIN)).toBe(60 * MIN);
    const job = new Conversations(30 * MIN);
    job.update(run('j', 10 * MIN, undefined, null));
    expect(job.oldest(['shop'], 20 * MIN)).toBe(10 * MIN);
    job.update(run('j', 10 * MIN, 15 * MIN, null));
    expect(job.oldest(['shop'], 16 * MIN)).toBeUndefined();
  });

  it('with the sweeper: a tab from turn 1 survives turn 3 an hour later', async () => {
    const chrome = await fakeChrome({
      a: 'chrome://new-tab-page/',
      b: 'https://accounts.example.com/profile',
    });
    servers.push(chrome.server);
    let now = 0;
    const c = new Conversations(30 * MIN);
    const sweeper = new TabSweeper({
      browsers: () => [{ cdpUrl: chrome.url, staleMs: 30 * MIN, projects: ['shop'], keepUrls: [] }],
      oldestRun: (p) => c.oldest(p, now),
      now: () => now,
      log: () => {},
    });
    c.update(run('t1', 0));
    now = 1 * MIN;
    await sweeper.sweep(); // tab b first seen during turn 1
    c.update(run('t1', 0, 10 * MIN));
    c.update(run('t2', 30 * MIN, 40 * MIN));
    c.update(run('t3', 55 * MIN));
    now = 60 * MIN;
    expect(await sweeper.sweep()).toBe(0);
    c.update(run('t3', 55 * MIN, 62 * MIN));
    now = 95 * MIN;
    expect(await sweeper.sweep()).toBe(1); // idle 33 minutes: now it is stale
  });
});
