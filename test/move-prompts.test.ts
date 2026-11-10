import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadJobs } from '../src/config/load.js';
import { applyPromptMove, planPromptMove, type RawJobsFile } from '../src/config/move-prompts.js';

function repo(skills: Record<string, string>, files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-move-'));
  for (const [name, md] of Object.entries(skills)) {
    mkdirSync(path.join(dir, '.claude/skills', name), { recursive: true });
    writeFileSync(path.join(dir, '.claude/skills', name, 'SKILL.md'), md);
  }
  mkdirSync(path.join(dir, '.tara'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}
const skill = (dir: string, name: string) =>
  readFileSync(path.join(dir, '.claude/skills', name, 'SKILL.md'), 'utf8');
const move = (dir: string, file: RawJobsFile) => {
  const m = planPromptMove(dir, file);
  applyPromptMove(m, path.join(dir, '.tara/jobs.json'));
  return {
    moved: m.moved,
    unused: m.unusedPromptFiles,
    jobs: loadJobs({ dir, config: {} } as never).map((j) => j.job),
  };
};
const PLAIN = `"Above" means the run's prompt: its approved items and step output.`;

describe('planPromptMove', () => {
  it("puts a one-skill job's prompt in that skill, without the schedule, and bumps its version", () => {
    const dir = repo({ 'ga-audit': '---\nname: ga-audit\nversion: 1.5.0\n---\n\n# GA\n\nThe workflow.\n' });
    const file: RawJobsFile = {
      jobs: [
        {
          id: 'weekly-ga',
          name: 'Weekly GA',
          cron: '0 10 * * 2',
          skills: ['ga-audit'],
          prompt: 'Every Tuesday at 10:00 AM IST, do the audit following the `ga-audit` skill.',
        },
      ],
    };
    const { moved, jobs } = move(dir, file);
    expect(moved).toEqual(['weekly-ga: instructions → .claude/skills/ga-audit/SKILL.md']);
    expect(skill(dir, 'ga-audit')).toBe(
      '---\nname: ga-audit\nversion: 1.5.1\n---\n\n# GA\n\nThe workflow.\n\n## Job: `weekly-ga`\n\n' +
        `Instructions for the tara job \`weekly-ga\` (Weekly GA). ${PLAIN}\n\n` +
        'Do the audit following this skill.\n',
    );
    expect(jobs[0]).toMatchObject({ id: 'weekly-ga', skills: ['ga-audit'] });
    expect(file.jobs[0]?.prompt).toBeDefined(); // the input is left as it was
  });

  it('gives a job with several skills, or none, a skill of its own, first in its list', () => {
    const dir = repo({ 'amazon-ads': '# Amazon ads\n' }, { 'shared.md': 'Use the shared browser.' });
    const { moved, unused, jobs } = move(dir, {
      jobs: [
        {
          id: 'ads-audit',
          name: 'Ads Audit',
          skills: ['amazon-ads', 'flipkart-ads'],
          prompt: 'Combine the reports.',
          steps: [
            { name: 'Amazon', promptFile: 'shared.md', prompt: 'Audit Amazon.', timeoutMinutes: 40 },
            { name: 'Flipkart', promptFile: 'shared.md', prompt: 'Audit Flipkart.' },
          ],
        },
        {
          id: 'credit-watch',
          name: 'Credit Watch',
          prompt: 'Every Saturday night (Sunday 1:50 AM IST): check credits.',
        },
      ],
    });
    expect(moved).toEqual([
      'ads-audit: instructions → .claude/skills/ads-audit/SKILL.md (new skill)',
      'credit-watch: instructions → .claude/skills/credit-watch/SKILL.md (new skill)',
    ]);
    expect(unused).toEqual(['shared.md']);
    expect(skill(dir, 'ads-audit')).toMatch(
      /^---\nname: ads-audit\ndescription: "Instructions for the tara job \\"Ads Audit\\" \(ads-audit\)\. Use when running that job\."\n---\n\n# Ads Audit\n\n## Job: `ads-audit`\n\n.*\n\nCombine the reports\.\n\n### Every step\n\nUse the shared browser\.\n\n### Step: Amazon\n\nAudit Amazon\.\n\n### Step: Flipkart\n\nAudit Flipkart\.\n$/,
    );
    expect(jobs[0]).toMatchObject({
      skills: ['ads-audit', 'amazon-ads', 'flipkart-ads'],
      steps: [{ name: 'Amazon', timeoutMinutes: 40 }, { name: 'Flipkart' }],
    });
    expect(jobs[1]?.skills).toEqual(['credit-watch']);
    expect(skill(dir, 'credit-watch')).toMatch(/\n\nCheck credits\.\n$/);
  });

  it('moves a gate script into the job section, before its instructions', () => {
    const dir = repo({ scout: '# Scout\n' });
    const { moved, jobs } = move(dir, {
      jobs: [
        {
          id: 'scout-job',
          name: 'Scout',
          skills: ['scout'],
          preScript: '.tara/scripts/gate.py',
          prompt: 'Vet the leads above.',
        },
      ],
    });
    expect(moved).toEqual(['scout-job: instructions + script → .claude/skills/scout/SKILL.md']);
    const md = skill(dir, 'scout');
    expect(md).toContain(
      '"Above", "the script output" and "the gate output" mean what the script under "Before you start" printed',
    );
    expect(md).toMatch(
      /### Before you start\n\nRun `python3 \.tara\/scripts\/gate\.py` from the repo root[\s\S]*Reply with exactly `\[SILENT\]` and stop\.[\s\S]*\n\nVet the leads above\.\n$/,
    );
    expect(jobs[0]).not.toHaveProperty('preScript');
  });

  it("adds the script to a section moved earlier, and turns a script-only job into one that posts the script's output", () => {
    const old = `"Above" means the run's prompt: the pre-run script's output and any approved items.`;
    const dir = repo({
      labels: `# Labels\n\n## Job: \`labels\`\n\nInstructions for the tara job \`labels\` (Labels). ${old}\n\nA pre-run script has already run this job in the automations server; its output is above. On STATUS: OK reply with SUMMARY.\n\n## Notes\n\nThe pre-run script is fine.\n`,
      other: `# Other\n\n## Job: \`other\`\n\nInstructions for the tara job \`other\` (Other). ${old}\n\nDo it.\n`,
    });
    const { moved, jobs } = move(dir, {
      jobs: [
        { id: 'labels', name: 'Labels', skills: ['labels'], preScript: '.tara/scripts/labels.sh' },
        { id: 'other', name: 'Other', skills: ['other'] },
        { id: 'backup', name: 'Backup', agent: false, preScript: 'bin/backup' },
      ],
    });
    expect(moved).toEqual([
      'labels: script → .claude/skills/labels/SKILL.md',
      'backup: script → .claude/skills/backup/SKILL.md (new skill)',
    ]);
    expect(skill(dir, 'labels')).toMatch(
      /Instructions for the tara job `labels` \(Labels\)\. "Above", "the script output"[^\n]*\n\n### Before you start\n\nRun `bash \.tara\/scripts\/labels\.sh`[\s\S]*\n\nThe script under "Before you start" runs this job in the automations server; its output is above\. On STATUS: OK reply with SUMMARY\.\n\n## Notes\n\nThe pre-run script is fine\.\n$/,
    );
    expect(skill(dir, 'other')).toContain(`(Other). ${PLAIN}\n\nDo it.`);
    expect(skill(dir, 'backup')).toMatch(
      /Run `\.\/bin\/backup`[\s\S]*This job is the script: reply with a one-line headline/,
    );
    expect(jobs.map((j) => j.skills)).toEqual([['labels'], ['other'], ['backup']]);
  });

  it('refuses to add a section twice', () => {
    const dir = repo({ s: '# S\n\n## Job: `j`\n\nOld.\n' });
    expect(() =>
      planPromptMove(dir, { jobs: [{ id: 'j', name: 'J', skills: ['s'], prompt: 'New.' }] }),
    ).toThrow(/already has a "## Job: `j`" section/);
    expect(existsSync(path.join(dir, '.tara/jobs.json'))).toBe(false);
  });
});
