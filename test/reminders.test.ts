import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Project, ProjectConfig } from '../src/config/schema.js';
import { repeatText } from '../src/http/reminders-page.js';
import { startHttpServer } from '../src/http/server.js';
import { Reminders } from '../src/reminders/reminders.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import type { IncomingMessage } from '../src/sessions/manager.js';
import { Store } from '../src/store/store.js';
import { FakeChat } from './fakes.js';

const silent = { info() {}, warn() {}, error() {} };
// Sat 14 Nov 2026, 04:00 UTC = 09:30 in Asia/Kolkata.
const START = Date.parse('2026-11-14T04:00:00Z');
const MIN = 60_000;

function project(overrides: Partial<ProjectConfig> = {}): Project {
  return {
    dir: '/repo',
    config: {
      name: 'shop',
      slackChannel: 'C1',
      permissionMode: 'default',
      chatModel: 'sonnet',
      allowedTools: [],
      allowedUsers: [],
      billing: 'subscription',
      selfImprove: 'trouble',
      owner: 'U1',
      ...overrides,
    },
  };
}

function setup(p = project(), hook?: (body: unknown) => Response) {
  const chat = new FakeChat('ts');
  const store = new Store(':memory:');
  let clock = START;
  let n = 0;
  const hooked: unknown[] = [];
  const runs: IncomingMessage[] = [];
  const reminders = new Reminders({
    startRun: async (msg) => {
      runs.push(msg);
    },
    store,
    chat,
    projects: [p],
    timeZone: 'Asia/Kolkata',
    log: silent,
    now: () => clock,
    newId: () => `r${++n}`,
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      hooked.push(body);
      return hook ? hook(body) : new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  const at = (ms: number) => {
    clock = ms;
  };
  return { chat, store, reminders, hooked, runs, at };
}

describe('Reminders', () => {
  it('posts a one-off reminder once, in its own Run Reminder thread, mentioning the owner', async () => {
    const { chat, reminders, at } = setup();
    reminders.add('shop', { text: 'Call the bank', at: '2026-11-14T10:00:00+05:30' });
    await reminders.tick();
    expect(chat.posts).toEqual([]);
    at(START + 30 * MIN);
    await reminders.tick();
    await reminders.tick();
    expect(chat.log).toEqual(['post top ts1: Run Reminder', 'post ts1 ts2: <@U1> ⏰ Call the bank']);
    expect(reminders.list('shop')).toEqual([]);
  });

  it('moves a repeating reminder on to its next time in the host timezone', async () => {
    const { chat, reminders, at } = setup();
    const r = reminders.add('shop', { text: 'File GSTR-3B', cron: '30 9 19 * *' });
    expect(new Date(r.nextAt as number).toISOString()).toBe('2026-11-19T04:00:00.000Z');
    at(Date.parse('2026-11-19T04:00:00Z'));
    await reminders.tick();
    expect(chat.texts()).toEqual(['Run Reminder', '<@U1> ⏰ File GSTR-3B']);
    expect(new Date(reminders.list('shop')[0]?.nextAt as number).toISOString()).toBe(
      '2026-12-19T04:00:00.000Z',
    );
  });

  it('says a reminder is late when tara-agent was down at its time, and posts a missed repeat only once', async () => {
    const { chat, reminders, at } = setup();
    reminders.add('shop', { text: 'Stand up', cron: '0 10 * * *' });
    at(Date.parse('2026-11-17T08:00:00Z'));
    await reminders.tick();
    expect(chat.texts()).toEqual(['Run Reminder', '<@U1> ⏰ Stand up (late: was due Sat 14 Nov, 10:00)']);
    expect(new Date(reminders.list('shop')[0]?.nextAt as number).toISOString()).toBe(
      '2026-11-18T04:30:00.000Z',
    );
  });

  it('sends a notify reminder through the project hook too, and says when the hook fails', async () => {
    const ok = setup(project({ reminders: { hookUrl: 'http://127.0.0.1:4001/hook' } }));
    ok.reminders.add('shop', { text: 'GSTR-1 due', at: START + MIN, notify: true });
    ok.at(START + MIN);
    await ok.reminders.tick();
    expect(ok.hooked).toEqual([{ id: 'r1', text: '⏰ GSTR-1 due' }]);
    expect(ok.chat.texts().at(-1)).toBe('✅ Also sent through the reminder hook');

    const bad = setup(project({ reminders: { hookUrl: 'http://127.0.0.1:4001/hook' } }), () => {
      return new Response('WAHA down', { status: 502 });
    });
    bad.reminders.add('shop', { text: 'GSTR-1 due', at: START + MIN, notify: true });
    bad.at(START + MIN);
    await bad.reminders.tick();
    expect(bad.chat.texts().at(-1)).toBe('⚠️ Not sent to the reminder hook: 502 WAHA down');
  });

  it('never calls the hook for a reminder without notify', async () => {
    const { reminders, hooked, at } = setup(
      project({ reminders: { hookUrl: 'http://127.0.0.1:4001/hook' } }),
    );
    reminders.add('shop', { text: 'Slack only', at: START + MIN });
    at(START + MIN);
    await reminders.tick();
    expect(hooked).toEqual([]);
  });

  it('refuses reminders it could not keep', () => {
    const { reminders } = setup();
    expect(() => reminders.add('shop', { text: 'x' })).toThrow(/either "cron"/);
    expect(() => reminders.add('shop', { text: 'x', cron: '0 9 * * *', at: START + MIN })).toThrow(
      /either "cron"/,
    );
    expect(() => reminders.add('shop', { text: 'x', at: '2026-11-19T09:30:00' })).toThrow(/offset/);
    expect(() => reminders.add('shop', { text: 'x', at: START - MIN })).toThrow(/past/);
    expect(() => reminders.add('shop', { text: 'x', cron: 'every day' })).toThrow(/not a cron/);
    expect(() => reminders.add('shop', { text: ' ', at: START + MIN })).toThrow(/required/);
    expect(() => reminders.add('shop', { text: 'x', at: START + MIN, notify: true })).toThrow(/hookUrl/);
    expect(() => reminders.add('other', { text: 'x', at: START + MIN })).toThrow(/No project/);
  });

  it('cancels a reminder so it is never posted', async () => {
    const { chat, reminders, at } = setup();
    const r = reminders.add('shop', { text: 'Drop me', cron: '0 10 * * *' });
    expect(reminders.cancel('shop', r.id)).toBe(true);
    expect(reminders.cancel('shop', r.id)).toBe(false);
    at(START + 3 * 86_400_000);
    await reminders.tick();
    expect(chat.posts).toEqual([]);
  });

  it('keeps reminders across a restart (they live in the store)', async () => {
    const { store, chat, reminders } = setup();
    reminders.add('shop', { text: 'Survive', at: START + MIN });
    const again = new Reminders({
      store,
      chat,
      projects: [project()],
      timeZone: 'Asia/Kolkata',
      log: silent,
      now: () => START + MIN,
    });
    await again.tick();
    expect(chat.texts()).toEqual(['Run Reminder', '<@U1> ⏰ Survive']);
  });
});

describe('Scheduled tasks', () => {
  it('starts one run at its time, in a fresh Run <title> thread holding the note, then is gone', async () => {
    const { chat, reminders, runs, at } = setup();
    const note = 'Check CI of PR 142 in acme/shop; if green, tell <@U7> it can be merged.';
    reminders.add('shop', {
      text: note,
      at: START + 30 * MIN,
      task: true,
      title: 'Check PR 142 CI',
      by: 'U7',
    });
    expect(reminders.list('shop')).toMatchObject([{ task: true, title: 'Check PR 142 CI' }]);
    await reminders.tick();
    expect(runs).toEqual([]);
    at(START + 30 * MIN);
    await reminders.tick();
    await reminders.tick();
    expect(chat.log).toEqual([
      'post top ts1: Run Check PR 142 CI',
      `post ts1 ts2: 📝 Scheduled task, set by <@U7> Sat 14 Nov, 09:30 for Sat 14 Nov, 10:00:\n${note}`,
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ channel: 'C1', threadTs: 'ts1', ts: 'ts2', user: 'U7' });
    expect(runs[0]?.text).toContain(note);
    expect(reminders.list('shop')).toEqual([]);
  });

  it('runs as the project owner when a job set it, and says when it is late', async () => {
    const { chat, reminders, runs, at } = setup();
    reminders.add('shop', { text: 'Recheck stock', at: START + MIN, task: true, by: 'stock-audit' });
    at(START + MIN + 60 * MIN);
    await reminders.tick();
    expect(chat.texts()[0]).toBe('Run Scheduled Task');
    expect(chat.texts()[1]).toContain('set by stock-audit');
    expect(chat.texts()[1]).toContain('(late: was due Sat 14 Nov, 09:31)');
    expect(runs[0]?.user).toBe('U1');
  });

  it('skips a task missed by more than the catch-up window instead of running it stale', async () => {
    const { chat, reminders, runs, at } = setup();
    reminders.add('shop', { text: 'Post the 9am update', at: START + MIN, task: true });
    at(START + 7 * 3_600_000);
    await reminders.tick();
    expect(runs).toEqual([]);
    expect(chat.texts().at(-1)).toBe(
      '⏭ Skipped: tara-agent was down at its time. Ask here if it is still needed.',
    );
    expect(chat.reactions).toEqual(['+double_vertical_bar@ts1']);
    expect(reminders.list('shop')).toEqual([]);
  });

  it('refuses tasks it could not keep', () => {
    const { reminders } = setup(project({ reminders: { hookUrl: 'http://127.0.0.1:4001/hook' } }));
    expect(() => reminders.add('shop', { text: 'x', cron: '0 9 * * *', task: true })).toThrow(/runs once/);
    expect(() => reminders.add('shop', { text: 'x', task: true })).toThrow(/runs once/);
    expect(() => reminders.add('shop', { text: ' ', at: START + MIN, task: true })).toThrow(/note/);
    expect(() => reminders.add('shop', { text: 'x', at: START + MIN, task: true, notify: true })).toThrow(
      /notify/,
    );
    expect(() =>
      reminders.add('shop', { text: 'x', at: START + MIN, task: true, title: 'T'.repeat(81) }),
    ).toThrow(/title/);
    expect(reminders.add('shop', { text: 'y'.repeat(3000), at: START + MIN, task: true }).task).toBe(true);
    const off = new Reminders({
      store: new Store(':memory:'),
      chat: new FakeChat('ts'),
      projects: [project()],
      timeZone: 'Asia/Kolkata',
      log: silent,
      now: () => START,
    });
    expect(() => off.add('shop', { text: 'x', at: START + MIN, task: true })).toThrow(/off/);
  });
});

describe('Reminders API', () => {
  it('adds, lists and cancels through the local API', async () => {
    const { store, reminders } = setup();
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store,
      reminders,
      projects: ['shop'],
      log: silent,
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: object) =>
      fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({
        status: r.status,
        json: (await r.json()) as { id?: string; error?: string },
      }));
    try {
      const added = await post('/reminders/shop', {
        text: 'File GSTR-1',
        cron: '30 9 10 * *',
        by: 'migration',
      });
      expect(added.status).toBe(200);
      const bad = await post('/reminders/shop', { text: 'No time' });
      expect(bad).toEqual({ status: 400, json: { error: 'Give either "cron" (repeating) or "at" (once)' } });
      const listed = (await fetch(`${base}/reminders?project=shop`).then((r) => r.json())) as {
        reminders: { id: string; text: string; createdBy: string }[];
      };
      expect(listed.reminders.map((r) => [r.text, r.createdBy])).toEqual([['File GSTR-1', 'migration']]);
      expect((await post(`/reminders/shop/${added.json.id}/cancel`, {})).status).toBe(200);
      expect((await post(`/reminders/shop/${added.json.id}/cancel`, {})).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('Reminders page', () => {
  it('lists each project reminder with its next time, schedule, hook label and a Cancel button', async () => {
    const p = project({
      title: 'Shop',
      reminders: { hookUrl: 'http://127.0.0.1:4001/hook', label: 'Ops WhatsApp' },
    });
    const { store, reminders } = setup(p);
    reminders.add('shop', { text: 'File GSTR-3B', cron: '30 9 19 * *', notify: true });
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store,
      reminders,
      projects: ['shop'],
      log: silent,
      dashboard: { projects: [p], timeZone: 'Asia/Kolkata', agentName: 'Jarvis' },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const html = await fetch(`${base}/reminders`, { headers: { accept: 'text/html' } }).then((r) =>
        r.text(),
      );
      expect(html).toContain('href="/reminders" class="nav-item on"');
      expect(html).toContain('File GSTR-3B');
      expect(html).toContain('🔁 Every month on the 19th at 9:30 AM');
      expect(html).toContain('Next: <span class="when">Thu 19 Nov, 9:30 am</span>');
      expect(html).toContain('+ Ops WhatsApp');
      expect(html).toContain('data-cancel="shop/r1"');
      reminders.add('shop', {
        text: 'Check CI of PR 142',
        at: START + MIN,
        task: true,
        title: 'Check PR 142',
      });
      const withTask = await fetch(`${base}/reminders`, { headers: { accept: 'text/html' } }).then((r) =>
        r.text(),
      );
      expect(withTask).toContain('<span class="title">Check PR 142</span>');
      expect(withTask).toContain('▶️ Task: starts a run');
      expect(withTask).toContain('Check CI of PR 142');
      const home = await fetch(`${base}/`, { headers: { accept: 'text/html' } }).then((r) => r.text());
      expect(home).toContain('href="/reminders"');
    } finally {
      server.close();
    }
  });
});

describe('repeatText', () => {
  it('says how often in plain English', () => {
    const tz = 'Asia/Kolkata';
    expect(repeatText('30 9 19 * *', tz)).toBe('Every month on the 19th at 9:30 AM');
    expect(repeatText('0 10 * * *', tz)).toBe('Every day at 10:00 AM');
    expect(repeatText('0 9 * * 1', tz)).toBe('Every Mon at 9:00 AM');
    expect(repeatText('*/10 * * * *', tz)).toBe('Every 10 min');
    expect(repeatText('0 9 1 1 *', tz)).toBe('Repeats on a custom schedule (see Details)');
  });
});
