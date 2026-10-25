import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import { jobDataDir, scratchRoot, sessionScratch, sweepScratch } from '../src/runner/workspace.js';

function project(overrides: Partial<Project['config']> = {}): Project {
  return {
    dir: mkdtempSync(path.join(tmpdir(), 'tara-ws-repo-')),
    config: {
      name: 'shop',
      slackChannel: 'C1',
      permissionMode: 'default',
      chatModel: 'sonnet',
      allowedTools: [],
      allowedUsers: [],
      billing: 'subscription',
      selfImprove: true,
      ...overrides,
    },
  };
}

const DAY = 86_400_000;

describe('workspace', () => {
  it('gives each session its own scratch folder and reuses it on later turns', () => {
    const state = mkdtempSync(path.join(tmpdir(), 'tara-ws-state-'));
    const p = project();
    const dir = sessionScratch(p, state, 'chat', '1234567890abcdef');
    expect(dir).toBe(path.join(state, 'scratch', 'shop', 'chat-12345678'));
    expect(existsSync(path.join(dir, '.tara-scratch'))).toBe(true);
    expect(sessionScratch(p, state, 'chat', '1234567890abcdef')).toBe(dir);
    expect(sessionScratch(p, state, 'sla', 'abcdef1234567890')).not.toBe(dir);
  });

  it('puts folders inside the repo when scratchDir and jobDataDir are set', () => {
    const p = project({ scratchDir: '.scratch', jobDataDir: '.agents/state/jobs' });
    expect(scratchRoot(p, '/state')).toBe(path.join(p.dir, '.scratch'));
    expect(jobDataDir(p, '/state', 'sla')).toBe(path.join(p.dir, '.agents/state/jobs/sla'));
    expect(existsSync(path.join(p.dir, '.agents/state/jobs/sla'))).toBe(true);
  });

  it('deletes only its own folders, and only after they went unused for scratchDays', () => {
    const state = mkdtempSync(path.join(tmpdir(), 'tara-ws-state-'));
    const p = project({ scratchDir: '.scratch' });
    const now = Date.now();
    const old = sessionScratch(p, state, 'sla', 'old00000');
    const fresh = sessionScratch(p, state, 'chat', 'fresh000');
    const then = new Date(now - 4 * DAY);
    utimesSync(path.join(old, '.tara-scratch'), then, then);
    // Not made by tara-agent: no marker.
    const mine = path.join(p.dir, '.scratch', 'my-notes');
    mkdirSync(mine);
    writeFileSync(path.join(p.dir, '.scratch', 'loose.txt'), 'x');

    expect(sweepScratch([p], state, 3, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(path.join(p.dir, '.scratch', 'loose.txt'))).toBe(true);
    // A project without a scratch folder yet is fine.
    expect(sweepScratch([project()], state, 3, now)).toBe(0);
  });
});
