import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { Bridge, type RunContext, wantsPermissionPrompts } from '../src/bridge/bridge.js';
import type { Project, ProjectConfig } from '../src/config/schema.js';
import { startHttpServer } from '../src/http/server.js';
import { buildClaudeArgs } from '../src/runner/args.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { type IncomingMessage, SessionManager } from '../src/sessions/manager.js';
import { Store } from '../src/store/store.js';
import { FakeChat, testHost } from './fakes.js';

const silent = { info() {}, warn() {}, error() {} };

function project(overrides: Partial<ProjectConfig> = {}): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-bridge-'));
  return {
    dir,
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
  };
}

function setup(p = project()) {
  const chat = new FakeChat('ts');
  const store = new Store(':memory:');
  let n = 0;
  const bridge = new Bridge({
    apiUrl: 'http://127.0.0.1:1',
    chat,
    store,
    log: silent,
    projects: [p],
    timeZone: 'UTC',
    permissionTimeoutMs: 200,
    now: () => Date.parse('2026-10-25T08:30:00Z'),
    newId: () => `id${++n}`,
  });
  const decisions: IncomingMessage[] = [];
  bridge.onDecision = async (m) => void decisions.push(m);
  const ctx: RunContext = {
    project: p,
    channel: 'C1',
    threadTs: '100.1',
    kind: 'chat',
    permissionPrompts: true,
  };
  return { chat, store, bridge, decisions, ctx, project: p };
}

/** Opens a run and returns its token (read back from the MCP config, as the MCP server gets it). */
function openRun(bridge: Bridge, ctx: RunContext) {
  const handle = bridge.open(ctx);
  const config = JSON.parse(readFileSync(handle.mcpConfigPath, 'utf8'));
  return { handle, token: config.mcpServers.tara.env.TARA_RUN_TOKEN as string, config };
}

describe('Bridge runs', () => {
  it('writes a private MCP config with the run token and forgets it on dispose', () => {
    const { bridge, ctx } = setup();
    const { handle, token, config } = openRun(bridge, ctx);
    expect(statSync(handle.mcpConfigPath).mode & 0o777).toBe(0o600);
    expect(config.mcpServers.tara.env).toMatchObject({
      TARA_API: 'http://127.0.0.1:1',
      TARA_PERMISSION_PROMPTS: '1',
    });
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(bridge.run(token)).toBe(ctx);
    handle.dispose();
    expect(() => bridge.run(token)).toThrow(/Unknown or finished run/);
    expect(() => statSync(handle.mcpConfigPath)).toThrow();
  });

  it('asks for permission prompts only in modes that ask', () => {
    expect(wantsPermissionPrompts('default')).toBe(true);
    expect(wantsPermissionPrompts('auto')).toBe(true);
    expect(wantsPermissionPrompts('bypassPermissions')).toBe(false);
    expect(wantsPermissionPrompts('dontAsk')).toBe(false);
  });
});

describe('approvals', () => {
  it('posts buttons, decides once, and resumes the thread with the decision', async () => {
    const { chat, store, bridge, decisions, ctx } = setup();
    const { token } = openRun(bridge, ctx);
    const res = await bridge.requestApproval(token, {
      title: 'Cut 4 ad bids',
      details: '**Saves** ₹1,240/week',
    });
    expect(res).toEqual({ id: 'id1', options: ['Approve', 'Reject'] });

    const post = chat.blockPosts[0];
    expect(post?.thread).toBe('100.1');
    expect(JSON.stringify(post?.blocks)).toContain('*Saves* ₹1,240/week');
    const buttons = (
      (post as { blocks: unknown[] }).blocks[1] as { elements: Array<Record<string, unknown>> }
    ).elements;
    expect(buttons.map((b) => [b.action_id, b.value, b.style])).toEqual([
      ['tara:approval:0', 'id1', 'primary'],
      ['tara:approval:1', 'id1', 'danger'],
    ]);
    expect(store.getApproval('id1')).toMatchObject({ status: 'pending', messageTs: 'ts1' });

    const tap = { actionId: 'tara:approval:0', value: 'id1', user: 'U1', channel: 'C1', messageTs: 'ts1' };
    await bridge.handleButton(tap);
    await bridge.handleButton({ ...tap, actionId: 'tara:approval:1', user: 'U2' }); // too late: already decided

    expect(store.getApproval('id1')).toMatchObject({
      status: 'decided',
      decision: 'Approve',
      decidedBy: 'U1',
    });
    expect(chat.updates[0]?.text).toBe('Cut 4 ad bids: Approve');
    expect(JSON.stringify(chat.updates[0]?.blocks)).toContain('✅ *Approve*, chosen by <@U1> at 08:30');
    expect(decisions).toEqual([
      {
        channel: 'C1',
        threadTs: '100.1',
        ts: 'ts1',
        user: 'U1',
        text: 'USER DECISION on "Cut 4 ad bids": Approve (tapped at 08:30)',
      },
    ]);
  });

  it('posts a long proposal in full before the buttons', async () => {
    const { chat, bridge, ctx } = setup();
    const { token } = openRun(bridge, ctx);
    await bridge.requestApproval(token, {
      title: 'Big',
      details: 'x'.repeat(5_000),
      options: ['Go', 'Stop', 'Later'],
    });
    expect(chat.posts.map((p) => p.text.length).reduce((a, b) => a + b)).toBe(5_000);
    expect(JSON.stringify(chat.blockPosts[0]?.blocks)).toContain('_Full proposal above._');
  });

  it('ignores taps from people outside allowedUsers', async () => {
    const { store, bridge, decisions, ctx } = setup(project({ allowedUsers: ['U9'] }));
    const { token } = openRun(bridge, ctx);
    await bridge.requestApproval(token, { title: 'T', details: 'D' });
    await bridge.handleButton({
      actionId: 'tara:approval:0',
      value: 'id1',
      user: 'U1',
      channel: 'C1',
      messageTs: 'ts1',
    });
    expect(store.getApproval('id1')?.status).toBe('pending');
    expect(decisions).toHaveLength(0);
  });

  it('rejects unknown runs', async () => {
    const { bridge } = setup();
    await expect(bridge.requestApproval('nope', { title: 'T', details: 'D' })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('send_file', () => {
  it('uploads files inside the project and refuses anything outside, including via symlinks', async () => {
    const { chat, bridge, ctx, project: p } = setup();
    const { token } = openRun(bridge, ctx);
    mkdirSync(path.join(p.dir, '.scratch'));
    writeFileSync(path.join(p.dir, '.scratch', 'shot.png'), 'png');
    const outside = path.join(mkdtempSync(path.join(path.dirname(p.dir), 'other-')), 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(p.dir, 'link.txt'));

    expect(await bridge.sendFile(token, { path: '.scratch/shot.png', comment: 'here' })).toEqual({
      name: 'shot.png',
    });
    expect(chat.uploads[0]).toMatchObject({ thread: '100.1', comment: 'here' });
    expect(chat.uploads[0]?.file.endsWith(path.join('.scratch', 'shot.png'))).toBe(true);

    await expect(bridge.sendFile(token, { path: 'missing.txt' })).rejects.toMatchObject({ status: 404 });
    await expect(bridge.sendFile(token, { path: '.scratch' })).rejects.toMatchObject({ status: 400 });
    await expect(bridge.sendFile(token, { path: '/etc/hosts' })).rejects.toMatchObject({ status: 403 });
    // The temp dir is allowed, so this escape test uses a path outside both roots.
    if (!outside.startsWith(tmpdir())) {
      await expect(bridge.sendFile(token, { path: 'link.txt' })).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe('permission prompts', () => {
  it('waits for a tap and returns allow with the original input', async () => {
    const { chat, bridge, ctx } = setup();
    const { token } = openRun(bridge, ctx);
    const { id } = await bridge.askPermission(token, { tool_name: 'Bash', input: { command: 'npm test' } });
    expect(chat.blockPosts[0]?.text).toBe('Permission needed: Bash: npm test');
    expect(await bridge.waitPermission(token, id, 20)).toBeUndefined();

    const waiting = bridge.waitPermission(token, id, 5_000);
    await bridge.handleButton({
      actionId: 'tara:perm:allow',
      value: id,
      user: 'U1',
      channel: 'C1',
      messageTs: 'ts1',
    });
    expect(await waiting).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    expect(chat.updates.at(-1)?.text).toBe('Bash: npm test: ✅ Allowed by <@U1> at 08:30');
  });

  it('denies on a Deny tap and when nobody answers in time', async () => {
    const { bridge, ctx } = setup();
    const { token } = openRun(bridge, ctx);
    const a = await bridge.askPermission(token, { tool_name: 'Write', input: { file_path: '/x' } });
    await bridge.handleButton({
      actionId: 'tara:perm:deny',
      value: a.id,
      user: 'U1',
      channel: 'C1',
      messageTs: 'ts1',
    });
    expect(await bridge.waitPermission(token, a.id, 10)).toMatchObject({ behavior: 'deny' });

    const b = await bridge.askPermission(token, { tool_name: 'Write', input: {} });
    expect(await bridge.waitPermission(token, b.id, 1_000)).toEqual({
      behavior: 'deny',
      message: 'Nobody answered the permission prompt in time.',
    });
  });

  it('refuses prompts for runs that have them off', async () => {
    const { bridge, ctx } = setup();
    const { token } = openRun(bridge, { ...ctx, permissionPrompts: false });
    await expect(bridge.askPermission(token, { tool_name: 'Bash', input: {} })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('claude args', () => {
  it('adds the MCP config, the permission tool and tara tools', () => {
    const args = buildClaudeArgs({
      sessionId: 's',
      resume: false,
      permissionMode: 'default',
      allowedTools: ['Read'],
      mcpConfig: '/tmp/x.json',
      permissionPrompts: true,
    });
    expect(args.join(' ')).toContain(
      '--mcp-config /tmp/x.json --permission-prompt-tool mcp__tara__permission',
    );
    expect(args.slice(-6)).toEqual([
      '--allowedTools',
      'Read',
      'mcp__tara__request_approval',
      'mcp__tara__send_file',
      'mcp__tara__list_jobs',
      'mcp__tara__run_job',
    ]);
  });
});

describe('a decision resumes the session', () => {
  it('runs the next turn in the same thread with the decision as the prompt', async () => {
    const { bridge, store, chat, project: p } = setup();
    const calls: RunOptions[] = [];
    const host = testHost({
      concurrency: 1,
      catchUpHours: 0,
      claude: { bin: 'claude', chatTimeoutMinutes: 5 },
    });
    const outcome = (text: string): RunOutcome => ({
      status: 'ok',
      text,
      durationMs: 1,
      toolCalls: 0,
      permissionDenials: [],
    });
    const manager = new SessionManager({
      projects: [p],
      host,
      store,
      chat,
      bridge,
      env: {},
      log: silent,
      newSessionId: () => 'sid',
      run: async (o) => {
        calls.push(o);
        o.onEvent?.({ kind: 'init', sessionId: 'sid', model: 'm' });
        if (calls.length === 1) {
          // The model asks for approval mid-turn, through the run's token.
          const token = JSON.parse(readFileSync(o.args[o.args.indexOf('--mcp-config') + 1] as string, 'utf8'))
            .mcpServers.tara.env.TARA_RUN_TOKEN;
          await bridge.requestApproval(token, { title: 'Publish post', details: 'Post X today' });
          return outcome('Waiting for approval.');
        }
        return outcome('Published.');
      },
    });
    bridge.onDecision = (m) => manager.handle(m);

    await manager.handle({ channel: 'C1', threadTs: '100.1', ts: '100.1', user: 'U1', text: 'publish it' });
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['--permission-prompt-tool', 'mcp__tara__permission']),
    );
    expect(calls[0]?.args.join(' ')).toContain('request_approval');

    const approval = chat.blockPosts[0] as { ts: string };
    await bridge.handleButton({
      actionId: 'tara:approval:0',
      value: 'id1',
      user: 'U1',
      channel: 'C1',
      messageTs: approval.ts,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['--resume', 'sid']));
    expect(calls[1]?.prompt).toBe('<@U1>: USER DECISION on "Publish post": Approve (tapped at 08:30)');
    expect(chat.texts()).toContain('Published.');
  });
});

describe('MCP server end to end', () => {
  it('lists the tools and posts an approval through the local API', async () => {
    const { bridge, chat, store, ctx } = setup();
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [], reloadAll() {}, trigger: () => 'unknown' } as unknown as Scheduler,
      store,
      bridge,
      projects: ['shop'],
      log: silent,
    });
    const port = (server.address() as AddressInfo).port;
    const { token } = openRun(bridge, ctx);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url))],
      env: {
        PATH: process.env.PATH ?? '',
        TARA_API: `http://127.0.0.1:${port}`,
        TARA_RUN_TOKEN: token,
        TARA_PERMISSION_PROMPTS: '1',
      },
    });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['permission', 'request_approval', 'send_file']);

      const result = await client.callTool({
        name: 'request_approval',
        arguments: { title: 'Raise price', details: '₹149 → ₹199', options: ['Do it', 'Skip'] },
      });
      expect(JSON.stringify(result.content)).toContain(
        'Approval request posted in the Slack thread (buttons: Do it / Skip)',
      );
      expect(chat.blockPosts[0]?.text).toBe('Approval needed: Raise price');

      const bad = await client.callTool({ name: 'send_file', arguments: { path: '/etc/hosts' } });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toContain('Only files inside the project');
    } finally {
      await client.close();
      server.close();
    }
  }, 30_000);

  it('rejects internal calls without a valid run token', async () => {
    const { bridge, store } = setup();
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: {} as Scheduler,
      store,
      bridge,
      projects: [],
      log: silent,
    });
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/internal/approval`, {
      method: 'POST',
      headers: { 'x-tara-run': 'forged' },
      body: JSON.stringify({ title: 'T', details: 'D' }),
    });
    expect(res.status).toBe(401);
    server.close();
  });
});

describe('job tools for Claude', () => {
  it("lists and starts jobs for chat turns only, in the speaker's name", () => {
    const { bridge, ctx } = setup();
    const started: unknown[][] = [];
    bridge.jobs = {
      list: () => [
        {
          id: 'sla',
          name: 'SLA Report',
          enabled: true,
          running: false,
          cron: '* * * * *',
          tz: 'UTC',
          skills: [],
          model: 'h',
        },
        {
          id: 'off',
          name: 'Off',
          enabled: false,
          running: false,
          cron: '* * * * *',
          tz: 'UTC',
          skills: [],
          model: 'h',
        },
      ],
      trigger: (...a: unknown[]) => {
        started.push(a);
        return 'started';
      },
      digest: () => null,
    };
    const chatRun = openRun(bridge, { ...ctx, user: 'U7' });
    expect(chatRun.config.mcpServers.tara.env.TARA_JOB_TOOLS).toBe('1');
    expect(bridge.listJobs(chatRun.token).map((j) => j.id)).toEqual(['sla', 'off']);
    expect(bridge.runJob(chatRun.token, 'sla')).toEqual({ result: 'started', name: 'SLA Report' });
    expect(started).toEqual([['shop', 'sla', 'U7']]);
    expect(bridge.runJob(chatRun.token, 'off')).toEqual({ result: 'paused', name: 'Off' });
    expect(() => bridge.runJob(chatRun.token, 'nope')).toThrow(/No job "nope"/);

    const jobRun = openRun(bridge, { ...ctx, kind: 'job' });
    expect(jobRun.config.mcpServers.tara.env.TARA_JOB_TOOLS).toBe('0');
    expect(() => bridge.runJob(jobRun.token, 'sla')).toThrow(/only be started from a chat turn/);
  });
});
