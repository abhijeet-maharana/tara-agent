import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import { startHttpServer } from '../src/http/server.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import { buildDigest } from '../src/scheduler/health.js';
import { streamRecipient } from '../src/scheduler/job-runner.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { ScriptResult } from '../src/scheduler/script.js';
import { Threads } from '../src/sessions/threads.js';
import { type Item, Store, type StoredRun } from '../src/store/store.js';
import { FakeChat, FakeStream, testHost } from './fakes.js';

const host = testHost({ concurrency: 2, catchUpHours: 6, claude: { bin: 'claude', chatTimeoutMinutes: 20 } });

function makeProject(jobs: object[], env: object = {}, owner?: string, selfImprove = false): Project {
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
  script?: ScriptResult;
  now?: () => number;
  store?: Store;
  stream?: FakeStream;
  owner?: string;
  selfImprove?: boolean;
  /** Tool calls that fail in the first run. */
  toolErrors?: number;
}) {
  const chat = new FakeChat('ts');
  chat.stream = opts.stream;
  const store = opts.store ?? new Store(':memory:', opts.now);
  const calls: RunOptions[] = [];
  const callTimes: number[] = [];
  const scripts: { script: string; env: NodeJS.ProcessEnv }[] = [];
  const replies = [...(opts.replies ?? [])];
  const project = makeProject(opts.jobs, opts.env, opts.owner, opts.selfImprove);
  const scheduler = new Scheduler({
    projects: [project],
    host,
    store,
    chat,
    log: { info() {}, warn() {}, error() {} },
    env: { PATH: '/bin', SLACK_BOT_TOKEN: 'secret' },
    now: opts.now,
    newSessionId: () => 'sid',
    runScript: async (script, _cwd, env) => {
      scripts.push({ script, env });
      return opts.script ?? { ok: true, output: 'STATUS: OK', exitCode: 0, timedOut: false };
    },
    run: async (o) => {
      calls.push(o);
      callTimes.push(Date.now());
      o.onEvent?.({ kind: 'init', sessionId: 'sid', model: 'claude-haiku-5-5' });
      o.onEvent?.({ kind: 'tool', id: 't1', name: 'Bash', status: 'Bash: curl' });
      o.onEvent?.({ kind: 'tool_result', id: 't1', isError: false });
      if (calls.length === 1) {
        for (let i = 0; i < (opts.toolErrors ?? 0); i++) {
          o.onEvent?.({ kind: 'tool', id: `e${i}`, name: 'Bash', status: 'Bash: click' });
          o.onEvent?.({ kind: 'tool_result', id: `e${i}`, isError: true });
        }
      }
      const reply = replies.shift() ?? 'Headline\n---\nDetails here';
      o.onEvent?.({ kind: 'text_start' });
      o.onEvent?.({ kind: 'text', text: reply });
      return ok(reply);
    },
  });
  return { chat, store, calls, callTimes, scripts, scheduler, project };
}

const baseJob = {
  id: 'sla',
  name: 'SLA Report',
  cron: '0 * * * *',
  tz: 'UTC',
  prompt: 'Run the report.',
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

  it('runs a job on demand: script context, job prompt, headline in channel, details in thread', async () => {
    const { chat, calls, scripts, scheduler, store } = setup({
      jobs: [{ ...baseJob, preScript: 'gate.sh', skills: ['sla-report'] }],
      env: { ROOT: '~/repo' },
    });
    scheduler.start();
    expect(scheduler.trigger('shop', 'sla', 'U1')).toBe('started');
    expect(scheduler.trigger('shop', 'sla', 'U1')).toBe('running');
    await scheduler.idle();

    expect(scripts[0]?.script).toBe('gate.sh');
    expect(scripts[0]?.env.ROOT).toMatch(/\/repo$/);
    expect(scripts[0]?.env.SLACK_BOT_TOKEN).toBeUndefined();
    const call = calls[0] as RunOptions;
    expect(call.prompt).toMatch(/^## Script Output[\s\S]*Run the report\.[\s\S]*`sla-report`/);
    expect(call.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--session-id', 'sid']));
    // No host effort set: the model's default applies.
    expect(call.args).not.toContain('--effort');
    expect(call.systemPrompt).toContain('unattended');
    expect(call.systemPrompt).toContain('Project rules.');
    // Its own scratch folder and the job's data folder, as env and as absolute paths in the prompt.
    expect(call.env.TARA_SCRATCH).toBe('/tmp/scratch/shop/sla-sid');
    expect(call.env.TARA_JOB_DATA).toBe('/tmp/job-data/shop/sla');
    expect(call.prompt).toContain('- Scratch folder (`$TARA_SCRATCH`): /tmp/scratch/shop/sla-sid.');
    expect(call.prompt).toContain('- Job data folder (`$TARA_JOB_DATA`): /tmp/job-data/shop/sla.');
    expect(scripts[0]?.env.TARA_JOB_DATA).toBe('/tmp/job-data/shop/sla');
    expect(scripts[0]?.env.TARA_SCRATCH).toBeUndefined();

    expect(chat.log[0]).toBe('post top ts1: ⏳ *SLA Report* (run by <@U1>)');
    expect(chat.log.at(-2)).toBe(
      'update ts1: ✅ *SLA Report* (run by <@U1>) · 2s · 2 steps · claude-haiku-5-5\nHeadline',
    );
    expect(chat.log.at(-1)).toBe('post ts1 ts2: Details here');
    // Replies in the job thread resume the job's session.
    expect(store.getSession('C1:ts1')).toMatchObject({ sessionId: 'sid', model: 'haiku', started: true });
    expect(scheduler.list('shop')[0]).toMatchObject({ id: 'sla', lastStatus: 'ok', running: false });
    await scheduler.stop();
  });

  it('stays silent when the script gate says so (no model, no post)', async () => {
    const { chat, calls, scheduler } = setup({
      jobs: [{ ...baseJob, preScript: 'gate.py' }],
      script: { ok: true, output: 'checked\n{"wakeAgent": false}', exitCode: 0, timedOut: false },
    });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(calls).toHaveLength(0);
    expect(chat.log).toEqual([]);
    await scheduler.stop();
  });

  it('deletes the thread when the model replies [SILENT]', async () => {
    const { chat, scheduler, store } = setup({ jobs: [baseJob], replies: ['[SILENT]'] });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(chat.log.at(-1)).toBe('delete ts1');
    expect(store.getSession('C1:ts1')).toBeUndefined();
    await scheduler.stop();
  });

  it('marks [CRON_FAILURE] replies as failed', async () => {
    const { chat, scheduler } = setup({ jobs: [baseJob], replies: ['[CRON_FAILURE]\nPortal login expired'] });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(
      chat.log.some((l) => l.startsWith('update ts1: ❌ *SLA Report*') && l.endsWith('Portal login expired')),
    ).toBe(true);
    expect(scheduler.list('shop')[0]?.lastStatus).toBe('failed');
    await scheduler.stop();
  });

  describe('selfImprove', () => {
    it('resumes a failed run once to fix its skill, reports the change, and keeps it out of job history', async () => {
      const { chat, calls, scheduler, store } = setup({
        jobs: [baseJob],
        selfImprove: true,
        replies: ['[CRON_FAILURE]\nSave button not found', '.claude/skills/sla/SKILL.md: new Save selector'],
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
        'post ts1 ts3: 🔧 *SLA Report* learned from this run (it reported a failure: Save button not found):\n.claude/skills/sla/SKILL.md: new Save selector',
      );
      expect(store.jobRuns('shop', 'sla', 10).map((r) => r.status)).toEqual(['failed']);
      expect(store.runsSince(0).map((r) => r.kind)).toEqual(['job', 'learn']);
      expect(scheduler.list('shop')[0]?.lastStatus).toBe('failed');
      await scheduler.stop();
    });

    it('costs nothing extra for a clean run, and posts nothing when there is nothing to change', async () => {
      const clean = setup({ jobs: [baseJob], selfImprove: true });
      clean.scheduler.start();
      clean.scheduler.trigger('shop', 'sla', 'U1');
      await clean.scheduler.idle();
      expect(clean.calls).toHaveLength(1);
      await clean.scheduler.stop();

      const none = setup({
        jobs: [baseJob],
        selfImprove: true,
        replies: ['[CRON_FAILURE]\nPortal down', 'NONE'],
      });
      none.scheduler.start();
      none.scheduler.trigger('shop', 'sla', 'U1');
      await none.scheduler.idle();
      expect(none.calls).toHaveLength(2);
      expect(none.chat.log.some((l) => l.includes('🔧'))).toBe(false);
      await none.scheduler.stop();
    });

    it('learns from tool errors in a silent run and reports in the channel, since its thread is gone', async () => {
      const { chat, calls, scheduler } = setup({
        jobs: [baseJob],
        selfImprove: true,
        toolErrors: 2,
        replies: ['[SILENT]', 'SKILL.md: dismiss the cookie banner first'],
      });
      scheduler.start();
      scheduler.trigger('shop', 'sla', 'U1');
      await scheduler.idle();
      expect(calls[1]?.prompt).toContain('2 tool calls returned errors');
      expect(chat.log.at(-1)).toMatch(/^post top ts\d: 🔧 \*SLA Report\* learned from this run/);
      await scheduler.stop();
    });

    it('stays off when the project turns it off', async () => {
      const { calls, scheduler } = setup({ jobs: [baseJob], replies: ['[CRON_FAILURE]\nBroken'] });
      scheduler.start();
      scheduler.trigger('shop', 'sla', 'U1');
      await scheduler.idle();
      expect(calls).toHaveLength(1);
      await scheduler.stop();
    });
  });

  it('posts script output as-is for script-only jobs', async () => {
    const { chat, calls, scheduler } = setup({
      jobs: [{ id: 'backup', name: 'Backup', cron: '0 2 * * *', preScript: 'b.sh', agent: false }],
      script: { ok: false, output: 'upload failed\n(exit code 1)', exitCode: 1, timedOut: false },
    });
    scheduler.start();
    scheduler.trigger('shop', 'backup', 'U1');
    await scheduler.idle();
    expect(calls).toHaveLength(0);
    expect(chat.log[0]).toMatch(/^post top ts1: ❌ \*Backup\* \(run by <@U1>\) · \d+s\n```\nupload failed/);
    await scheduler.stop();
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
    await second.scheduler.idle();
    expect(second.calls).toHaveLength(1);
    expect(second.chat.log[0]).toBe('post top ts1: ⏳ *SLA Report* (catch-up)');
    await second.scheduler.stop();

    // A restart in the same hour doesn't run it again: the slot is claimed.
    const third = setup({ jobs: [job], store, now: () => now });
    third.scheduler.start();
    await third.scheduler.idle();
    expect(third.calls).toHaveLength(0);
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
    const { calls, callTimes, scheduler, store } = setup({ jobs: [{ ...baseJob, cron: '*/2 * * * * *' }] });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 2_600));
    await scheduler.idle();
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
    expect(chat.log[0]).toMatch(/jobs\.json` was not reloaded/);
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
    expect(chat.log[0]).toBe('post top ts1: ⏳ *SLA Report* (run by job-board)');
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

describe('health digest', () => {
  const run = (o: Partial<StoredRun>): StoredRun => ({
    id: 1,
    kind: 'job',
    project: 'shop',
    jobId: 'sla',
    startedAt: Date.parse('2026-10-25T05:00:00Z'),
    endedAt: Date.parse('2026-10-25T05:02:00Z'),
    status: 'ok',
    ...o,
  });

  it('stays quiet when nothing ran or was missed', () => {
    expect(buildDigest({ project: 'shop', runs: [], missed: [], timeZone: 'UTC' })).toBeNull();
  });

  it('summarises runs, problems, missed slots and usage', () => {
    const digest = buildDigest({
      project: 'shop',
      timeZone: 'UTC',
      runs: [
        run({ rateLimitUtilization: 0.41, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2_000_000 }),
        run({ status: 'silent' }),
        run({ status: 'failed', jobId: 'ads', error: 'Portal login expired\nmore' }),
        run({ kind: 'chat', jobId: undefined }),
      ],
      missed: [{ id: 'labels', name: 'Labels', slots: [Date.parse('2026-10-25T00:00:00Z')] }],
    });
    expect(digest?.headline).toBe(
      '⚠️ *Daily health · shop* · last 24h: 3 job runs (1 ok, 1 silent, 1 with problems), 1 chat turns · *1 missed* · peak 5h usage 41%',
    );
    expect(digest?.details).toContain('• `ads` failed at Sun 05:00: Portal login expired');
    expect(digest?.details).toContain('• `labels` Labels: Sun 00:00');
    expect(digest?.details).toContain('1.5k tokens in/out, 2.00M cache reads');
  });

  it('lists skill fixes from learning turns, without counting them as job runs or problems', () => {
    const digest = buildDigest({
      project: 'shop',
      timeZone: 'UTC',
      runs: [
        run({ status: 'failed', jobId: 'ads', error: 'Save button not found' }),
        run({ kind: 'learn', jobId: 'ads', output: '.claude/skills/ads/SKILL.md: new Save selector' }),
        run({ kind: 'learn', jobId: 'ads', output: 'NONE' }),
        run({ kind: 'learn', jobId: 'ads', status: 'timeout' }),
      ],
      missed: [],
    });
    expect(digest?.headline).toBe(
      '⚠️ *Daily health · shop* · last 24h: 1 job runs (0 ok, 0 silent, 1 with problems), 0 chat turns · 🔧 1 skill fix · peak 5h usage 0%',
    );
    expect(digest?.details).toContain('*Learned*');
    expect(digest?.details).toContain('• `ads` at Sun 05:00: .claude/skills/ads/SKILL.md: new Save selector');
  });

  it('finds slots that were never claimed (downtime) but not slots that ran', async () => {
    let now = Date.parse('2026-10-25T00:30:00Z');
    const store = new Store(':memory:', () => now);
    const ctx = setup({ jobs: [{ ...baseJob, cron: '0 */6 * * *', catchUp: false }], store, now: () => now });
    ctx.scheduler.start(); // first seen 00:30
    await ctx.scheduler.stop();
    now = Date.parse('2026-10-25T13:00:00Z');
    store.claimSlot('shop:sla', Date.parse('2026-10-25T06:00:00Z')); // 06:00 ran, 12:00 was missed
    const later = setup({
      jobs: [{ ...baseJob, cron: '0 */6 * * *', catchUp: false }],
      store,
      now: () => now,
    });
    later.scheduler.start();
    await later.scheduler.idle();
    const digest = later.scheduler.digest('shop');
    expect(digest?.headline).toContain('*1 missed*');
    expect(digest?.details).toContain('• `sla` SLA Report: Sun 12:00');
    await later.scheduler.stop();
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
  it('streams only runs someone started, to that person or the project owner', () => {
    expect(streamRecipient({ kind: 'schedule' }, 'UOWNER')).toBeUndefined();
    expect(streamRecipient({ kind: 'catch-up' }, 'UOWNER')).toBeUndefined();
    expect(streamRecipient({ kind: 'manual', by: 'U123ABC' }, 'UOWNER')).toBe('U123ABC');
    expect(streamRecipient({ kind: 'manual', by: 'Shop Dashboard' }, 'UOWNER')).toBe('UOWNER');
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
    // Headline still updates the channel message; details are not posted a second time.
    expect(chat.log.some((l) => l.startsWith('update ts1: ✅ *SLA Report* (run by <@U1>)'))).toBe(true);
    expect(chat.posts.filter((p) => p.thread === 'ts1')).toHaveLength(0);
    await scheduler.stop();
  });

  it('streams board/API runs to the owner, and keeps scheduled runs as before', async () => {
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
    expect(plain.chat.texts()).toContain('Details here');
    await plain.scheduler.stop();
    expect(chat.posts.filter((p) => p.thread === 'ts1')).toHaveLength(0);
  });

  it('removes the streamed thread too when the job had nothing to report', async () => {
    const stream = new FakeStream();
    const { chat, scheduler } = setup({ jobs: [baseJob], stream, replies: ['[SILENT]'] });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1');
    await scheduler.idle();
    expect(chat.deleted).toEqual(['s1', 'ts1']);
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

  it('says why when the pre-check finds nothing to do', async () => {
    const { chat, scheduler } = setup({
      jobs: [{ ...baseJob, preScript: 'gate.py' }],
      script: {
        ok: true,
        output: 'Skipping: 1 post in the queue\n{"wakeAgent": false}',
        exitCode: 0,
        timedOut: false,
      },
    });
    scheduler.start();
    scheduler.trigger('shop', 'sla', 'U1', { channel: 'C1', ts: '500.1' });
    await scheduler.idle();
    expect(chat.texts()).toEqual([
      '🔇 *SLA Report* (run by <@U1>): nothing to do right now.\n> Skipping: 1 post in the queue',
    ]);
    await scheduler.stop();
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
    await second.scheduler.idle();
    expect(second.calls).toHaveLength(1);
    expect(second.chat.log[0]).toBe('post top ts1: ⏳ *SLA Report* (catch-up)');
    await second.scheduler.stop();

    const third = setup({ jobs: [job], store, now: () => now });
    third.scheduler.start();
    await third.scheduler.idle();
    expect(third.calls).toHaveLength(0); // done now: not again
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
