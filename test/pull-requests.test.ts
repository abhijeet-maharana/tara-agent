import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockedPath, branchName, PullRequests } from '../src/github/pull-requests.js';
import { buildChildEnv } from '../src/runner/env.js';

const silent = { info() {}, warn() {}, error() {} };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

/** A bare repo standing in for GitHub, with one commit on main. */
function origin() {
  const root = mkdtempSync(path.join(tmpdir(), 'tara-pr-test-'));
  const bare = path.join(root, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  const seed = path.join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(seed, 'README.md'), 'hello\n');
  mkdirSync(path.join(seed, 'src'));
  writeFileSync(path.join(seed, 'src', 'a.ts'), 'export const a = 1;\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'init');
  git(seed, 'push', '--quiet', bare, 'main');
  return { root, bare };
}

function setup() {
  const { root, bare } = origin();
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const open: Array<{ html_url: string; number: number }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    if (init?.method === 'POST') {
      const pr = { html_url: 'https://github.com/o/r/pull/7', number: 7 };
      open.push(pr);
      return new Response(JSON.stringify(pr), { status: 201 });
    }
    return new Response(JSON.stringify(open), { status: 200 });
  }) as typeof fetch;
  const prs = new PullRequests({
    repos: [{ project: 'shop', repo: 'o/r' }],
    token: 'secret-token',
    agentName: 'Jarvis',
    stateDir: path.join(root, 'state'),
    workRoot: root,
    log: silent,
    remoteUrl: () => bare,
    fetch: fakeFetch,
  });
  return { root, bare, prs, calls };
}

describe('branch names and paths', () => {
  it('puts every branch under the agent name', () => {
    expect(branchName('Jarvis', 'fix-otp')).toBe('jarvis/fix-otp');
    expect(branchName('Jarvis', 'jarvis/fix-otp')).toBe('jarvis/fix-otp');
    expect(branchName('Jarvis', 'main')).toBe('jarvis/main');
    expect(() => branchName('Jarvis', 'a/b')).toThrow();
    expect(() => branchName('Jarvis', '../x')).toThrow();
  });

  it('refuses secrets and CI files', () => {
    expect(blockedPath('.github/workflows/x.yml')).toBeDefined();
    expect(blockedPath('apps/api/.env')).toBeDefined();
    expect(blockedPath('.env.production')).toBeDefined();
    expect(blockedPath('certs/server.pem')).toBeDefined();
    expect(blockedPath('apps/api/src/env.ts')).toBeUndefined();
    expect(blockedPath('docs/environment.md')).toBeUndefined();
  });

  it('never hands the token to a run', () => {
    const env = buildChildEnv(
      { TARA_GITHUB_TOKEN: 'x', GH_TOKEN: 'y', GITHUB_TOKEN: 'z', PATH: '/bin' },
      'subscription',
    );
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('PullRequests', () => {
  it('opens a PR from a workspace and pushes only the agent branch', async () => {
    const { root, bare, prs, calls } = setup();
    try {
      const ws = await prs.start('shop', 'fix-a');
      expect(ws).toMatchObject({ branch: 'jarvis/fix-a', base: 'main', existing: false });
      expect(readFileSync(path.join(ws.dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');

      writeFileSync(path.join(ws.dir, 'src', 'a.ts'), 'export const a = 2;\n');
      writeFileSync(path.join(ws.dir, 'src', 'b.ts'), 'export const b = 1;\n');
      const pr = await prs.open('shop', { branch: 'fix-a', title: 'fix: bump a', body: 'Why' });

      expect(pr).toMatchObject({
        url: 'https://github.com/o/r/pull/7',
        branch: 'jarvis/fix-a',
        updated: false,
      });
      expect(pr.files.sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(git(bare, 'show', 'jarvis/fix-a:src/a.ts')).toBe('export const a = 2;');
      expect(git(bare, 'log', '-1', '--format=%an %s', 'jarvis/fix-a')).toBe('Jarvis fix: bump a');
      expect(git(bare, 'show', 'main:src/a.ts')).toBe('export const a = 1;');
      const create = calls.find((c) => c.method === 'POST');
      expect(create?.body).toMatchObject({ head: 'jarvis/fix-a', base: 'main', title: 'fix: bump a' });
      expect(existsSync(ws.dir)).toBe(false);

      // A follow-up starts from the branch and adds a commit to the same PR.
      const again = await prs.start('shop', 'fix-a');
      expect(again.existing).toBe(true);
      expect(readFileSync(path.join(again.dir, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
      writeFileSync(path.join(again.dir, 'src', 'b.ts'), 'export const b = 2;\n');
      const second = await prs.open('shop', { branch: 'fix-a', title: 'fix: bump b' });
      expect(second).toMatchObject({ updated: true, files: ['src/b.ts'] });
      expect(git(bare, 'rev-list', '--count', 'jarvis/fix-a')).toBe('3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses blocked files, empty changes and unknown projects', async () => {
    const { root, bare, prs } = setup();
    try {
      await expect(prs.start('other', 'x-y')).rejects.toThrow(/not set up/);
      const ws = await prs.start('shop', 'ci');
      await expect(prs.open('shop', { branch: 'ci', title: 'nothing' })).rejects.toThrow(/Nothing changed/);
      mkdirSync(path.join(ws.dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(path.join(ws.dir, '.github', 'workflows', 'x.yml'), 'on: push\n');
      await expect(prs.open('shop', { branch: 'ci', title: 'add ci' })).rejects.toThrow(/\.github/);
      expect(() => git(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/jarvis/ci')).toThrow();
      await expect(prs.open('shop', { branch: 'never-started', title: 'x' })).rejects.toThrow(
        /start_pull_request/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
