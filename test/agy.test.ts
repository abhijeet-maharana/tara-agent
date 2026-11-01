// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the expandMcpServers tests use literal ${VAR} placeholders
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgyParser, buildAgyArgs, describeAgyTool, runAgy } from '../src/runner/agy.js';
import type { RunOptions } from '../src/runner/run.js';
import type { StreamEvent } from '../src/runner/stream.js';
import { expandMcpServers } from '../src/scheduler/steps.js';

const fakeAgy = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));

describe('buildAgyArgs', () => {
  const base = { model: 'gemini-x', timeoutMs: 45 * 60_000 };

  it('streams JSON both ways, stops by itself before the run timeout and continues a conversation', () => {
    const { args } = buildAgyArgs({ ...base, permissionMode: 'bypassPermissions', conversationId: 'c1' });
    expect(args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '2670s',
      '--disable-slash-commands',
      '--model',
      'gemini-x',
      '--conversation',
      'c1',
      '--dangerously-skip-permissions',
    ]);
  });

  it('uses the job rules instead of skipping checks, always allowing tara tools', () => {
    const { args, settings } = buildAgyArgs({
      ...base,
      permissionMode: 'bypassPermissions',
      permissions: { allow: ['command(npx tsc)'], deny: ['write_file(/home)'], ask: [] },
    });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(settings).toEqual({
      permissions: { allow: ['command(npx tsc)', 'mcp(tara_tara/*)'], deny: ['write_file(/home)'], ask: [] },
    });
  });

  it('allows only tara tools outside bypass mode', () => {
    const { args, settings } = buildAgyArgs({ ...base, permissionMode: 'default', timeoutMs: 10_000 });
    expect(args).toContain('60s');
    expect(settings).toEqual({ permissions: { allow: ['mcp(tara_tara/*)'], deny: [], ask: [] } });
  });
});

describe('AgyParser', () => {
  const lines = [
    { event: 'init', conversation_id: 'c1', init: { model: 'gemini-x' } },
    { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } },
    {
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'npx tsc --noEmit' } },
      },
    },
    {
      event: 'step_update',
      step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'A' },
    },
    {
      event: 'step_update',
      step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'B' },
    },
    {
      event: 'step_update',
      step_update: { step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'C' },
    },
    {
      event: 'result',
      result: {
        conversation_id: 'c1',
        status: 'SUCCESS',
        response: 'ABC',
        duration_seconds: 2.25,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 3, cache_read_tokens: 7 },
        denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }],
      },
    },
  ].map((l) => JSON.stringify(l));

  it('maps init, tool steps, text blocks and the result to stream events', () => {
    const parser = new AgyParser();
    const events: StreamEvent[] = [...lines, 'not json'].flatMap((l) => parser.line(l));
    expect(events).toEqual([
      { kind: 'init', sessionId: 'c1', model: 'gemini-x' },
      { kind: 'tool', id: 'agy-1', name: 'run_command', status: 'run_command: npx tsc --noEmit' },
      { kind: 'tool_result', id: 'agy-1', isError: false },
      { kind: 'text', text: 'A' },
      { kind: 'text', text: 'B' },
      { kind: 'text_start' },
      { kind: 'text', text: 'C' },
      {
        kind: 'result',
        isError: false,
        subtype: 'SUCCESS',
        text: 'ABC',
        sessionId: 'c1',
        durationMs: 2250,
        numTurns: 1,
        usage: { input: 10, output: 8, cacheRead: 7, cacheCreation: 0 },
        permissionDenials: ['mcp: CallMcpTool'],
      },
    ]);
  });

  it('describes tool steps', () => {
    expect(describeAgyTool('call_mcp_tool', { ServerName: 'tara_tara', ToolName: 'send_file' })).toBe(
      'tara_tara: send_file',
    );
    expect(describeAgyTool('read_file', { Path: '/repo/src/index.ts' })).toBe('read_file: index.ts');
    expect(describeAgyTool('list_dir', {})).toBe('list_dir');
  });
});

describe('runAgy', () => {
  const options = (mode: string, extra: Partial<RunOptions> = {}): RunOptions => ({
    bin: process.execPath,
    args: [fakeAgy, '--model', 'gemini-test'],
    cwd: tmpdir(),
    env: { ...process.env, FAKE_AGY_MODE: mode },
    prompt: 'Do the job.',
    timeoutMs: 10_000,
    ...extra,
  });

  it('reports the conversation, steps, text and usage of a successful turn', async () => {
    const events: StreamEvent[] = [];
    const outcome = await runAgy(options('ok', { onEvent: (e) => events.push(e) }));
    expect(outcome).toMatchObject({
      status: 'ok',
      text: 'Headline',
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      model: 'gemini-test',
      toolCalls: 2,
      usage: { input: 10, output: 8, cacheRead: 7, cacheCreation: 0 },
    });
    expect(events.filter((e) => e.kind === 'tool_result')).toEqual([
      { kind: 'tool_result', id: 'agy-1', isError: false },
      { kind: 'tool_result', id: 'agy-2', isError: true },
    ]);
  });

  it('sends the prompt on stdin and tara tools, system prompt and settings through an --add-dir plugin', async () => {
    const mcp = path.join(mkdtempSync(path.join(tmpdir(), 'tara-agy-test-')), 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { tara: { command: 'node', args: ['server.js'] } } }));
    const outcome = await runAgy(
      options('echo', {
        systemPrompt: 'Your name is tara.',
        agy: { mcpConfig: mcp, settings: { permissions: { allow: ['mcp(tara_tara/*)'] } } },
        mcpServers: { browser: { command: 'npx', args: ['mcp'], env: {} } },
      }),
    );
    const seen = JSON.parse(outcome.text);
    expect(seen.prompt).toBe('Do the job.');
    expect(seen.args.join(' ')).not.toContain('Do the job.');
    expect(seen.args.slice(-2)).toEqual(['-p', '']);
    expect(JSON.parse(seen.mcp).mcpServers.tara.args).toEqual(['server.js']);
    expect(JSON.parse(seen.mcp).mcpServers.browser).toEqual({ command: 'npx', args: ['mcp'], env: {} });
    expect(seen.rules).toBe('Your name is tara.');
    expect(JSON.parse(seen.plugin)).toEqual({ name: 'tara' });
    expect(JSON.parse(seen.settings)).toEqual({ permissions: { allow: ['mcp(tara_tara/*)'] } });
    // The per-run folder is gone afterwards.
    expect(existsSync(seen.dir)).toBe(false);
  });

  it('treats agy running out of time as a timeout, and a quota error as a limit', async () => {
    expect((await runAgy(options('print-timeout'))).status).toBe('timeout');
    const quota = await runAgy(options('quota'));
    expect(quota).toMatchObject({ status: 'limit', error: 'RESOURCE_EXHAUSTED: quota exceeded' });
  });

  it('treats an empty answer as an error naming what was denied', async () => {
    expect(await runAgy(options('empty'))).toMatchObject({
      status: 'error',
      error: 'agy gave no answer (denied: command: RunCommand)',
    });
  });

  it('reports a failed start with stderr, and a missing binary plainly', async () => {
    const crash = await runAgy(options('crash'));
    expect(crash).toMatchObject({ status: 'error', error: 'Error: Please sign in' });
    const missing = await runAgy(options('ok', { bin: '/nonexistent/agy', args: [] }));
    expect(missing.status).toBe('error');
    expect(missing.error).toMatch(/Antigravity CLI not found/);
  });

  it('stops a hanging run at the timeout', async () => {
    const outcome = await runAgy(options('hang', { timeoutMs: 300 }));
    expect(outcome.status).toBe('timeout');
  });
});

describe('expandMcpServers', () => {
  it('replaces ${VAR} from the run environment and leaves unknown names', () => {
    expect(
      expandMcpServers(
        {
          b: {
            command: '${BIN}',
            args: ['--workspace=${TARA_SCRATCH}/x', '${NOPE}'],
            env: { D: '${TARA_JOB_DATA}' },
          },
        },
        { BIN: 'npx', TARA_SCRATCH: '/s', TARA_JOB_DATA: '/d' },
      ),
    ).toEqual({ b: { command: 'npx', args: ['--workspace=/s/x', '${NOPE}'], env: { D: '/d' } } });
    expect(expandMcpServers(undefined, {})).toBeUndefined();
  });
});
