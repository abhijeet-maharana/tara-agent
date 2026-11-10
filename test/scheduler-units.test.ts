import { describe, expect, it } from 'vitest';
import { jobSchema } from '../src/config/schema.js';
import { convertHermesJobs } from '../src/import-hermes.js';
import { buildJobPrompt, cronFailure, isSilentReply, splitHeadline } from '../src/scheduler/prompt.js';

const job = (o: object = {}) =>
  jobSchema.parse({ id: 'j', name: 'J', cron: '* * * * *', skills: ['do-it'], ...o });

describe('buildJobPrompt', () => {
  it("is the job's section in its first skill, then the skills to load", () => {
    expect(buildJobPrompt(job({ skills: ['sla-report', 'humanizer'] }))).toBe(
      'Run the job "J" (`j`): do what the "## Job: `j`" section of the `sla-report` skill says, with the rest of that skill.\n\n' +
        'Skills for this job: `sla-report`, `humanizer`. Load each one before you start (the Skill tool, or its SKILL.md) and follow it.',
    );
  });

  it('needs a skill, and refuses the keys that moved into it', () => {
    const base = { id: 'x', name: 'X', cron: '* * * * *' };
    expect(jobSchema.safeParse(base).success).toBe(false);
    const script = jobSchema.safeParse({ ...base, skills: ['s'], preScript: 'a.sh' });
    expect(script.error?.issues[0]?.message).toMatch(
      /`preScript` is no longer read: the job's skill runs its scripts/,
    );
    const agent = jobSchema.safeParse({ ...base, skills: ['s'], agent: false });
    expect(agent.error?.issues[0]?.message).toMatch(/`agent` is no longer read/);
    const old = jobSchema.safeParse({ ...base, skills: ['s'], prompt: 'Do it.' });
    expect(old.error?.issues[0]?.message).toMatch(/`prompt` is no longer read.*move-prompts/);
    const step = jobSchema.safeParse({ ...base, skills: ['s'], steps: [{ name: 'A', promptFile: 'a.md' }] });
    expect(step.error?.issues[0]?.message).toMatch(/`promptFile` is no longer read/);
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

describe('convertHermesJobs', () => {
  const hermes = {
    jobs: [
      {
        name: 'Meesho Label Download',
        schedule: { kind: 'cron', expr: '30 18 * * *' },
        prompt: 'Download labels',
        skill: 'meesho-label-download',
        skills: null,
        script: 'ops-meesho-labels.sh',
        model: null,
        enabled: true,
        enabled_toolsets: ['mcp-chrome', 'terminal'],
      },
      {
        name: 'Weekly P&L Pulse',
        schedule: '0 6 * * 1',
        prompt: 'P&L',
        skills: ['marketplace-pnl-weekly'],
        model: 'claude-sonnet-5-5',
        enabled: false,
        enabled_toolsets: ['terminal', 'file', 'no_mcp'],
      },
      { name: 'Weekly P&L Pulse', schedule: '0 7 * * 1', prompt: 'again', enabled_toolsets: null },
    ],
  };

  it('maps Hermes jobs to valid tara jobs', () => {
    const out = convertHermesJobs(hermes, {
      scriptsDir: '.agents/hermes/cron/scripts',
      defaultModel: 'haiku',
      tz: 'UTC',
      env: { ROOT: '~/x' },
    });
    expect(out.env).toEqual({ ROOT: '~/x' });
    expect(out.jobs.map((j) => j.id)).toEqual([
      'meesho-label-download',
      'weekly-p-and-l-pulse',
      'weekly-p-and-l-pulse-2',
    ]);
    expect(out.jobs[0]).toMatchObject({
      cron: '30 18 * * *',
      tz: 'UTC',
      skills: ['meesho-label-download'],
      preScript: '.agents/hermes/cron/scripts/ops-meesho-labels.sh',
      model: 'haiku',
      locks: ['chrome'],
      timeoutMinutes: 40,
      enabled: true,
    });
    expect(out.jobs[1]).toMatchObject({ model: 'sonnet', locks: [], enabled: false });
    expect(out.jobs[2]?.locks).toEqual(['chrome']);
    expect(out.jobs[0]?.prompt).toBe('Download labels');
  });

  it('rejects input without a jobs list', () => {
    expect(() =>
      convertHermesJobs({ nope: 1 }, { scriptsDir: 's', defaultModel: 'h', tz: 'UTC', env: {} }),
    ).toThrow(/list of Hermes jobs/);
  });
});
