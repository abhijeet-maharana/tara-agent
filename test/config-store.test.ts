import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadHostConfig, loadJobs, loadProject, loadProjects } from '../src/config/load.js';
import { Store } from '../src/store/store.js';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'tara-test-'));
}

function makeProject(config: object, files: Record<string, string> = {}): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, '.tara'));
  writeFileSync(path.join(dir, '.tara', 'config.json'), JSON.stringify(config));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

describe('loadHostConfig', () => {
  it('applies defaults and expands ~', () => {
    const file = path.join(tempDir(), 'config.yaml');
    writeFileSync(file, 'projects:\n  - ~/Projects/a\n  - /srv/b\n');
    const host = loadHostConfig(file);
    expect(host.projects).toEqual([path.join(homedir(), 'Projects/a'), '/srv/b']);
    expect(host.concurrency).toBe(2);
    expect(host.claude).toEqual({ bin: 'claude', chatTimeoutMinutes: 20 });
    expect(host.stateDir).toBe(path.join(homedir(), '.local/state/tara-agent'));
  });

  it('lists every invalid field', () => {
    const file = path.join(tempDir(), 'config.yaml');
    writeFileSync(file, 'projects: []\nconcurrency: 0\n');
    expect(() => loadHostConfig(file)).toThrow(/projects[\s\S]*concurrency/);
  });

  it('explains a missing file', () => {
    expect(() => loadHostConfig('/nonexistent/config.yaml')).toThrow(/Cannot read host config/);
  });
});

describe('loadProject', () => {
  it('reads config with defaults and the system prompt file', () => {
    const dir = makeProject(
      { name: 'shop', slackChannel: 'C0123ABC', systemPromptFile: 'prompt.md' },
      { 'prompt.md': 'Be nice.' },
    );
    const project = loadProject(dir);
    expect(project.config).toMatchObject({
      name: 'shop',
      permissionMode: 'default',
      chatModel: 'sonnet',
      billing: 'subscription',
      allowedTools: [],
      allowedUsers: [],
      selfImprove: true,
    });
    expect(project.systemPrompt).toBe('Be nice.');
  });

  it('rejects a bad channel id and name', () => {
    const dir = makeProject({ name: 'Shop!', slackChannel: '#general' });
    expect(() => loadProject(dir)).toThrow(/name[\s\S]*slackChannel/);
  });

  it('rejects duplicate channels across projects', () => {
    const a = makeProject({ name: 'a', slackChannel: 'C1' });
    const b = makeProject({ name: 'b', slackChannel: 'C1' });
    const host = loadHostConfig(
      (() => {
        const f = path.join(tempDir(), 'c.yaml');
        writeFileSync(f, `projects:\n  - ${a}\n  - ${b}\n`);
        return f;
      })(),
    );
    expect(() => loadProjects(host)).toThrow(/same slackChannel/);
  });
});

describe('loadJobs', () => {
  it('uses the file tz unless a job sets its own', () => {
    const dir = makeProject({ name: 'shop', slackChannel: 'C0123ABC' });
    writeFileSync(
      path.join(dir, '.tara', 'jobs.json'),
      JSON.stringify({
        tz: 'Asia/Kolkata',
        jobs: [
          { id: 'a', name: 'A', cron: '0 9 * * *', prompt: 'a', durationMinutes: 5 },
          { id: 'b', name: 'B', cron: '0 9 * * *', prompt: 'b', tz: 'UTC' },
        ],
      }),
    );
    const [a, b] = loadJobs(loadProject(dir));
    expect(a?.job).toMatchObject({ tz: 'Asia/Kolkata', durationMinutes: 5 });
    expect(b?.job.tz).toBe('UTC');
  });
});

describe('Store', () => {
  it('saves, updates and deletes sessions', () => {
    const store = new Store(':memory:');
    store.saveSession({ threadKey: 'C1:1', project: 'p', sessionId: 's1', model: 'sonnet', started: false });
    store.saveSession({ threadKey: 'C1:1', project: 'p', sessionId: 's1', model: 'opus', started: true });
    expect(store.getSession('C1:1')).toEqual({
      threadKey: 'C1:1',
      project: 'p',
      sessionId: 's1',
      model: 'opus',
      started: true,
    });
    store.deleteSession('C1:1');
    expect(store.getSession('C1:1')).toBeUndefined();
  });

  it('records runs and survives reopening the file', () => {
    const file = path.join(tempDir(), 'state', 'tara.db');
    const store = new Store(file);
    store.recordRun({
      kind: 'chat',
      project: 'p',
      startedAt: 1000,
      endedAt: 2000,
      status: 'ok',
      inputTokens: 5,
      rateLimitUtilization: 0.1,
    });
    store.close();
    const reopened = new Store(file);
    expect(reopened.runsSince(0)).toEqual([
      expect.objectContaining({ kind: 'chat', status: 'ok', inputTokens: 5, rateLimitUtilization: 0.1 }),
    ]);
    expect(reopened.runsSince(1500)).toEqual([]);
    reopened.close();
  });
});
