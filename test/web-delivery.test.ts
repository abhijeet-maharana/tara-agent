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
/** A fresh state folder, so the day's quiet-runs file never carries over between tests. */
const tmpState = () => mkdtempSync(path.join(tmpdir(), 'tara-state-'));

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
  stateDir?: string;
}) {
  const store = opts.store ?? new Store(':memory:');
  const { slack, web, chat } = routed(store);
  const calls: RunOptions[] = [];
  const replies = [...(opts.replies ?? [])];
  const scheduler = new Scheduler({
    projects: [opts.project ?? makeProject(opts.jobs ?? [job])],
    host: testHost({ stateDir: opts.stateDir ?? tmpState() }),
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
    // One first line: the status, the job's name, then its headline.
    expect(summary?.blocks[0]).toMatchObject({
      type: 'section',
      text: { text: '✅ *Prime Check* (run from the dashboard) · Amazon Prime is on again' },
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
    const { slack, calls, scheduler } = setup({
      store,
      now: () => now,
      replies: ['⚠️ Amazon Prime was off, turned it on\n---\nChecked the account page.'],
    });
    scheduler.start(); // the 12:00 slot was missed: caught up on the dashboard
    await new Promise((r) => setImmediate(r));
    await scheduler.idle();
    expect(calls).toHaveLength(1);
    expect(slack.posts).toEqual([]);
    expect(slack.blockPosts.map((b) => b.text)).toEqual([
      'Prime Check: ⚠️ Amazon Prime was off, turned it on',
    ]);
    expect(JSON.stringify(slack.blockPosts[0]?.blocks)).toContain('(catch-up)');
    expect(store.slotClaim('shop:prime', Date.parse('2026-10-25T12:00:00Z'))?.status).toBe('ok');
    await scheduler.stop();
  });

  it('posts a summary after every scheduled run, a ✅ one with its reason too', async () => {
    let now = Date.parse('2026-10-25T10:20:00Z');
    const store = new Store(':memory:', () => now);
    const first = setup({ store, now: () => now });
    first.scheduler.start();
    await first.scheduler.stop();
    now = Date.parse('2026-10-25T12:30:00Z');
    const { slack, scheduler } = setup({
      store,
      now: () => now,
      replies: ['✅ Nothing to do: Prime is already on\n---\nChecked the account page.'],
    });
    scheduler.start();
    await new Promise((r) => setImmediate(r));
    await scheduler.idle();
    expect(slack.blockPosts.map((b) => b.text)).toEqual([
      'Prime Check: ✅ Nothing to do: Prime is already on',
    ]);
    expect(slack.blockPosts[0]?.blocks[0]).toMatchObject({
      text: { text: '✅ *Prime Check* (catch-up) · Nothing to do: Prime is already on' },
    });
    await scheduler.stop();
  });

  it('posts one line with the card count, the cards in its thread, and the result of a decision under it', async () => {
    // A ticking clock: the follow-up starts after the cards were raised.
    let t = Date.parse('2026-10-25T12:00:00Z');
    const clock = () => (t += 1000);
    const store = new Store(':memory:', clock);
    const { slack, chat } = routed(store);
    let thread = '';
    const scheduler = new Scheduler({
      projects: [makeProject([job])],
      host: testHost({ stateDir: tmpState() }),
      store,
      chat,
      log: quiet,
      env: { PATH: '/bin' },
      newSessionId: () => 'sid',
      now: clock,
      approvalsUrl: 'https://dash.example/approvals',
      run: async (o) => {
        const key = o.env.TARA_THREAD as string;
        const at = key.indexOf(':');
        thread = key.slice(at + 1);
        if (!o.args.includes('--resume')) {
          o.onEvent?.({ kind: 'init', sessionId: 'sid', model: 'm' });
          for (const n of [1, 2]) {
            const item = store.proposeItem({
              project: 'shop',
              kind: 'ui-review',
              mode: 'resume',
              title: `UI issue ${n}`,
              options: ['Fix it', 'Skip'],
              jobId: 'prime',
              channel: key.slice(0, at),
              threadTs: thread,
            });
            const ts = await chat.postBlocks(key.slice(0, at), thread, `Approval needed ${n}`, [
              {
                type: 'actions',
                elements: [{ type: 'button', action_id: 'tara:approval:0', value: item.id }],
              },
            ]);
            store.setItemMessage(item.id, ts);
          }
          // A draft: no buttons, so it is listed with a link to the Approvals page.
          store.proposeItem({
            project: 'shop',
            kind: 'post',
            mode: 'queue',
            title: 'LinkedIn post <draft>',
            options: ['Approve'],
            jobId: 'prime',
            channel: key.slice(0, at),
            threadTs: thread,
          });
          return ok('⚠️ 2 UI issues found\n| Page | Issue |\n|---|---|\n| / | a |\n| /buy | b |');
        }
        return ok('✅ Fixed UI issue 1, uncommitted');
      },
    });
    scheduler.start();
    scheduler.trigger('shop', 'prime', 'dashboard');
    await scheduler.idle();
    // One channel message: no table; the count and a link to the Approvals page.
    const summary = slack.blockPosts[0];
    expect(slack.blockPosts.filter((p) => !p.thread)).toEqual([summary]);
    expect(summary?.blocks).toHaveLength(2);
    expect(summary?.blocks[0]).toMatchObject({
      text: { text: '⚠️ *Prime Check* (run from the dashboard) · 2 UI issues found' },
    });
    expect(JSON.stringify(summary?.blocks[1])).toContain(
      '<https://dash.example/approvals|🟡 3 cards wait for you on the Approvals page ↗>',
    );
    // The approval cards follow in its thread with their buttons, linked to the cards so a decision
    // edits them; the draft is one line with a link.
    const copies = slack.blockPosts.slice(1);
    expect(copies.map((p) => [p.thread, p.text])).toEqual([
      [summary?.ts, 'Approval needed 1'],
      [summary?.ts, 'Approval needed 2'],
    ]);
    const cards = store.itemsInThread(webChannel('shop'), thread).filter((i) => i.mode === 'resume');
    expect(cards.map((i) => store.webMirror(i.messageTs as string)?.ts)).toEqual(copies.map((p) => p.ts));
    const draft = store.itemsInThread(webChannel('shop'), thread).find((i) => i.mode === 'queue');
    expect(slack.posts.filter((p) => p.thread === summary?.ts).map((p) => p.text)).toEqual([
      `📝 *1 draft waits on the Approvals page*\n• <https://dash.example/approvals#item-${draft?.id}|LinkedIn post  draft>`,
    ]);

    // The decision continues the run; its result is a reply under the job's summary.
    expect(
      await scheduler.resume('shop', 'prime', {
        channel: webChannel('shop'),
        threadTs: thread,
        text: 'Fix it',
        by: 'U1',
        card: { title: 'UI issue 1', body: '', declined: false },
      }),
    ).toBe('ok');
    expect(slack.blockPosts).toHaveLength(4);
    expect(slack.blockPosts[3]).toMatchObject({
      thread: summary?.ts,
      text: 'Prime Check: ✅ Fixed UI issue 1, uncommitted',
    });
    // Its reply doesn't take over the job's Slack thread: replies there still reach the job's session.
    expect(store.aliasesOf(`${webChannel('shop')}:${thread}`)).toEqual([`C1:${summary?.ts}`]);
    await scheduler.stop();
  });

  it('posts one message for a usage limit that stops many runs, and closes it once runs work again', async () => {
    const store = new Store(':memory:');
    const { slack, chat } = routed(store);
    let limited = true;
    const scheduler = new Scheduler({
      projects: [makeProject([job, { ...job, id: 'notices', name: 'Notices' }])],
      host: testHost({ stateDir: tmpState() }),
      store,
      chat,
      log: quiet,
      env: { PATH: '/bin' },
      newSessionId: () => 'sid',
      run: async () =>
        limited
          ? { ...ok(''), status: 'limit', error: "You've hit your weekly limit · resets Nov 22, 3:30pm" }
          : ok('⚠️ One notice to read'),
    });
    scheduler.start();
    scheduler.trigger('shop', 'prime', 'dashboard');
    await scheduler.idle();
    scheduler.trigger('shop', 'notices', 'dashboard');
    await scheduler.idle();
    expect(slack.blockPosts).toEqual([]);
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toContain('⏸ *Claude usage limit reached*');
    expect(slack.updates.at(-1)?.text).toContain('_Skipped (2):_ Prime Check, Notices');
    expect(slack.updates.at(-1)?.text).toContain('resets Nov 22');
    limited = false;
    scheduler.trigger('shop', 'prime', 'dashboard');
    await scheduler.idle();
    expect(slack.updates.at(-1)?.text).toContain('✅ _Over: runs work again._');
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

  it('answers "run <skill>" asked as a reply in a Slack thread in that thread, the run on the dashboard', async () => {
    const { slack, calls, scheduler } = setup({ replies: ['✅ Prime is on', ''] });
    scheduler.start();
    scheduler.trigger('shop', 'prime', 'U1', undefined, { replyIn: { channel: 'C1', ts: '600.1' } });
    await scheduler.idle();
    expect(calls[0]?.env.TARA_THREAD?.startsWith('web-shop:')).toBe(true);
    expect(slack.posts).toEqual([]);
    expect(slack.blockPosts.map((b) => b.thread)).toEqual(['600.1']);
    expect(slack.blockPosts[0]?.text).toBe('Prime Check: ✅ Prime is on');
    // Even with nothing to report, the person who asked gets an answer there.
    scheduler.trigger('shop', 'prime', 'U1', undefined, { replyIn: { channel: 'C1', ts: '600.1' } });
    await scheduler.idle();
    expect(slack.blockPosts.map((b) => b.thread)).toEqual(['600.1', '600.1']);
    expect(slack.blockPosts[1]?.text).toContain('Nothing to report');
    await scheduler.stop();
  });

  it('attaches the files a run sent to its summary', async () => {
    const store = new Store(':memory:');
    const { slack, chat } = routed(store);
    const scheduler = new Scheduler({
      projects: [makeProject([job])],
      host: testHost({ stateDir: tmpState() }),
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
  it('keeps approval cards off Slack, copies a permission prompt and keeps it in step', async () => {
    const store = new Store(':memory:');
    const { slack, chat } = routed(store);
    const channel = webChannel('shop');
    const root = await chat.post(channel, undefined, 'Run Prime Check');
    await chat.postBlocks(channel, root, 'Approval needed', [
      { type: 'actions', elements: [{ type: 'button', action_id: 'tara:approval:0', value: 'i1' }] },
    ]);
    expect(slack.blockPosts).toEqual([]);

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'Allow Bash?' } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'tara:perm:allow', value: 'p1' }] },
    ];
    const prompt = await chat.postBlocks(channel, root, 'Permission needed', blocks);
    expect(slack.blockPosts).toHaveLength(1);
    const copy = slack.blockPosts[0];
    expect(copy?.thread).toBe('');
    expect(JSON.stringify(copy?.blocks)).toContain(`https://dash.example/t/${channel}/${root}`);
    expect(store.threadAlias(`C1:${copy?.ts}`)).toBe(`${channel}:${root}`);

    await chat.update(channel, prompt, 'Allowed', [
      { type: 'section', text: { type: 'mrkdwn', text: '✅ Allowed' } },
    ]);
    expect(slack.updates[0]?.ts).toBe(copy?.ts);
    expect(store.getWebMessage(channel, prompt)?.text).toBe('Allowed');

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
    expect(withoutName('*Prime Check:* ⚠️ 5 cards wait', '*Prime Check*')).toBe('⚠️ 5 cards wait');
    expect(withoutName('⚠️ **Prime Check: no new errors.**', '*Prime Check*')).toBe('⚠️ **no new errors.**');
  });

  it('opens with the status, the name and the first line of the headline', async () => {
    const { summaryHeader } = await import('../src/web/summary.js');
    expect(summaryHeader('*UI Review*', '⚠️ 3 **low** issues\n| a |\n|---|\n| 1 |')).toEqual({
      header: '⚠️ *UI Review* · 3 *low* issues',
      body: '| a |\n|---|\n| 1 |',
    });
    // A table first, or a long line: the name alone, the headline in full below.
    expect(summaryHeader('*UI Review*', '| a |\n|---|')).toEqual({
      header: '*UI Review*',
      body: '| a |\n|---|',
    });
    expect(summaryHeader('*UI Review*', 'x'.repeat(201)).header).toBe('*UI Review*');
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
      host: testHost({ stateDir: tmpState() }),
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
      host: testHost({ stateDir: tmpState() }),
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

  it("says in a chat's Slack summary how many cards it left, since approval cards aren't copied to Slack", async () => {
    const store = new Store(':memory:');
    const { slack, chat } = routed(store);
    const manager = new SessionManager({
      projects: [makeProject([])],
      host: testHost({ stateDir: tmpState() }),
      store,
      chat,
      log: quiet,
      env: { PATH: '/bin' },
      newSessionId: () => 'fresh',
      approvalsUrl: 'https://dash.example/approvals',
      run: async () => {
        store.proposeItem({
          project: 'shop',
          kind: 'email',
          mode: 'queue',
          title: 'Reply to Ann',
          options: ['Approve'],
          channel: 'web-shop',
          threadTs: '3.0',
        });
        return ok('');
      },
    });
    await manager.handle({
      channel: 'web-shop',
      threadTs: '3.0',
      ts: '3.0',
      user: 'U1',
      text: 'draft the reply',
      summary: '*Card decision*',
    });
    const posted = JSON.stringify(slack.blockPosts);
    expect(posted).toContain('Left 1 card for you');
    expect(posted).toContain('https://dash.example/approvals');
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
