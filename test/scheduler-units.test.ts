import { describe, expect, it } from 'vitest';
import { jobSchema } from '../src/config/schema.js';
import { buildJobPrompt, failedReply, splitHeadline } from '../src/scheduler/prompt.js';

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
