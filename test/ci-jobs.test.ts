import { describe, expect, it } from 'vitest';
import { CiJobs, cleanLine, parseJobRef } from '../src/github/actions.js';

const silent = { info() {}, warn() {}, error() {} };
const TOKEN = 'secret-token';
const BLOB = 'https://productionresultssa0.blob.core.windows.net/logs/job-42.txt?sig=abc';

const job = {
  id: 42,
  name: 'test',
  workflow_name: 'CI',
  head_branch: 'jarvis/fix-a',
  head_sha: '0123456789abcdef0123456789abcdef01234567',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/o/r/actions/runs/7/job/42',
  steps: [
    { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
    { number: 4, name: 'Run tests', status: 'completed', conclusion: 'failure' },
    { number: 5, name: 'Upload', status: 'completed', conclusion: 'skipped' },
  ],
};

function log(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 1000; i++) {
    const text =
      i === 100
        ? `\x1b[31m##[error]src/a.test.ts: expected 1 to be 2\x1b[0m`
        : i === 1000
          ? '##[error]Process completed with exit code 1.'
          : `\x1b[36mline ${i}\x1b[0m`;
    lines.push(`2026-11-04T10:00:00.1234567Z ${text}\r`);
  }
  return `﻿${lines.join('\n')}\n`;
}

function setup(over: { logs?: () => Response; job?: () => Response } = {}) {
  const calls: Array<{ url: string; auth?: string; method?: string; redirect?: string }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.authorization, method: init?.method, redirect: init?.redirect });
    if (url === 'https://api.github.com/repos/o/r/actions/jobs/42')
      return over.job?.() ?? new Response(JSON.stringify(job), { status: 200 });
    if (url === 'https://api.github.com/repos/o/r/actions/jobs/42/logs')
      return over.logs?.() ?? new Response(null, { status: 302, headers: { location: BLOB } });
    if (url === BLOB) return new Response(log(), { status: 200 });
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof fetch;
  const ci = new CiJobs({
    repos: [{ project: 'shop', repo: 'o/r' }],
    token: TOKEN,
    log: silent,
    fetch: fakeFetch,
  });
  return { ci, calls };
}

describe('job references', () => {
  it('accepts job ids and job URLs', () => {
    expect(parseJobRef('42')).toEqual({ id: '42' });
    expect(parseJobRef('https://github.com/o/r/actions/runs/7/job/42')).toEqual({ repo: 'o/r', id: '42' });
    expect(parseJobRef('https://github.com/o/r/actions/runs/7/job/42?pr=3#step:4:12')).toEqual({
      repo: 'o/r',
      id: '42',
    });
    expect(parseJobRef('https://github.com/o/r/runs/42')).toEqual({ repo: 'o/r', id: '42' });
    expect(parseJobRef('https://api.github.com/repos/o/r/actions/jobs/42')).toEqual({
      repo: 'o/r',
      id: '42',
    });
  });

  it('refuses anything else', () => {
    expect(() => parseJobRef('https://github.com/o/r/actions/runs/7')).toThrow(/workflow run, not a job/);
    expect(() => parseJobRef('https://evil.example/o/r/actions/runs/7/job/42')).toThrow();
    expect(() => parseJobRef('42; rm -rf /')).toThrow();
    expect(() => parseJobRef('../../42')).toThrow();
  });

  it('strips timestamps and ANSI codes', () => {
    expect(cleanLine('2026-11-04T10:00:00.1234567Z \x1b[1;31mboom\x1b[0m\r')).toBe('boom');
    expect(cleanLine('﻿2026-11-04T10:00:00Z plain')).toBe('plain');
  });
});

describe('CiJobs', () => {
  it('reads the job, its failed steps and a log excerpt, sending the token only to the API', async () => {
    const { ci, calls } = setup();
    const r = await ci.read('shop', 'https://github.com/o/r/actions/runs/7/job/42');
    expect(r).toMatchObject({
      id: '42',
      name: 'test',
      workflow: 'CI',
      branch: 'jarvis/fix-a',
      conclusion: 'failure',
      failedSteps: [{ number: 4, name: 'Run tests', conclusion: 'failure' }],
      logLines: 1000,
    });
    expect(r.tail).toHaveLength(300);
    expect(r.tail[0]).toBe('line 701');
    expect(r.tail.at(-1)).toBe('##[error]Process completed with exit code 1.');
    expect(r.firstError?.line).toBe(100);
    expect(r.firstError?.lines).toContain('##[error]src/a.test.ts: expected 1 to be 2');
    expect(r.firstError?.lines[0]).toBe('line 70');
    expect(r.firstError?.lines.at(-1)).toBe('line 115');

    expect(calls.every((c) => c.method === 'GET' || c.method === undefined)).toBe(true);
    const api = calls.filter((c) => c.url.startsWith('https://api.github.com/'));
    expect(api.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.find((c) => c.url.includes('/logs'))?.redirect).toBe('manual');
    expect(calls.find((c) => c.url === BLOB)?.auth).toBeUndefined();
  });

  it('accepts a bare job id, and the repo in any case', async () => {
    expect((await setup().ci.read('shop', '42')).id).toBe('42');
    expect((await setup().ci.read('shop', 'https://github.com/O/R/actions/runs/7/job/42')).id).toBe('42');
  });

  it('refuses other repos and projects without a repo', async () => {
    const { ci, calls } = setup();
    await expect(ci.read('shop', 'https://github.com/o/other/actions/runs/7/job/42')).rejects.toThrow(
      /not this project's repo/,
    );
    await expect(ci.read('blog', '42')).rejects.toThrow(/not set up/);
    expect(calls).toHaveLength(0);
  });

  it('says why there is no log', async () => {
    const { ci } = setup({ logs: () => new Response('{}', { status: 410 }) });
    const r = await ci.read('shop', '42');
    expect(r.logMissing).toMatch(/expired/);
    expect(r.tail).toEqual([]);
  });

  it('never puts the token in errors', async () => {
    const { ci } = setup({
      job: () => new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 401 }),
    });
    const err = (await ci.read('shop', '42').catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain(TOKEN);
  });
});
