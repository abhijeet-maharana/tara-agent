import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobSchema } from '../src/config/schema.js';
import { convertHermesJobs } from '../src/import-hermes.js';
import {
  buildJobPrompt,
  cronFailure,
  isSilentReply,
  parseWakeGate,
  splitHeadline,
} from '../src/scheduler/prompt.js';
import { runScript } from '../src/scheduler/script.js';

const job = (o: object = {}) =>
  jobSchema.parse({ id: 'j', name: 'J', cron: '* * * * *', prompt: 'Do it.', ...o });

describe('parseWakeGate', () => {
  it.each([
    ['', true],
    ['some report', true],
    ['data\n{"wakeAgent": true}', true],
    ['data\n{"wakeAgent": false}\n\n', false],
    ['{"wakeAgent": false} trailing', true],
    ['{"other": 1}', true],
  ])('%j → %s', (output, wake) => {
    expect(parseWakeGate(output)).toBe(wake);
  });
});

describe('buildJobPrompt', () => {
  it('puts script output first, then the prompt and skills', () => {
    const prompt = buildJobPrompt(job({ skills: ['sla-report'] }), {
      ok: true,
      output: 'STATUS: OK',
      exitCode: 0,
      timedOut: false,
    });
    expect(prompt).toMatch(/^## Script Output\nThe following data was collected/);
    expect(prompt).toContain('```\nSTATUS: OK\n```\n\nDo it.');
    expect(prompt).toContain('Skills for this job: `sla-report`');
  });

  it('reports a failed script as Script Error', () => {
    const prompt = buildJobPrompt(job(), { ok: false, output: 'boom', exitCode: 1, timedOut: false });
    expect(prompt).toMatch(/^## Script Error\nThe data-collection script failed/);
  });

  it('is just the prompt without a script', () => {
    expect(buildJobPrompt(job())).toBe('Do it.');
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

describe('runScript', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-script-'));
  const write = (name: string, body: string) => {
    writeFileSync(path.join(dir, name), body);
    chmodSync(path.join(dir, name), 0o755);
    return name;
  };

  it('runs .sh relative to the repo with the given env', async () => {
    const r = await runScript(
      write('ok.sh', 'echo "root=$PWD v=$MY_VAR"'),
      dir,
      { ...process.env, MY_VAR: 'x' },
      5_000,
    );
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(r.output).toBe(`root=${realpathSync(dir)} v=x`);
  });

  it('runs .py with python3', async () => {
    const r = await runScript(write('ok.py', 'print("from python")'), dir, process.env, 5_000);
    expect(r.output).toBe('from python');
  });

  it('reports failures with stderr and the exit code', async () => {
    const r = await runScript(
      write('bad.sh', 'echo partial; echo oops >&2; exit 3'),
      dir,
      process.env,
      5_000,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toBe('partial\noops\n(exit code 3)');
  });

  it('kills a script that runs too long', async () => {
    const r = await runScript(write('slow.sh', 'sleep 30'), dir, process.env, 300);
    expect(r).toMatchObject({ ok: false, timedOut: true });
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
    for (const j of out.jobs) expect(() => jobSchema.parse(j)).not.toThrow();
  });

  it('rejects input without a jobs list', () => {
    expect(() =>
      convertHermesJobs({ nope: 1 }, { scriptsDir: 's', defaultModel: 'h', tz: 'UTC', env: {} }),
    ).toThrow(/list of Hermes jobs/);
  });
});
