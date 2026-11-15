import { describe, expect, it } from 'vitest';
import { jobSchema } from '../src/config/schema.js';
import { buildJobPrompt, failedReply, splitHeadline, usageParagraph } from '../src/scheduler/prompt.js';
import { typicalRun } from '../src/sessions/learn.js';
import type { StoredRun } from '../src/store/store.js';

const job = (o: object = {}) =>
  jobSchema.parse({ id: 'j', name: 'J', cron: '* * * * *', skills: ['do-it'], ...o });

describe('buildJobPrompt', () => {
  it("is the job's section in its first skill, then the skills to load", () => {
    expect(buildJobPrompt(job({ skills: ['sla-report', 'humanizer'] }))).toBe(
      'Run the job "J" (`j`): do what the "## Job" section of the `sla-report` skill says (in an older skill: "## Job: `j`"), with the rest of that skill.\n\n' +
        'Skills for this job: `sla-report`, `humanizer`. Load each one before you start (the Skill tool, or its SKILL.md) and follow it.',
    );
  });

  it('needs a skill', () => {
    const base = { id: 'x', name: 'X', cron: '* * * * *' };
    expect(jobSchema.safeParse(base).success).toBe(false);
    expect(jobSchema.safeParse({ ...base, skills: ['s'] }).success).toBe(true);
  });

  it('tells a job with steps that they are done', () => {
    expect(buildJobPrompt(job({ steps: [{ name: 'A' }] }))).toContain(
      'Its "### Step" parts were done by the sessions before you (their output is above): do the rest.',
    );
  });
});

describe('failedReply', () => {
  it('reads a reply whose first line starts with ❌ as a failure', () => {
    expect(failedReply('❌ Flipkart login expired\nlogin page shown')).toBe(
      'Flipkart login expired\nlogin page shown',
    );
    expect(failedReply('❌')).toBe('The job reported a failure.');
    expect(failedReply('⚠️ 2 SKUs below floor')).toBeUndefined();
    expect(failedReply('✅ All good, ❌ none failed')).toBeUndefined();
  });
});

describe('splitHeadline', () => {
  it('moves a table out of the headline into the details', () => {
    const table = '| SKU | Left |\n| --- | --- |\n| car-v2 | 12 |';
    expect(splitHeadline(`✅ Stock checked\n${table}\n---\nAll fine`)).toEqual({
      headline: '✅ Stock checked',
      details: `${table}\n\nAll fine`,
    });
  });

  it('splits at a --- line', () => {
    expect(splitHeadline('*3 orders late*\n\n---\n• a\n• b')).toEqual({
      headline: '*3 orders late*',
      details: '• a\n• b',
    });
  });

  it('keeps short replies whole', () => {
    expect(splitHeadline('All good.')).toEqual({ headline: 'All good.', details: '' });
  });

  it('cuts long replies at the first paragraph', () => {
    const { headline, details } = splitHeadline(`Summary line\n\n${'detail '.repeat(200)}`);
    expect(headline).toBe('Summary line');
    expect(details.startsWith('detail')).toBe(true);
  });
});

describe('typicalRun', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const run = (o: Partial<StoredRun>): StoredRun => ({
    id: 1,
    kind: 'job',
    project: 'p',
    jobId: 'j',
    startedAt: now - 86_400_000,
    endedAt: now - 86_400_000 + 300_000,
    status: 'ok',
    costUsd: 1,
    ...o,
  });

  it('is the median of the first run in each recent thread', () => {
    const t = typicalRun(
      [
        run({ id: 1, threadKey: 'a', costUsd: 1 }),
        // A continuation after a card in the same thread: not a scheduled run.
        run({ id: 2, threadKey: 'a', costUsd: 0.1, startedAt: now - 3_600_000, endedAt: now - 3_500_000 }),
        run({ id: 3, threadKey: 'b', costUsd: 3 }),
        run({ id: 4, threadKey: 'c', costUsd: 2 }),
      ],
      now,
    );
    expect(t).toEqual({ costUsd: 2, durationMs: 300_000, runs: 3 });
  });

  it('needs three runs from the last two weeks that reported a cost and did their work', () => {
    expect(
      typicalRun(
        [
          run({ id: 1, threadKey: 'a' }),
          run({ id: 2, threadKey: 'b' }),
          run({ id: 3, threadKey: 'c', startedAt: now - 20 * 86_400_000 }),
          run({ id: 4, threadKey: 'd', costUsd: undefined }),
          run({ id: 5, threadKey: 'e', status: 'limit' }),
        ],
        now,
      ),
    ).toBeUndefined();
  });
});

describe('usageParagraph', () => {
  const use = {
    costUsd: 1.2,
    inputTokens: 3_400_000,
    outputTokens: 45_000,
    toolCalls: 38,
    durationMs: 720_000,
  };

  it('gives the numbers and asks for a cheaper path without blaming a normal run', () => {
    const text = usageParagraph({ session: use, typical: { costUsd: 1, durationMs: 600_000, runs: 5 } });
    expect(text).toContain(
      'What this session used: $1.20 at API prices, 3.4M input tokens (most of it re-read from cache) and 45k output, 38 tool calls, 12 min.',
    );
    expect(text).toContain("This job's usual run: $1.00 and 10 min (median of the last 5 runs).");
    expect(text).toContain('If you see how to get the same result with fewer turns');
    expect(text).not.toContain('the usual. Find');
  });

  it("names a step's share and an expensive whole run", () => {
    const text = usageParagraph(
      {
        session: { ...use, costUsd: 3 },
        run: { ...use, costUsd: 4 },
        typical: { costUsd: 2, durationMs: 600_000, runs: 4 },
      },
      'Review part 1',
    );
    expect(text).toContain('What this step used: $3.00');
    expect(text).toContain('This step was 75% of its cost.');
    expect(text).toContain('This run cost 2.0× the usual. Find what made it expensive in this step');
  });
});
