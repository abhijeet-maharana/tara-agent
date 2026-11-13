import { describe, expect, it } from 'vitest';
import { jobSchema } from '../src/config/schema.js';
import { buildJobPrompt, cronFailure, isSilentReply, splitHeadline } from '../src/scheduler/prompt.js';

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

describe('isSilentReply / cronFailure', () => {
  it.each([
    ['[SILENT]', true],
    ['  silent  ', true],
    ['NO_REPLY', true],
    ['Nothing new.\n[SILENT]', true],
    ['[SILENT]\nignored', true],
    ['We stay [SILENT] on this', false],
    ['Report: 3 orders', false],
  ])('%j silent=%s', (text, silent) => {
    expect(isSilentReply(text)).toBe(silent);
  });

  it('reads [CRON_FAILURE] only as the exact first line', () => {
    expect(cronFailure('[CRON_FAILURE]\nlogin expired')).toBe('login expired');
    expect(cronFailure('[CRON_FAILURE]')).toBe('The job reported a failure.');
    expect(cronFailure('Note: [CRON_FAILURE] is a marker')).toBeUndefined();
  });
});

describe('splitHeadline', () => {
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
