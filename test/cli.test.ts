import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const cli = (...args: string[]) =>
  run(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), ...args], {
    encoding: 'utf8',
  }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );

function project(name: string, config: string, jobs?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `tara-cli-${name}-`));
  mkdirSync(path.join(dir, '.tara'));
  writeFileSync(path.join(dir, '.tara', 'config.json'), config);
  if (jobs) writeFileSync(path.join(dir, '.tara', 'jobs.json'), jobs);
  return dir;
}

describe('tara-agent validate', () => {
  it('checks host, project and job config, and fails on the first broken one', async () => {
    const shop = project(
      'shop',
      JSON.stringify({ name: 'shop', slackChannel: 'C1' }),
      JSON.stringify({ jobs: [{ id: 'sla', name: 'SLA', cron: '0 9 * * *', skills: ['sla'] }] }),
    );
    const host = path.join(mkdtempSync(path.join(tmpdir(), 'tara-cli-host-')), 'config.yaml');
    writeFileSync(host, `projects:\n  - ${shop}\n`);
    const good = await cli('validate', '--config', host);
    expect(good.code).toBe(0);
    expect(good.out).toContain('✓ shop');
    expect(good.out).toContain('1/1 jobs enabled');

    const broken = project('blog', '{ not json');
    writeFileSync(host, `projects:\n  - ${shop}\n  - ${broken}\n`);
    const bad = await cli('validate', '--config', host);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('Invalid JSON');
  }, 30_000);
});
