import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { PhoneVoice, type VoiceJob } from '../src/http/phone-voice.js';
import type { GeminiLive, LiveConnectOptions, LiveEvents } from '../src/live/gemini.js';
import { laneOf, liveCost, PhoneLive, type PhoneLiveDeps } from '../src/live/phone-live.js';
import type { Task } from '../src/runner/activity.js';

const silent = { info: () => {}, warn: () => {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The phone's end of the WebSocket. */
function fakeClient() {
  const ws = new EventEmitter() as EventEmitter & {
    readyState: number;
    sent: unknown[];
    send(d: unknown): void;
  };
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  const events = () => ws.sent.filter((x) => !Buffer.isBuffer(x)) as Array<Record<string, unknown>>;
  const say = (msg: Record<string, unknown>) => ws.emit('message', Buffer.from(JSON.stringify(msg)), false);
  return { ws, events, say };
}

/** A stand-in Gemini session: records what it is sent, and lets the test play the model. */
function fakeGemini() {
  const sent = { audio: 0, text: [] as string[], responses: [] as unknown[], closed: false };
  let events!: LiveEvents;
  let setup!: LiveConnectOptions['setup'];
  const up = {
    sendAudio: () => {
      sent.audio++;
    },
    endAudio: () => {},
    sendText: (t: string) => sent.text.push(t),
    sendToolResponses: (r: unknown[]) => sent.responses.push(...r),
    close: () => {
      sent.closed = true;
      events.onClose();
    },
  };
  const connect = vi.fn(async (o: LiveConnectOptions) => {
    events = o.events;
    setup = o.setup;
    return up as unknown as GeminiLive;
  });
  return { connect, sent, ev: () => events, setup: () => setup };
}

const job = (over: Partial<VoiceJob> = {}): VoiceJob => ({
  project: 'abtara',
  projectTitle: 'Abtara',
  id: 'blog-writer',
  name: 'Blog writer',
  enabled: true,
  running: false,
  ...over,
});

function setup(over: Partial<PhoneLiveDeps> = {}) {
  const client = fakeClient();
  const gemini = fakeGemini();
  const runJob = vi.fn(() => 'started' as const);
  const voice = new PhoneVoice({
    agentName: 'Jarvis',
    projects: [{ name: 'abtara', title: 'Abtara' }],
    timeZone: 'UTC',
    glance: () =>
      ({
        needs: { urgent: 0, waiting: 0, top: [] },
        approvals: {
          total: 3,
          projects: [{ project: 'Abtara', count: 3, oldestAt: Date.now(), title: 'Post' }],
        },
        running: [],
        recent: [],
        next: [],
        quiet: { now: false, from: '23:00', to: '07:00' },
        alerts: [],
        held: 0,
        ready: true,
        build: '1',
      }) as never,
    attention: async () => ({ items: [], notes: [] }),
    jobs: () => [job()],
    tasks: () => [],
    runJob,
    setJobEnabled: () => 'ok',
    stopTask: () => true,
    quiet: { until: () => undefined, set: () => {} },
    announce: () => {},
  });
  const live = new PhoneLive(
    client.ws as unknown as WebSocket,
    { apiKey: 'k', url: 'wss://x', model: 'm', voice: 'Charon', idleSeconds: 20 },
    {
      agentName: 'Jarvis',
      voice,
      jobs: () => [job()],
      tasks: () => [],
      runJob,
      setJobEnabled: () => 'ok',
      stopTask: () => true,
      log: silent,
      connect: gemini.connect,
      ...over,
    },
  );
  return { live, client, gemini, runJob };
}

const call = (name: string, args: Record<string, unknown> = {}, id = 'c1') => [{ id, name, args }];

describe('PhoneLive', () => {
  it('opens the voice session on start and streams the microphone to it', async () => {
    const { client, gemini } = setup();
    client.ws.emit('message', Buffer.alloc(640), true); // before start: dropped
    client.say({ type: 'start', locked: true });
    client.ws.emit('message', Buffer.alloc(640), true);
    await tick();
    expect(gemini.connect).toHaveBeenCalledOnce();
    expect(gemini.sent.audio).toBe(1);
    expect(gemini.setup().tools.map((t) => t.name)).toContain('running');
    expect(client.events()).toContainEqual({ type: 'state', state: 'listening' });
  });

  it('answers a rule tool with a step and a card', async () => {
    const { client, gemini } = setup();
    client.say({ type: 'start' });
    await tick();
    gemini.ev().onToolCalls(call('approvals'));
    await tick();
    const ev = client.events();
    expect(ev).toContainEqual(expect.objectContaining({ type: 'step', label: 'Approvals', status: 'ok' }));
    expect(ev).toContainEqual(
      expect.objectContaining({ type: 'card', card: expect.objectContaining({ kind: 'list' }) }),
    );
    expect(gemini.sent.responses[0]).toMatchObject({
      name: 'approvals',
      response: { answer: expect.stringMatching(/3 cards/) },
    });
  });

  it('asks for the unlock before an action on a locked phone', async () => {
    const { client, gemini, runJob } = setup();
    client.say({ type: 'start', locked: true });
    await tick();
    gemini.ev().onToolCalls(call('job', { action: 'run', job: 'blog writer' }));
    await tick();
    expect(client.events()).toContainEqual({ type: 'unlock' });
    expect(gemini.sent.responses[0]).toMatchObject({ response: { error: expect.stringMatching(/locked/) } });
    client.say({ type: 'lock', locked: false });
    expect(gemini.sent.text.at(-1)).toMatch(/unlocked now/);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('acts only on a yes in the user’s own words', async () => {
    const { client, gemini, runJob } = setup();
    client.say({ type: 'start', locked: false });
    await tick();
    const ev = gemini.ev();
    ev.onToolCalls(call('job', { action: 'run', job: 'blog writer' }));
    await tick();
    expect(gemini.sent.responses[0]).toMatchObject({
      response: { needsConfirmation: true, question: 'Run Blog writer, in Abtara, now?' },
    });
    // The model says yes for the user: refused.
    ev.onToolCalls(call('confirm', { answer: 'yes' }, 'c2'));
    await tick();
    expect(gemini.sent.responses[1]).toMatchObject({
      response: { error: expect.stringMatching(/didn't hear a yes/) },
    });
    expect(runJob).not.toHaveBeenCalled();
    // The user says it (Hinglish).
    ev.onTranscript('user', 'haan chalao');
    ev.onToolCalls(call('confirm', { answer: 'yes' }, 'c3'));
    await tick();
    expect(runJob).toHaveBeenCalledWith('abtara', 'blog-writer');
    expect(gemini.sent.responses[2]).toMatchObject({ response: { result: 'started' } });
  });

  it('a no in the words wins over a yes', async () => {
    const { client, gemini, runJob } = setup();
    client.say({ type: 'start', locked: false });
    await tick();
    gemini.ev().onToolCalls(call('job', { action: 'pause', job: 'blog' }));
    await tick();
    gemini.ev().onTranscript('user', 'yes, no wait, nahi');
    gemini.ev().onToolCalls(call('confirm', { answer: 'yes' }, 'c2'));
    await tick();
    expect(runJob).not.toHaveBeenCalled();
    expect(gemini.sent.responses[1]).toMatchObject({ response: { error: expect.any(String) } });
  });

  it('takes the Yes button and tells the model what happened', async () => {
    const { client, gemini, runJob } = setup();
    client.say({ type: 'start', locked: false });
    await tick();
    gemini.ev().onToolCalls(call('job', { action: 'run', job: 'blog-writer' }));
    await tick();
    client.say({ type: 'confirm', yes: true });
    await tick();
    expect(runJob).toHaveBeenCalledOnce();
    expect(gemini.sent.text.at(-1)).toMatch(/tapped Yes/);
    expect(client.events()).toContainEqual(
      expect.objectContaining({
        type: 'card',
        card: expect.objectContaining({ kind: 'confirm', state: 'yes' }),
      }),
    );
  });

  it('tells the model when a job it started ends', async () => {
    let listener!: (e: { type: 'task'; task: Task }) => void;
    const { client, gemini } = setup({
      subscribe: (l) => {
        listener = l as never;
        return () => {};
      },
    });
    client.say({ type: 'start', locked: false });
    await tick();
    gemini.ev().onToolCalls(call('job', { action: 'run', job: 'blog-writer' }));
    await tick();
    gemini.ev().onTranscript('user', 'yes');
    gemini.ev().onToolCalls(call('confirm', { answer: 'yes' }, 'c2'));
    await tick();
    listener({
      type: 'task',
      task: {
        id: 't1',
        project: 'abtara',
        kind: 'job',
        jobId: 'blog-writer',
        title: 'Blog writer',
        startedAt: Date.now(),
        endedAt: Date.now() + 120_000,
        status: 'error',
        steps: [],
        stepCount: 0,
        text: '',
        error: 'Timed out',
      },
    });
    expect(gemini.sent.text.at(-1)).toMatch(
      /TASK DONE: The job Blog writer \(abtara\) ended: error.*Timed out/s,
    );
  });

  it('shows Google Search sources', async () => {
    const { client, gemini } = setup();
    client.say({ type: 'start' });
    await tick();
    gemini
      .ev()
      .onGrounding?.({ queries: ['best movies 2026'], sources: [{ title: 'imdb.com', uri: 'https://x' }] });
    expect(client.events()).toContainEqual(
      expect.objectContaining({ type: 'step', label: 'Google: best movies 2026' }),
    );
    expect(client.events()).toContainEqual(
      expect.objectContaining({
        card: {
          kind: 'sources',
          queries: ['best movies 2026'],
          sources: [{ title: 'imdb.com', site: 'imdb.com' }],
        },
      }),
    );
  });

  it('closes after end_conversation and tells the phone', async () => {
    vi.useFakeTimers();
    try {
      const { client, gemini } = setup();
      client.say({ type: 'start' });
      await vi.advanceTimersByTimeAsync(0);
      gemini.ev().onToolCalls(call('end_conversation'));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(gemini.sent.closed).toBe(true);
      expect(client.events()).toContainEqual(expect.objectContaining({ type: 'end' }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('music during a conversation', () => {
  it('pauses the speaker while the user talks and resumes it after', async () => {
    const control = vi.fn(async (a: string) => (a === 'status' ? { state: 'PLAYING' } : {}));
    const { client, gemini } = setup({ music: { control } });
    client.say({ type: 'start' });
    await tick();
    await tick();
    expect(control).toHaveBeenCalledWith('pause');
    gemini.ev().onClose();
    expect(control).toHaveBeenLastCalledWith('resume');
  });

  it("doesn't resume music the user handled in the conversation", async () => {
    const control = vi.fn(async (a: string) => (a === 'status' ? { state: 'PLAYING' } : {}));
    const kit = {
      declarations: [{ name: 'music', description: '' }],
      run: async () => ({ response: { state: 'stopped' } }),
    };
    const { client, gemini } = setup({ music: { control }, kit });
    client.say({ type: 'start' });
    await tick();
    await tick();
    gemini.ev().onToolCalls([{ id: 'c1', name: 'music', args: { action: 'stop' } }]);
    await tick();
    gemini.ev().onClose();
    expect(control).not.toHaveBeenCalledWith('resume');
  });
});

describe('helpers', () => {
  it('names the lane of a turn', () => {
    expect(laneOf([])).toBe('chat');
    expect(laneOf(['running'])).toBe('tools');
    expect(laneOf(['google'])).toBe('search');
    expect(laneOf(['running', 'ask_claude'])).toBe('claude');
  });

  it('prices a session', () => {
    // A minute each way of audio: 1,500 tokens in, 1,500 out.
    expect(liveCost({ total: 3000, input: { AUDIO: 1500 }, output: { AUDIO: 1500 } })).toBeCloseTo(0.0225, 4);
  });
});
