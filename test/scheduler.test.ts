import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostConfig, Project, SelfImprove } from '../src/config/schema.js';
import { startHttpServer } from '../src/http/server.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import { streamRecipient } from '../src/scheduler/job-runner.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { findRunJob, parseScheduledRun, SCHEDULE_BY } from '../src/scheduler/slack-trigger.js';
import { Threads } from '../src/sessions/threads.js';
import { type Item, Store } from '../src/store/store.js';
import { FakeChat, FakeStream, fakeChrome, testHost } from './fakes.js';

const host = testHost({ concurrency: 2, catchUpHours: 6, claude: { bin: 'claude', chatTimeoutMinutes: 20 } });

function makeProject(
  jobs: object[],
  env: object = {},
  owner?: string,
  selfImprove: SelfImprove = 'off',
): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-sched-'));
  mkdirSync(path.join(dir, '.tara'));
  writeFileSync(path.join(dir, '.tara', 'jobs.json'), JSON.stringify({ env, jobs }));
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
      // Off by default here so run counts stay exact; the selfImprove tests turn it on.
      selfImprove,
      ...(owner ? { owner } : {}),
    },
    systemPrompt: 'Project rules.',
  };
}

const ok = (text: string): RunOutcome => ({
  status: 'ok',
  text,
  sessionId: 'sid',
  model: 'claude-haiku-5-5',
  durationMs: 2000,
  toolCalls: 2,
  permissionDenials: [],
});

function setup(opts: {
  jobs: object[];
  env?: object;
  replies?: string[];
  now?: () => number;
  store?: Store;
  stream?: FakeStream;
  owner?: string;
  selfImprove?: SelfImprove;
  /** Tool calls that fail in the first run. */
  toolErrors?: number;
  /** How the first run ends, e.g. `aborted` for a run a person stopped. */
  firstStatus?: RunOutcome['status'];
  /** The session id the CLI reports (agy picks its own conversation id). */
  initSessionId?: string;
  chatSetup?: (chat: FakeChat) => void;
  pickupTimeoutMs?: number;
  /** The shared browser's DevTools address: tabs are closed after runs that hold its lock. */
  browserUrl?: string;
  /** Several browsers, each with its own lock (instead of `browserUrl`). */
  browsers?: HostConfig['browsers'];
  /** Called inside each model run, e.g. to open a browser tab. */
  during?: () => Promise<void>;
}) {
  const chat = new FakeChat('ts');
  chat.stream = opts.stream;
  opts.chatSetup?.(chat);
  const store = opts.store ?? new Store(':memory:', opts.now);
  const calls: RunOptions[] = [];
  const callTimes: number[] = [];
  const replies = [...(opts.replies ?? [])];
  const project = makeProject(opts.jobs, opts.env, opts.owner, opts.selfImprove);
  const scheduler = new Scheduler({
    projects: [project],
    host: opts.browsers
      ? { ...host, browsers: opts.browsers }
      : opts.browserUrl
        ? {
            ...host,
            browsers: [{ cdpUrl: opts.browserUrl, lock: 'chrome', closeTabs: true, staleMinutes: 30 }],
          }
        : host,
    store,
    chat,
    log: { info() {}, warn() {}, error() {} },
    env: { PATH: '/bin', SLACK_BOT_TOKEN: 'secret' },
    now: opts.now,
    newSessionId: () => 'sid',
    pickupTimeoutMs: opts.pickupTimeoutMs,
    run: async (o) => {
      calls.push(o);
      await opts.during?.();
      callTimes.push(Date.now());
      o.onEvent?.({ kind: 'init', sessionId: opts.initSessionId ?? 'sid', model: 'claude-haiku-5-5' });
      if (!o.prompt.includes('Reply with exactly NONE')) {
        o.onEvent?.({ kind: 'tool', id: 't1', name: 'Bash', status: 'Bash: curl' });
        o.onEvent?.({ kind: 'tool_result', id: 't1', isError: false });
      }
      if (calls.length === 1) {
        for (let i = 0; i < (opts.toolErrors ?? 0); i++) {
          o.onEvent?.({ kind: 'tool', id: `e${i}`, name: 'Bash', status: 'Bash: click' });
          o.onEvent?.({ kind: 'tool_result', id: `e${i}`, isError: true });
        }
      }
      const reply = replies.shift() ?? 'Headline\n---\nDetails here';
      o.onEvent?.({ kind: 'text_start' });
      o.onEvent?.({ kind: 'text', text: reply });
      if (calls.length === 1 && opts.firstStatus) return { ...ok(''), status: opts.firstStatus };
      return ok(reply);
    },
  });
  return { chat, store, calls, callTimes, scheduler, project };
}

/** What the bot does when its own trigger messages arrive from Slack: start each job in its thread. */
async function pickUp(scheduler: Scheduler, chat: FakeChat): Promise<void> {
  await new Promise((r) => setImmediate(r));
  for (const post of chat.posts) {
    const said = post.thread === '' ? parseScheduledRun(post.text) : undefined;
    const job = said ? findRunJob(scheduler.list('shop'), said) : undefined;
    if (job) scheduler.trigger('shop', job.id, SCHEDULE_BY, { channel: 'C1', ts: post.ts });
  }
  await scheduler.idle();
}

const baseJob = {
  id: 'sla',
  name: 'SLA Report',
  cron: '0 * * * *',
  tz: 'UTC',
  skills: ['sla-report'],
  model: 'haiku',
};

describe('Scheduler', () => {
  it('runs a card posted in Slack inside its thread', async () => {
    const { chat, store, scheduler } = setup({ jobs: [baseJob] });
    scheduler.start();
    const card = store.proposeItem({
      project: 'shop',
      kind: 'x-reply',
      mode: 'queue',
      title: 'Reply',
      options: ['Approve'],
      queue: 'replies',
    });
    store.setItemSlack(card.id, 'C1', 'card.1');
    await scheduler.runQueue('shop', 'sla', 'replies', [store.getItem(card.id) as Item]);
    expect(chat.posts[0]?.thread).toBe('card.1');
    expect(chat.reactions).toContain('+eyes@card.1');
  });

  it('runs a job on demand: its skill section, a Run message, status and details in its thread', async () => {
    const { chat, calls, scheduler, store } = setup({
      jobs: [{ ...baseJob, timeoutMinutes: 20 }],
      env: { ROOT: '~/repo' },
    });
    scheduler.start();
    expect(scheduler.trigger('shop', 'sla', 'U1')).toBe('started');
    expect(scheduler.trigger('shop', 'sla', 'U1')).toBe('running');
    await scheduler.idle();

    const call = calls[0] as RunOptions;
    expect(call.prompt).toMatch(
      /^Run the job "SLA Report" \(`sla`\): do what the "## Job" section of the `sla-report` skill says/,
    );
    // The job's env (no Slack token), and Bash may take as long as the job: the skill runs its scripts.
    expect(call.env.ROOT).toMatch(/\/repo$/);
    expect(call.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(call.env.BASH_MAX_TIMEOUT_MS).toBe(String(20 * 60_000));
    expect(call.env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(20 * 60_000));
    expect(call.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--session-id', 'sid']));
    // No host effort set: the model's default applies.
    expect(call.args).not.toContain('--effort');
    expect(call.systemPrompt).toContain('unattended');
    expect(call.systemPrompt).toContain('Project rules.');
    // Its own scratch folder and the job's data folder, as env and as absolute paths in the prompt.
    expect(call.env.TARA_SCRATCH).toBe('/tmp/scratch/shop/sla-sid');
    expect(call.env.TARA_JOB_DATA).toBe('/tmp/job-data/shop/sla');
    // The run's thread, for a project server that makes a card for this run.
    expect(call.env.TARA_THREAD).toMatch(/^C\w*:.+/);
    expect(call.prompt).toContain('- Scratch folder (`$TARA_SCRATCH`): /tmp/scratch/shop/sla-sid.');
    expect(call.prompt).toContain('- Job data folder (`$TARA_JOB_DATA`): /tmp/job-data/shop/sla.');

    // The channel gets only "Run SLA Report"; the status line and Claude's whole reply are in its thread.
    expect(chat.log[0]).toBe('post top ts1: Run SLA Report');
    expect(chat.log[1]).toBe('post ts1 ts2: ⏳ *SLA Report* (run by <@U1>)');
    expect(chat.log.at(-2)).toBe(
      'update ts2: ✅ *SLA Report* (run by <@U1>) · 2s · 2 steps · claude-haiku-5-5\nHeadline',
    );
    expect(chat.log.at(-1)).toBe('post ts1 ts3: Headline\n---\nDetails here');
    // Replies in the job thread resume the job's session.
    expect(store.getSession('C1:ts1')).toMatchObject({ sessionId: 'sid', model: 'haiku', started: true });
    expect(scheduler.list('shop')[0]).toMatchObject({ id: 'sla', lastStatus: 'ok', running: false });
    await scheduler.stop();
  });

  it('runs an agy job through agy and continues its conversation after a decision', async () => {
    const { calls, scheduler, store } = setup({
      jobs: [{ ...baseJob, harness: 'agy', model: 'gemini-x' }],
      initSessionId: 'conv-1',
    });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    const first = calls[0] as RunOptions;
    expect(first.harness).toBe('agy');
    expect(first.bin).toBe('agy');
    expect(first.args).toEqual(
      expect.arrayContaining(['--input-format', 'stream-json', '--model', 'gemini-x']),
    );
    // The project runs in bypassPermissions and the job has no rules of its own.
    expect(first.args).toContain('--dangerously-skip-permissions');
    expect(first.args).not.toContain('--session-id');
    expect(store.getSession('C1:ts1')).toMatchObject({ sessionId: 'conv-1', harness: 'agy', started: true });

    await scheduler.resume('shop', 'sla', { threadTs: 'ts1', text: 'USER DECISION: Fix it', by: 'U1' });
    const second = calls[1] as RunOptions;
    expect(second.harness).toBe('agy');
    expect(second.args).toEqual(expect.arrayContaining(['--conversation', 'conv-1']));
    expect(second.prompt).toBe('USER DECISION: Fix it');
    await scheduler.stop();
  });

  it('hands an approved card over to a fresh session on the handoff harness, and runs nothing for a decline', async () => {
    const { calls, scheduler, store } = setup({
      jobs: [
        {
          ...baseJob,
          harness: 'agy',
          model: 'gemini-x',
          handoff: { harness: 'claude', model: 'claude-opus-5-5' },
        },
      ],
      initSessionId: 'conv-1',
    });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    const scratch = (calls[0] as RunOptions).env.TARA_SCRATCH;

    // A declined card runs no model at all.
    const skip = {
      threadTs: 'ts1',
      text: 'USER DECISION on "Overflow": Skip',
      by: 'U1',
      card: { title: 'Overflow', body: 'Menu overflows.', declined: true },
    };
    expect(await scheduler.resume('shop', 'sla', skip)).toBe('silent');
    expect(calls).toHaveLength(1);

    // An approved one starts Claude with the card, the decision and the job's prompt, in the same scratch folder.
    await scheduler.resume('shop', 'sla', {
      threadTs: 'ts1',
      text: 'USER DECISION on "Footer": Fix it',
      by: 'U1',
      card: {
        title: 'Footer',
        body: 'WhatsApp button covers the footer.\nScreenshot: /s/ui-1.png',
        declined: false,
      },
    });
    const fix = calls[1] as RunOptions;
    expect(fix.harness).toBe('claude');
    expect(fix.bin).toBe('claude');
    expect(fix.args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--session-id', 'sid']));
    expect(fix.args).not.toContain('--resume');
    expect(fix.env.TARA_SCRATCH).toBe(scratch);
    expect(fix.prompt).toContain('ran on agy');
    expect(fix.prompt).toContain('### Footer\nWhatsApp button covers the footer.');
    expect(fix.prompt).toContain('## The decision\nUSER DECISION on "Footer": Fix it');
    expect(fix.prompt).toContain(
      '## The job\'s instructions\nRun the job "SLA Report" (`sla`): do what the "## Job" section of the `sla-report` skill says (in an older skill: "## Job: `sla`")',
    );
    expect(store.getSession('C1:ts1')).toMatchObject({
      harness: 'claude',
      model: 'claude-opus-5-5',
      started: true,
    });

    // The next approval resumes that Claude session, with its card since that session never saw it.
    await scheduler.resume('shop', 'sla', {
      threadTs: 'ts1',
      text: 'USER DECISION on "Menu": Fix it',
      by: 'U1',
      card: { title: 'Menu', body: 'Search overlaps the menu.', declined: false },
    });
    const next = calls[2] as RunOptions;
    expect(next.harness).toBe('claude');
    expect(next.args).toEqual(expect.arrayContaining(['--resume', 'conv-1']));
    expect(next.prompt).toBe(
      '## The card\n### Menu\nSearch overlaps the menu.\n\nUSER DECISION on "Menu": Fix it',
    );
    await scheduler.stop();
  });

  it('runs steps in their own sessions before the main prompt, with the job MCP servers', async () => {
    const { calls, scheduler } = setup({
      jobs: [
        {
          ...baseJob,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} placeholder, expanded by tara-agent
          mcpServers: { browser: { command: 'npx', args: ['mcp', '--workspace=${TARA_SCRATCH}/shots'] } },
          steps: [{ name: 'Home' }, { name: 'Cart', skill: 'cart-test', timeoutMinutes: 5, model: 'sonnet' }],
        },
      ],
      replies: ['home: 1 finding', 'cart: fine', 'Headline\n---\nAll steps done'],
    });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(calls).toHaveLength(3);
    const [home, cart, main] = calls as [RunOptions, RunOptions, RunOptions];
    expect(home.prompt).toMatch(
      /^This is the step "Home" of the job "SLA Report" \(`sla`\)\. Load the `sla-report` skill[\s\S]*do only the "### Step: Home" part[\s\S]*\n\nYour folders:/,
    );
    expect(cart.prompt).toContain('Load the `cart-test` skill');
    expect(home.systemPrompt).toContain('one step of a scheduled job');
    expect(home.mcpServers).toEqual({
      browser: { command: 'npx', args: ['mcp', '--workspace=/tmp/scratch/shop/sla-sid/shots'], env: {} },
    });
    expect(cart.timeoutMs).toBe(5 * 60_000);
    expect(home.args).toEqual(expect.arrayContaining(['--model', 'haiku']));
    expect(cart.args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
    expect(main.prompt).toMatch(
      /## Step Output[\s\S]*### Home\nhome: 1 finding[\s\S]*### Cart\ncart: fine[\s\S]*Its "### Step" parts were done by the sessions before you/,
    );
    expect(main.mcpServers).toEqual(home.mcpServers);
    await scheduler.stop();
  });

  it('keeps its own Run thread and session when the model replies nothing', async () => {
    const { chat, scheduler, store } = setup({ jobs: [baseJob], replies: [''] });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(chat.deleted).toEqual([]);
    expect(
      chat.log.some((l) => l.startsWith('update ts2: 🔇 *SLA Report*') && l.endsWith('· nothing to report')),
    ).toBe(true);
    // The thread says so in words: it is never left without a reply.
    expect(chat.log.at(-1)).toMatch(/^post ts1 ts\d+: 🔇 Claude finished without a written reply · /);
    expect(store.getSession('C1:ts1')).toBeDefined();
    await scheduler.stop();
  });

  it('marks replies that start with ❌ as failed', async () => {
    const { chat, scheduler } = setup({ jobs: [baseJob], replies: ['❌ Portal login expired'] });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(
      chat.log.some((l) => l.startsWith('update ts2: ❌ *SLA Report*') && l.endsWith('Portal login expired')),
    ).toBe(true);
    expect(scheduler.list('shop')[0]?.lastStatus).toBe('failed');
    await scheduler.stop();
  });

  describe('selfImprove', () => {
    it('resumes a failed run once to fix its skill, reports the change, and keeps it out of job history', async () => {
      const { chat, calls, scheduler, store } = setup({
        jobs: [baseJob],
        selfImprove: 'trouble',
        replies: ['❌ Save button not found', '.claude/skills/sla/SKILL.md: new Save selector'],
      });
      scheduler.start();
      scheduler.trigger('shop', 'sla', 'U1');
      await scheduler.idle();

      expect(calls).toHaveLength(2);
      const [job, learn] = calls as [RunOptions, RunOptions];
      expect(learn.args).toEqual(expect.arrayContaining(['--resume', 'sid', '--model', 'haiku']));
      expect(learn.args).not.toContain('--mcp-config');
      // Same system prompt as the job, so the cached prompt is reused.
      const sys = (o: RunOptions) => o.systemPrompt;
      expect(sys(learn)).toBe(sys(job));
      expect(learn.prompt).toContain('it reported a failure: Save button not found');
      expect(learn.prompt).toContain('Reply with exactly NONE');
      expect(chat.log.at(-1)).toBe(
        'post ts1 ts4: 🔧 *SLA Report* learned from this run (it reported a failure: Save button not found):\n.claude/skills/sla/SKILL.md: new Save selector',
      );
      expect(store.jobRuns('shop', 'sla', 10).map((r) => r.status)).toEqual(['failed']);
      expect(store.runsSince(0).map((r) => r.kind)).toEqual(['job', 'learn']);
      expect(scheduler.list('shop')[0]?.lastStatus).toBe('failed');
      await scheduler.stop();
    });

    it('looks back after a clean run in always mode, and reports a change without reasons', async () => {
      const { chat, calls, scheduler, store } = setup({
        jobs: [baseJob],
        selfImprove: 'always',
        replies: ['Headline\n---\nDetails', '.claude/skills/sla/SKILL.md: export button moved to the menu'],
      });
      scheduler.start();
      scheduler.trigger('shop', 'sla', 'U1');
      await scheduler.idle();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.prompt).toContain('This run is done. Before you stop, look back');
      expect(calls[1]?.prompt).toContain('Reply with exactly NONE');
      expect(chat.log.at(-1)).toMatch(/🔧 \*SLA Report\* learned from this run:\n\.claude/);
      expect(store.jobRuns('shop', 'sla', 10).map((r) => r.status)).toEqual(['ok']);
      await scheduler.stop();
    });

    it('lets a job override the project mode', async () => {
      const { calls, scheduler } = setup({
        jobs: [{ ...baseJob, selfImprove: 'trouble' }],
        selfImprove: 'always',
      });
      scheduler.start();
      scheduler.trigger('shop', 'sla', 'U1');
      await scheduler.idle();
      expect(calls).toHaveLength(1);
      await scheduler.stop();
    });

    it('costs nothing extra for a clean run in trouble mode, and posts nothing when there is nothing to change', async () => {
      const clean = setup({ jobs: [baseJob], selfImprove: 'trouble' });
      clean.scheduler.start();
      clean.scheduler.trigger('shop', 'sla', 'U1');
      await clean.scheduler.idle();
      expect(clean.calls).toHaveLength(1);
      await clean.scheduler.stop();

      const none = setup({
        jobs: [baseJob],
        selfImprove: 'trouble',
        replies: ['❌ Portal down', 'NONE'],
      });
      none.scheduler.start();
      none.scheduler.trigger('shop', 'sla', 'U1');
      await none.scheduler.idle();
      expect(none.calls).toHaveLength(2);
      expect(none.chat.log.some((l) => l.includes('🔧'))).toBe(false);
      await none.scheduler.stop();
    });

    it('learns from tool errors in a silent run, with the note in its kept thread', async () => {
      const { chat, calls, scheduler } = setup({
        jobs: [baseJob],
        selfImprove: 'trouble',
        toolErrors: 2,
        replies: ['', 'SKILL.md: dismiss the cookie banner first'],
      });
      scheduler.start();
      scheduler.trigger('shop', 'sla', 'U1');
      await scheduler.idle();
      expect(calls[1]?.prompt).toContain('2 tool calls returned errors');
      expect(calls).toHaveLength(2);
      // A silent run keeps its thread, so the lesson's note goes there.
      expect(chat.log.some((l) => l.startsWith('post ts1') && l.includes('🔧'))).toBe(true);
      await scheduler.stop();
    });

    it('stays off when the project turns it off', async () => {
      const { calls, scheduler } = setup({ jobs: [baseJob], replies: ['❌ Broken'] });
      scheduler.start();
      scheduler.trigger('shop', 'sla', 'U1');
      await scheduler.idle();
      expect(calls).toHaveLength(1);
      await scheduler.stop();
    });
  });

  it('catches up a missed slot once, but never for a job first seen after that slot', async () => {
    let now = Date.parse('2026-10-25T10:20:00Z');
    const store = new Store(':memory:', () => now);
    const job = { ...baseJob, cron: '0 * * * *' };

    // First start at 10:20: job is new, so the 10:00 slot is not caught up.
    const first = setup({ jobs: [job], store, now: () => now });
    first.scheduler.start();
    await first.scheduler.idle();
    expect(first.calls).toHaveLength(0);
    await first.scheduler.stop();

    // Down until 12:30: the 12:00 slot is missed and caught up once.
    now = Date.parse('2026-10-25T12:30:00Z');
    const second = setup({ jobs: [job], store, now: () => now });
    second.scheduler.start();
    await pickUp(second.scheduler, second.chat);
    expect(second.calls).toHaveLength(1);
    expect(second.chat.log[0]).toBe('post top ts1: Run SLA Report');
    // The trigger message is the run's status line; the run itself is in its thread.
    expect(second.chat.log[1]).toBe('post ts1 ts2: ⏳ *SLA Report* (catch-up)');
    await second.scheduler.stop();

    // A restart in the same hour doesn't run it again: the slot is claimed.
    const third = setup({ jobs: [job], store, now: () => now });
    third.scheduler.start();
    await pickUp(third.scheduler, third.chat);
    expect(third.calls).toHaveLength(0);
    expect(third.chat.posts).toHaveLength(0);
    await third.scheduler.stop();
  });

  it('skips catch-up when disabled for the job', async () => {
    let now = Date.parse('2026-10-25T10:20:00Z');
    const store = new Store(':memory:', () => now);
    const job = { ...baseJob, catchUp: false };
    const a = setup({ jobs: [job], store, now: () => now });
    a.scheduler.start();
    await a.scheduler.stop();
    now = Date.parse('2026-10-25T12:30:00Z');
    const b = setup({ jobs: [job], store, now: () => now });
    b.scheduler.start();
    await b.scheduler.idle();
    expect(b.calls).toHaveLength(0);
    await b.scheduler.stop();
  });

  it('fires on the real clock and claims each slot once', async () => {
    const { calls, callTimes, chat, scheduler, store } = setup({
      jobs: [{ ...baseJob, cron: '*/2 * * * * *' }],
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 2_600));
    await pickUp(scheduler, chat);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const slot = Math.floor((callTimes[0] as number) / 2_000) * 2_000;
    expect(store.claimSlot('shop:sla', slot)).toBe(false);
    await scheduler.stop();
  });

  it('lists jobs by next run and does not schedule disabled ones', async () => {
    const { scheduler } = setup({
      jobs: [
        { ...baseJob, id: 'later', cron: '0 0 1 1 *' },
        { ...baseJob, id: 'soon', cron: '* * * * *' },
        { ...baseJob, id: 'off', enabled: false },
      ],
    });
    scheduler.start();
    const list = scheduler.list('shop');
    expect(list.map((j) => j.id)).toEqual(['soon', 'later', 'off']);
    expect(list[2]).toMatchObject({ enabled: false, nextRun: undefined });
    expect(scheduler.trigger('shop', 'nope', 'U1')).toBe('unknown');
    await scheduler.stop();
  });

  it('pauses and resumes a job by flipping enabled in the jobs file, effective at once', async () => {
    const { scheduler, project } = setup({ jobs: [baseJob, { ...baseJob, id: 'other' }] });
    const file = path.join(project.dir, '.tara', 'jobs.json');
    const original = `${JSON.stringify({ tz: 'UTC', jobs: [baseJob, { ...baseJob, id: 'other' }] }, null, 2)}\n`;
    writeFileSync(file, original);
    scheduler.start();

    expect(scheduler.setEnabled('shop', 'sla', false)).toBe('ok');
    expect(scheduler.list('shop').find((j) => j.id === 'sla')).toMatchObject({
      enabled: false,
      nextRun: undefined,
    });
    const paused = readFileSync(file, 'utf8');
    expect(JSON.parse(paused).jobs[0].enabled).toBe(false);
    expect(JSON.parse(paused).jobs[1].enabled).toBeUndefined();
    expect(paused.replace(/,\n {6}"enabled": false/, '')).toBe(original);

    expect(scheduler.setEnabled('shop', 'sla', true)).toBe('ok');
    expect(scheduler.list('shop').find((j) => j.id === 'sla')?.nextRun).toBeInstanceOf(Date);
    // Resuming drops the key again, so a pause + resume leaves the file exactly as it was.
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(scheduler.setEnabled('shop', 'nope', false)).toBe('unknown');
    expect(scheduler.setEnabled('elsewhere', 'sla', false)).toBe('unknown');
    await scheduler.stop();
  });

  it('keeps the old schedule and reports an invalid jobs file', async () => {
    const { chat, scheduler, project } = setup({ jobs: [baseJob] });
    scheduler.start();
    writeFileSync(path.join(project.dir, '.tara', 'jobs.json'), '{"jobs":[{"id":"Bad Id"}]}');
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the private poller for a deterministic test
    (scheduler as any).checkFiles();
    await new Promise((r) => setImmediate(r));
    // Logs and the dashboard only: nothing goes to Slack for a reload.
    expect(chat.log).toEqual([]);
    expect(scheduler.jobFileErrors().get('shop')?.message).toBeTruthy();
    expect(scheduler.list('shop').map((j) => j.id)).toEqual(['sla']);
    await scheduler.stop();
  });
});

describe('HTTP API', () => {
  async function api(token?: string) {
    const ctx = setup({
      jobs: [{ ...baseJob, skills: ['sla-report'] }],
      replies: ['Done\n---\nAll details'],
    });
    ctx.scheduler.start();
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      token,
      scheduler: ctx.scheduler,
      store: ctx.store,
      projects: ['shop'],
      log: { info() {}, warn() {}, error() {} },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, init?: RequestInit) => {
      const res = await fetch(base + path, init);
      // biome-ignore lint/suspicious/noExplicitAny: JSON bodies of several shapes, checked by the assertions
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const close = async () => {
      server.close();
      await ctx.scheduler.stop();
    };
    return { ...ctx, call, close };
  }

  it('lists jobs, runs one and returns its history and output', async () => {
    const { call, close, scheduler } = await api();
    expect((await call('/health')).body).toMatchObject({ ok: true, projects: ['shop'], jobs: { total: 1 } });

    const jobs = await call('/jobs?project=shop');
    expect(jobs.body.jobs[0]).toMatchObject({
      id: 'sla',
      skills: ['sla-report'],
      enabled: true,
      lastRunAt: null,
    });

    const run = await call('/jobs/shop/sla/run', {
      method: 'POST',
      body: JSON.stringify({ by: 'job-board' }),
    });
    expect(run.body).toEqual({ result: 'started' });
    await scheduler.idle();

    const runs = await call('/jobs/shop/sla/runs?limit=5');
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0]).toMatchObject({ status: 'ok', jobId: 'sla', hasOutput: true });
    expect(runs.body.runs[0].output).toBeUndefined();

    const detail = await call(`/runs/${runs.body.runs[0].id}`);
    expect(detail.body.run).toMatchObject({ output: 'Done\n---\nAll details' });
    expect(detail.body.run.scriptOutput).toBeUndefined();
    expect((await call('/jobs?project=shop')).body.jobs[0].lastStatus).toBe('ok');
    await close();
  });

  it('labels API runs with the caller', async () => {
    const { call, close, scheduler, chat } = await api();
    await call('/jobs/shop/sla/run', { method: 'POST', body: '{"by":"job-board"}' });
    await scheduler.idle();
    expect(chat.log.slice(0, 2)).toEqual([
      'post top ts1: Run SLA Report',
      'post ts1 ts2: ⏳ *SLA Report* (run by job-board)',
    ]);
    await close();
  });

  it('returns clear errors', async () => {
    const { call, close } = await api();
    expect((await call('/jobs?project=nope')).status).toBe(404);
    expect((await call('/jobs/shop/nope/run', { method: 'POST' })).status).toBe(404);
    expect((await call('/jobs/shop/sla/run', { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await call('/runs/999')).status).toBe(404);
    expect((await call('/reload', { method: 'POST' })).body).toEqual({ ok: true });
    await close();
  });

  it('pauses and resumes over the API', async () => {
    const { call, close, scheduler } = await api();
    expect((await call('/jobs/shop/sla/pause', { method: 'POST' })).body).toEqual({
      ok: true,
      enabled: false,
    });
    expect(scheduler.list('shop')[0]?.enabled).toBe(false);
    expect((await call('/jobs/shop/sla/resume', { method: 'POST' })).body).toEqual({
      ok: true,
      enabled: true,
    });
    expect(scheduler.list('shop')[0]?.enabled).toBe(true);
    expect((await call('/jobs/shop/nope/pause', { method: 'POST' })).status).toBe(404);
    expect((await call('/jobs/nope/sla/resume', { method: 'POST' })).status).toBe(404);
    await close();
  });

  it('requires the bearer token when one is set', async () => {
    const { call, close } = await api('s3cret');
    expect((await call('/health')).status).toBe(401);
    expect((await call('/health', { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200);
    await close();
  });
});

describe('job threads', () => {
  it('holds its thread while it runs, and a stop there ends the run', async () => {
    const threads = new Threads();
    const store = new Store(':memory:');
    const scheduler = new Scheduler({
      projects: [makeProject([baseJob])],
      host,
      store,
      chat: new FakeChat('ts'),
      threads,
      log: { info() {}, warn() {}, error() {} },
      env: { PATH: '/bin' },
      newSessionId: () => 'sid',
      run: (o) =>
        new Promise((resolve) =>
          o.signal?.addEventListener('abort', () => resolve({ ...ok(''), status: 'aborted' })),
        ),
    });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    while (!threads.busy('C1:ts1')) await new Promise((r) => setTimeout(r, 5));

    expect(threads.stop('C1:ts1')).toBe(true);
    await scheduler.idle();
    expect(store.lastJobRun('shop', 'sla')?.status).toBe('aborted');
    expect(threads.busy('C1:ts1')).toBe(false);
    await scheduler.stop();
  });
});

describe('job streaming', () => {
  it('streams every run: to whoever started or continued it in Slack, else the project owner', () => {
    expect(streamRecipient({ kind: 'schedule' }, 'UOWNER')).toBe('UOWNER');
    expect(streamRecipient({ kind: 'catch-up' }, 'UOWNER')).toBe('UOWNER');
    expect(streamRecipient({ kind: 'queue', queue: 'content', items: [] }, 'UOWNER')).toBe('UOWNER');
    expect(streamRecipient({ kind: 'manual', by: 'U123ABC' }, 'UOWNER')).toBe('U123ABC');
    expect(streamRecipient({ kind: 'resume', by: 'U123ABC', threadTs: 't', text: 'go' }, 'UOWNER')).toBe(
      'U123ABC',
    );
    expect(streamRecipient({ kind: 'manual', by: 'Shop Dashboard' }, 'UOWNER')).toBe('UOWNER');
    expect(streamRecipient({ kind: 'schedule' }, undefined)).toBeUndefined();
    expect(streamRecipient({ kind: 'manual', by: 'api' }, undefined)).toBeUndefined();
  });

  it('streams a run someone started into the job thread and does not repost the details', async () => {
    const stream = new FakeStream();
    const { chat, calls, scheduler } = setup({ jobs: [baseJob], stream });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(calls[0]?.args).toContain('--include-partial-messages');
    expect(stream.calls[0]).toBe('start ts1 for U1 → s1');
    expect(stream.text()).toBe('Headline\n---\nDetails here');
    expect(stream.state()).toEqual({
      title: '✅ Done · 2s · 2 steps · claude-haiku-5-5',
      tasks: { 'Bash: curl': 'complete' },
    });
    // The headline updates the status line; the details are not posted a second time.
    expect(chat.log.some((l) => l.startsWith('update ts2: ✅ *SLA Report* (run by <@U1>)'))).toBe(true);
    expect(chat.posts.filter((p) => p.thread === 'ts1').map((p) => p.text)).toEqual([
      '⏳ *SLA Report* (run by <@U1>)',
    ]);
    await scheduler.stop();
  });

  it('puts even a headline-only reply in the thread, as well as in the status line', async () => {
    const stream = new FakeStream();
    const { chat, scheduler } = setup({
      jobs: [baseJob],
      stream,
      replies: ['All 12 orders shipped on time.'],
    });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(
      chat.log.some(
        (l) => l.startsWith('update ts2: ✅ *SLA Report*') && l.endsWith('All 12 orders shipped on time.'),
      ),
    ).toBe(true);
    // The thread always has Claude's exact reply, so a run can be checked from Slack.
    expect(stream.text()).toBe('All 12 orders shipped on time.');
    expect(stream.state()).toEqual({
      title: '✅ Done · 2s · 2 steps · claude-haiku-5-5',
      tasks: { 'Bash: curl': 'complete' },
    });
    expect(chat.posts.filter((p) => p.thread === 'ts1').map((p) => p.text)).toEqual([
      '⏳ *SLA Report* (run by <@U1>)',
    ]);
    expect(stream.calls.at(-1)).toMatch(/^stop s1/);
    await scheduler.stop();
  });

  it('streams board/API runs to the owner, and posts details without an owner', async () => {
    const stream = new FakeStream();
    const { chat, scheduler } = setup({ jobs: [baseJob], stream, owner: 'UOWNER' });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'Shop Dashboard');
    await scheduler.idle();
    expect(stream.calls[0]).toBe('start ts1 for UOWNER → s1');
    await scheduler.stop();

    const quiet = new FakeStream();
    const plain = setup({ jobs: [baseJob], stream: quiet });
    plain.scheduler.start();
    plain.scheduler.trigger('shop', 'sla', 'api'); // no owner: no stream
    await plain.scheduler.idle();
    expect(quiet.calls).toEqual([]);
    expect(plain.chat.texts()).toContain('Headline\n---\nDetails here');
    await plain.scheduler.stop();
    expect(chat.posts.filter((p) => p.thread === 'ts1').map((p) => p.text)).toEqual([
      '⏳ *SLA Report* (run by Shop Dashboard)',
    ]);
  });

  it('keeps the streamed steps when the job had nothing to report', async () => {
    const stream = new FakeStream();
    const { chat, scheduler } = setup({ jobs: [baseJob], stream, replies: [''] });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    // The stream (its steps) is finished, not removed, so the thread shows what the run checked.
    expect(chat.deleted).toEqual([]);
    expect(stream.appended.flat()).toContainEqual({
      type: 'plan_update',
      title: expect.stringMatching(/^🔇 Nothing to report/),
    });
    expect(stream.text()).toMatch(/🔇 Claude finished without a written reply · /);
    expect(stream.calls.at(-1)).toMatch(/^stop s1/);
    await scheduler.stop();
  });
});

describe('a job run asked for in chat', () => {
  it("runs inside the requester's thread, with the status as its first reply and reactions on the request", async () => {
    const stream = new FakeStream();
    const { chat, scheduler, store } = setup({ jobs: [baseJob], stream });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1', { channel: 'C1', ts: '500.1' });
    await scheduler.idle();
    expect(chat.log[0]).toBe('post 500.1 ts1: ⏳ *SLA Report* (run by <@U1>)');
    expect(stream.calls[0]).toBe('start 500.1 for U1 → s1');
    expect(chat.log.some((l) => l.startsWith('update ts1: ✅ *SLA Report*'))).toBe(true);
    expect(chat.reactions).toEqual(expect.arrayContaining(['+eyes@500.1', '+white_check_mark@500.1']));
    // Replies in the requester's thread continue the job's session.
    expect(store.getSession('C1:500.1')).toMatchObject({ model: 'haiku', started: true });
    await scheduler.stop();
  });
});

/** A job whose 12:00 slot was missed while tara was down: started at 12:30, its trigger is posted. */
function missedSlot(
  opts: Omit<Parameters<typeof setup>[0], 'jobs' | 'store' | 'now'> = {},
  job: object = {},
) {
  let now = Date.parse('2026-10-25T10:20:00Z');
  const store = new Store(':memory:', () => now);
  const jobs = [{ ...baseJob, ...job }];
  const first = setup({ jobs, store, now: () => now });
  first.scheduler.start(); // first seen 10:20
  void first.scheduler.stop();
  now = Date.parse('2026-10-25T12:30:00Z');
  const run = setup({ ...opts, jobs, store, now: () => now });
  run.scheduler.start();
  return { ...run, setNow: (t: string) => (now = Date.parse(t)), jobs };
}

describe('the shared browser', () => {
  it('leaves tabs alone when a job ends: runs close their own, the tab sweeper the rest', async () => {
    const chrome = await fakeChrome({ a: 'chrome://new-tab-page/' });
    try {
      const { scheduler } = setup({
        jobs: [{ ...baseJob, locks: ['chrome'] }],
        browserUrl: chrome.url,
        during: async () => {
          await fetch(`${chrome.url}/json/new?https://seller.example/`, { method: 'PUT' });
        },
      });
      scheduler.start();
      scheduler.trigger('shop', 'sla', 'U1');
      await scheduler.idle();
      expect(chrome.pages()).toHaveLength(2);
      expect(chrome.calls.some((c) => c.startsWith('GET /json/close'))).toBe(false);
      await scheduler.stop();
    } finally {
      chrome.server.close();
    }
  });
});

describe('scheduled runs through Slack', () => {
  it('posts a trigger message and runs only once the bot picks it up, in its thread', async () => {
    const { chat, calls, scheduler, store } = missedSlot();
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(0);
    expect(chat.log).toEqual(['post top ts1: Run SLA Report']);
    await pickUp(scheduler, chat);
    expect(calls).toHaveLength(1);
    expect(chat.updates.at(-1)?.text).toMatch(/^✅ \*SLA Report\* \(catch-up\) · .*\nHeadline$/);
    expect(chat.log.at(-1)).toBe('post ts1 ts3: Headline\n---\nDetails here');
    expect(chat.posts.filter((p) => p.thread === '')).toHaveLength(1); // nothing else top-level
    expect(store.getSession('C1:ts1')).toBeDefined();
    await scheduler.stop();
  });

  it('posts the trigger as a person when a user token is set', async () => {
    const asUser: string[] = [];
    const { chat, scheduler, calls } = missedSlot({
      chatSetup: (c) => {
        c.postAsUser = async (_channel, text) => {
          asUser.push(text);
          return 'u1';
        };
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(asUser).toEqual(['Run SLA Report']);
    expect(chat.posts).toHaveLength(0);
    scheduler.trigger('shop', 'sla', SCHEDULE_BY, { channel: 'C1', ts: 'u1' });
    await scheduler.idle();
    expect(calls).toHaveLength(1);
    // The bot can't edit a person's message: the status is the first reply in its thread.
    expect(chat.log[0]).toBe('post u1 ts1: ⏳ *SLA Report* (catch-up)');
    expect(chat.updates.every((u) => u.ts !== 'u1')).toBe(true);
    expect(chat.reactions.length).toBeGreaterThan(0);
    await scheduler.stop();
  });

  it('posts the trigger as the bot when the person is not in the channel', async () => {
    const { chat, scheduler, calls } = missedSlot({
      chatSetup: (c) => {
        c.postAsUser = async () => {
          throw new Error('not_in_channel');
        };
      },
    });
    await pickUp(scheduler, chat);
    expect(chat.log[0]).toBe('post top ts1: Run SLA Report');
    expect(calls).toHaveLength(1);
    expect(chat.log[1]).toBe('post ts1 ts2: ⏳ *SLA Report* (catch-up)'); // in the bot's own message's thread
    await scheduler.stop();
  });

  it("starts a trigger itself when Slack never delivers it, in the trigger's thread", async () => {
    const { chat, calls, scheduler } = missedSlot({ pickupTimeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    await scheduler.idle();
    expect(calls).toHaveLength(1);
    expect(chat.log[1]).toBe('post ts1 ts2: ⏳ *SLA Report* (catch-up)');
    // A late event for it starts nothing.
    expect(scheduler.trigger('shop', 'sla', SCHEDULE_BY, { channel: 'C1', ts: 'ts1' })).toBe('unknown');
    await scheduler.stop();
  });

  it('never starts a job paused between its trigger post and pickup', async () => {
    const { calls, scheduler, store, jobs, setNow } = missedSlot({ pickupTimeoutMs: 20 });
    expect(scheduler.setEnabled('shop', 'sla', false)).toBe('ok');
    await new Promise((r) => setTimeout(r, 60));
    await scheduler.idle();
    expect(calls).toHaveLength(0);
    await scheduler.stop();
    // The slot is closed as skipped (not left `running`), so the next start doesn't catch it up.
    expect(store.claimSlot('shop:sla', Date.parse('2026-10-25T12:00:00Z'))).toBe(false);
    setNow('2026-10-25T12:40:00Z');
    const next = setup({ jobs, store, now: () => Date.parse('2026-10-25T12:40:00Z') });
    next.scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    await next.scheduler.idle();
    expect(next.chat.texts()).not.toContain('Run SLA Report');
    expect(next.calls).toHaveLength(0);
    await next.scheduler.stop();
  });

  it('leaves a trigger the bot picked up to the bot', async () => {
    const { chat, calls, scheduler } = missedSlot({ pickupTimeoutMs: 30 });
    await pickUp(scheduler, chat);
    await new Promise((r) => setTimeout(r, 60));
    await scheduler.idle();
    expect(calls).toHaveLength(1);
    await scheduler.stop();
  });

  it('starts a slot once, even when Slack delivers the trigger twice', async () => {
    const { chat, calls, scheduler } = missedSlot();
    await pickUp(scheduler, chat);
    expect(scheduler.trigger('shop', 'sla', SCHEDULE_BY, { channel: 'C1', ts: 'ts1' })).toBe('unknown');
    await scheduler.idle();
    expect(calls).toHaveLength(1);
    await scheduler.stop();
  });

  it('keeps the thread and its session when the run replies nothing', async () => {
    const { chat, scheduler, store } = missedSlot({ replies: [''] });
    await pickUp(scheduler, chat);
    expect(chat.deleted).toEqual([]);
    expect(
      chat.log.some(
        (l) => l.startsWith('update ts2: 🔇 *SLA Report* (catch-up) ·') && l.endsWith('· nothing to report'),
      ),
    ).toBe(true);
    expect(store.getSession('C1:ts1')).toBeDefined();
    await scheduler.stop();
  });

  it('posts the trigger again on the next start when the bot never picked it up', async () => {
    const { chat, scheduler, store, setNow, jobs } = missedSlot();
    await new Promise((r) => setImmediate(r));
    expect(chat.posts).toHaveLength(1);
    await scheduler.stop(); // the message event never arrived
    setNow('2026-10-25T12:35:00Z');
    const again = setup({ jobs, store, now: () => Date.parse('2026-10-25T12:35:00Z') });
    again.scheduler.start();
    await pickUp(again.scheduler, again.chat);
    expect(again.calls).toHaveLength(1);
    await again.scheduler.stop();
  });
});

describe('runs cut short by a restart', () => {
  it('re-runs a slot that a shutdown aborted, once, on the next start', async () => {
    let now = Date.parse('2026-10-25T09:00:00Z');
    const store = new Store(':memory:', () => now);
    const job = { ...baseJob, cron: '0 * * * *' };
    const first = setup({ jobs: [job], store, now: () => now });
    first.scheduler.start(); // first seen 09:00:00, so the 09:00 slot counts
    await first.scheduler.stop();
    now = Date.parse('2026-10-25T10:00:30Z');
    store.claimSlot('shop:sla', Date.parse('2026-10-25T10:00:00Z'));
    store.finishSlot('shop:sla', Date.parse('2026-10-25T10:00:00Z'), 'aborted'); // the restart killed it

    now = Date.parse('2026-10-25T10:02:00Z');
    const second = setup({ jobs: [job], store, now: () => now });
    second.scheduler.start();
    await pickUp(second.scheduler, second.chat);
    expect(second.calls).toHaveLength(1);
    expect(second.chat.log[0]).toBe('post top ts1: Run SLA Report');
    await second.scheduler.stop();

    const third = setup({ jobs: [job], store, now: () => now });
    third.scheduler.start();
    await pickUp(third.scheduler, third.chat);
    expect(third.calls).toHaveLength(0); // done now: not again
    await third.scheduler.stop();
  });

  it('never re-runs a slot a person stopped', async () => {
    let now = Date.parse('2026-10-25T09:00:00Z');
    const store = new Store(':memory:', () => now);
    const job = { ...baseJob, cron: '0 * * * *' };
    const first = setup({ jobs: [job], store, now: () => now });
    first.scheduler.start();
    await first.scheduler.stop();

    // The 10:00 slot is caught up and stopped in its thread (the scheduler itself keeps running).
    now = Date.parse('2026-10-25T10:02:00Z');
    const second = setup({ jobs: [job], store, now: () => now, firstStatus: 'aborted' });
    second.scheduler.start();
    await pickUp(second.scheduler, second.chat);
    expect(second.calls).toHaveLength(1);
    await second.scheduler.stop();

    const third = setup({ jobs: [job], store, now: () => now });
    third.scheduler.start();
    await pickUp(third.scheduler, third.chat);
    expect(third.calls).toHaveLength(0);
    await third.scheduler.stop();
  });

  it('retakes a claim left running by a process that died, but never one from the current process', () => {
    let now = 1_000;
    const store = new Store(':memory:', () => now);
    expect(store.claimSlot('k', 1)).toBe(true);
    now = 2_000;
    expect(store.claimSlot('k', 1, 1_500)).toBe(true); // claimed at 1000 < 1500: stale
    expect(store.claimSlot('k', 1, 1_500)).toBe(false); // claimed at 2000: ours, still running
    store.finishSlot('k', 1, 'ok');
    expect(store.claimSlot('k', 1, 9_999)).toBe(false);
  });
});
