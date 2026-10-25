import { describe, expect, it } from 'vitest';
import type { HostConfig, Project, ProjectConfig } from '../src/config/schema.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import { type IncomingMessage, SessionManager } from '../src/sessions/manager.js';
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
      selfImprove: true,
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
  opts: { project?: Project; outcomes?: RunOutcome[]; env?: NodeJS.ProcessEnv; host?: HostConfig } = {},
) {
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
    run: async (options) => {
      calls.push(options);
      options.onEvent?.({ kind: 'init', sessionId: 'sid-1', model: 'claude-sonnet-5-5' });
      options.onEvent?.({ kind: 'tool', id: 't1', name: 'Bash', status: 'Bash: npm test' });
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
    expect(calls[0]?.args.join(' ')).toContain('Project rules.');
    expect(calls[0]?.args.join(' ')).toContain('Your name is tara.');
    expect(calls[0]?.env).toEqual({ PATH: '/bin', TARA_SCRATCH: '/tmp/scratch/shop/chat-sid-1' });

    expect(chat.texts()).toContain('*Answer*');
    expect(chat.updates.at(-1)?.text).toMatch(/^✅ Done · 3s · 1 step · claude-sonnet-5-5$/);
    expect(chat.reactions).toEqual(
      expect.arrayContaining(['+eyes@100.1', '-eyes@100.1', '+white_check_mark@100.1']),
    );
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

  it('switches model with !model and clears the session with !new', async () => {
    const { chat, calls, manager, store } = setup();
    await manager.handle(msg('!model opus'));
    await manager.handle(msg('hi'));
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--model', 'opus']));
    await manager.handle(msg('!new'));
    expect(store.getSession('C1:100.1')).toBeUndefined();
    expect(chat.texts().some((t) => t.includes('Session cleared'))).toBe(true);
  });

  it('shows the health digest on !health', async () => {
    const chat = new FakeChat('bot.');
    const manager = new SessionManager({
      projects: [project()],
      host,
      store: new Store(':memory:'),
      chat,
      log: { info() {}, warn() {}, error() {} },
      run: async () => ok(),
      jobs: {
        list: () => [],
        trigger: () => 'unknown',
        digest: () => ({ headline: '🩺 all good', details: '*Usage*\n• 1k tokens' }),
      },
    });
    await manager.handle(msg('!health'));
    expect(chat.texts()).toEqual(['🩺 all good', '*Usage*\n• 1k tokens']);
  });

  it('shows status and help', async () => {
    const { chat, manager } = setup();
    await manager.handle(msg('!status'));
    await manager.handle(msg('!help'));
    expect(chat.texts()[0]).toContain('*Project:* shop');
    expect(chat.texts()[1]).toContain('!stop');
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
      const sys = (o: RunOptions) => o.args[o.args.indexOf('--append-system-prompt') + 1];
      expect(sys(learn)).toBe(sys(turn));
      expect(learn.prompt).toContain('it ended with an error: boom');
      expect(learn.env).toEqual(turn.env);
      expect(next.prompt).toBe('<@U1>: next');
      expect(chat.texts()).toContain(
        '🔧 This conversation learned from this run (it ended with an error: boom):\n.claude/skills/x/SKILL.md: new login step',
      );
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
        project: project({ selfImprove: false }),
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

  it('stops a running turn with !stop', async () => {
    const chat = new FakeChat('bot.');
    const manager = new SessionManager({
      projects: [project()],
      host,
      store: new Store(':memory:'),
      chat,
      env: {},
      log: { info() {}, warn() {}, error() {} },
      run: (options) =>
        new Promise((resolve) =>
          options.signal?.addEventListener('abort', () =>
            resolve(ok({ status: 'aborted', text: '', durationMs: 1000 })),
          ),
        ),
    });
    const turn = manager.handle(msg('long job'));
    await new Promise((r) => setTimeout(r, 10));
    await manager.handle(msg('!stop', { ts: '100.2' }));
    await turn;
    expect(chat.updates.at(-1)?.text).toBe('⏹ Stopped after 1s.');
  });
});
