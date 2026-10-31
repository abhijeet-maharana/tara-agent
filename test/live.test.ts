import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { hostConfigSchema } from '../src/config/schema.js';
import { commandPage } from '../src/http/command-page.js';
import { startHttpServer } from '../src/http/server.js';
import { Activity, type Task } from '../src/live/activity.js';
import type { Alert } from '../src/live/alerts.js';
import { askArgs } from '../src/live/ask.js';
import { GEMINI_LIVE_URL, GeminiLive, type LiveConnectOptions, type LiveEvents } from '../src/live/gemini.js';
import { cleanTranscript, LiveSession, type ServerEvent } from '../src/live/session.js';
import {
  attentionForModel,
  type JobSummary,
  type LiveDeps,
  matchJob,
  matchProject,
  matchTask,
  overviewForModel,
  type ProjectOverview,
  systemInstruction,
} from '../src/live/tools.js';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A stand-in for Google's endpoint: records what clients send, and answers setup. */
function fakeGemini() {
  const wss = new WebSocketServer({ port: 0 });
  const connections: Array<{ ws: WebSocket; url: string; messages: Record<string, unknown>[] }> = [];
  wss.on('connection', (ws, req) => {
    const conn = { ws, url: req.url ?? '', messages: [] as Record<string, unknown>[] };
    connections.push(conn);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      conn.messages.push(msg);
      // Google sends JSON in binary frames.
      if (msg.setup) ws.send(Buffer.from(JSON.stringify({ setupComplete: {} })));
    });
  });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  return { wss, url, connections, close: () => new Promise((r) => wss.close(r)) };
}

const events = (): LiveEvents & { log: string[] } => {
  const log: string[] = [];
  return {
    log,
    onAudio: (pcm) => log.push(`audio ${pcm.toString()}`),
    onTranscript: (who, text) => log.push(`${who}: ${text}`),
    onToolCalls: (calls) => log.push(`tools ${calls.map((c) => `${c.id}:${c.name}`).join(',')}`),
    onToolCancel: (ids) => log.push(`cancel ${ids.join(',')}`),
    onInterrupted: () => log.push('interrupted'),
    onTurnComplete: () => log.push('turn complete'),
    onClose: (reason) => log.push(`close ${reason ?? 'by us'}`),
  };
};

const SETUP = { model: 'gemini-3.8-live', voice: 'Kore', systemInstruction: 'Be brief.', tools: [] };

describe('GeminiLive', () => {
  let server: ReturnType<typeof fakeGemini>;
  afterEach(() => server?.close());

  it('sends the setup with the key, streams audio, and reports what comes back', async () => {
    server = fakeGemini();
    const ev = events();
    const live = await GeminiLive.connect({ url: server.url, apiKey: 'k&1', setup: SETUP, events: ev });
    const conn = server.connections[0];
    expect(conn?.url).toBe('/ws?key=k%261');
    expect(conn?.messages[0]).toMatchObject({
      setup: {
        model: 'models/gemini-3.8-live',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
        systemInstruction: { parts: [{ text: 'Be brief.' }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
      },
    });

    live.sendAudio(Buffer.from('mic'));
    live.endAudio();
    live.sendToolResponses([{ id: 'c1', name: 'status', response: { ok: true } }]);
    await until(() => (conn?.messages.length ?? 0) === 4);
    expect(conn?.messages.slice(1)).toEqual([
      {
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from('mic').toString('base64') },
        },
      },
      { realtimeInput: { audioStreamEnd: true } },
      { toolResponse: { functionResponses: [{ id: 'c1', name: 'status', response: { ok: true } }] } },
    ]);

    const send = (m: object) => conn?.ws.send(Buffer.from(JSON.stringify(m)));
    send({ serverContent: { inputTranscription: { text: 'what needs me' } } });
    send({ toolCall: { functionCalls: [{ id: 'c2', name: 'attention', args: {} }] } });
    send({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from('hi').toString('base64') } },
          ],
        },
        outputTranscription: { text: 'Two approvals.' },
      },
    });
    send({ serverContent: { interrupted: true } });
    send({ serverContent: { turnComplete: true } });
    await until(() => ev.log.length === 6);
    expect(ev.log).toEqual([
      'user: what needs me',
      'tools c2:attention',
      'model: Two approvals.',
      'audio hi',
      'interrupted',
      'turn complete',
    ]);

    live.close();
    expect(ev.log.at(-1)).toBe('close by us');
  });

  it('moves to a new connection with the resumption handle on "go away"', async () => {
    server = fakeGemini();
    const ev = events();
    const live = await GeminiLive.connect({ url: server.url, apiKey: 'k', setup: SETUP, events: ev });
    const first = server.connections[0];
    first?.ws.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } }));
    first?.ws.send(JSON.stringify({ goAway: { timeLeft: '5s' } }));
    await until(() => server.connections.length === 2 && (server.connections[1]?.messages.length ?? 0) > 0);
    expect(server.connections[1]?.messages[0]).toMatchObject({
      setup: { sessionResumption: { handle: 'h1' } },
    });

    // Audio sent while reconnecting goes out once the new session is set up.
    live.sendAudio(Buffer.from('later'));
    await until(() => (server.connections[1]?.messages.length ?? 0) === 2);
    expect(ev.log).toEqual([]);
    live.close();
  });

  it('reports the session closed when the server drops it with nothing to resume', async () => {
    server = fakeGemini();
    const ev = events();
    await GeminiLive.connect({ url: server.url, apiKey: 'k', setup: SETUP, events: ev });
    server.connections[0]?.ws.close(1011, 'quota exceeded');
    await until(() => ev.log.length === 1);
    expect(ev.log).toEqual(['close closed (1011): quota exceeded']);
  });

  it('fails to connect with the reason the server gave', async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => ws.on('message', () => ws.close(1008, 'models/nope is not found')));
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    await expect(GeminiLive.connect({ url, apiKey: 'k', setup: SETUP, events: events() })).rejects.toThrow(
      'closed (1008): models/nope is not found',
    );
    await new Promise((r) => wss.close(r));
  });
});

/** A browser tab: what LiveSession needs from a ws WebSocket. */
class FakeClient extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<ServerEvent | Buffer> = [];
  send(data: string | Buffer) {
    this.sent.push(typeof data === 'string' ? (JSON.parse(data) as ServerEvent) : data);
  }
  say(msg: object) {
    this.emit('message', Buffer.from(JSON.stringify(msg)), false);
  }
  audio(text: string) {
    this.emit('message', Buffer.from(text), true);
  }
  events<T extends ServerEvent['type']>(type: T) {
    return this.sent.filter(
      (e): e is Extract<ServerEvent, { type: T }> => !Buffer.isBuffer(e) && e.type === type,
    );
  }
  states() {
    return this.events('state').map((e) => e.state);
  }
}

/** Stands in for GeminiLive.connect: records what the session sends upstream. */
function fakeUpstream() {
  const up = {
    events: undefined as LiveEvents | undefined,
    options: undefined as LiveConnectOptions | undefined,
    audio: [] as string[],
    texts: [] as string[],
    responses: [] as Array<{ id: string; name: string; response: Record<string, unknown> }>,
    ended: 0,
    closed: false,
    opens: 0,
  };
  const live = {
    sendAudio: (pcm: Buffer) => up.audio.push(pcm.toString()),
    endAudio: () => up.ended++,
    sendText: (t: string) => up.texts.push(t),
    sendToolResponses: (r: typeof up.responses) => up.responses.push(...r),
    close: () => {
      up.closed = true;
      up.events?.onClose();
    },
  };
  const connect = async (o: LiveConnectOptions) => {
    up.opens++;
    up.options = o;
    up.events = o.events;
    up.closed = false;
    return live as unknown as GeminiLive;
  };
  return { up, connect };
}

const JOBS: JobSummary[] = [
  { project: 'shop', id: 'payments-sync', name: 'Payments sync', state: 'running' },
  { project: 'shop', id: 'digest', name: 'Daily digest', state: 'failing', lastError: 'timed out' },
  { project: 'tara-agent', id: 'deps', name: 'Dependency check', state: 'ok' },
];

const OVERVIEW: ProjectOverview[] = [
  {
    name: 'shop',
    title: 'Online Shop',
    jobs: { total: 2, running: ['Payments sync'], failing: ['Daily digest'], paused: 0 },
    approvals: 1,
    repo: { branch: 'main', changes: 3 },
  },
  {
    name: 'tara-agent',
    title: 'tara-agent',
    jobs: { total: 1, running: [], failing: [], paused: 0 },
    approvals: 0,
  },
];

const deps = (over: Partial<LiveDeps> = {}): LiveDeps => ({
  agentName: 'Jarvis',
  projects: ['shop', 'tara-agent'],
  repos: ['shop', 'site'],
  overview: async () => OVERVIEW,
  attention: async () => ({
    items: [
      { key: 'a', tier: 'waiting', kind: 'approval', title: 'Approval waiting: Send newsletter' },
      { key: 'b', tier: 'later', kind: 'repo-changes', title: '3 uncommitted files in site' },
    ],
    notes: [],
  }),
  ask: async () => 'It retries three times.',
  dispatch: async () => ({ url: 'https://slack/thread' }),
  activity: new Activity(),
  jobs: () => JOBS,
  runJob: () => 'started',
  setJobEnabled: () => 'ok',
  repo: async () => ({
    branch: 'main',
    head: { sha: 'abc1234', subject: 'Fix sync', at: 0 },
    changes: [{ path: 'src/a.ts', state: 'modified', staged: false, added: 3, removed: 1 }],
  }),
  diff: async () => ({ text: '@@ -1 +1 @@\n-old\n+new\n+more', truncated: false, binary: false }),
  approvals: () => [
    {
      id: 'i1',
      project: 'shop',
      title: 'Send newsletter',
      kind: 'email',
      options: ['Approve', 'Skip'],
      createdAt: 0,
    },
  ],
  decide: async () => ({ status: 'approved' }),
  ...over,
});

const CFG = { url: 'wss://x', apiKey: 'k', model: 'gemini-3.8-live', voice: 'Kore', idleSeconds: 20 };

describe('LiveSession', () => {
  afterEach(() => vi.useRealTimers());

  it('opens Gemini on "talk", sends audio only while talking, and relays speech back', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    new LiveSession(client as unknown as WebSocket, CFG, deps(), { focusUntil: 0 }, silent, connect);
    client.audio('ignored: not talking yet');
    client.say({ type: 'talk' });
    client.audio('early'); // before the session is open: kept and sent once it is
    await tick();
    expect(up.options?.setup.systemInstruction).toContain('Projects: shop, tara-agent.');
    expect(up.options?.setup.tools.map((t) => t.name)).toEqual([
      'attention',
      'brief',
      'projects',
      'jobs',
      'job',
      'repo',
      'approvals',
      'decide',
      'ask',
      'dispatch',
      'status',
      'stop',
      'watch',
      'focus',
    ]);
    client.audio('more');
    expect(up.audio).toEqual(['early', 'more']);

    up.events?.onTranscript('user', 'hello');
    up.events?.onAudio(Buffer.from('pcm'));
    up.events?.onTurnComplete();
    client.say({ type: 'mute' });
    expect(up.ended).toBe(1);
    expect(client.states()).toEqual(['idle', 'connecting', 'listening', 'speaking', 'listening']);
    expect(client.sent.filter(Buffer.isBuffer).map(String)).toEqual(['pcm']);
    expect(client.events('transcript')).toEqual([{ type: 'transcript', who: 'user', text: 'hello' }]);
  });

  it('answers attention, status, dispatch and focus calls together', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    const shared = { focusUntil: 0 };
    const dispatch = vi.fn(async () => ({ url: 'https://slack/t1' }));
    new LiveSession(
      client as unknown as WebSocket,
      CFG,
      deps({ dispatch, now: () => 1_000 }),
      shared,
      silent,
      connect,
    );
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([
      { id: '1', name: 'attention', args: {} },
      { id: '2', name: 'status', args: {} },
      { id: '3', name: 'dispatch', args: { project: 'Tara Agent', task: 'Bump the version' } },
      { id: '4', name: 'focus', args: { minutes: 30 } },
      { id: '5', name: 'dispatch', args: { project: 'nope', task: 'x' } },
    ]);
    await until(() => up.responses.length === 5);
    expect(up.responses.map((r) => [r.id, r.response])).toEqual([
      [
        '1',
        {
          urgent: [],
          waiting: ['Approval waiting: Send newsletter'],
          later: { count: 1, first: ['3 uncommitted files in site'] },
        },
      ],
      ['2', { running: [], unansweredQuestions: [] }],
      ['3', { status: 'started', where: "the tara-agent Slack channel, live on the user's screen" }],
      ['4', { focus: 'on for 30 minutes' }],
      ['5', { error: 'Unknown project "nope". Projects: shop, tara-agent' }],
    ]);
    expect(dispatch).toHaveBeenCalledWith('tara-agent', 'Bump the version');
    expect(shared.focusUntil).toBe(1_000 + 30 * 60_000);
    expect(client.events('panel').map((e) => [e.id, e.panel.kind])).toEqual([
      ['attention', 'attention'],
      ['dispatch:3', 'dispatch'],
    ]);
    expect(client.events('panel')[1]?.panel).toEqual({
      kind: 'dispatch',
      project: 'tara-agent',
      task: 'Bump the version',
      url: 'https://slack/t1',
    });
  });

  it('answers "ask" at once and tells the model the result after its current turn', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    let answer!: (s: string) => void;
    const ask = vi.fn(() => new Promise<string>((r) => (answer = r)));
    new LiveSession(client as unknown as WebSocket, CFG, deps({ ask }), { focusUntil: 0 }, silent, connect);
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([
      { id: 'q', name: 'ask', args: { project: 'shop', question: 'How does sync retry?' } },
    ]);
    await until(() => up.responses.length === 1);
    expect(up.responses[0]?.response).toMatchObject({ status: 'checking' });
    expect(ask).toHaveBeenCalledWith('shop', 'How does sync retry?', expect.any(AbortSignal));

    up.events?.onTranscript('model', 'Checking.'); // still talking when the answer comes
    answer('It retries three times.');
    await tick();
    expect(up.texts).toEqual([]);
    up.events?.onTurnComplete();
    expect(up.texts).toEqual([
      'ASK RESULT for "How does sync retry?" (shop): It retries three times.\n\nTell the user now, in one or two sentences.',
    ]);
    // A "checking" panel at once, replaced by the answer.
    expect(client.events('panel')).toEqual([
      {
        type: 'panel',
        id: 'ask:q',
        panel: { kind: 'ask', project: 'shop', question: 'How does sync retry?' },
      },
      {
        type: 'panel',
        id: 'ask:q',
        panel: {
          kind: 'ask',
          project: 'shop',
          question: 'How does sync retry?',
          answer: 'It retries three times.',
        },
      },
    ]);
  });

  it('closes Gemini after a quiet spell, but not while a question is being answered', async () => {
    vi.useFakeTimers();
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    let answer!: (s: string) => void;
    const ask = () => new Promise<string>((r) => (answer = r));
    new LiveSession(client as unknown as WebSocket, CFG, deps({ ask }), { focusUntil: 0 }, silent, connect);
    client.say({ type: 'talk' });
    await vi.advanceTimersByTimeAsync(0);
    up.events?.onToolCalls([{ id: 'q', name: 'ask', args: { project: 'shop', question: 'Q?' } }]);
    await vi.advanceTimersByTimeAsync(0);
    up.events?.onTurnComplete();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(up.closed).toBe(false);
    answer('A.');
    await vi.advanceTimersByTimeAsync(0);
    expect(up.texts).toHaveLength(1);
    up.events?.onTurnComplete();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(up.closed).toBe(true);
    expect(client.states().at(-1)).toBe('idle');

    // Audio after the close is ignored until the next "talk".
    client.audio('stray');
    expect(up.audio).toEqual([]);
  });

  it('stops a pending question when the tab closes', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    let signal!: AbortSignal;
    const ask = (_p: string, _q: string, s: AbortSignal) => {
      signal = s;
      return new Promise<string>(() => {});
    };
    new LiveSession(client as unknown as WebSocket, CFG, deps({ ask }), { focusUntil: 0 }, silent, connect);
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([{ id: 'q', name: 'ask', args: { project: 'shop', question: 'Q?' } }]);
    await tick();
    client.emit('close');
    expect(signal.aborted).toBe(true);
    expect(up.closed).toBe(true);
  });

  it('tells the tab when Gemini can not be reached', async () => {
    const client = new FakeClient();
    const connect = async () => {
      throw new Error('closed (1008): API key not valid');
    };
    new LiveSession(client as unknown as WebSocket, CFG, deps(), { focusUntil: 0 }, silent, connect);
    client.say({ type: 'talk' });
    await until(() => client.events('error').length === 1);
    expect(client.events('error')[0]?.message).toBe(
      'Could not start the voice session: closed (1008): API key not valid',
    );
    expect(client.states()).toEqual(['idle', 'connecting', 'idle']);
  });

  it('sends the projects overview when the tab connects', async () => {
    const { connect } = fakeUpstream();
    const client = new FakeClient();
    new LiveSession(client as unknown as WebSocket, CFG, deps(), { focusUntil: 5 }, silent, connect);
    await until(() => client.events('overview').length === 1);
    expect(client.events('overview')[0]).toEqual({
      type: 'overview',
      projects: OVERVIEW,
      focusUntil: 5,
      needs: { urgent: 0, waiting: 1, later: 1, prs: 0 },
    });
    client.emit('close');
  });

  it('answers projects, jobs and repo calls and shows each on screen', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    new LiveSession(client as unknown as WebSocket, CFG, deps(), { focusUntil: 0 }, silent, connect);
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([
      { id: '1', name: 'projects', args: {} },
      { id: '2', name: 'jobs', args: { project: 'Shop' } },
      { id: '3', name: 'repo', args: { repo: 'site' } },
      { id: '4', name: 'repo', args: { repo: 'nope' } },
      { id: '5', name: 'repo', args: { repo: 'shop', file: 'src/a.ts' } },
    ]);
    await until(() => up.responses.length === 5);
    expect(up.responses.map((r) => r.response)).toEqual([
      {
        projects: [
          {
            project: 'shop',
            runningJobs: ['Payments sync'],
            failingJobs: ['Daily digest'],
            waitingApprovals: 1,
            uncommittedFiles: 3,
            branch: 'main',
          },
          { project: 'tara-agent' },
        ],
      },
      {
        jobs: [
          { job: 'Payments sync', project: 'shop', state: 'running' },
          { job: 'Daily digest', project: 'shop', state: 'failing', lastError: 'timed out' },
        ],
      },
      { branch: 'main', lastCommit: 'Fix sync', uncommittedFiles: 1, files: ['src/a.ts (modified)'] },
      { error: 'Unknown repo "nope". Repos: shop, site' },
      { file: 'src/a.ts', added: 2, removed: 1 },
    ]);
    expect(client.events('panel').map((e) => e.id)).toEqual(['jobs', 'repo:site', 'diff:shop:src/a.ts']);
    expect(client.events('panel')[0]?.panel).toMatchObject({ kind: 'jobs', project: 'shop' });
  });

  it('runs and pauses jobs by voice or button, and refreshes the jobs panel', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    const runJob = vi.fn(() => 'started' as const);
    const setJobEnabled = vi.fn(() => 'ok' as const);
    new LiveSession(
      client as unknown as WebSocket,
      CFG,
      deps({ runJob, setJobEnabled }),
      { focusUntil: 0 },
      silent,
      connect,
    );
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([
      { id: '1', name: 'job', args: { action: 'run', project: 'shop', job: 'digest' } },
      { id: '2', name: 'job', args: { action: 'run', project: 'shop', job: 'sync' } },
      { id: '3', name: 'job', args: { action: 'run', project: 'shop', job: 'nothing like it' } },
    ]);
    await until(() => up.responses.length === 3);
    expect(up.responses.map((r) => r.response)).toEqual([
      { job: 'Daily digest', project: 'shop', result: 'started' },
      { job: 'Payments sync', project: 'shop', result: 'started' },
      { error: 'No job "nothing like it" in shop. Jobs: Payments sync, Daily digest' },
    ]);
    expect(runJob.mock.calls).toEqual([
      ['shop', 'digest'],
      ['shop', 'payments-sync'],
    ]);

    client.say({ type: 'job', action: 'pause', project: 'tara-agent', id: 'deps' });
    expect(setJobEnabled).toHaveBeenCalledWith('tara-agent', 'deps', false);
    client.say({ type: 'job', action: 'run', project: 'nope', id: 'deps' });
    const actions = client.events('panel').filter((e) => e.panel.kind === 'action');
    expect(actions.map((e) => e.panel)).toEqual([
      { kind: 'action', project: 'shop', text: 'Daily digest: started', ok: true },
      { kind: 'action', project: 'shop', text: 'Payments sync: started', ok: true },
      { kind: 'action', project: 'tara-agent', text: 'Dependency check: paused', ok: true },
      { kind: 'action', project: undefined, text: 'Unknown project "nope"', ok: false },
    ]);
    expect(client.events('panel').filter((e) => e.id === 'jobs')).toHaveLength(3);
  });

  it('decides only cards it has shown, with one of their options', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    const decide = vi.fn(async () => ({ status: 'approved' }));
    new LiveSession(
      client as unknown as WebSocket,
      CFG,
      deps({ decide }),
      { focusUntil: 0 },
      silent,
      connect,
    );
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([{ id: '1', name: 'decide', args: { id: 'i1', option: 'Approve' } }]);
    await until(() => up.responses.length === 1);
    expect(up.responses[0]?.response).toEqual({ error: 'Call approvals first, so the user sees the card' });

    up.events?.onToolCalls([{ id: '2', name: 'approvals', args: {} }]);
    await until(() => up.responses.length === 2);
    expect(up.responses[1]?.response).toEqual({
      cards: [{ id: 'i1', project: 'shop', title: 'Send newsletter', options: ['Approve', 'Skip'] }],
    });
    up.events?.onToolCalls([
      { id: '3', name: 'decide', args: { id: 'i1', option: 'Ship it' } },
      { id: '4', name: 'decide', args: { id: 'i1', option: 'approve' } },
    ]);
    await until(() => up.responses.length === 4);
    expect(up.responses.slice(2).map((r) => r.response)).toEqual([
      { error: '"Ship it" isn\'t an option. Options: Approve, Skip' },
      { card: 'Send newsletter', decided: 'Approve', status: 'approved' },
    ]);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith('i1', 'Approve');

    // The panel's buttons take the same path.
    client.say({ type: 'decide', id: 'i1', option: 'Skip' });
    await until(() => decide.mock.calls.length === 2);
    expect(decide).toHaveBeenLastCalledWith('i1', 'Skip');
  });

  it('streams live tasks, lists them in status, and stops them by voice or button', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    const activity = new Activity();
    const finishers: Array<() => void> = [];
    const run = activity.wrap(
      (o) =>
        new Promise<RunOutcome>((resolve) => {
          o.onEvent?.({ kind: 'tool', id: 't', name: 'Bash', status: 'Running npm test' });
          const end = (status: RunOutcome['status']) =>
            resolve({ status, text: '', durationMs: 1, toolCalls: 1, permissionDenials: [] });
          o.signal?.addEventListener('abort', () => end('aborted'));
          finishers.push(() => end('ok'));
        }),
    );
    const base: RunOptions = { bin: 'c', args: [], cwd: '/', env: {}, prompt: '', timeoutMs: 1 };
    const first = run({ ...base, label: { project: 'shop', kind: 'chat', title: 'Fix the retry' } });
    new LiveSession(
      client as unknown as WebSocket,
      CFG,
      deps({ activity }),
      { focusUntil: 0 },
      silent,
      connect,
    );
    expect(client.events('tasks')[0]?.tasks.map((t) => t.title)).toEqual(['Fix the retry']);
    const second = run({
      ...base,
      label: { project: 'shop', kind: 'job', title: 'Payments sync', jobId: 'payments-sync' },
    });
    const third = run({
      ...base,
      label: { project: 'site', kind: 'ask', title: 'How is the build cached?' },
    });
    expect(client.events('task').map((e) => e.task.title)).toEqual([
      'Payments sync',
      'How is the build cached?',
    ]);

    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([
      { id: '1', name: 'status', args: {} },
      { id: '2', name: 'stop', args: { task: 'shop' } },
      { id: '3', name: 'stop', args: { task: 'the build' } },
    ]);
    await until(() => up.responses.length === 3);
    const status = up.responses[0]?.response as { running: Array<Record<string, unknown>> };
    expect(status.running.map((r) => [r.task, r.kind, r.now])).toEqual([
      ['How is the build cached?', 'ask', 'Running npm test'],
      ['Payments sync', 'job', 'Running npm test'],
      ['Fix the retry', 'chat', 'Running npm test'],
    ]);
    expect(up.responses[1]?.response).toEqual({
      error: 'Which one? Running: "Payments sync" (shop), "Fix the retry" (shop)',
    });
    expect(up.responses[2]?.response).toEqual({ stopping: 'How is the build cached?', project: 'site' });
    up.events?.onToolCalls([{ id: '4', name: 'watch', args: { task: 'retry' } }]);
    await until(() => up.responses.length === 4);
    expect(up.responses[3]?.response).toEqual({
      showing: 'Fix the retry',
      project: 'shop',
      status: 'running',
    });
    expect(client.events('watch').map((e) => e.id)).toEqual([
      activity.tasks().find((t) => t.title === 'Fix the retry')?.id,
    ]);
    expect((await third).status).toBe('aborted');

    const job = activity.tasks().find((t) => t.title === 'Payments sync');
    client.say({ type: 'stop', id: job?.id ?? '' });
    expect((await second).status).toBe('aborted');
    client.say({ type: 'stop', id: job?.id ?? '' });
    expect(
      client
        .events('panel')
        .filter((e) => e.panel.kind === 'action')
        .map((e) => e.panel),
    ).toEqual([
      { kind: 'action', project: 'site', text: 'Stopping: How is the build cached?', ok: true },
      { kind: 'action', project: 'shop', text: 'Stopping: Payments sync', ok: true },
      { kind: 'action', project: undefined, text: 'That task is no longer running', ok: false },
    ]);
    finishers[0]?.();
    await first;
    expect(client.events('task').at(-1)?.task).toMatchObject({ title: 'Fix the retry', status: 'ok' });
  });

  it('says urgent alerts through the voice while talking, and leaves them to the tab otherwise', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    let raise!: (a: Alert) => void;
    const alerts = {
      subscribe: (fn: (a: Alert) => void) => {
        raise = fn;
        return () => {};
      },
    };
    new LiveSession(
      client as unknown as WebSocket,
      { ...CFG, alertLang: 'en-IN' },
      deps({ alerts }),
      { focusUntil: 0 },
      silent,
      connect,
    );
    expect(client.events('config')).toEqual([{ type: 'config', alertLang: 'en-IN' }]);
    const alert = (id: string, quiet = false): Alert => ({
      id,
      kind: 'urgent',
      items: [{ title: 'Payments sync failed 3 times in a row', project: 'shop' }],
      text: 'Heads up: Payments sync failed 3 times in a row.',
      at: 0,
      quiet,
    });
    raise(alert('a1'));
    expect(client.events('alert').map((e) => [e.alert.id, e.voice])).toEqual([['a1', false]]);
    expect(up.opens).toBe(0); // a closed session isn't opened for it

    client.say({ type: 'talk' });
    await tick();
    raise(alert('a2'));
    raise(alert('a3', true));
    expect(client.events('alert').map((e) => [e.alert.id, e.voice])).toEqual([
      ['a1', false],
      ['a2', true],
      ['a3', false],
    ]);
    expect(up.texts).toEqual([
      'URGENT: Heads up: Payments sync failed 3 times in a row.\n\nTell the user now, in one or two sentences.',
    ]);
  });

  it('has the tab say when work it started ends while the voice session is closed', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    const activity = new Activity();
    const shared = { focusUntil: 0 };
    const run = activity.wrap(async (o) => ({
      status: o.label?.title === 'Broken' ? 'error' : 'ok',
      text: '',
      durationMs: 1,
      toolCalls: 0,
      permissionDenials: [],
    }));
    const threads = ['1.0', '2.0', '3.0'];
    const dispatch = async () => ({ thread: { channel: 'C1', ts: threads.shift() ?? '' } });
    new LiveSession(
      client as unknown as WebSocket,
      CFG,
      deps({ activity, dispatch }),
      shared,
      silent,
      connect,
    );
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([
      { id: '1', name: 'dispatch', args: { project: 'shop', task: 'Fix the retry' } },
      { id: '2', name: 'dispatch', args: { project: 'shop', task: 'Broken thing' } },
      { id: '3', name: 'dispatch', args: { project: 'shop', task: 'Quiet one' } },
    ]);
    await until(() => up.responses.length === 3);
    up.events?.onClose(); // the voice session closed after a quiet spell
    const base: RunOptions = { bin: 'c', args: [], cwd: '/', env: {}, prompt: '', timeoutMs: 1 };
    await run({
      ...base,
      label: { project: 'shop', kind: 'chat', title: 'x', thread: { channel: 'C1', ts: '1.0' } },
    });
    await run({
      ...base,
      label: { project: 'shop', kind: 'chat', title: 'Broken', thread: { channel: 'C1', ts: '2.0' } },
    });
    shared.focusUntil = Date.now() + 60_000;
    await run({
      ...base,
      label: { project: 'shop', kind: 'chat', title: 'x', thread: { channel: 'C1', ts: '3.0' } },
    });
    expect(client.events('notify')).toEqual([
      { type: 'notify', text: 'Fix the retry, in shop, is done.', ok: true, quiet: false },
      { type: 'notify', text: 'Broken thing, in shop, failed.', ok: false, quiet: false },
      { type: 'notify', text: 'Quiet one, in shop, is done.', ok: true, quiet: true },
    ]);
    expect(up.texts).toEqual([]);
  });

  it('gathers a briefing', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    const activity = new Activity();
    const run = activity.wrap(async () => ({
      status: 'ok',
      text: '',
      durationMs: 1,
      toolCalls: 0,
      permissionDenials: [],
    }));
    await run({
      bin: 'c',
      args: [],
      cwd: '/',
      env: {},
      prompt: '',
      timeoutMs: 1,
      label: { project: 'site', kind: 'job', title: 'Nightly build' },
    });
    new LiveSession(
      client as unknown as WebSocket,
      CFG,
      deps({ activity }),
      { focusUntil: 0 },
      silent,
      connect,
    );
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([{ id: '1', name: 'brief', args: {} }]);
    await until(() => up.responses.length === 1);
    expect(up.responses[0]?.response).toEqual({
      needsYou: {
        urgent: [],
        waiting: ['Approval waiting: Send newsletter'],
        later: { count: 1, first: ['3 uncommitted files in site'] },
      },
      projects: [
        {
          project: 'shop',
          runningJobs: ['Payments sync'],
          failingJobs: ['Daily digest'],
          waitingApprovals: 1,
          uncommittedFiles: 3,
          branch: 'main',
        },
      ],
      quietProjects: ['tara-agent'],
      running: [],
      finishedRecently: ['Nightly build (site): ok'],
    });
  });

  it('tells the model when work it started ends, but not other work', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    const activity = new Activity();
    const run = activity.wrap(async (o) => ({
      status: o.label?.kind === 'job' ? 'error' : 'ok',
      text: o.label?.kind === 'job' ? '' : 'Retry fixed; tests pass.',
      error: o.label?.kind === 'job' ? 'Timed out' : undefined,
      durationMs: 1,
      toolCalls: 0,
      permissionDenials: [],
    }));
    const dispatch = async () => ({ url: 'https://slack/t', thread: { channel: 'C1', ts: '9.1' } });
    new LiveSession(
      client as unknown as WebSocket,
      CFG,
      deps({ activity, dispatch }),
      { focusUntil: 0 },
      silent,
      connect,
    );
    client.say({ type: 'talk' });
    await tick();
    up.events?.onToolCalls([
      { id: '1', name: 'dispatch', args: { project: 'shop', task: 'Fix the payment retry' } },
      { id: '2', name: 'job', args: { action: 'run', project: 'shop', job: 'digest' } },
    ]);
    await until(() => up.responses.length === 2);
    up.events?.onTurnComplete();
    const base: RunOptions = { bin: 'c', args: [], cwd: '/', env: {}, prompt: '', timeoutMs: 1 };
    // Someone else's chat in another thread: not this tab's.
    await run({
      ...base,
      label: { project: 'shop', kind: 'chat', title: 'x', thread: { channel: 'C1', ts: '5.0' } },
    });
    await run({
      ...base,
      label: { project: 'shop', kind: 'chat', title: 'Fix', thread: { channel: 'C1', ts: '9.1' } },
    });
    await run({ ...base, label: { project: 'shop', kind: 'job', title: 'Daily digest', jobId: 'digest' } });
    expect(up.texts).toHaveLength(2);
    expect(up.texts[0]).toMatch(
      /^TASK DONE: "Fix the payment retry" \(shop\) finished after 1 min\. Its last words: Retry fixed; tests pass\./,
    );
    expect(up.texts[1]).toMatch(
      /^TASK DONE: The job Daily digest \(shop\) ended: error after 1 min\. Its last words: Timed out/,
    );
    // A second run in the same thread is no longer watched.
    await run({
      ...base,
      label: { project: 'shop', kind: 'chat', title: 'Again', thread: { channel: 'C1', ts: '9.1' } },
    });
    expect(up.texts).toHaveLength(2);
  });

  it('opens a panel for a Systems button without the voice model', async () => {
    const { up, connect } = fakeUpstream();
    const client = new FakeClient();
    new LiveSession(client as unknown as WebSocket, CFG, deps(), { focusUntil: 0 }, silent, connect);
    client.say({ type: 'show', what: 'approvals', project: 'shop' });
    client.say({ type: 'show', what: 'repo', project: 'shop' });
    client.say({ type: 'show', what: 'decide', project: 'shop' }); // not a panel: ignored
    await until(() => client.events('panel').length === 2);
    expect(client.events('panel').map((e) => e.id)).toEqual(['approvals', 'repo:shop']);
    expect(up.opens).toBe(0);
  });
});

describe('Live helpers', () => {
  it('adds how to speak to the instructions only when set', () => {
    expect(systemInstruction({ agentName: 'J', projects: ['shop'] })).not.toContain('Language and accent');
    expect(
      systemInstruction(
        { agentName: 'J', projects: ['shop'] },
        'Indian English; Hindi when spoken to in Hindi.',
      ),
    ).toContain('Language and accent: Indian English; Hindi when spoken to in Hindi.');
  });

  it('drops transcript markers that are not words', () => {
    expect(cleanTranscript('<no speech>{pause}')).toBe('');
    expect(cleanTranscript('Two approvals.{pause} One failing job.')).toBe('Two approvals. One failing job.');
  });

  it('matches spoken job names', () => {
    expect(matchJob(JOBS, 'payments-sync')?.id).toBe('payments-sync');
    expect(matchJob(JOBS, 'daily DIGEST')?.id).toBe('digest');
    expect(matchJob(JOBS, 'sync')?.id).toBe('payments-sync');
    expect(matchJob(JOBS, 'y')).toBeUndefined(); // more than one contains it
    expect(matchJob(JOBS, '')).toBeUndefined();
  });

  it('matches running tasks by id, project or words from the title', () => {
    const task = (id: string, project: string, title: string): Task => ({
      id,
      project,
      title,
      kind: 'chat',
      status: 'running',
      startedAt: 0,
      steps: [],
      stepCount: 0,
      text: '',
    });
    const running = [
      task('a', 'shop', 'Fix the payment retry'),
      task('b', 'shop', 'Weekly SEO report'),
      task('c', 'site', 'Bump deps'),
    ];
    expect(matchTask(running, 'c').task?.id).toBe('c');
    expect(matchTask(running, 'Site').task?.id).toBe('c');
    expect(matchTask(running, 'shop').candidates.map((t) => t.id)).toEqual(['a', 'b']);
    expect(matchTask(running, 'the payment fix').task?.id).toBe('a');
    expect(matchTask(running, 'nothing like it').candidates).toHaveLength(3);
    expect(matchTask([], 'x').candidates).toEqual([]);
  });

  it('trims the overview to what is not zero', () => {
    expect(overviewForModel(OVERVIEW)[1]).toEqual({ project: 'tara-agent' });
  });

  it('matches spoken project names', () => {
    expect(matchProject(['shop', 'tara-agent'], 'Tara agent')).toBe('tara-agent');
    expect(matchProject(['shop', 'tara-agent'], 'SHOP')).toBe('shop');
    expect(matchProject(['shop'], 'site')).toBeUndefined();
    expect(matchProject(['shop'], 3)).toBeUndefined();
  });

  it('trims attention for speech and passes on what could not be checked', () => {
    expect(attentionForModel({ items: [], notes: ['GitHub: not logged in'] })).toEqual({
      urgent: [],
      waiting: [],
      later: { count: 0, first: [] },
      couldNotCheck: ['GitHub: not logged in'],
    });
  });

  it('asks with read-only tools and no MCP servers', () => {
    const args = askArgs('s1', 'haiku');
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--allowedTools'))).toEqual([
      '--tools',
      'Read',
      'Grep',
      'Glob',
    ]);
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'dontAsk',
    ]);
    expect(args.at(-4)).toBe('--allowedTools');
  });

  it('is off by default and points at Google when on', () => {
    expect(hostConfigSchema.parse({ projects: ['/p'] }).live).toBeUndefined();
    expect(hostConfigSchema.parse({ projects: ['/p'], live: {} }).live).toEqual({
      url: GEMINI_LIVE_URL,
      model: 'gemini-3.8-live',
      voice: 'Kore',
      idleSeconds: 20,
      askModel: 'haiku',
      askTimeoutSeconds: 120,
      urgentGapMinutes: 30,
      alwaysInterrupt: [],
    });
    expect(() => hostConfigSchema.parse({ projects: ['/p'], live: { alwaysInterrupt: ['shop'] } })).toThrow(
      'project/jobId',
    );
  });
});

describe('/command/ws', () => {
  it('only lets an unlocked browser from the same origin connect', async () => {
    const store = new Store(':memory:');
    const connected: WebSocket[] = [];
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store,
      projects: [],
      log: silent,
      adminToken: 'open-sesame',
      decisionsFromLocal: true,
      live: { connect: (ws) => connected.push(ws) },
    });
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const open = (headers: Record<string, string>, path = '/command/ws') =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://${host}${path}`, { headers });
        ws.on('open', () => {
          ws.close();
          resolve(101);
        });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => {});
      });
    expect(await open({})).toBe(403);
    expect(await open({ cookie: 'tara_admin=wrong' })).toBe(403);
    expect(await open({ cookie: 'tara_admin=open-sesame', origin: 'https://evil.example' })).toBe(403);
    expect(await open({ cookie: 'tara_admin=open-sesame' }, '/other')).toBe(404);
    expect(await open({ cookie: 'tara_admin=open-sesame', origin: `http://${host}` })).toBe(101);
    expect(await open({ cookie: 'tara_admin=open-sesame' }, '/live/ws')).toBe(101); // the old name
    expect(connected).toHaveLength(2);
    server.close();
    store.close();
  });
});

describe('/command page', () => {
  const ctx = { projects: [], timeZone: 'UTC', agentName: 'Jarvis', live: true };

  it('asks to unlock first, and only then offers Talk', () => {
    const locked = commandPage(ctx, { unlocked: false });
    expect(locked).toContain('href="/unlock"');
    expect(locked).not.toContain('id="talk"');
    const open = commandPage(ctx, { unlocked: true });
    expect(open).toContain('id="talk" aria-pressed="false"');
    expect(open).toContain('id="systems"');
    expect(open).toContain('id="ops"');
    expect(open).toContain('href="/command" class="nav-item on" aria-current="page"');
  });

  it('ships a script that parses', () => {
    const script = commandPage(ctx, { unlocked: true }).split('<script>').at(-1)?.split('</script>')[0] ?? '';
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('registerProcessor("mic"');
    expect(script).toContain('registerProcessor("player"');
  });

  it('is served, and in the menu, only when Command is on; /live moved to /command', async () => {
    const store = new Store(':memory:');
    const start = (live?: { connect: () => void }) =>
      startHttpServer({
        bind: '127.0.0.1',
        port: 0,
        scheduler: { list: () => [] } as unknown as Scheduler,
        store,
        projects: [],
        log: silent,
        live,
        dashboard: { projects: [], timeZone: 'UTC', agentName: 'Jarvis' },
      });
    for (const [live, status, inMenu] of [
      [{ connect: () => {} }, 200, true],
      [undefined, 404, false],
    ] as const) {
      const server = await start(live);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const page = await fetch(`${base}/command`, { headers: { accept: 'text/html' } });
      expect(page.status).toBe(status);
      const old = await fetch(`${base}/live`, { headers: { accept: 'text/html' }, redirect: 'manual' });
      expect(old.status).toBe(inMenu ? 301 : 404);
      if (inMenu) expect(old.headers.get('location')).toBe('/command');
      const home = await fetch(`${base}/`, { headers: { accept: 'text/html' } }).then((r) => r.text());
      expect(home.includes('href="/command"')).toBe(inMenu);
      server.close();
    }
    store.close();
  });
});

describe('HTTPS listener', () => {
  it('serves the same pages and /command/ws over TLS, next to plain HTTP', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tara-tls-'));
    const cert = path.join(dir, 'cert.pem');
    const key = path.join(dir, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const free = await new Promise<number>((resolve) => {
      const probe = createNetServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const store = new Store(':memory:');
    const connected: WebSocket[] = [];
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      tls: { port: free, cert, key },
      scheduler: { list: () => [] } as unknown as Scheduler,
      store,
      projects: [],
      log: silent,
      adminToken: 'k',
      decisionsFromLocal: true,
      live: { connect: (ws) => connected.push(ws) },
    });
    const get = (url: string) =>
      new Promise<number>((resolve, reject) =>
        httpsGet(url, { rejectUnauthorized: false }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on('error', reject),
      );
    expect(await get(`https://127.0.0.1:${free}/health`)).toBe(200);
    expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`)).status).toBe(
      200,
    );
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${free}/command/ws`, {
        rejectUnauthorized: false,
        headers: { cookie: 'tara_admin=k' },
      });
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
    expect(connected).toHaveLength(1);
    await new Promise((r) => server.close(r));
    // Closing the main server closes the HTTPS one too.
    await expect(get(`https://127.0.0.1:${free}/health`)).rejects.toThrow();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
