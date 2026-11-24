import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import { doctor, formatDoctor, sharedSkills } from '../src/doctor.js';
import { testHost } from './fakes.js';

/** A host whose dashboard is on, so doctor asks the running tara-agent. */
const host = () => ({ ...testHost(), http: { ...testHost().http, enabled: true } });

function project(skills: Record<string, string>): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-doctor-'));
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(path.join(dir, '.claude', 'skills', name), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'skills', name, 'SKILL.md'), text);
  }
  return { dir, config: { name: 'shop', slackChannel: 'C1' } } as unknown as Project;
}

const json = (body: object, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('doctor', () => {
  it('lists config, skills, required services and the live health checks, red first', async () => {
    const p = project({ report: '# Report\n\n## Job\n\nDo it.', notes: '# Notes only' });
    const lines = await doctor({
      host: host(),
      projects: [p],
      jobs: () => [
        {
          job: {
            id: 'report',
            skills: ['report'],
            enabled: true,
            requires: ['http://x/up', 'http://x/down'],
          },
        },
        { job: { id: 'notes', skills: ['notes'], enabled: true } },
        { job: { id: 'gone', skills: ['missing'], enabled: true } },
        { job: { id: 'off', skills: ['missing'], enabled: false } },
      ],
      probe: async (u) => u.endsWith('/up'),
      fetch: json({
        checks: [
          { status: 'ok', group: 'Jarvis', name: 'Slack', detail: 'Connected' },
          { status: 'warn', group: 'Jobs', name: 'Report', detail: 'Failed its last run' },
          { status: 'bad', group: 'Jarvis', name: 'Disk', detail: '95% used' },
        ],
      }),
    });
    const { text, code } = formatDoctor(lines);
    expect(code).toBe(1);
    expect(text).toContain('✗ shop: notes: skill "notes" has no "## Job" section');
    expect(text).toContain('✗ shop: gone: skill "missing" not found');
    expect(text).not.toContain('off:');
    expect(text).toContain('✓ services: http://x/up answers (shop/report)');
    expect(text).toContain('✗ services: http://x/down NOT answering (shop/report)');
    expect(text).toContain('1 of 3 health checks fine');
    expect(text.indexOf('✗ Jarvis: Disk')).toBeLessThan(text.indexOf('⚠ Jobs: Report'));
    expect(text).toMatch(/4 problems, 1 to look at$/);
  });

  it('is all fine with good skills and a healthy agent, and red when the agent is down', async () => {
    const p = project({ report: '## Job\n\nDo it.' });
    const base = {
      host: host(),
      projects: [p],
      jobs: () => [{ job: { id: 'report', skills: ['report'], enabled: true } }],
    };
    const good = formatDoctor(await doctor({ ...base, fetch: json({ checks: [] }) }));
    expect(good).toMatchObject({ code: 0 });
    expect(good.text).toMatch(/All fine\.$/);
    const down = formatDoctor(
      await doctor({
        ...base,
        fetch: (async () => {
          throw new Error('connect ECONNREFUSED');
        }) as unknown as typeof fetch,
      }),
    );
    expect(down.code).toBe(1);
    expect(down.text).toContain('tara-agent is not answering');
  });

  it('checks that a shared skill is the same in every project, apart from its own files', () => {
    const copy = (name: string, skill: string, voice: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'tara-shared-'));
      const s = path.join(dir, '.claude', 'skills', 'humanizer');
      mkdirSync(path.join(s, 'scripts'), { recursive: true });
      writeFileSync(path.join(s, 'SKILL.md'), skill);
      writeFileSync(path.join(s, 'scripts', 'slop.json'), '[]');
      writeFileSync(path.join(s, 'voice-samples.md'), voice);
      writeFileSync(path.join(s, 'SHARED'), 'Shared skill. Per-project files:\nvoice-samples.md\n');
      return { dir, config: { name } } as unknown as Project;
    };
    const same = sharedSkills([copy('a', '# H', 'voice A'), copy('b', '# H', 'voice B')]);
    expect(same).toEqual([
      { mark: 'ok', area: 'skills', text: 'shared skill "humanizer" is the same in a, b' },
    ]);
    const drift = sharedSkills([copy('a', '# H', 'x'), copy('b', '# H, edited', 'x')]);
    expect(drift[0]).toMatchObject({
      mark: 'warn',
      text: expect.stringContaining('differs between a, b: SKILL.md'),
    });
    // A skill without SHARED is the project's own, whatever its name.
    expect(sharedSkills([project({ notes: '# N' })])).toEqual([]);
  });
});
