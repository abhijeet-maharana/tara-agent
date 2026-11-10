import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HostConfig, Project, ProjectConfig } from '../src/config/schema.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import type { StreamEvent } from '../src/runner/stream.js';
import type { JobControl } from '../src/scheduler/scheduler.js';
import { learnOverreach } from '../src/sessions/learn.js';
import { type IncomingMessage, isStopRequest, SessionManager } from '../src/sessions/manager.js';
import { Threads } from '../src/sessions/threads.js';
import { Store } from '../src/store/store.js';
import { FakeChat, testHost } from './fakes.js';

const host = testHost({ concurrency: 2, catchUpHours: 6, claude: { bin: 'claude', chatTimeoutMinutes: 20 } });

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
      ...overrides,
    },
    systemPrompt: 'Project rules.',
  };
}

const ok = (o: Partial<RunOutcome> = {}): RunOutcome => ({
  status: 'ok',
  text: '**Answer**',
  sessionId: 'sid-1',
  model: 'claude-sonnet-5-5',
  durationMs: 3000,
  toolCalls: 1,
  permissionDenials: [],
  ...o,
});

function setup(
  opts: {
    project?: Project;
    outcomes?: RunOutcome[];
    env?: NodeJS.ProcessEnv;
    host?: HostConfig;
    jobs?: JobControl;
    /** Tool calls the learning turn makes. */
    learnEvents?: StreamEvent[];
  } = {},
) {
  const learnEvents = [...(opts.learnEvents ?? [])];
  const chat = new FakeChat('bot.');
  const store = new Store(':memory:');
  const calls: RunOptions[] = [];
  const outcomes = [...(opts.outcomes ?? [])];
  let ids = 0;
  const manager = new SessionManager({
    projects: [opts.project ?? project()],
    host: opts.host ?? host,
    store,
    chat,
    env: opts.env ?? { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'secret' },
    log: { info() {}, warn() {}, error() {} },
    newSessionId: () => `sid-${++ids}`,
    jobs: opts.jobs,
    run: async (options) => {
      calls.push(options);
      options.onEvent?.({ kind: 'init', sessionId: 'sid-1', model: 'claude-sonnet-5-5' });
      const learning = options.prompt.includes('Reply with exactly NONE');
      if (!learning) options.onEvent?.({ kind: 'tool', id: 't1', name: 'Bash', status: 'Bash: npm test' });
      for (const e of learnEvents.splice(0, learning ? learnEvents.length : 0)) options.onEvent?.(e);
      return outcomes.shift() ?? ok();
    },
  });
  return { chat, store, calls, manager };
}

const msg = (text: string, o: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channel: 'C1',
  threadTs: '100.1',
  ts: '100.1',
  user: 'U1',
  text,
  ...o,
});

describe('SessionManager', () => {
  it("continues an agy job's session under the job's rules, never skipping agy's checks", async () => {
    const rules = { allow: ['command(grep)'], deny: ['write_file(*)'], ask: [] };
    const jobs: JobControl = {
      list: () => [],
      trigger: () => 'unknown',
      agyPermissions: (_p, id) => (id === 'ui-test' ? rules : undefined),
    };
    const { store, calls, manager } = setup({
      project: project({ permissionMode: 'bypassPermissions' }),
      jobs,
    });
    const now = Date.now();
    for (const [ts, jobId] of [
      ['100.1', 'ui-test'],
      ['200.1', 'gone'],
    ] as const) {
      store.saveSession({
        threadKey: `C1:${ts}`,
        project: 'shop',
        sessionId: `conv-${ts}`,
        model: 'gemini-x',
        started: true,
        harness: 'agy',
      });
      store.recordRun({
        kind: 'job',
        project: 'shop',
        jobId,
        threadKey: `C1:${ts}`,
        startedAt: now,
        endedAt: now,
        status: 'error',
      });
    }

    await manager.handle(msg('raise the cards', { ts: '100.2' }));
    expect(calls[0]?.harness).toBe('agy');
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--conversation', 'conv-100.1']));
    expect(calls[0]?.args).not.toContain('--dangerously-skip-permissions');
    expect(calls[0]?.agy?.settings).toEqual({
      permissions: { allow: ['command(grep)', 'mcp(tara_tara/*)'], deny: ['write_file(*)'], ask: [] },
    });

    // A job that's gone (or has no rules): only tara's tools.
    await manager.handle(msg('and this one?', { threadTs: '200.1', ts: '200.2' }));
    expect(calls[1]?.args).not.toContain('--dangerously-skip-permissions');
    expect(calls[1]?.agy?.settings).toEqual({
      permissions: { allow: ['mcp(tara_tara/*)'], deny: [], ask: [] },
    });
  });

  it('starts a session, then resumes it on a thread reply', async () => {
    const { chat, calls, manager } = setup();
    await manager.handle(msg('hello'));
    await manager.handle(msg('and then?', { ts: '100.2' }));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--session-id', 'sid-1', '--model', 'sonnet']));
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['--resume', 'sid-1']));
    // The first message of a session names its scratch folder; replies don't repeat it.
    expect(calls[0]?.prompt).toMatch(
      /^<@U1>: hello\n\nYour folders:\n- Scratch folder \(`\$TARA_SCRATCH`\): \/tmp\/scratch\/shop\/chat-sid-1\./,
    );
    expect(calls[1]?.prompt).toBe('<@U1>: and then?');
    expect(calls[0]?.cwd).toBe('/repo');
    expect(calls[0]?.systemPrompt).toContain('Project rules.');
    expect(calls[0]?.systemPrompt).toContain('Your name is tara.');
    expect(calls[0]?.env).toEqual({ PATH: '/bin', TARA_SCRATCH: '/tmp/scratch/shop/chat-sid-1' });

    expect(chat.texts()).toContain('*Answer*');
    expect(chat.updates.at(-1)?.text).toMatch(/^✅ Done · 3s · 1 step · claude-sonnet-5-5$/);
    expect(chat.reactions).toEqual(
      expect.arrayContaining(['+eyes@100.1', '-eyes@100.1', '+white_check_mark@100.1']),
    );
  });

  it('saves posted files to the scratch folder and names them in the prompt', async () => {
    const { calls, manager } = setup();
    await manager.handle(
      msg('', {
        ts: '100.3',
        attachments: [
          { name: 'label photo.jpg', fetch: async () => Buffer.from('jpg') },
          { name: 'gone.png', fetch: async () => Promise.reject(new Error('HTTP 404')) },
        ],
      }),
    );
    const saved = '/tmp/scratch/shop/chat-sid-1/slack/100.3-1-label_photo.jpg';
    expect(calls[0]?.prompt).toMatch(
      /^<@U1>: \n\nAttached files \(read them with the Read tool\):\n- \/tmp\/scratch\/shop\/chat-sid-1\/slack\/100\.3-1-label_photo\.jpg\n- gone\.png \(could not be downloaded\)\n\nYour folders:/,
    );
    expect(readFileSync(saved, 'utf8')).toBe('jpg');
  });

  it('runs every turn at the host effort level when one is set', async () => {
    const { calls, manager } = setup({
      host: testHost({ claude: { bin: 'claude', chatTimeoutMinutes: 20, effort: 'high' } }),
    });
    await manager.handle(msg('hello'));
    expect(calls[0]?.args.join(' ')).toContain('--effort high');
  });

  it('keeps separate sessions per thread', async () => {
    const { calls, manager } = setup();
    await manager.handle(msg('a'));
    await manager.handle(msg('b', { threadTs: '200.1', ts: '200.1' }));
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['--session-id', 'sid-2']));
  });

  it('ignores other channels and users outside allowedUsers', async () => {
    const { calls, manager } = setup({ project: project({ allowedUsers: ['U9'] }) });
    await manager.handle(msg('hi', { channel: 'C2' }));
    await manager.handle(msg('hi'));
    expect(calls).toHaveLength(0);
  });

  it('sends "!" messages to Claude like any other message', async () => {
    const { calls, manager } = setup();
    await manager.handle(msg('!status'));
    expect(calls[0]?.prompt).toMatch(/^<@U1>: !status/);
  });

  it('explains permission denials', async () => {
    const { chat, manager } = setup({ outcomes: [ok({ permissionDenials: ['Bash', 'WebFetch'] })] });
    await manager.handle(msg('run tests'));
    expect(chat.texts().at(-1)).toMatch(/Blocked by permission mode `default`: Bash, WebFetch/);
  });

  it('reports limits and failures without posting an answer', async () => {
    const { chat, manager } = setup({
      outcomes: [
        ok({ status: 'limit', text: '', rateLimit: { status: 'rejected' } }),
        ok({ status: 'error', text: '', error: 'boom' }),
      ],
    });
    await manager.handle(msg('one'));
    await manager.handle(msg('two', { ts: '100.3' }));
    const finals = chat.updates.map((u) => u.text).filter((t) => !t.startsWith('⏳'));
    expect(finals[0]).toMatch(/usage limit/);
    expect(finals[1]).toBe('❌ Failed: boom');
    expect(chat.texts()).not.toContain('*Answer*');
  });

  describe('selfImprove', () => {
    it('learns after a turn with trouble, before the next message resumes the session', async () => {
      const { chat, calls, manager } = setup({
        outcomes: [
          ok({ status: 'error', text: '', error: 'boom' }),
          ok({ text: '.claude/skills/x/SKILL.md: new login step' }),
          ok(),
        ],
      });
      await manager.handle(msg('one'));
      await manager.handle(msg('next', { ts: '100.2' }));

      expect(calls).toHaveLength(3);
      const [turn, learn, next] = calls as [RunOptions, RunOptions, RunOptions];
      expect(learn.args).toEqual(expect.arrayContaining(['--resume', 'sid-1', '--model', 'sonnet']));
      // Same system prompt as the turn, so the cached prompt is reused.
      const sys = (o: RunOptions) => o.systemPrompt;
      expect(sys(learn)).toBe(sys(turn));
      expect(learn.prompt).toContain('it ended with an error: boom');
      expect(learn.env).toEqual(turn.env);
      expect(next.prompt).toBe('<@U1>: next');
      expect(chat.texts()).toContain(
        '🔧 This conversation learned from this run (it ended with an error: boom):\n.claude/skills/x/SKILL.md: new login step',
      );
    });

    it('looks back after every clean turn that used a tool in always mode', async () => {
      const { chat, calls, manager } = setup({
        project: project({ selfImprove: 'always' }),
        outcomes: [ok(), ok({ text: 'NONE' }), ok({ toolCalls: 0 })],
      });
      await manager.handle(msg('one'));
      expect(calls).toHaveLength(2);
      expect(calls[1]?.prompt).toContain('This run is done. Before you stop, look back');
      expect(chat.texts().some((t) => t.includes('🔧'))).toBe(false);

      // A reply with no tool calls followed no procedure: nothing to look back at.
      await manager.handle(msg('two', { ts: '100.2' }));
      expect(calls).toHaveLength(3);

      const limited = setup({
        project: project({ selfImprove: 'always' }),
        outcomes: [ok({ status: 'limit', text: '', rateLimit: { status: 'rejected' } })],
      });
      await limited.manager.handle(msg('hi'));
      expect(limited.calls).toHaveLength(1);
    });

    it('warns when the learning turn edits more than instruction files', async () => {
      const { chat, manager } = setup({
        outcomes: [ok({ status: 'error', text: '', error: 'boom' }), ok({ text: 'SKILL.md: new step' })],
        learnEvents: [
          {
            kind: 'tool',
            id: 'l1',
            name: 'Edit',
            status: 'Edit: SKILL.md',
            file: '/repo/.claude/skills/x/SKILL.md',
          },
          { kind: 'tool', id: 'l2', name: 'Write', status: 'Write: app.ts', file: '/repo/src/app.ts' },
        ],
      });
      await manager.handle(msg('one'));
      const note = chat.texts().find((t) => t.startsWith('🔧'));
      expect(note).toContain(
        '⚠️ It also did more than edit instruction files, please check: edited /repo/src/app.ts',
      );
      expect(note).not.toContain('SKILL.md, ');
    });

    it('skips clean turns, usage limits, stops, setup errors and projects that turn it off', async () => {
      const clean = setup({ outcomes: [ok()] });
      await clean.manager.handle(msg('hi'));
      expect(clean.calls).toHaveLength(1);

      const limited = setup({
        outcomes: [ok({ status: 'limit', text: '', rateLimit: { status: 'rejected' } })],
      });
      await limited.manager.handle(msg('hi'));
      expect(limited.calls).toHaveLength(1);

      const stopped = setup({ outcomes: [ok({ status: 'aborted', text: '' })] });
      await stopped.manager.handle(msg('hi'));
      expect(stopped.calls).toHaveLength(1);

      const off = setup({
        project: project({ selfImprove: 'off' }),
        outcomes: [ok({ status: 'error', text: '', error: 'boom' })],
      });
      await off.manager.handle(msg('hi'));
      expect(off.calls).toHaveLength(1);
    });
  });

  it('drops a session the CLI no longer knows', async () => {
    const { manager, store } = setup({
      outcomes: [ok(), ok({ status: 'error', error: 'No conversation found with session ID: sid-1' })],
    });
    await manager.handle(msg('one'));
    await manager.handle(msg('two', { ts: '100.2' }));
    expect(store.getSession('C1:100.1')).toBeUndefined();
  });

  it('reports a setup error for api billing without a key', async () => {
    const { chat, calls, manager } = setup({ project: project({ billing: 'api' }), env: { PATH: '/bin' } });
    await manager.handle(msg('hi'));
    expect(calls).toHaveLength(0);
    expect(chat.updates.at(-1)?.text).toMatch(/ANTHROPIC_API_KEY/);
  });

  /** A manager whose turns run until stopped. */
  function blocking() {
    const chat = new FakeChat('bot.');
    const calls: RunOptions[] = [];
    const manager = new SessionManager({
      projects: [project({ selfImprove: 'off' })],
      host,
      store: new Store(':memory:'),
      chat,
      env: {},
      log: { info() {}, warn() {}, error() {} },
      run: (options) => {
        calls.push(options);
        return new Promise((resolve) => {
          const stop = () => resolve(ok({ status: 'aborted', text: '', durationMs: 1000 }));
          if (options.signal?.aborted) stop();
          options.signal?.addEventListener('abort', stop);
        });
      },
    });
    return { chat, calls, manager };
  }

  it.each(['stop', 'Stop!', '!stop', 'please stop it', 'cancel', 'abort now'])(
    'stops a running turn on "%s"',
    async (word) => {
      const { chat, calls, manager } = blocking();
      const turn = manager.handle(msg('long job'));
      await new Promise((r) => setTimeout(r, 10));
      await manager.handle(msg(word, { ts: '100.2' }));
      await turn;
      expect(chat.updates.at(-1)?.text).toBe('⏹ Stopped after 1s.');
      expect(calls).toHaveLength(1);
    },
  );

  it('treats "stop" inside a longer message as a normal message', async () => {
    const { calls, manager } = setup();
    expect(isStopRequest('stop the meesho ads')).toBe(false);
    await manager.handle(msg('stop the meesho ads'));
    expect(calls[0]?.prompt).toMatch(/^<@U1>: stop the meesho ads/);
  });

  it('says so when "stop" finds nothing running', async () => {
    const { chat, calls, manager } = setup();
    await manager.handle(msg('stop'));
    expect(calls).toHaveLength(0);
    expect(chat.texts()).toEqual(['Nothing is running in this thread.']);
  });

  it('tells you a message waits for the running turn, then runs it next', async () => {
    const { chat, calls, manager } = blocking();
    const first = manager.handle(msg('long job'));
    await new Promise((r) => setTimeout(r, 10));
    const second = manager.handle(msg('also include X', { ts: '100.2' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(chat.texts().some((t) => t.startsWith('⏳ Noted.'))).toBe(true);
    expect(calls).toHaveLength(1);

    await manager.handle(msg('stop', { ts: '100.3' }));
    await first;
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toMatch(/^<@U1>: also include X/);
    await manager.handle(msg('stop', { ts: '100.4' }));
    await second;
  });

  it('makes a reply wait for a job holding the thread, and stops the job on "stop"', async () => {
    const threads = new Threads();
    const chat = new FakeChat('bot.');
    const calls: RunOptions[] = [];
    const manager = new SessionManager({
      projects: [project({ selfImprove: 'off' })],
      host,
      store: new Store(':memory:'),
      chat,
      threads,
      log: { info() {}, warn() {}, error() {} },
      run: async (options) => {
        calls.push(options);
        return ok();
      },
    });
    const job = await threads.enter('C1:100.1');
    const reply = manager.handle(msg('also include X', { ts: '100.2' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);

    await manager.handle(msg('stop', { ts: '100.3' }));
    expect(job.signal.aborted).toBe(true);
    job.release();
    await reply;
    expect(calls).toHaveLength(1);
  });

  it("starts a scheduled job from the bot's own trigger message, whoever allowedUsers names", async () => {
    const started: unknown[] = [];
    const jobs: JobControl = {
      list: () => [
        {
          id: 'find-jobs',
          name: 'Find jobs',
          enabled: true,
          running: false,
          tz: 'UTC',
          skills: [],
          model: 'opus',
        },
      ],
      trigger: (...args) => {
        started.push(args);
        return 'started';
      },
    };
    const { calls, manager } = setup({ project: project({ allowedUsers: ['U1'] }), jobs });
    const text = '⏰ Scheduled: *Find jobs* (`find-jobs`)';
    await manager.handle(msg(text, { user: 'UBOT', fromSelf: true }));
    expect(started).toEqual([['shop', 'find-jobs', 'schedule', { channel: 'C1', ts: '100.1' }]]);
    // From someone not in allowedUsers: ignored.
    await manager.handle(msg(text, { user: 'U2', ts: '200.1', threadTs: '200.1' }));
    expect(started).toHaveLength(1);
    // Posted as an allowed person (SLACK_USER_TOKEN): the same scheduled start.
    await manager.handle(msg(text, { user: 'U1', ts: '300.1', threadTs: '300.1' }));
    expect(started.at(-1)).toEqual(['shop', 'find-jobs', 'schedule', { channel: 'C1', ts: '300.1' }]);
    // Something that looks like a trigger but doesn't parse never reaches Claude as a chat message.
    await manager.handle(
      msg(':alarm_clock: Scheduled: *Find jobs* (find-jobs)', { ts: '400.1', threadTs: '400.1' }),
    );
    expect(started).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });
});

describe('"Run <id>" triggers', () => {
  function withSlot(pending: boolean) {
    const started: unknown[][] = [];
    let slot = pending;
    const jobs: JobControl = {
      list: () => [
        {
          id: 'find-jobs',
          name: 'Find jobs',
          enabled: true,
          running: false,
          tz: 'UTC',
          skills: [],
          model: 'opus',
        },
      ],
      trigger: (...args) => {
        started.push(args);
        if (args[2] !== 'schedule') return 'started';
        // Like the scheduler: a scheduled start takes the waiting slot once.
        const had = slot;
        slot = false;
        return had ? 'started' : 'unknown';
      },
    };
    return { started, ...setup({ project: project({ allowedUsers: ['U1'] }), jobs }) };
  }

  it('runs the waiting slot when the scheduler posted it, as the bot or as a person', async () => {
    const bot = withSlot(true);
    await bot.manager.handle(msg('Run find-jobs', { user: 'UBOT', fromSelf: true }));
    expect(bot.started).toEqual([['shop', 'find-jobs', 'schedule', { channel: 'C1', ts: '100.1' }]]);

    const person = withSlot(true);
    await person.manager.handle(msg('Run find-jobs', { user: 'U1' }));
    expect(person.started).toEqual([['shop', 'find-jobs', 'schedule', { channel: 'C1', ts: '100.1' }]]);
    expect(person.calls).toHaveLength(0);
  });

  it("ignores the bot's own Run message for a paused job (it opened a thread for a run already going)", async () => {
    const started: unknown[] = [];
    const jobs: JobControl = {
      list: () => [
        {
          id: 'find-jobs',
          name: 'Find jobs',
          enabled: false,
          running: false,
          tz: 'UTC',
          skills: [],
          model: 'opus',
        },
      ],
      trigger: (...args) => {
        started.push(args);
        return 'started';
      },
    };
    const { chat, calls, manager } = setup({ jobs });
    await manager.handle(msg('Run find-jobs', { user: 'UBOT', fromSelf: true }));
    expect(started).toHaveLength(0);
    expect(chat.texts()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('is a normal run request when a person types it and no slot is waiting', async () => {
    const { started, calls, manager } = withSlot(false);
    await manager.handle(msg('Run find-jobs', { user: 'U1' }));
    expect(started.at(-1)).toEqual(['shop', 'find-jobs', 'U1', { channel: 'C1', ts: '100.1' }]);
    expect(calls).toHaveLength(0);

    // The bot's own message with no slot waiting (a redelivery) starts nothing.
    const again = withSlot(false);
    await again.manager.handle(msg('Run find-jobs', { user: 'UBOT', fromSelf: true }));
    expect(again.started).toHaveLength(1);
    expect(again.started[0]?.[2]).toBe('schedule');
  });
});

describe('learnOverreach', () => {
  it('allows reads and .md edits, and names everything else', () => {
    expect(
      learnOverreach([
        { name: 'Read', file: '/r/src/a.ts' },
        { name: 'Grep' },
        { name: 'Edit', file: '/r/.claude/skills/x/SKILL.md' },
        { name: 'Edit', file: '/r/src/a.ts' },
      ]),
    ).toEqual(['edited /r/src/a.ts']);
    expect(learnOverreach([{ name: 'Read', file: '/r/src/a.ts' }])).toEqual([]);
    expect(learnOverreach([{ name: 'Glob' }, { name: 'Edit', file: '/r/CLAUDE.md' }])).toEqual([]);
    // A skill's own scripts, and the job scripts skills run, may be fixed too.
    expect(
      learnOverreach([
        { name: 'Write', file: '/r/.agents/skills/x/scripts/fetch.py' },
        { name: 'Edit', file: '/r/.tara/scripts/gate.sh' },
      ]),
    ).toEqual([]);
    expect(
      learnOverreach([
        { name: 'Bash' },
        { name: 'Bash' },
        { name: 'mcp__tara__send_file' },
        { name: 'Write', file: '/r/x.json' },
      ]),
    ).toEqual(['used Bash', 'used mcp__tara__send_file', 'edited /r/x.json']);
  });
});
