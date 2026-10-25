import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Approvals } from '../src/approvals/approvals.js';
import { verifySeal } from '../src/approvals/seal.js';
import type { Project, QueueConfig } from '../src/config/schema.js';
import { startHttpServer } from '../src/http/server.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import { nextWindowStart, QueueWorker, windowOpen } from '../src/scheduler/queues.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { IncomingMessage } from '../src/sessions/manager.js';
import { type Item, Store } from '../src/store/store.js';
import { FakeChat, testHost } from './fakes.js';

const silent = { info() {}, warn() {}, error() {} };
const KEY = 'seal-key';
// Tue 27 Oct 2026, 09:00 UTC = 10:00 Europe/Berlin (winter time).
const TUE_9_UTC = Date.parse('2026-10-27T09:00:00Z');

const QUEUES = {
  linkedin: {
    executor: { job: 'sender' },
    batch: 2,
    windows: { EU: { tz: 'Europe/Berlin', days: 'tue-thu', from: '10:00', to: '12:00' } },
    caps: { perDay: 3 },
    gapMinutes: 0,
  },
  content: {
    executor: { url: 'http://board/send' },
    batch: 1,
    slots: '30 18 * * 1,3,5',
    alternate: ['image-post', 'reel'],
    caps: {},
    gapMinutes: 0,
  },
  outreach: {
    executor: { external: true },
    batch: 1,
    windows: { EU: { tz: 'Europe/Berlin', days: 'tue-thu', from: '10:00', to: '12:00' } },
    caps: {},
    gapMinutes: 0,
  },
  email: {
    executor: { url: 'http://board/send' },
    batch: 1,
    windows: { EU: { tz: 'Europe/Berlin', days: 'tue-thu', from: '10:00', to: '12:00' } },
    caps: { perDay: 5 },
    gapMinutes: 0,
  },
} satisfies Record<string, QueueConfig>;

function makeProject(extra: object = {}): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-appr-'));
  mkdirSync(path.join(dir, '.tara'));
  writeFileSync(path.join(dir, '.tara', 'queues.json'), JSON.stringify({ queues: QUEUES }));
  writeFileSync(
    path.join(dir, '.tara', 'jobs.json'),
    JSON.stringify({
      jobs: [{ id: 'sender', name: 'Sender', cron: '0 0 1 1 *', prompt: 'Send.', locks: ['chrome'] }],
    }),
  );
  return {
    dir,
    config: {
      name: 'shop',
      slackChannel: 'C1',
      permissionMode: 'bypassPermissions',
      chatModel: 'opus',
      allowedTools: [],
      allowedUsers: [],
      billing: 'subscription',
      selfImprove: false,
      owner: 'U1',
      ...extra,
    },
  };
}

function setup(opts: { now?: () => number; fetch?: typeof fetch; project?: Project } = {}) {
  const project = opts.project ?? makeProject();
  const store = new Store(':memory:', opts.now);
  const chat = new FakeChat('ts');
  const approvals = new Approvals({
    store,
    chat,
    log: silent,
    projects: [project],
    timeZone: 'UTC',
    sealKey: KEY,
    fetch: opts.fetch,
    now: opts.now,
  });
  const chats: IncomingMessage[] = [];
  const jobs: Array<{ jobId: string; text: string }> = [];
  approvals.onChat = async (m) => void chats.push(m);
  approvals.onJob = async (_p, jobId, r) => void jobs.push({ jobId, text: r.text });
  return { project, store, chat, approvals, chats, jobs };
}

const note = (value: string) => ({
  key: 'note',
  label: 'Note',
  type: 'textarea' as const,
  value,
  maxLength: 20,
});

describe('proposing and deciding', () => {
  it('checks field rules, replaces a pending draft by key, and seals what was approved', async () => {
    const { project, store, approvals } = setup();
    const first = await approvals.propose(project, {
      kind: 'note',
      key: 'k1',
      title: 'Jane',
      queue: 'linkedin',
      window: 'EU',
      fields: [note('x'.repeat(25))],
    });
    expect(first.checks).toEqual([{ text: 'Note: 25/20 characters', blocking: true }]);
    await expect(
      approvals.decide(first.id, { option: 'Approve', by: 'U1', via: 'dashboard' }),
    ).rejects.toMatchObject({ status: 409 });

    const again = await approvals.propose(project, {
      kind: 'note',
      key: 'k1',
      title: 'Jane',
      queue: 'linkedin',
      fields: [note('hello')],
    });
    expect(again.id).toBe(first.id);
    expect(store.items({ statuses: ['pending'] })).toHaveLength(1);

    const approved = await approvals.decide(first.id, {
      option: 'Approve',
      by: 'U1',
      via: 'dashboard',
      fields: { note: 'hello there' },
    });
    expect(approved).toMatchObject({ status: 'approved', decision: 'Approve' });
    expect(approved.fields[0]?.value).toBe('hello there');
    expect(verifySeal(approved, KEY)).toBe(true);
    expect(verifySeal({ ...approved, fields: [note('changed')] }, KEY)).toBe(false);
    await expect(
      approvals.decide(first.id, { option: 'Reject', by: 'U2', via: 'slack' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses unknown queues and windows, and adds the project checks', async () => {
    const fetchFake = (async () =>
      new Response(
        JSON.stringify({ checks: [{ text: 'Mentions Abtara', blocking: true }] }),
      )) as typeof fetch;
    const { project, approvals } = setup({
      fetch: fetchFake,
      project: makeProject({ approvals: { validateUrl: 'http://board/validate' } }),
    });
    await expect(approvals.propose(project, { kind: 'x', title: 'T', queue: 'nope' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      approvals.propose(project, { kind: 'x', title: 'T', queue: 'linkedin', window: 'US' }),
    ).rejects.toMatchObject({ status: 400 });
    const item = await approvals.propose(project, {
      kind: 'x',
      title: 'T',
      queue: 'linkedin',
      fields: [note('ok')],
    });
    expect(item.checks).toEqual([{ text: 'Mentions Abtara', blocking: true }]);
  });

  it('Revise on a draft keeps it waiting and asks Jarvis in its thread; a paused job continues as the job', async () => {
    const { project, approvals, chats, jobs, store } = setup();
    const draft = await approvals.propose(
      project,
      { kind: 'post', key: 'p1', title: 'Post', queue: 'linkedin', fields: [note('hi')] },
      { channel: 'C1', threadTs: '50.1' },
    );
    await expect(
      approvals.decide(draft.id, { option: 'Revise', by: 'dashboard', via: 'dashboard' }),
    ).rejects.toMatchObject({ status: 400 });
    await approvals.decide(draft.id, {
      option: 'Revise',
      by: 'dashboard',
      via: 'dashboard',
      reply: 'Shorter',
    });
    expect(store.getItem(draft.id)).toMatchObject({ status: 'pending', reply: 'Shorter' });
    expect(chats[0]).toMatchObject({ channel: 'C1', threadTs: '50.1', user: 'U1' });
    expect(chats[0]?.text).toContain('USER REVISE REQUEST for post "Post" (key p1)');

    const ask = await approvals.requestDecision(
      { project, channel: 'C1', threadTs: '60.1', jobId: 'sender' },
      { title: 'Cut bids', details: 'D' },
    );
    await approvals.decide(ask.id, {
      option: 'Approve',
      by: 'dashboard',
      via: 'dashboard',
      reply: 'only two',
    });
    expect(jobs).toEqual([
      {
        jobId: 'sender',
        text: expect.stringContaining('USER DECISION on "Cut bids": Approve\nNote: only two'),
      },
    ]);
  });
});

describe('queue worker', () => {
  it('knows when windows are open', () => {
    const eu = QUEUES.linkedin.windows.EU;
    expect(windowOpen(eu, 'UTC', TUE_9_UTC)).toBe(true);
    expect(windowOpen(eu, 'UTC', TUE_9_UTC + 2 * 3_600_000)).toBe(false); // 12:00 Berlin
    expect(windowOpen(eu, 'UTC', Date.parse('2026-10-26T09:00:00Z'))).toBe(false); // Monday
    expect(nextWindowStart(eu, 'UTC', Date.parse('2026-10-26T09:00:00Z'))).toBe(TUE_9_UTC);
  });

  it('runs approved items in their window, in batches, within the daily cap; unreported ones fail', async () => {
    let now = TUE_9_UTC - 3_600_000; // window not open yet
    const { project, store, approvals } = setup({ now: () => now });
    const runs: Item[][] = [];
    const worker = new QueueWorker({
      projects: [project],
      store,
      log: silent,
      timeZone: 'UTC',
      now: () => now,
      jobs: {
        enabled: () => true,
        runQueue: async (_p, _job, _q, items) => {
          runs.push(items);
          store.finishItem(items[0]?.id as string, 'done', 'sent');
          return 'ok';
        },
      },
    });
    for (const n of [1, 2, 3, 4]) {
      const i = await approvals.propose(project, {
        kind: 'note',
        title: `Lead ${n}`,
        queue: 'linkedin',
        window: 'EU',
        fields: [note('hi')],
      });
      await approvals.decide(i.id, { option: 'Approve', by: 'U1', via: 'dashboard' });
    }
    await worker.tick();
    expect(runs).toHaveLength(0);

    now = TUE_9_UTC;
    await worker.tick();
    await worker.idle();
    expect(runs.map((b) => b.map((i) => i.title))).toEqual([['Lead 1', 'Lead 2']]);
    expect(store.items({ statuses: ['done'] }).map((i) => i.title)).toEqual(['Lead 1']);
    expect(store.items({ statuses: ['failed'] })[0]).toMatchObject({
      title: 'Lead 2',
      result: expect.stringContaining('without reporting'),
    });

    now += 60_000;
    await worker.tick();
    await worker.idle();
    expect(runs.map((b) => b.length)).toEqual([2, 1]); // cap 3 a day
    now += 60_000;
    await worker.tick();
    expect(runs).toHaveLength(2);
    expect(store.items({ statuses: ['approved'] }).map((i) => i.title)).toEqual(['Lead 4']);
  });

  it('runs one item per slot, taking turns between kinds, and posts it sealed to a URL executor', async () => {
    let now = Date.parse('2026-10-26T18:00:00Z'); // Monday before the 18:30 slot
    const posted: Array<{
      item: { title: string; seal: string; fields: Item['fields']; id: string; kind: string };
    }> = [];
    const fetchFake = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ status: 'done', result: 'https://live' }));
    }) as unknown as typeof fetch;
    const { project, store, approvals } = setup({ now: () => now });
    const worker = new QueueWorker({
      projects: [project],
      store,
      log: silent,
      timeZone: 'UTC',
      now: () => now,
      fetch: fetchFake,
      jobs: { runQueue: async () => 'ok', enabled: () => true },
    });
    for (const [kind, title] of [
      ['image-post', 'Post A'],
      ['image-post', 'Post B'],
      ['reel', 'Reel A'],
    ]) {
      const i = await approvals.propose(project, {
        kind: kind as string,
        title: title as string,
        queue: 'content',
      });
      await approvals.decide(i.id, { option: 'Approve', by: 'U1', via: 'dashboard' });
    }
    await worker.tick(); // first look: Friday's slot is only recorded, nothing runs
    expect(posted).toHaveLength(0);
    now = Date.parse('2026-10-26T18:31:00Z');
    await worker.tick();
    await worker.idle();
    now = Date.parse('2026-10-26T18:40:00Z');
    await worker.tick(); // same slot: nothing more
    await worker.idle();
    now = Date.parse('2026-10-28T18:31:00Z');
    await worker.tick();
    await worker.idle();
    expect(posted.map((p) => p.item.title)).toEqual(['Post A', 'Reel A']);
    expect(store.items({ statuses: ['approved'] }).map((i) => i.title)).toEqual(['Post B']);
    expect(store.items({ statuses: ['done'] })[0]?.result).toBe('https://live');
    for (const p of posted) expect(verifySeal(p.item, KEY)).toBe(true);
  });

  it('puts an item back in the queue when a URL executor answers later', async () => {
    let now = TUE_9_UTC;
    let answer: object = { status: 'later', result: 'daily cap reached', retryAt: TUE_9_UTC + 86_400_000 };
    const fetchFake = (async () => new Response(JSON.stringify(answer))) as unknown as typeof fetch;
    const { project, store, approvals } = setup({ now: () => now });
    const finished: string[] = [];
    const worker = new QueueWorker({
      projects: [project],
      store,
      log: silent,
      timeZone: 'UTC',
      now: () => now,
      fetch: fetchFake,
      onFinished: (i) => finished.push(i.status),
      jobs: { runQueue: async () => 'ok', enabled: () => true },
    });
    const i = await approvals.propose(project, { kind: 'email', title: 'Ann', queue: 'email', window: 'EU' });
    await approvals.decide(i.id, { option: 'Approve', by: 'U1', via: 'dashboard' });
    await worker.tick();
    await worker.idle();
    expect(store.getItem(i.id)).toMatchObject({
      status: 'approved',
      result: 'daily cap reached',
      runAfter: TUE_9_UTC + 86_400_000,
    });
    expect(store.queueStarts(project.config.name, 'email', 0)).toHaveLength(0); // not counted against caps
    expect(finished).toEqual([]);

    now += 60_000;
    await worker.tick();
    await worker.idle();
    expect(store.getItem(i.id)?.status).toBe('approved'); // waits for retryAt

    now = TUE_9_UTC + 86_400_000; // Wednesday, same window
    answer = { status: 'done', result: 'sent' };
    await worker.tick();
    await worker.idle();
    expect(store.getItem(i.id)).toMatchObject({ status: 'done', result: 'sent' });
    expect(finished).toEqual(['done']);
  });
});

describe('decisions over HTTP', () => {
  it("lists a project's queues with the next slot times and the kind that went last", async () => {
    const { project, store, approvals } = setup({ now: () => Date.parse('2026-10-26T18:00:00Z') });
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [], plannedRuns: () => [] } as unknown as Scheduler,
      store,
      approvals,
      projects: ['shop'],
      log: silent,
      dashboard: { projects: [project], timeZone: 'UTC', agentName: 'Jarvis' },
    });
    const reel = await approvals.propose(project, { kind: 'reel', title: 'R', queue: 'content' });
    await approvals.decide(reel.id, { option: 'Approve', by: 'U1', via: 'dashboard' });
    store.startItems([reel.id]);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { queues } = (await fetch(`${base}/queues?project=shop&upcoming=3`).then((r) => r.json())) as {
      queues: Array<{ name: string; executor: string; nextSlots: number[]; lastKind: string | null }>;
    };
    const content = queues.find((q) => q.name === 'content');
    expect(content?.executor).toBe('url');
    expect(content?.lastKind).toBe('reel');
    expect(content?.nextSlots).toHaveLength(3);
    expect(queues.find((q) => q.name === 'outreach')?.executor).toBe('external');
    server.close();
  });

  it('needs the unlock cookie (and another device), then decides and renders the card', async () => {
    const { project, store, approvals } = setup();
    const item = await approvals.propose(project, {
      kind: 'note',
      title: 'Jane <CTO>',
      queue: 'linkedin',
      fields: [note('hello')],
    });
    const start = (decisionsFromLocal: boolean) =>
      startHttpServer({
        bind: '127.0.0.1',
        port: 0,
        scheduler: { list: () => [], plannedRuns: () => [] } as unknown as Scheduler,
        store,
        approvals,
        adminToken: 'open-sesame',
        decisionsFromLocal,
        projects: ['shop'],
        log: silent,
        dashboard: { projects: [project], timeZone: 'UTC', agentName: 'Jarvis' },
      });
    const local = await start(false);
    const localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    const refused = await fetch(`${localBase}/items/${item.id}/decide`, {
      method: 'POST',
      headers: { cookie: 'tara_admin=open-sesame' },
      body: JSON.stringify({ option: 'Approve' }),
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/another device/);
    local.close();

    const server = await start(true);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const noCookie = await fetch(`${base}/items/${item.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ option: 'Approve' }),
    });
    expect(noCookie.status).toBe(403);

    const wrong = await fetch(`${base}/unlock`, {
      method: 'POST',
      body: 'token=nope',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(wrong.status).toBe(403);
    const unlock = await fetch(`${base}/unlock`, {
      method: 'POST',
      body: 'token=open-sesame',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    expect(unlock.status).toBe(303);
    const cookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0] as string;

    const page = await fetch(`${base}/approvals`, { headers: { accept: 'text/html', cookie } }).then((r) =>
      r.text(),
    );
    expect(page).toContain('Jane &lt;CTO&gt;');
    expect(page).toContain('data-decide="Approve"');
    expect(page).not.toContain('can look but not decide');

    const ok = await fetch(`${base}/items/${item.id}/decide`, {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ option: 'Approve', fields: { note: 'edited' } }),
    });
    expect(ok.status).toBe(200);
    expect(store.getItem(item.id)).toMatchObject({ status: 'approved', decidedBy: 'U1' });
    expect(store.getItem(item.id)?.fields[0]?.value).toBe('edited');
    server.close();
  });
});

describe('a decision continues the job as the job', () => {
  it('resumes the same session with the job lock held and the decision as the prompt', async () => {
    const project = makeProject();
    const store = new Store(':memory:');
    const chat = new FakeChat('ts');
    const calls: RunOptions[] = [];
    const ok = (text: string): RunOutcome => ({
      status: 'ok',
      text,
      sessionId: 'sid',
      durationMs: 1,
      toolCalls: 0,
      permissionDenials: [],
    });
    const scheduler = new Scheduler({
      projects: [project],
      host: testHost(),
      store,
      chat,
      log: silent,
      env: {},
      newSessionId: () => 'sid',
      run: async (o) => {
        calls.push(o);
        o.onEvent?.({ kind: 'init', sessionId: 'sid', model: 'm' });
        return ok(calls.length === 1 ? 'Asked for approval.' : 'Done after approval.');
      },
    });
    scheduler.start();
    scheduler.trigger('shop', 'sender', 'api');
    await scheduler.idle();
    const root = chat.posts[0]?.ts as string;
    const status = await scheduler.resume('shop', 'sender', {
      threadTs: root,
      text: 'USER DECISION on "X": Approve',
      by: 'U1',
    });
    await scheduler.stop();
    expect(status).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['--resume', 'sid']));
    expect(calls[1]?.prompt).toBe('USER DECISION on "X": Approve');
    expect(chat.posts.at(-1)).toMatchObject({
      thread: root,
      text: expect.stringContaining('continuing after your decision'),
    });
  });
});

describe('queue executors', () => {
  it('a job without cron is never scheduled, and a paused executor holds its queue', async () => {
    const project = makeProject();
    writeFileSync(
      path.join(project.dir, '.tara', 'jobs.json'),
      JSON.stringify({ jobs: [{ id: 'sender', name: 'Sender', prompt: 'Send.', enabled: false }] }),
    );
    const store = new Store(':memory:');
    const scheduler = new Scheduler({
      projects: [project],
      host: testHost(),
      store,
      chat: new FakeChat('ts'),
      log: silent,
      env: {},
      run: async () => ({ status: 'ok', text: 'x', durationMs: 1, toolCalls: 0, permissionDenials: [] }),
    });
    scheduler.start();
    expect(scheduler.list('shop')[0]).toMatchObject({ id: 'sender', cron: undefined, nextRun: undefined });
    expect(scheduler.plannedRuns('shop', 0, Date.now() + 86_400_000, 10)).toEqual([]);
    expect(scheduler.enabled('shop', 'sender')).toBe(false);

    const now = TUE_9_UTC;
    const approvals = new Approvals({
      store,
      chat: new FakeChat('ts'),
      log: silent,
      projects: [project],
      timeZone: 'UTC',
      now: () => now,
    });
    const item = await approvals.propose(project, {
      kind: 'note',
      title: 'Lead',
      queue: 'linkedin',
      window: 'EU',
    });
    await approvals.decide(item.id, { option: 'Approve', by: 'U1', via: 'dashboard' });
    const worker = new QueueWorker({
      projects: [project],
      store,
      log: silent,
      timeZone: 'UTC',
      now: () => now,
      jobs: scheduler,
    });
    await worker.tick();
    expect(store.getItem(item.id)?.status).toBe('approved');
    await scheduler.stop();
  });
});

describe('closing options and the project hook', () => {
  it('never runs an external queue: its project reports each item, and hears about a cancel', async () => {
    const hooks: string[] = [];
    const fetchFake = (async (_url: string, init: RequestInit) => {
      const { event, item } = JSON.parse(init.body as string);
      hooks.push(`${event}:${item.status}`);
      return new Response('{}');
    }) as unknown as typeof fetch;
    const { project, store, approvals } = setup({
      now: () => TUE_9_UTC,
      fetch: fetchFake,
      project: makeProject({ approvals: { hookUrl: 'http://board/hook' } }),
    });
    const worker = new QueueWorker({
      projects: [project],
      store,
      log: silent,
      timeZone: 'UTC',
      now: () => TUE_9_UTC,
      jobs: { runQueue: async () => 'ok', enabled: () => true },
    });
    const a = await approvals.propose(project, {
      kind: 'linkedin-outreach',
      title: 'Ann',
      queue: 'outreach',
      window: 'EU',
    });
    const b = await approvals.propose(project, {
      kind: 'linkedin-outreach',
      title: 'Bo',
      queue: 'outreach',
      window: 'EU',
    });
    for (const i of [a, b]) await approvals.decide(i.id, { option: 'Approve', by: 'U1', via: 'dashboard' });
    await worker.tick();
    await worker.idle();
    expect(store.getItem(a.id)?.status).toBe('approved'); // the window is open, but tara-agent never starts it

    expect(approvals.report(a.id, 'waiting', 'comment posted').result).toBe('comment posted');
    expect(approvals.report(a.id, 'done', 'note sent')).toMatchObject({
      status: 'done',
      result: 'note sent',
    });
    expect(() => approvals.report(a.id, 'done')).toThrow(/Already done/);
    approvals.cancel(b.id, 'U1');
    await new Promise((r) => setTimeout(r, 10));
    expect(hooks).toEqual(['decided:approved', 'decided:approved', 'finished:done', 'decided:cancelled']);

    const pending = await approvals.propose(project, {
      kind: 'linkedin-outreach',
      title: 'Di',
      queue: 'outreach',
    });
    expect(approvals.withdraw(pending.id, 'sent by hand')).toMatchObject({
      status: 'cancelled',
      result: 'sent by hand',
    });
    expect(() => approvals.withdraw(pending.id)).toThrow(/Already cancelled/);

    const other = await approvals.propose(project, { kind: 'note', title: 'Cy', queue: 'linkedin' });
    await approvals.decide(other.id, { option: 'Approve', by: 'U1', via: 'dashboard' });
    expect(() => approvals.report(other.id, 'done')).toThrow(/external queue/);
  });

  it('only the first option runs a draft; the project server gets signed decided and finished notes', async () => {
    const hooks: Array<{ event: string; item: Item; signature: string; body: string }> = [];
    const fetchFake = (async (_url: string, init: RequestInit) => {
      const body = init.body as string;
      hooks.push({
        ...JSON.parse(body),
        signature: (init.headers as Record<string, string>)['x-tara-signature'],
        body,
      });
      return new Response('{}');
    }) as unknown as typeof fetch;
    const { project, approvals, store } = setup({
      fetch: fetchFake,
      project: makeProject({ approvals: { hookUrl: 'http://board/hook' } }),
    });
    const opts = { kind: 'application', queue: 'linkedin', options: ['Approve', 'Skip', 'Applied by hand'] };
    const byHand = await approvals.propose(project, { ...opts, title: 'Acme' });
    const decided = await approvals.decide(byHand.id, {
      option: 'Applied by hand',
      by: 'U1',
      via: 'dashboard',
    });
    expect(decided).toMatchObject({
      status: 'done',
      decision: 'Applied by hand',
      seal: undefined,
      runNow: false,
    });
    const skip = await approvals.propose(project, { ...opts, title: 'Beta' });
    expect((await approvals.decide(skip.id, { option: 'Skip', by: 'U1', via: 'dashboard' })).status).toBe(
      'rejected',
    );
    const go = await approvals.propose(project, { ...opts, title: 'Gamma' });
    expect(
      (await approvals.decide(go.id, { option: 'Approve', by: 'U1', via: 'dashboard', runNow: true })).status,
    ).toBe('approved');
    store.startItems([go.id]);
    approvals.notify(store.finishItem(go.id, 'done', 'applied') as Item, 'finished');
    await new Promise((r) => setTimeout(r, 10));

    expect(hooks.map((h) => `${h.event}:${h.item.title}:${h.item.status}`)).toEqual([
      'decided:Acme:done',
      'decided:Beta:rejected',
      'decided:Gamma:approved',
      'finished:Gamma:done',
    ]);
    const { createHmac } = await import('node:crypto');
    for (const h of hooks) expect(h.signature).toBe(createHmac('sha256', KEY).update(h.body).digest('hex'));
  });
});
