import { describe, expect, it, vi } from 'vitest';
import type { VoiceJob } from '../src/http/phone-voice.js';
import { ClaudeLane, details, titlesCard } from '../src/live/claude-lane.js';
import type { ToolContext } from '../src/live/phone-live.js';

const silent = { info: () => {}, warn: () => {} };

const job: VoiceJob = {
  project: 'abtara',
  projectTitle: 'Abtara',
  id: 'blog-writer',
  name: 'Blog writer',
  enabled: true,
  running: false,
  lastStatus: 'error',
  lastError: 'Timed out',
};

function ctx() {
  const steps: string[] = [];
  const cards: Array<{ id: string; card: unknown }> = [];
  const c: ToolContext = {
    step: (label) => {
      steps.push(label);
      return `s${steps.length}`;
    },
    finishStep: () => {},
    card: (id, card) => cards.push({ id, card }),
    watchRun: () => {},
    signal: new AbortController().signal,
  };
  return { c, steps, cards };
}

/** A stand-in for the Messages API: answers in turn with the given responses. */
function fakeClient(responses: unknown[]) {
  const create = vi.fn(async () => responses.shift());
  return { client: { beta: { messages: { create } } } as never, create };
}

function lane(client: never, over: Record<string, unknown> = {}) {
  return new ClaudeLane({
    apiKey: 'k',
    projects: [{ name: 'abtara', title: 'Abtara' }],
    jobs: () => [job],
    jobRuns: () => [
      {
        id: 7,
        kind: 'job',
        project: 'abtara',
        jobId: 'blog-writer',
        startedAt: 0,
        endedAt: 60_000,
        status: 'error',
        error: 'Timed out after 30 min',
        output: 'partial',
      },
    ],
    tasks: () => [],
    journal: async () => ['2026-11-17T10:00 blog-writer: timed out'],
    timeZone: 'UTC',
    log: silent,
    client,
    ...over,
  });
}

describe('ClaudeLane', () => {
  it('runs its read tools, shows each step, and answers', async () => {
    const { client, create } = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'u1', name: 'job_runs', input: { job: 'blog writer' } },
          { type: 'tool_use', id: 'u2', name: 'service_log', input: { grep: 'blog-writer' } },
        ],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'It timed out after 30 minutes.\n---\n- run 7: timed out' }],
      },
    ]);
    const { c, steps, cards } = ctx();
    const r = await lane(client).ask('Why did the blog job fail?', { ctx: c, cardId: 'x' });
    expect(r.answer).toMatch(/^It timed out/);
    expect(r.model).toBe('sonnet 5.5');
    expect(steps).toEqual(['Runs: blog writer', 'Log: blog-writer']);
    // Both results go back in one user message.
    const second = (
      create.mock.calls[1] as unknown as [{ messages: Array<{ role: string; content: unknown[] }> }]
    )[0];
    expect(second.messages[2]?.content).toHaveLength(2);
    expect(JSON.stringify(second.messages[2])).toMatch(/Timed out after 30 min/);
    expect(cards.at(-1)?.card).toMatchObject({
      kind: 'claude',
      status: 'done',
      answer: '- run 7: timed out',
    });
  });

  it('uses Opus for hard questions and shows web searches', async () => {
    const { client, create } = fakeClient([
      {
        stop_reason: 'end_turn',
        content: [
          { type: 'server_tool_use', id: 'w', name: 'web_search', input: { query: 'best comedies 2026' } },
          { type: 'text', text: 'Try Hit Man.' },
        ],
      },
    ]);
    const { c, steps } = ctx();
    await lane(client).ask('A film for tonight?', { hard: true, ctx: c, cardId: 'x' });
    expect((create.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe('claude-opus-5-5');
    expect(steps).toEqual(['Web: best comedies 2026']);
  });

  it('gives Gemini its tools, claude_code gated', () => {
    const kit = lane(fakeClient([]).client, { dispatch: async () => ({}) }).kit();
    expect(kit.declarations.map((d) => d.name)).toEqual(['ask_claude', 'show_titles', 'claude_code']);
    expect(kit.gated).toEqual(['claude_code']);
  });
});

describe('helpers', () => {
  it('splits the spoken part from the details', () => {
    expect(details('Short.\n---\n- **a**\n- b')).toBe('- a\n- b');
    expect(details('Only this.')).toBe('Only this.');
  });

  it('finds posters on Wikipedia, film titles first', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('Hit_Man_(2023_film)')
        ? new Response(
            JSON.stringify({ type: 'standard', thumbnail: { source: 'https://upload.example/hitman.jpg' } }),
          )
        : new Response('', { status: 404 }),
    );
    const card = await titlesCard(
      {
        title: 'Tonight',
        kind: 'film',
        items: [{ title: 'Hit Man', year: '2023', note: 'Netflix' }, { title: 'Nope Film' }],
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(card.items[0]).toEqual({
      title: 'Hit Man',
      sub: '2023',
      note: 'Netflix',
      image: 'https://upload.example/hitman.jpg',
    });
    expect(card.items[1]).toEqual({ title: 'Nope Film' });
  });
});
