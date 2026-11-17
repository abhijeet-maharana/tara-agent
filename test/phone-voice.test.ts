import { describe, expect, it, vi } from 'vitest';
import type { Attention } from '../src/http/attention.js';
import type { GlanceState } from '../src/http/phone-events.js';
import {
  chatModel,
  findJob,
  normalise,
  PhoneVoice,
  parseMinutes,
  parseModelReply,
  type VoiceDeps,
  type VoiceJob,
} from '../src/http/phone-voice.js';
import type { Task } from '../src/runner/activity.js';

/** 2026-11-17 12:00 UTC. */
const NOON = Date.UTC(2026, 10, 17, 12, 0);
const MIN = 60_000;

const job = (over: Partial<VoiceJob> = {}): VoiceJob => ({
  project: 'abtara',
  projectTitle: 'Abtara',
  id: 'blog-writer',
  name: 'Blog writer',
  enabled: true,
  running: false,
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  project: 'abtara',
  kind: 'job',
  title: 'Blog writer',
  startedAt: NOON - 4 * MIN,
  status: 'running',
  steps: [],
  stepCount: 3,
  text: '',
  ...over,
});

function glance(over: Partial<GlanceState> = {}): GlanceState {
  return {
    build: 'b',
    at: NOON,
    ready: true,
    quiet: { from: '23:00', to: '07:00', now: false },
    needs: { urgent: 0, waiting: 0, top: [] },
    approvals: { total: 0, projects: [] },
    running: [],
    recent: [],
    next: [],
    alerts: [],
    held: 0,
    ...over,
  };
}

function setup(over: Partial<VoiceDeps> = {}) {
  const calls: string[] = [];
  const announced: Array<{ id: string; say: string }> = [];
  let quietUntil: number | undefined;
  const state = { glance: glance(), attention: { items: [], notes: [] } as Attention };
  const voice = new PhoneVoice({
    agentName: 'Jarvis',
    projects: [
      { name: 'abtara', title: 'Abtara' },
      { name: 'personal', title: 'Personal' },
    ],
    timeZone: 'UTC',
    glance: () => state.glance,
    attention: async () => state.attention,
    jobs: () => [
      job(),
      job({ project: 'personal', projectTitle: 'Personal', id: 'gym-log', name: 'Gym log' }),
    ],
    tasks: () => [task()],
    runJob: (p, id) => {
      calls.push(`run ${p}/${id}`);
      return 'started';
    },
    setJobEnabled: (p, id, on) => {
      calls.push(`${on ? 'resume' : 'pause'} ${p}/${id}`);
      return 'ok';
    },
    stopTask: (id) => {
      calls.push(`stop ${id}`);
      return true;
    },
    quiet: { until: () => quietUntil, set: (u) => (quietUntil = u) },
    announce: (d) => announced.push(d),
    now: () => NOON,
    ...over,
  });
  return { voice, calls, announced, state, quiet: () => quietUntil };
}

describe('normalise', () => {
  it('drops the wake words, politeness and punctuation', () => {
    expect(normalise('Hey Jarvis, what’s running?', 'Jarvis')).toBe("what's running");
    expect(normalise('Jarvis can you please run the blog job please', 'Jarvis')).toBe('run the blog job');
  });
});

describe('parseMinutes', () => {
  it('reads spoken durations', () => {
    expect(parseMinutes('quiet for two hours')).toBe(120);
    expect(parseMinutes('quiet for 45 minutes')).toBe(45);
    expect(parseMinutes('quiet for an hour and a half')).toBe(90);
    expect(parseMinutes('quiet for half an hour')).toBe(30);
    expect(parseMinutes('quiet mode')).toBeUndefined();
  });
});

describe('findJob', () => {
  const jobs = [
    job(),
    job({ id: 'blog-review', name: 'Blog review' }),
    job({ project: 'personal', projectTitle: 'Personal', id: 'gym-log', name: 'Gym log' }),
  ];
  it('finds by words, and narrows by a named project', () => {
    expect(findJob(jobs, 'gym').job?.id).toBe('gym-log');
    expect(findJob(jobs, 'blog writer').job?.id).toBe('blog-writer');
    expect(findJob(jobs, 'blog').candidates).toHaveLength(2);
    expect(findJob(jobs, 'gym log in personal').job?.id).toBe('gym-log');
    expect(findJob(jobs, 'nothing like it').job).toBeUndefined();
  });
});

describe('PhoneVoice rules', () => {
  it("answers what's running from the glance, at once", async () => {
    const { voice, state } = setup();
    state.glance = glance({
      running: [
        {
          id: 't1',
          project: 'Abtara',
          kind: 'job',
          title: 'Blog writer',
          startedAt: NOON - 4 * MIN,
          status: 'running',
          stepCount: 3,
          step: 'Reading',
        },
      ],
    });
    const r = await voice.turn('d1', "Jarvis, what's running?", true);
    expect(r).toMatchObject({ via: 'rule', say: 'Blog writer, in Abtara, for 4 minutes.' });
    expect(r.panel?.lines[0]?.text).toBe('Blog writer');
  });

  it('says what needs the owner, approvals counted apart', async () => {
    const { voice, state } = setup();
    state.attention = {
      items: [
        {
          key: 'f',
          tier: 'urgent',
          kind: 'job-failing',
          project: 'abtara',
          title: 'Payments sync failed 3 times in a row',
        },
        { key: 'a', tier: 'waiting', kind: 'approval', project: 'abtara', title: 'Card' },
      ],
      notes: [],
    };
    state.glance = glance({
      approvals: {
        total: 2,
        projects: [{ project: 'Abtara', count: 2, oldestAt: NOON - 60 * MIN, title: 'Post' }],
      },
    });
    const r = await voice.turn('d1', 'what needs me', true);
    expect(r.say).toBe('Urgent: Payments sync failed 3 times in a row. 2 approval cards waiting.');
    expect(r.panel?.lines.map((l) => l.text)).toEqual([
      'Payments sync failed 3 times in a row',
      '2 approval cards waiting',
    ]);
  });

  it('says how old the oldest card is, not its title', async () => {
    const { voice, state } = setup();
    state.glance = glance({
      approvals: {
        total: 4,
        projects: [
          { project: 'Job Search', count: 3, oldestAt: NOON - 6 * 1440 * MIN, title: '61 · Lette · Husam' },
          { project: 'Abtara', count: 1, oldestAt: NOON - 60 * MIN, title: 'Post' },
        ],
      },
    });
    expect((await voice.turn('d1', 'any approvals', true)).say).toBe(
      '4 cards waiting across 2 projects. The oldest is 6 days old, in Job Search.',
    );
  });

  it('never decides cards by voice', async () => {
    const { voice } = setup();
    const r = await voice.turn('d1', 'approve the first card', false);
    expect(r.say).toMatch(/can't decide cards by voice/);
  });

  it('sets and ends quiet mode', async () => {
    const { voice, quiet } = setup();
    expect((await voice.turn('d1', 'quiet mode for two hours', true)).say).toBe(
      'Quiet until 14:00. Alerts will wait.',
    );
    expect(quiet()).toBe(NOON + 120 * MIN);
    expect((await voice.turn('d1', 'quiet mode off', true)).say).toBe('Quiet mode is off.');
    expect(quiet()).toBeUndefined();
  });
});

describe('PhoneVoice actions', () => {
  it('asks for the unlock on a locked phone, and acts nowhere', async () => {
    const { voice, calls } = setup();
    expect(await voice.turn('d1', 'run the gym job', true)).toMatchObject({ unlock: true });
    expect(calls).toEqual([]);
  });

  it('asks for a yes, then runs', async () => {
    const { voice, calls } = setup();
    const q = await voice.turn('d1', 'run the gym job', false);
    expect(q).toMatchObject({ say: 'Run Gym log, in Personal, now?', expect: 'confirm' });
    // Another phone's yes doesn't count.
    expect(calls).toEqual([]);
    const done = await voice.turn('d1', 'yes', false);
    expect(done.say).toBe('Started Gym log.');
    expect(calls).toEqual(['run personal/gym-log']);
  });

  it('needs the unlock again if the phone locked before the yes', async () => {
    const { voice, calls } = setup();
    await voice.turn('d1', 'pause the gym job', false);
    expect(await voice.turn('d1', 'yes', true)).toMatchObject({ unlock: true });
    await voice.turn('d1', 'yes', false);
    expect(calls).toEqual(['pause personal/gym-log']);
  });

  it('drops the question on a no', async () => {
    const { voice, calls } = setup();
    await voice.turn('d1', 'stop the blog run', false);
    expect((await voice.turn('d1', 'no', false)).say).toMatch(/won/);
    expect((await voice.turn('d1', 'yes', false)).via).not.toBe('confirm');
    expect(calls).toEqual([]);
  });

  it('takes a verb-led sentence as an action before its keywords', async () => {
    const { voice } = setup({ jobs: () => [job({ id: 'approvals-cleanup', name: 'Approvals cleanup' })] });
    expect(await voice.turn('d1', 'run the approvals cleanup job', false)).toMatchObject({
      say: 'Run Approvals cleanup, in Abtara, now?',
      expect: 'confirm',
    });
  });

  it('takes "stop blog" as a stop, not a no', async () => {
    const { voice } = setup();
    expect(await voice.turn('d1', 'stop blog', false)).toMatchObject({
      expect: 'confirm',
      say: 'Stop Blog writer, in Abtara?',
    });
  });

  it('asks which job when the words fit several', async () => {
    const { voice } = setup({ jobs: () => [job(), job({ id: 'blog-review', name: 'Blog review' })] });
    expect((await voice.turn('d1', 'run blog', false)).say).toMatch(
      /^Which one\? Blog writer in Abtara and Blog review/,
    );
  });
});

describe('PhoneVoice model', () => {
  it('passes what the rules miss to the model, with the glance', async () => {
    const model = vi.fn(async () => JSON.stringify({ say: 'It failed on a timeout.' }));
    const { voice } = setup({ model });
    const r = await voice.turn('d1', 'why did the payments thing break', true);
    expect(r).toMatchObject({ via: 'model', say: 'It failed on a timeout.' });
    const [system, user] = model.mock.calls[0] as unknown as [string, string];
    expect(system).toMatch(/You are Jarvis/);
    expect(user).toMatch(/"blog-writer"/);
  });

  it("routes the model's actions through the same yes and unlock", async () => {
    const model = vi.fn(async () =>
      JSON.stringify({ say: '', action: { type: 'run_job', project: 'abtara', job: 'blog-writer' } }),
    );
    const { voice, calls } = setup({ model });
    expect(await voice.turn('d1', 'kick that writing thing off', true)).toMatchObject({ unlock: true });
    expect(await voice.turn('d1', 'kick that writing thing off', false)).toMatchObject({ expect: 'confirm' });
    await voice.turn('d1', 'haan', false);
    expect(calls).toEqual(['run abtara/blog-writer']);
  });

  it('asks Claude for code questions and announces the answer later', async () => {
    const model = async () =>
      JSON.stringify({
        say: 'Checking.',
        action: { type: 'ask', project: 'abtara', question: 'How many retries?' },
      });
    let answer: (s: string) => void = () => {};
    const ask = vi.fn(() => new Promise<string>((r) => (answer = r)));
    const { voice, announced } = setup({ model, ask });
    const r = await voice.turn('d1', 'how many retries does the sync do', true);
    expect(r).toMatchObject({ say: 'Checking.', pending: expect.stringMatching(/^ask-/) });
    expect(ask).toHaveBeenCalledWith('abtara', 'How many retries?');
    answer('Three.');
    await new Promise((r) => setTimeout(r, 0));
    expect(announced).toEqual([expect.objectContaining({ id: r.pending, say: 'Three.' })]);
  });

  it("gives Claude the project's job errors with the question", async () => {
    const model = async () =>
      JSON.stringify({
        say: '',
        action: { type: 'ask', project: 'abtara', question: 'Why did the blog writer fail?' },
      });
    const ask = vi.fn(async (_project: string, _question: string) => 'A timeout.');
    const { voice } = setup({
      model,
      ask,
      jobs: () => [job({ lastStatus: 'error', lastError: 'Timed out after 30 min' })],
    });
    expect((await voice.turn('d1', 'what broke in the writer', true)).say).toBe('Checking Abtara.');
    expect(ask.mock.calls[0]?.[1]).toMatch(
      /Why did the blog writer fail\?\n\n.*\n- Blog writer \(blog-writer\): last error: Timed out after 30 min/,
    );
  });

  it('falls back gracefully without a model, or when it fails', async () => {
    expect((await setup().voice.turn('d1', 'sing a song', true)).via).toBe('none');
    const broken = setup({ model: async () => Promise.reject(new Error('down')) });
    expect((await broken.voice.turn('d1', 'sing a song', true)).say).toMatch(/model didn't answer/);
  });
});

describe('parseModelReply', () => {
  it('reads JSON, fenced JSON and plain text', () => {
    expect(parseModelReply('{"say":"Hi"}')).toEqual({ say: 'Hi' });
    expect(parseModelReply('```json\n{"say":"Hi","panel":{"title":"T","lines":["a"]}}\n```')).toEqual({
      say: 'Hi',
      panel: { title: 'T', lines: [{ text: 'a' }] },
    });
    expect(parseModelReply('Just words')).toEqual({ say: 'Just words' });
  });
});

describe('chatModel', () => {
  it('tries the next model when one fails', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model;
      if (model === 'a') return new Response('no', { status: 503 });
      return Response.json({ choices: [{ message: { content: '{"say":"ok"}' } }] });
    });
    const call = chatModel(
      { url: 'http://x/v1/chat/completions', models: ['a', 'b'], apiKey: 'k' },
      fetchImpl as typeof fetch,
    );
    expect(await call('sys', 'user')).toBe('{"say":"ok"}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
