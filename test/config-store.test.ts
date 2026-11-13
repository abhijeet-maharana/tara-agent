import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { loadHostConfig, loadJobs, loadProject, loadProjects } from '../src/config/load.js';
import { projectConfigSchema, queueSchema } from '../src/config/schema.js';
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
    expect(host.concurrency).toBe(8);
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
      selfImprove: 'always',
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

describe('selfImprove', () => {
  it('defaults to always and takes only the named modes', () => {
    const parse = (v?: unknown) =>
      projectConfigSchema.parse({ name: 'shop', slackChannel: 'C0123ABC', selfImprove: v }).selfImprove;
    expect(parse()).toBe('always');
    expect(parse('trouble')).toBe('trouble');
    expect(() => parse(true)).toThrow();
    expect(() => parse('sometimes')).toThrow();
  });
});

describe('queueSchema', () => {
  it('refuses a bad slot or timezone when the file loads, not when it first fires', () => {
    const base = { executor: { job: 'post' } };
    expect(queueSchema.safeParse({ ...base, slots: '0 9 * * *', tz: 'Asia/Kolkata' }).success).toBe(true);
    expect(queueSchema.safeParse({ ...base, slots: '0 99 * * *' }).success).toBe(false);
    expect(queueSchema.safeParse({ ...base, slots: '0 9 * * *', tz: 'Mars/Olympus' }).success).toBe(false);
  });

  it('takes a skill as its executor: the job named after it', () => {
    const q = queueSchema.parse({ executor: { skill: 'post-publisher' } });
    expect(q.executor).toEqual({ job: 'post-publisher' });
  });
});

describe('loadJobs', () => {
  it('reads a job as its one skill: the id, the name (from words) and no locks', () => {
    const dir = makeProject({
      name: 'shop',
      slackChannel: 'C0123ABC',
      words: { linkedin: 'LinkedIn', sla: 'SLA' },
    });
    writeFileSync(
      path.join(dir, '.tara', 'jobs.json'),
      JSON.stringify({
        defaults: { model: 'opus', locks: ['chrome'] },
        jobs: [
          { skill: 'linkedin-job-scout', cron: '0 9 * * *' },
          { skill: 'pickup-sla-check', model: 'haiku' },
          { id: 'old', name: 'Old Style', skills: ['old', 'humanizer'] },
        ],
      }),
    );
    const [a, b, c] = loadJobs(loadProject(dir));
    expect(a?.job).toMatchObject({
      id: 'linkedin-job-scout',
      name: 'LinkedIn Job Scout',
      skills: ['linkedin-job-scout'],
      locks: [],
      model: 'opus',
      cron: '0 9 * * *',
    });
    expect(b?.job).toMatchObject({ id: 'pickup-sla-check', name: 'Pickup SLA Check', model: 'haiku' });
    expect(c?.job).toMatchObject({ id: 'old', name: 'Old Style', locks: ['chrome'] });
  });

  it('refuses id, name, skills or locks next to skill, and a skill scheduled twice', () => {
    const dir = makeProject({ name: 'shop', slackChannel: 'C0123ABC' });
    const file = path.join(dir, '.tara', 'jobs.json');
    writeFileSync(file, JSON.stringify({ jobs: [{ skill: 'a', name: 'A' }] }));
    expect(() => loadJobs(loadProject(dir))).toThrow(/jobs\.0\.name: a job with "skill" has no "name"/);
    writeFileSync(file, JSON.stringify({ jobs: [{ skill: 'a', locks: [] }] }));
    expect(() => loadJobs(loadProject(dir))).toThrow(/no "locks"/);
    writeFileSync(file, JSON.stringify({ jobs: [{ skill: 'a' }, { skill: 'a', cron: '0 9 * * *' }] }));
    expect(() => loadJobs(loadProject(dir))).toThrow(/duplicate job id "a"/);
  });

  it('uses the file tz unless a job sets its own', () => {
    const dir = makeProject({ name: 'shop', slackChannel: 'C0123ABC' });
    writeFileSync(
      path.join(dir, '.tara', 'jobs.json'),
      JSON.stringify({
        tz: 'Asia/Kolkata',
        jobs: [
          { id: 'a', name: 'A', cron: '0 9 * * *', skills: ['a'], durationMinutes: 5 },
          { id: 'b', name: 'B', cron: '0 9 * * *', skills: ['b'], tz: 'UTC' },
        ],
      }),
    );
    const [a, b] = loadJobs(loadProject(dir));
    expect(a?.job).toMatchObject({ tz: 'Asia/Kolkata', durationMinutes: 5 });
    expect(b?.job.tz).toBe('UTC');
  });

  it("gives every job the file's defaults unless it sets its own", () => {
    const dir = makeProject({ name: 'shop', slackChannel: 'C0123ABC' });
    writeFileSync(
      path.join(dir, '.tara', 'jobs.json'),
      JSON.stringify({
        defaults: { model: 'opus', locks: ['chrome'], timeoutMinutes: 40 },
        jobs: [
          { id: 'a', name: 'A', skills: ['a'] },
          { id: 'b', name: 'B', skills: ['b'], model: 'haiku', locks: [], timeoutMinutes: 5 },
        ],
      }),
    );
    const [a, b] = loadJobs(loadProject(dir));
    expect(a?.job).toMatchObject({ model: 'opus', locks: ['chrome'], timeoutMinutes: 40, harness: 'claude' });
    expect(b?.job).toMatchObject({ model: 'haiku', locks: [], timeoutMinutes: 5 });
  });

  it('refuses an unknown default, and points a bad job at its index', () => {
    const dir = makeProject({ name: 'shop', slackChannel: 'C0123ABC' });
    const file = path.join(dir, '.tara', 'jobs.json');
    writeFileSync(file, JSON.stringify({ defaults: { modle: 'opus' }, jobs: [] }));
    expect(() => loadJobs(loadProject(dir))).toThrow(/modle/);
    writeFileSync(
      file,
      JSON.stringify({ defaults: { timeoutMinutes: -1 }, jobs: [{ id: 'a', name: 'A', skills: ['a'] }] }),
    );
    expect(() => loadJobs(loadProject(dir))).toThrow(/timeoutMinutes/);
    writeFileSync(file, JSON.stringify({ jobs: [{ id: 'Bad Id', name: 'A', skills: ['a'] }] }));
    expect(() => loadJobs(loadProject(dir))).toThrow(/jobs\.0\.id|jobs\[0\]|0\.id/);
  });
});

describe('Store', () => {
  it("stores each run's own cost, though the CLI reports the session's running total", () => {
    const store = new Store(':memory:');
    const run = (sessionId: string | undefined, costUsd: number | undefined, at: number) =>
      store.recordRun({
        kind: 'chat',
        project: 'p',
        sessionId,
        startedAt: at,
        endedAt: at,
        status: 'ok',
        costUsd,
      });
    run('s1', 0.4, 1);
    run('s1', 1.0, 2); // a second turn: total 1.00, this turn 0.60
    run('s1', 1.1, 3); // a learning turn
    run('s2', 0.5, 4);
    run('s1', 0.2, 5); // a total that started over is kept as it is
    run(undefined, 0.3, 6);
    expect(store.runsSince(0).map((r) => Number(r.costUsd?.toFixed(2)))).toEqual([
      0.4, 0.6, 0.1, 0.5, 0.2, 0.3,
    ]);
  });

  it('turns stored running totals into per-run costs when it upgrades', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'tara-db-')), 'tara.db');
    new Store(file).close();
    const db = new DatabaseSync(file);
    const { user_version: v } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    // The database as it was before the upgrade: totals in cost_usd, no session_cost_usd.
    // (four migrations back: the cost one, day_threads, the health tables, then samples and logs)
    db.exec(
      `DROP TABLE log_events; DROP TABLE host_samples; DROP TABLE health_events; DROP TABLE health_state;
       DROP TABLE day_threads; ALTER TABLE runs DROP COLUMN session_cost_usd; PRAGMA user_version = ${v - 4};`,
    );
    const add = db.prepare(
      `INSERT INTO runs (kind, project, session_id, started_at, ended_at, status, cost_usd) VALUES ('chat', 'p', ?, ?, ?, 'ok', ?)`,
    );
    for (const [sid, at, cost] of [
      ['s1', 1, 0.4],
      ['s1', 2, 1.0],
      ['s2', 3, 0.5],
      ['s1', 4, 1.5],
    ] as const)
      add.run(sid, at, at, cost);
    db.close();
    const store = new Store(file);
    expect(store.runsSince(0).map((r) => Number(r.costUsd?.toFixed(2)))).toEqual([0.4, 0.6, 0.5, 0.5]);
    // New runs continue from the stored totals.
    store.recordRun({
      kind: 'chat',
      project: 'p',
      sessionId: 's1',
      startedAt: 5,
      endedAt: 5,
      status: 'ok',
      costUsd: 1.75,
    });
    expect(Number(store.runsSince(5)[0]?.costUsd?.toFixed(2))).toBe(0.25);
    store.close();
  });

  it('prunes old runs, claims and sessions, but keeps the latest run of each job', () => {
    let now = 1;
    const store = new Store(':memory:', () => now);
    const run = (o: Partial<Parameters<Store['recordRun']>[0]>, at: number) =>
      store.recordRun({ kind: 'chat', project: 'p', startedAt: at, endedAt: at, status: 'ok', ...o });
    run({ sessionId: 's1', threadKey: 't1' }, 1);
    run({ kind: 'job', jobId: 'monthly', sessionId: 's2' }, 3); // an older run of the job
    run({ kind: 'job', jobId: 'monthly', sessionId: 's3' }, 4); // its latest: kept
    run({ sessionId: 's4', threadKey: 't4' }, 200); // recent
    store.saveSession({ threadKey: 't1', project: 'p', sessionId: 's1', model: 'opus', started: true });
    now = 200;
    store.saveSession({ threadKey: 't4', project: 'p', sessionId: 's4', model: 'opus', started: true });
    store.claimSlot('p:monthly', 10);
    store.claimSlot('p:monthly', 300);

    expect(store.prune(100)).toEqual({ runs: 2, claims: 1, sessions: 1 });
    expect(store.runsSince(0).map((r) => r.startedAt)).toEqual([4, 200]);
    expect(store.jobRuns('p', 'monthly', 5).map((r) => r.startedAt)).toEqual([4]);
    expect(store.getSession('t1')).toBeUndefined();
    expect(store.getSession('t4')?.sessionId).toBe('s4');
    expect(store.claimSlot('p:monthly', 300)).toBe(false);
  });

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
      harness: 'claude',
    });
    // A session started by an agy job keeps its harness, so later turns stay on agy.
    store.saveSession({
      threadKey: 'C1:2',
      project: 'p',
      sessionId: 'c1',
      model: 'gemini',
      started: true,
      harness: 'agy',
    });
    expect(store.getSession('C1:2')?.harness).toBe('agy');
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

describe('Store.renameJobs', () => {
  it('moves run history, cards and slot claims to the new job id, in that project only', () => {
    const store = new Store(path.join(tempDir(), 'tara.db'));
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare(
      `INSERT INTO runs (kind, project, job_id, status, started_at, ended_at) VALUES ('job', 'shop', 'old-job', 'ok', 1, 2), ('job', 'other', 'old-job', 'ok', 1, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO items (id, project, kind, mode, title, options, status, source, job_id, created_at, updated_at)
       VALUES ('i1', 'shop', 'decision', 'resume', 'T', '[]', 'pending', 'old-job', 'old-job', 1, 1)`,
    ).run();
    expect(store.claimSlot('shop:old-job', 100)).toBe(true);
    const changed = store.renameJobs('shop', { 'old-job': 'new-skill' });
    expect(changed).toBe(4);
    expect(store.getItem('i1')).toMatchObject({ jobId: 'new-skill', source: 'new-skill' });
    const runs = db.prepare('SELECT project, job_id FROM runs ORDER BY project').all();
    expect(runs).toEqual([
      { project: 'other', job_id: 'old-job' },
      { project: 'shop', job_id: 'new-skill' },
    ]);
    expect(store.claimSlot('shop:new-skill', 100)).toBe(false); // already claimed, under its new key
  });
});
