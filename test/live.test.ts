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
import { livePage } from '../src/http/live-page.js';
import { startHttpServer } from '../src/http/server.js';
import { askArgs } from '../src/live/ask.js';
import { GEMINI_LIVE_URL, GeminiLive, type LiveConnectOptions, type LiveEvents } from '../src/live/gemini.js';
import { cleanTranscript, LiveSession, type ServerEvent } from '../src/live/session.js';
import { attentionForModel, type LiveDeps, matchProject, systemInstruction } from '../src/live/tools.js';
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

const deps = (over: Partial<LiveDeps> = {}): LiveDeps => ({
  agentName: 'Jarvis',
  projects: ['shop', 'tara-agent'],
  attention: async () => ({
    items: [
      { key: 'a', tier: 'waiting', kind: 'approval', title: 'Approval waiting: Send newsletter' },
      { key: 'b', tier: 'later', kind: 'repo-changes', title: '3 uncommitted files in site' },
    ],
    notes: [],
  }),
  ask: async () => 'It retries three times.',
  dispatch: async () => ({ url: 'https://slack/thread' }),
  running: () => [{ project: 'shop', name: 'Payments sync' }],
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
      'ask',
      'dispatch',
      'status',
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
      ['2', { runningJobs: ['Payments sync (shop)'], unansweredQuestions: [] }],
      ['3', { status: 'started', where: 'the tara-agent Slack channel' }],
      ['4', { focus: 'on for 30 minutes' }],
      ['5', { error: 'Unknown project "nope". Projects: shop, tara-agent' }],
    ]);
    expect(dispatch).toHaveBeenCalledWith('tara-agent', 'Bump the version');
    expect(shared.focusUntil).toBe(1_000 + 30 * 60_000);
    expect(client.events('card')).toEqual([
      {
        type: 'card',
        kind: 'dispatch',
        project: 'tara-agent',
        task: 'Bump the version',
        url: 'https://slack/t1',
      },
    ]);
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
    expect(client.events('card')).toEqual([
      {
        type: 'card',
        kind: 'ask',
        project: 'shop',
        question: 'How does sync retry?',
        answer: 'It retries three times.',
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
    });
  });
});

describe('/live/ws', () => {
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
    const open = (headers: Record<string, string>, path = '/live/ws') =>
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
    expect(connected).toHaveLength(1);
    server.close();
    store.close();
  });
});

describe('/live page', () => {
  const ctx = { projects: [], timeZone: 'UTC', agentName: 'Jarvis', live: true };

  it('asks to unlock first, and only then offers Talk', () => {
    const locked = livePage(ctx, { unlocked: false });
    expect(locked).toContain('href="/unlock"');
    expect(locked).not.toContain('id="talk"');
    const open = livePage(ctx, { unlocked: true });
    expect(open).toContain('id="talk" aria-pressed="false"');
    expect(open).toContain('href="/live" class="nav-item on" aria-current="page"');
  });

  it('ships a script that parses', () => {
    const script = livePage(ctx, { unlocked: true }).split('<script>').at(-1)?.split('</script>')[0] ?? '';
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('registerProcessor("mic"');
    expect(script).toContain('registerProcessor("player"');
  });

  it('is served, and in the menu, only when Live is on', async () => {
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
      const page = await fetch(`${base}/live`, { headers: { accept: 'text/html' } });
      expect(page.status).toBe(status);
      const home = await fetch(`${base}/`, { headers: { accept: 'text/html' } }).then((r) => r.text());
      expect(home.includes('href="/live"')).toBe(inMenu);
      server.close();
    }
    store.close();
  });
});

describe('HTTPS listener', () => {
  it('serves the same pages and /live/ws over TLS, next to plain HTTP', async () => {
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
      const ws = new WebSocket(`wss://127.0.0.1:${free}/live/ws`, {
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
