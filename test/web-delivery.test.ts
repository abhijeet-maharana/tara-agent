import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { SessionManager } from '../src/sessions/manager.js';
import { Threads } from '../src/sessions/threads.js';
import { Store } from '../src/store/store.js';
import { RoutedChat, WebChat, webChannel } from '../src/web/chat.js';
import { notificationLine, summaryText } from '../src/web/summary.js';
import { FakeChat, testHost } from './fakes.js';

const quiet = { info() {}, warn() {}, error() {} };

function makeProject(jobs: object[], extra: object = {}): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-web-'));
  mkdirSync(path.join(dir, '.tara'));
  writeFileSync(path.join(dir, '.tara', 'jobs.json'), JSON.stringify({ jobs }));
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
      selfImprove: 'off',
      owner: 'U1',
      ...extra,
    },
    systemPrompt: '',
  };
}

const ok = (text: string): RunOutcome => ({
  status: 'ok',
  text,
  sessionId: 'sid',
  model: 'claude-haiku-5-5',
  durationMs: 2000,
  toolCalls: 1,
  permissionDenials: [],
});

const job = {
  id: 'prime',
  name: 'Prime Check',
  cron: '0 * * * *',
  tz: 'UTC',
  skills: ['prime'],
  model: 'haiku',
};

function routed(store: Store) {
  const slack = new FakeChat('sl.');
  const web = new WebChat(store, mkdtempSync(path.join(tmpdir(), 'tara-webstate-')));
  const chat = new RoutedChat(slack, web, {
    store,
    log: quiet,
    slackChannelFor: () => 'C1',
    link: (channel, ts) => `https://dash.example/t/${channel}/${ts}`,
  });
  return { slack, web, chat };
}

function setup(opts: {
  jobs?: object[];
  replies?: string[];
  project?: Project;
  status?: RunOutcome['status'];
  store?: Store;
  now?: () => number;
}) {
  const store = opts.store ?? new Store(':memory:');
  const { slack, web, chat } = routed(store);
  const calls: RunOptions[] = [];
  const replies = [...(opts.replies ?? [])];
  const scheduler = new Scheduler({
    projects: [opts.project ?? makeProject(opts.jobs ?? [job])],
    host: testHost(),
    store,
    chat,
    threads: new Threads(),
    log: quiet,
    env: { PATH: '/bin' },
    newSessionId: () => 'sid',
    now: opts.now,
    threadUrl: (channel, ts) => `https://dash.example/t/${channel}/${ts}`,
    run: async (o) => {
      calls.push(o);
      o.onEvent?.({ kind: 'init', sessionId: 'sid', model: 'claude-haiku-5-5' });
      o.onEvent?.({ kind: 'tool', id: 't1', name: 'Bash', status: 'Bash: curl' });
      o.onEvent?.({ kind: 'tool_result', id: 't1', isError: false });
      const reply = replies.shift() ?? '✅ Amazon Prime is on again\n---\nChecked the account page.';
      o.onEvent?.({ kind: 'text_start' });
      o.onEvent?.({ kind: 'text', text: reply });
      return opts.status ? { ...ok(''), status: opts.status } : ok(reply);
    },
  });
  return { store, slack, web, chat, calls, scheduler };
}

describe('dashboard delivery', () => {
  it('runs a job on the dashboard and posts only its headline in Slack', async () => {
    const { store, slack, web, calls, scheduler } = setup({});
    scheduler.start();
    expect(scheduler.trigger('shop', 'prime', 'dashboard')).toBe('started');
    await scheduler.idle();

    // Nothing but the summary in Slack: no "Run Prime Check", no status line, no streamed thread.
    expect(slack.posts).toEqual([]);
    expect(slack.blockPosts).toHaveLength(1);
    const summary = slack.blockPosts[0];
    expect(summary?.thread).toBe('');
    expect(summary?.text).toBe('Prime Check: ✅ Amazon Prime is on again');
    // The job's name first, then its headline.
    expect(summary?.blocks[0]).toMatchObject({
      type: 'section',
      text: { text: '*Prime Check* (run from the dashboard)' },
    });
    const shown = JSON.stringify(summary?.blocks);
    expect(shown).toContain('Amazon Prime is on again');
    expect(shown).not.toContain('Checked the account page');
    expect(shown).toContain('https://dash.example/t/web-shop/');
    expect(shown).toContain('Full details');

    // The run lives in a dashboard thread: its session, its env, its whole reply.
    const key = calls[0]?.env.TARA_THREAD as string;
    expect(key.startsWith('web-shop:')).toBe(true);
    const [channel, ts] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    expect(store.getSession(key)?.sessionId).toBe('sid');
    const thread = web.files(channel, ts);
    expect(thread).toEqual([]);
    const texts = store.webThread(channel, ts).map((m) => m.text);
    expect(texts[0]).toBe('Run Prime Check');
    expect(texts.join('\n')).toContain('Checked the account page.');
    // A reply under the summary continues that session.
    expect(store.threadAlias(`C1:${summary?.ts}`)).toBe(key);
    await scheduler.stop();
  });

  it('starts a scheduled slot itself, with no "Run <job>" message in Slack', async () => {
    let now = Date.parse('2026-10-25T10:20:00Z');
    const store = new Store(':memory:', () => now);
    const first = setup({ store, now: () => now });
    first.scheduler.start(); // first sight of the job: nothing to catch up
    await first.scheduler.stop();
    now = Date.parse('2026-10-25T12:30:00Z');
    const { slack, calls, scheduler } = setup({ store, now: () => now });
    scheduler.start(); // the 12:00 slot was missed: caught up on the dashboard
    await new Promise((r) => setImmediate(r));
    await scheduler.idle();
    expect(calls).toHaveLength(1);
    expect(slack.posts).toEqual([]);
    expect(slack.blockPosts.map((b) => b.text)).toEqual(['Prime Check: ✅ Amazon Prime is on again']);
    expect(JSON.stringify(slack.blockPosts[0]?.blocks)).toContain('(catch-up)');
    expect(store.slotClaim('shop:prime', Date.parse('2026-10-25T12:00:00Z'))?.status).toBe('ok');
    await scheduler.stop();
  });

  it('posts nothing in Slack for a run with nothing to report, or one a person stopped', async () => {
    for (const s of [setup({ replies: [''] }), setup({ status: 'aborted' })]) {
      s.scheduler.start();
      s.scheduler.trigger('shop', 'prime', 'dashboard');
      await s.scheduler.idle();
      expect(s.slack.blockPosts).toEqual([]);
      expect(s.slack.posts).toEqual([]);
      await s.scheduler.stop();
    }
  });

  it('says in Slack when a run fails or times out', async () => {
    const failed = setup({ replies: ['❌ Login expired\n---\nThe page asked for a password.'] });
    failed.scheduler.start();
    failed.scheduler.trigger('shop', 'prime', 'dashboard');
    await failed.scheduler.idle();
    expect(failed.slack.blockPosts[0]?.text).toBe('Prime Check: ❌ Login expired');
    await failed.scheduler.stop();

    const late = setup({ status: 'timeout' });
    late.scheduler.start();
    late.scheduler.trigger('shop', 'prime', 'dashboard');
    await late.scheduler.idle();
    expect(late.slack.blockPosts[0]?.text).toMatch(/^Prime Check: ⌛ Timed out after/);
    await late.scheduler.stop();
  });

  it('keeps a job on `delivery: thread` in its Slack thread', async () => {
    const { slack, scheduler } = setup({ jobs: [{ ...job, delivery: 'thread' }] });
    scheduler.start();
    scheduler.trigger('shop', 'prime', 'dashboard');
    await scheduler.idle();
    expect(slack.posts[0]).toMatchObject({ thread: '', text: 'Run Prime Check' });
    await scheduler.stop();
  });

  it('keeps a project on `delivery: thread` in Slack', async () => {
    const { slack, scheduler } = setup({ project: makeProject([job], { delivery: 'thread' }) });
    scheduler.start();
    scheduler.trigger('shop', 'prime', 'dashboard');
    await scheduler.idle();
    expect(slack.posts[0]?.text).toBe('Run Prime Check');
    await scheduler.stop();
  });

  it('runs a job asked for in a Slack thread in that thread', async () => {
    const { slack, scheduler } = setup({});
    scheduler.start();
    scheduler.trigger('shop', 'prime', 'U1', { channel: 'C1', ts: '500.1' });
    await scheduler.idle();
    expect(slack.posts[0]?.thread).toBe('500.1');
    // No separate summary: the person is in the thread already.
    expect(slack.blockPosts.filter((b) => b.thread === '')).toEqual([]);
    await scheduler.stop();
  });

  it('attaches the files a run sent to its summary', async () => {
    const store = new Store(':memory:');
    const { slack, chat } = routed(store);
    const scheduler = new Scheduler({
      projects: [makeProject([job])],
      host: testHost(),
      store,
      chat,
      log: quiet,
      env: { PATH: '/bin' },
      newSessionId: () => 'sid',
      run: async (o) => {
        const key = o.env.TARA_THREAD as string;
        const at = key.indexOf(':');
        await chat.uploadFile(key.slice(0, at), key.slice(at + 1), {
          name: 'labels.pdf',
          data: Buffer.from('%PDF'),
        });
        return ok('✅ 3 Meesho labels downloaded\n\n| Order | SKU |\n|---|---|\n| 1 | A |');
      },
    });
    scheduler.start();
    scheduler.trigger('shop', 'prime', 'dashboard');
    await scheduler.idle();
    const summary = slack.blockPosts[0];
    // A table goes as a markdown block, so Slack draws it.
    expect(summary?.blocks[1]).toMatchObject({ type: 'markdown' });
    expect(slack.uploads).toEqual([
      { thread: summary?.ts, file: 'labels.pdf', data: '%PDF', comment: undefined },
    ]);
    await scheduler.stop();
  });
});

describe('RoutedChat', () => {
  it('copies a card with buttons to Slack, keeps it in step, and sends replies there to the run', async () => {
    const store = new Store(':memory:');
    const { slack, chat } = routed(store);
    const channel = webChannel('shop');
    const root = await chat.post(channel, undefined, 'Run Prime Check');
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'Approve?' } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'tara:approval:0', value: 'i1' }] },
    ];
    const card = await chat.postBlocks(channel, root, 'Approval needed', blocks);
    expect(slack.blockPosts).toHaveLength(1);
    const copy = slack.blockPosts[0];
    expect(copy?.thread).toBe('');
    expect(JSON.stringify(copy?.blocks)).toContain(`https://dash.example/t/${channel}/${root}`);
    expect(store.threadAlias(`C1:${copy?.ts}`)).toBe(`${channel}:${root}`);

    await chat.update(channel, card, 'Decided', [
      { type: 'section', text: { type: 'mrkdwn', text: '✅ Approve' } },
    ]);
    expect(slack.updates[0]?.ts).toBe(copy?.ts);
    expect(store.getWebMessage(channel, card)?.text).toBe('Decided');

    // Plain messages stay on the dashboard.
    await chat.post(channel, root, '⏳ working');
    expect(slack.posts).toEqual([]);
  });

  it('streams into a dashboard message', async () => {
    const store = new Store(':memory:');
    const { chat } = routed(store);
    const port = chat.streamFor('web-shop');
    const ts = await port?.start('web-shop', '1.0', 'dashboard');
    await port?.append('web-shop', ts as string, [
      { type: 'plan_update', title: '⏳ Working…' },
      { type: 'task_update', id: 't1', title: 'Bash: curl', status: 'in_progress' },
      { type: 'markdown_text', text: 'Hello ' },
    ]);
    await port?.append('web-shop', ts as string, [
      { type: 'task_update', id: 't1', title: 'Bash: curl', status: 'complete' },
      { type: 'markdown_text', text: 'world' },
    ]);
    await port?.stop('web-shop', ts as string);
    const m = store.getWebMessage('web-shop', ts as string);
    expect(m?.text).toBe('Hello world');
    expect(m?.data).toMatchObject({ done: true, tasks: [{ id: 't1', status: 'complete' }] });
  });
});

describe('summaries', () => {
  it('keeps the headline and its table, and leaves the details for the dashboard', () => {
    expect(summaryText('✅ Done\n| a | b |\n|---|---|\n| 1 | 2 |\n---\nlots more')).toEqual({
      text: '✅ Done\n| a | b |\n|---|---|\n| 1 | 2 |',
      cut: true,
    });
    expect(summaryText('✅ No new notices')).toEqual({ text: '✅ No new notices', cut: false });
    expect(summaryText('x\n'.repeat(4000)).text.length).toBeLessThanOrEqual(2_800);
  });

  it('drops the run name Claude repeats at the start of its headline', async () => {
    const { withoutName } = await import('../src/web/summary.js');
    expect(withoutName('✅ Prime Check: Prime is on\n| a |', '*Prime Check* (catch-up)')).toBe(
      '✅ Prime is on\n| a |',
    );
    expect(withoutName('✅ Amazon Prime is on again', '*Prime Check*')).toBe('✅ Amazon Prime is on again');
  });

  it('makes a plain notification line', () => {
    expect(notificationLine('**✅ Prime** is [on](https://x.y)\nmore')).toBe('✅ Prime is on');
    expect(notificationLine('| a |\n|---|\n✅ After')).toBe('✅ After');
  });
});

describe('SessionManager with dashboard threads', () => {
  it('answers a reply under a Slack summary in Slack, in the dashboard run’s session', async () => {
    const store = new Store(':memory:');
    const { slack, chat } = routed(store);
    const calls: RunOptions[] = [];
    const manager = new SessionManager({
      projects: [makeProject([])],
      host: testHost(),
      store,
      chat,
      log: quiet,
      env: { PATH: '/bin' },
      newSessionId: () => 'fresh',
      run: async (o) => {
        calls.push(o);
        return ok('Because the page said so.');
      },
    });
    store.saveSession({
      threadKey: 'web-shop:1.0',
      project: 'shop',
      sessionId: 'jobsid',
      model: 'haiku',
      started: true,
    });
    store.saveThreadAlias('C1:9.9', 'web-shop:1.0');
    await manager.handle({ channel: 'C1', threadTs: '9.9', ts: '9.95', user: 'U1', text: 'why?' });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--resume', 'jobsid']));
    expect(calls[0]?.env.TARA_THREAD).toBe('web-shop:1.0');
    expect(slack.texts().join('\n')).toContain('Because the page said so.');
  });

  it('takes a message typed on the dashboard and answers there, with a Slack summary when asked', async () => {
    const store = new Store(':memory:');
    const { slack, chat } = routed(store);
    const manager = new SessionManager({
      projects: [makeProject([], { allowedUsers: ['U9'] })],
      host: testHost(),
      store,
      chat,
      log: quiet,
      env: { PATH: '/bin' },
      newSessionId: () => 'fresh',
      threadUrl: (c, ts) => `https://dash.example/t/${c}/${ts}`,
      run: async () => ok('✅ Reminder set\n---\nfor 5pm'),
    });
    // From the dashboard (not a Slack member, so allowedUsers doesn't apply), nobody to tell in Slack.
    await manager.handle({ channel: 'web-shop', threadTs: '1.0', ts: '1.1', user: 'U1', text: 'remind me' });
    expect(
      store
        .webThread('web-shop', '1.0')
        .map((m) => m.text)
        .join('\n'),
    ).toContain('Reminder set');
    expect(slack.blockPosts).toEqual([]);
    // A run nobody watches (a scheduled task): its result goes to Slack too.
    await manager.handle({
      channel: 'web-shop',
      threadTs: '2.0',
      ts: '2.0',
      user: 'U1',
      text: 'do the task',
      summary: '*Daily task*',
    });
    expect(slack.blockPosts[0]?.text).toBe('Daily task: ✅ Reminder set');
  });
});

describe('session page', () => {
  it("shows the run's own reply as its result, never a learning turn's notes", async () => {
    const { sessionPage } = await import('../src/http/dashboard.js');
    const store = new Store(':memory:');
    const base = { project: 'shop', sessionId: 's1', status: 'ok' as const };
    store.recordRun({
      ...base,
      kind: 'job',
      jobId: 'prime',
      startedAt: 1,
      endedAt: 2,
      output: '✅ Prime is on',
    });
    store.recordRun({ ...base, kind: 'learn', startedAt: 3, endedAt: 4, output: 'SKILL.md: added a trap' });
    const run = store.latestSessionRun('s1');
    expect(run?.output).toBe('✅ Prime is on');
    const ctx = { projects: [], timeZone: 'UTC', agentName: 'Jarvis' };
    const html = sessionPage(
      ctx,
      undefined,
      's1',
      [{ kind: 'user', text: `Run the job\n${'x\n'.repeat(400)}` }],
      {
        run,
      },
    );
    expect(html).toContain('Result');
    expect(html).toContain('Prime is on');
    expect(html).not.toContain('added a trap');
    expect(html).toContain('The job’s instructions (');
  });
});

describe('dashboard markdown', () => {
  it('draws tables (short rules too) and the details rule', async () => {
    const { md } = await import('../src/http/dashboard.js');
    const html = md('✅ Done\n| # | Co |\n| :-- | --: |\n| 1 | **A** |\n---\nmore');
    expect(html).toContain('<table class="md"><thead><tr><th>#</th><th>Co</th></tr></thead>');
    expect(html).toContain('<td><b>A</b></td>');
    expect(html).toContain('<hr class="md">');
  });
});

describe('sessions list pages', () => {
  it('pages sessions newest first and filters jobs and chats in the query', () => {
    let t = 0;
    const store = new Store(':memory:', () => ++t);
    for (let i = 1; i <= 5; i++) {
      store.saveSession({
        threadKey: `C1:${i}`,
        project: 'shop',
        sessionId: `s${i}`,
        model: 'm',
        started: true,
      });
      store.recordRun({
        kind: i % 2 ? 'job' : 'chat',
        project: 'shop',
        jobId: i % 2 ? 'prime' : undefined,
        threadKey: `C1:${i}`,
        sessionId: `s${i}`,
        startedAt: i * 100,
        endedAt: i * 100 + 1,
        status: 'ok',
      });
    }
    expect(store.sessionsCount()).toBe(5);
    expect(store.sessionsOverview({ limit: 2 }).map((s) => s.sessionId)).toEqual(['s5', 's4']);
    expect(store.sessionsOverview({ limit: 2, offset: 4 }).map((s) => s.sessionId)).toEqual(['s1']);
    expect(store.sessionsCount({ kind: 'job' })).toBe(3);
    expect(store.sessionsOverview({ kind: 'chat' }).map((s) => s.sessionId)).toEqual(['s4', 's2']);
  });
});
