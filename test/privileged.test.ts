import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Approvals } from '../src/approvals/approvals.js';
import { Bridge, type RunContext } from '../src/bridge/bridge.js';
import type { Project } from '../src/config/schema.js';
import { startHttpServer } from '../src/http/server.js';
import { Privileged } from '../src/privileged/privileged.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import type { IncomingMessage } from '../src/sessions/manager.js';
import { Store } from '../src/store/store.js';
import { FakeChat } from './fakes.js';

const silent = { info() {}, warn() {}, error() {} };
const HELPER = fileURLToPath(new URL('../deploy/tara-priv.mjs', import.meta.url));

/** A helper started directly (no sudo) with a test allowlist. */
function helper(actions: object) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tara-priv-')), 'privileged.json');
  writeFileSync(file, JSON.stringify({ actions }));
  return new Privileged([process.execPath, HELPER], { PATH: process.env.PATH, TARA_PRIV_CONFIG: file });
}

const ACTIONS = {
  'fix-permissions': {
    description: 'Re-apply repo permissions under a path',
    command: ['/bin/echo', 'fixed', '{path}'],
    args: { path: '/srv/repos/(shop|blog)(/.*)?' },
    auto: true,
  },
  'restart-shop': { description: 'Restart the shop server', command: ['/bin/echo', 'restarted'] },
  broken: { description: 'Always fails', command: ['/bin/sh', '-c', 'echo boom >&2; exit 3'] },
};

function project(): Project {
  return {
    dir: mkdtempSync(path.join(tmpdir(), 'tara-priv-proj-')),
    config: {
      name: 'shop',
      slackChannel: 'C1',
      permissionMode: 'bypassPermissions',
      chatModel: 'sonnet',
      allowedTools: [],
      allowedUsers: [],
      billing: 'subscription',
      selfImprove: true,
    },
  };
}

async function setup() {
  const p = project();
  const chat = new FakeChat('ts');
  const store = new Store(':memory:');
  const privileged = helper(ACTIONS);
  await privileged.load();
  let n = 0;
  const now = () => Date.parse('2026-10-26T08:30:00Z');
  const newId = () => `id${++n}`;
  const approvals = new Approvals({
    store,
    chat,
    log: silent,
    projects: [p],
    timeZone: 'UTC',
    privileged,
    now,
    newId,
  });
  const bridge = new Bridge({
    apiUrl: 'http://127.0.0.1:1',
    chat,
    store,
    approvals,
    privileged,
    log: silent,
    projects: [p],
    timeZone: 'UTC',
    now,
    newId,
  });
  const chats: IncomingMessage[] = [];
  const jobs: Array<{ jobId: string; text: string }> = [];
  approvals.onChat = async (m) => void chats.push(m);
  approvals.onJob = async (_p, jobId, r) => void jobs.push({ jobId, text: r.text });
  /** Opens a run and returns its token, read back from the MCP config as the MCP server gets it. */
  const token = (ctx: Partial<RunContext> = {}) => {
    const handle = bridge.open({
      project: p,
      channel: 'C1',
      threadTs: '100.1',
      kind: 'chat',
      permissionPrompts: false,
      ...ctx,
    });
    return JSON.parse(readFileSync(handle.mcpConfigPath, 'utf8')).mcpServers.tara.env
      .TARA_RUN_TOKEN as string;
  };
  return { store, chat, bridge, approvals, privileged, chats, jobs, token };
}

describe('tara-priv helper', () => {
  it('lists its actions and refuses anything outside them', async () => {
    const p = helper(ACTIONS);
    expect((await p.load()).map((a) => [a.id, a.auto])).toEqual([
      ['fix-permissions', true],
      ['restart-shop', false],
      ['broken', false],
    ]);
    expect((await p.plan('fix-permissions', { path: '/srv/repos/shop/data' })).command).toBe(
      '/bin/echo fixed /srv/repos/shop/data',
    );
    await expect(p.plan('rm-rf', {})).rejects.toThrow('No action "rm-rf"');
    await expect(p.plan('fix-permissions', { path: '/etc' })).rejects.toThrow('does not match');
    await expect(p.plan('fix-permissions', { path: '/srv/repos/shop/../../etc' })).rejects.toThrow('".."');
    await expect(p.plan('fix-permissions', {})).rejects.toThrow('needs "path"');
    await expect(p.plan('restart-shop', { extra: 'x' })).rejects.toThrow('takes no argument "extra"');
  });

  it('runs an action and passes its output and exit code through', async () => {
    const p = helper(ACTIONS);
    await p.load();
    expect(await p.run('restart-shop')).toEqual({
      ok: true,
      exitCode: 0,
      command: '/bin/echo restarted',
      output: 'restarted',
    });
    expect(await p.run('broken')).toMatchObject({ ok: false, exitCode: 3, output: 'boom' });
    expect(p.prompt()).toContain(
      '`fix-permissions` (path): Re-apply repo permissions under a path (runs at once',
    );
  });
});

describe('request_privileged', () => {
  it('runs an auto action at once and keeps it as a finished card', async () => {
    const { bridge, store, chat, token } = await setup();
    const r = await bridge.requestPrivileged(token(), {
      action: 'fix-permissions',
      args: { path: '/srv/repos/shop/out' },
      reason: 'EACCES on out/report.csv',
    });
    expect(r).toMatchObject({ ran: true, ok: true });
    expect(r.result).toContain('Ran `/bin/echo fixed /srv/repos/shop/out` as root: exit 0.');
    expect(store.getItem('id1')).toMatchObject({
      kind: 'privileged',
      status: 'done',
      decidedBy: 'auto',
      result: '/bin/echo fixed /srv/repos/shop/out: exit 0\nfixed /srv/repos/shop/out',
    });
    expect(chat.blockPosts).toEqual([]); // nothing to decide, so no Slack card
  });

  it('a chat: the card runs the action on approval and the thread continues with its output', async () => {
    const { bridge, store, approvals, chat, chats, token } = await setup();
    const r = await bridge.requestPrivileged(token(), {
      action: 'restart-shop',
      reason: 'The server still serves the old code',
    });
    expect(r).toEqual({ id: 'id1', options: ['Run it', 'Reject'] });
    expect(store.getItem('id1')).toMatchObject({ status: 'pending', title: 'Root: Restart the shop server' });
    expect(chat.blockPosts[0]?.text).toBe('Approval needed: Root: Restart the shop server');

    await approvals.decide('id1', { option: 'Run it', by: 'U1', via: 'dashboard' });
    expect(store.getItem('id1')).toMatchObject({ status: 'done', result: expect.stringContaining('exit 0') });
    expect(chats[0]?.text).toContain('USER DECISION on "Root: Restart the shop server": Run it');
    expect(chats[0]?.text).toContain('Ran `/bin/echo restarted` as root: exit 0.');
  });

  it('a scheduled job: approval continues the job as the job, and a failure says so', async () => {
    const { bridge, store, approvals, jobs, token } = await setup();
    await bridge.requestPrivileged(token({ kind: 'job', jobId: 'nightly' }), {
      action: 'broken',
      reason: 'try it',
    });
    expect(store.getItem('id1')).toMatchObject({ jobId: 'nightly', status: 'pending' });
    await approvals.decide('id1', { option: 'Run it', by: 'U1', via: 'slack' });
    expect(store.getItem('id1')?.status).toBe('failed');
    expect(jobs[0]?.jobId).toBe('nightly');
    expect(jobs[0]?.text).toContain('FAILED as root (exit 3)');
  });

  it('runs nothing on Reject, refuses unknown actions, and asks a person for anything else', async () => {
    const { bridge, store, approvals, chats, token } = await setup();
    const t = token();
    await bridge.requestPrivileged(t, { action: 'restart-shop', reason: 'r' });
    await approvals.decide('id1', { option: 'Reject', by: 'U1', via: 'slack' });
    expect(store.getItem('id1')).toMatchObject({ status: 'rejected', result: undefined });
    expect(chats[0]?.text).not.toContain('as root');

    await expect(bridge.requestPrivileged(t, { action: 'reboot', reason: 'r' })).rejects.toThrow(
      'No action "reboot"',
    );
    await expect(bridge.requestPrivileged(t, { reason: 'r' })).rejects.toThrow('either an "action" or');

    const manual = await bridge.requestPrivileged(t, {
      command: 'sudo apt install ffmpeg',
      reason: 'ffmpeg is missing',
    });
    expect(manual).toEqual({ id: 'id2', options: ['I ran it, continue', 'Reject'] });
    expect(store.getItem('id2')?.body).toContain('```\nsudo apt install ffmpeg\n```');
    await approvals.decide('id2', { option: 'I ran it, continue', by: 'U1', via: 'slack' });
    expect(store.getItem('id2')?.status).toBe('done');
    expect(chats[1]?.text).toContain('I ran it, continue');
  });

  it('the action shown on the card is what runs: its fields cannot be edited', async () => {
    const { bridge, store, approvals, chats, token } = await setup();
    await bridge.requestPrivileged(token(), { action: 'restart-shop', reason: 'r' });
    await approvals.decide('id1', {
      option: 'Run it',
      by: 'U1',
      via: 'dashboard',
      fields: { action: 'broken' },
    });
    expect(store.getItem('id1')?.status).toBe('done');
    expect(chats[0]?.text).toContain('Ran `/bin/echo restarted`');
  });

  it('mentions the actions in the system prompt, or only the manual way without a helper', async () => {
    const { bridge } = await setup();
    expect(bridge.prompt()).toContain('`restart-shop`: Restart the shop server');
    const plain = new Bridge({
      apiUrl: 'http://127.0.0.1:1',
      chat: new FakeChat(),
      store: new Store(':memory:'),
      approvals: {} as Approvals,
      log: silent,
      projects: [],
      timeZone: 'UTC',
    });
    expect(plain.prompt()).toContain('call `request_privileged` with `command`');
    expect(plain.prompt()).not.toContain('restart-shop');
  });
});

describe('sessions API for a person fixing a run', () => {
  it('continues a thread only with the admin token', async () => {
    const { store } = await setup();
    store.saveSession({
      threadKey: 'C1:100.1',
      project: 'shop',
      sessionId: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
      model: 'opus',
      started: true,
    });
    const sent: IncomingMessage[] = [];
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store,
      projects: ['shop'],
      log: silent,
      adminToken: 'admin-key',
      continueThread: async (m) => void sent.push(m),
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sessions/6f9619ff-8b86-d011-b42d-00c04fc964ff/message`;
    const body = JSON.stringify({ text: 'Fixed the permissions, retry' });
    try {
      expect((await fetch(url, { method: 'POST', body })).status).toBe(403);
      expect((await fetch(url, { method: 'POST', body, headers: { 'x-tara-admin': 'wrong' } })).status).toBe(
        403,
      );
      const ok = await fetch(url, { method: 'POST', body, headers: { 'x-tara-admin': 'admin-key' } });
      expect(await ok.json()).toEqual({ ok: true, threadKey: 'C1:100.1' });
      expect(sent).toEqual([
        {
          channel: 'C1',
          threadTs: '100.1',
          ts: '100.1',
          user: 'admin',
          text: 'Fixed the permissions, retry',
        },
      ]);
      const list = await fetch(url.replace(/\/sessions\/.*/, '/sessions?project=shop'));
      expect(((await list.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
