import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/runner/args.js';
import { buildChildEnv } from '../src/runner/env.js';
import { type RunOptions, runClaude } from '../src/runner/run.js';
import { describeTool, parseStreamLine, type StreamEvent } from '../src/runner/stream.js';

const fixture = fileURLToPath(new URL('./fixtures/turn-with-tool.jsonl', import.meta.url));
const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

describe('parseStreamLine', () => {
  const events = readFileSync(fixture, 'utf8').split('\n').flatMap(parseStreamLine);

  it('extracts init, tool, rate limit and result events', () => {
    expect(events.map((e) => e.kind)).toEqual(['init', 'tool', 'rate_limit', 'result']);
    expect(events[0]).toEqual({
      kind: 'init',
      sessionId: '11111111-2222-4333-8444-555555555555',
      model: 'claude-haiku-5-5',
    });
    expect(events[1]).toEqual({
      kind: 'tool',
      name: 'Bash',
      status: 'Bash: List files in current directory',
    });
    expect(events[2]).toMatchObject({
      rateLimit: { status: 'allowed', window: 'five_hour', utilization: 0.02 },
    });
  });

  it('reads the result with usage and cost', () => {
    const result = events[3] as Extract<StreamEvent, { kind: 'result' }>;
    expect(result).toMatchObject({ isError: false, text: 'done', numTurns: 2, permissionDenials: [] });
    expect(result.usage).toEqual({ input: 4, output: 77, cacheRead: 37611, cacheCreation: 14122 });
    expect(result.costUsd).toBeCloseTo(0.0032, 4);
  });

  it('ignores junk and unknown events', () => {
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine('{"type":"stream_event"}')).toEqual([]);
    expect(parseStreamLine('[]')).toEqual([]);
  });
});

describe('describeTool', () => {
  it.each([
    ['Read', { file_path: '/repo/src/index.ts' }, 'Read: index.ts'],
    ['Bash', { command: 'npm test' }, 'Bash: npm test'],
    ['WebFetch', { url: 'https://example.com/a/b' }, 'WebFetch: example.com'],
    ['WebFetch', { url: 'not a url' }, 'WebFetch'],
    ['mcp__chrome__navigate_page', {}, 'chrome: navigate_page'],
    ['Skill', { skill: 'sla-report' }, 'Skill: sla-report'],
    ['TodoWrite', {}, 'TodoWrite'],
  ])('%s', (name, input, expected) => {
    expect(describeTool(name, input)).toBe(expected);
  });

  it('truncates long commands to one line', () => {
    const status = describeTool('Bash', { command: `echo ${'x'.repeat(200)}\nmore` });
    expect(status.length).toBeLessThanOrEqual(86);
    expect(status).not.toContain('\n');
  });
});

describe('buildClaudeArgs', () => {
  it('starts a new session with --session-id and puts variadic tools last', () => {
    const args = buildClaudeArgs({
      sessionId: 'abc',
      resume: false,
      permissionMode: 'default',
      model: 'opus',
      appendSystemPrompt: 'be brief',
      allowedTools: ['Read', 'Bash(npm test:*)'],
    });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default',
      '--model',
      'opus',
      '--session-id',
      'abc',
      '--append-system-prompt',
      'be brief',
      '--allowedTools',
      'Read',
      'Bash(npm test:*)',
    ]);
  });

  it('resumes an existing session', () => {
    const args = buildClaudeArgs({ sessionId: 'abc', resume: true, permissionMode: 'bypassPermissions' });
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--allowedTools');
  });
});

describe('buildChildEnv', () => {
  const parent = {
    PATH: '/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_API_KEY: 'key',
    ANTHROPIC_AUTH_TOKEN: 'auth',
    SLACK_BOT_TOKEN: 'xoxb',
    SLACK_APP_TOKEN: 'xapp',
    CLAUDECODE: '1',
  };

  it('never forwards credentials on subscription billing', () => {
    expect(buildChildEnv(parent, 'subscription')).toEqual({ PATH: '/bin' });
  });

  it('passes only the API key on api billing', () => {
    expect(buildChildEnv(parent, 'api')).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'key' });
  });

  it('fails clearly when api billing has no key', () => {
    expect(() => buildChildEnv({ PATH: '/bin' }, 'api')).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('runClaude', () => {
  const run = (mode: string, extra: Partial<RunOptions> = {}) => {
    const events: StreamEvent[] = [];
    const outcome = runClaude({
      bin: process.execPath,
      args: [fakeClaude, '-p'],
      cwd: process.cwd(),
      env: { ...process.env, FAKE_CLAUDE_MODE: mode },
      prompt: 'hello',
      timeoutMs: 10_000,
      onEvent: (e) => events.push(e),
      ...extra,
    });
    return { outcome, events };
  };

  it('returns the final text, session and usage on success', async () => {
    const { outcome, events } = run('ok');
    const o = await outcome;
    expect(o).toMatchObject({
      status: 'ok',
      text: 'done',
      sessionId: '11111111-2222-4333-8444-555555555555',
      model: 'claude-haiku-5-5',
      toolCalls: 1,
    });
    expect(o.rateLimit?.utilization).toBe(0.02);
    expect(events.map((e) => e.kind)).toEqual(['init', 'tool', 'rate_limit', 'result']);
  });

  it('sends the prompt on stdin', async () => {
    const o = await run('echo').outcome;
    expect(JSON.parse(o.text)).toMatchObject({ prompt: 'hello', args: ['-p'] });
  });

  it('reports a crash with the stderr tail', async () => {
    const o = await run('crash').outcome;
    expect(o.status).toBe('error');
    expect(o.error).toContain('something broke');
  });

  it('detects usage limits', async () => {
    const o = await run('limit').outcome;
    expect(o.status).toBe('limit');
    expect(o.rateLimit?.resetsAt).toBe(1792924200);
  });

  it('collects unique permission denials', async () => {
    const o = await run('denied').outcome;
    expect(o).toMatchObject({ status: 'ok', permissionDenials: ['Bash'] });
  });

  it('kills a run that exceeds its timeout', async () => {
    const o = await run('hang', { timeoutMs: 300 }).outcome;
    expect(o.status).toBe('timeout');
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const { outcome } = run('hang', { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect((await outcome).status).toBe('aborted');
  });

  it('explains a missing CLI', async () => {
    const o = await run('ok', { bin: '/nonexistent/claude', args: [] }).outcome;
    expect(o.status).toBe('error');
    expect(o.error).toMatch(/CLI not found/);
  });
});
