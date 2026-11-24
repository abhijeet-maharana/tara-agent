import { spawn } from 'node:child_process';
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HEARTBEAT = fileURLToPath(new URL('../deploy/host/tara-heartbeat.mjs', import.meta.url));
const CLEANUP = fileURLToPath(new URL('../deploy/host/tara-cleanup.mjs', import.meta.url));

function run(script: string, env: Record<string, string>, ...args: string[]) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', script, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
/** Ages an entry; a link itself, not its target. */
const daysAgo = (p: string, days: number) => {
  const t = new Date(Date.now() - days * 86_400_000);
  lutimesSync(p, t, t);
};

let server: Server | undefined;
afterEach(() => server?.close());

describe('tara-heartbeat', () => {
  async function setup(uptime = 1000) {
    const dir = tmp('tara-heartbeat-');
    server = createServer((req, res) => res.writeHead(req.url === '/auth' ? 401 : 200).end('ok'));
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    writeFileSync(path.join(dir, 'uptime'), `${uptime}.5 100.0\n`);
    writeFileSync(path.join(dir, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n');
    const status = path.join(dir, 'backup.json');
    writeFileSync(
      status,
      JSON.stringify({ lastGood: { at: new Date(Date.now() - 50 * 3_600_000).toISOString() } }),
    );
    const config = path.join(dir, 'heartbeat.json');
    writeFileSync(
      config,
      JSON.stringify({
        uptimeFile: path.join(dir, 'uptime'),
        meminfoFile: path.join(dir, 'meminfo'),
        stampFile: path.join(dir, 'last'),
        failsFile: path.join(dir, 'fails'),
        statusFile: path.join(dir, 'status'),
        diskPercent: 101,
        http: [
          { name: 'App', url: `http://127.0.0.1:${port}/health` },
          { name: 'Locked', url: `http://127.0.0.1:${port}/auth` },
          { name: 'Gone (1)', url: 'http://127.0.0.1:1/health' },
        ],
        files: [{ name: 'Backup', path: status, jsonTime: 'lastGood.at', maxAgeHours: 30 }],
      }),
    );
    return { dir, config, env: { TARA_HEARTBEAT_CONFIG: config } };
  }

  it('reports a problem only once it failed twice in a row, and clears it when fixed', async () => {
    const { dir, config, env } = await setup();
    const status = () => readFileSync(path.join(dir, 'status'), 'utf8');
    const dryRun = await run(HEARTBEAT, env, '--dry-run');
    expect(dryRun.out).toContain('problem: Gone (1) not answering');
    expect(dryRun.out).toContain('problem: Backup: nothing new for 50h');
    expect(dryRun.out).not.toContain('Locked'); // a 401 still means up
    expect(existsSync(path.join(dir, 'last'))).toBe(false);

    await run(HEARTBEAT, env);
    expect(existsSync(path.join(dir, 'last'))).toBe(true);
    expect(status()).toBe('');
    await run(HEARTBEAT, env);
    expect(status()).toBe('Gone (1) not answering\nBackup: nothing new for 50h\n');

    const c = JSON.parse(readFileSync(config, 'utf8'));
    c.http = c.http.slice(0, 2);
    c.files = [];
    writeFileSync(config, JSON.stringify(c));
    await run(HEARTBEAT, env);
    expect(status()).toBe('');
  });

  it('skips the checks just after boot', async () => {
    const { env } = await setup(60);
    expect((await run(HEARTBEAT, env, '--dry-run')).out).toContain('(just booted: no checks)\nall fine');
  });
});

describe('tara-cleanup', () => {
  function setup() {
    const root = tmp('tara-cleanup-');
    const logs = path.join(root, 'logs');
    const keep = path.join(root, 'logs', 'records');
    const outside = path.join(root, 'outside');
    mkdirSync(keep, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(logs, 'old.png'), 'x'.repeat(2048));
    writeFileSync(path.join(logs, 'new.png'), 'x');
    mkdirSync(path.join(logs, 'old-run'));
    writeFileSync(path.join(logs, 'old-run', 'a.txt'), 'a');
    writeFileSync(path.join(keep, 'ledger.json'), '{}');
    writeFileSync(path.join(outside, 'precious.txt'), 'do not delete');
    symlinkSync(outside, path.join(logs, 'link-to-outside'));
    symlinkSync(path.join(outside, 'precious.txt'), path.join(logs, 'link-to-file'));
    writeFileSync(path.join(root, 'render-bundle-1'), 'r');
    writeFileSync(path.join(root, 'other-1'), 'o');
    for (const p of ['old.png', 'old-run', 'records', 'link-to-outside', 'link-to-file'])
      daysAgo(path.join(logs, p), 40);
    for (const p of ['render-bundle-1', 'other-1']) daysAgo(path.join(root, p), 3);
    const config = path.join(root, 'cleanup.json');
    writeFileSync(
      config,
      JSON.stringify({
        protected: [keep],
        statusFile: path.join(root, 'status', 'status.json'),
        rules: [
          { name: 'Logs', dir: logs, olderThanDays: 30 },
          { name: 'Bundles', dir: root, match: 'render-bundle-*', olderThanDays: 2 },
          { name: 'Missing', dir: path.join(root, 'nope'), olderThanDays: 1 },
        ],
      }),
    );
    return { root, logs, keep, outside, env: { TARA_CLEANUP_CONFIG: config } };
  }

  it('deletes only old, named, unprotected entries, and never follows a link', async () => {
    const { root, logs, keep, outside, env } = setup();
    const dry = await run(CLEANUP, env, '--dry-run');
    expect(JSON.parse(dry.out).rules[0].removed).toBe(4);
    expect(existsSync(path.join(logs, 'old.png'))).toBe(true);

    const res = await run(CLEANUP, env);
    expect(res.code).toBe(0);
    const summary = JSON.parse(res.out);
    expect(summary.rules.map((r: { removed: number }) => r.removed)).toEqual([4, 1, 0]);
    expect(summary.rules[0].skippedProtected).toBe(1);
    expect(summary.rules[2].note).toBe('folder not found');
    for (const gone of ['old.png', 'old-run', 'link-to-outside', 'link-to-file'])
      expect(existsSync(path.join(logs, gone))).toBe(false);
    expect(existsSync(path.join(logs, 'new.png'))).toBe(true);
    expect(existsSync(path.join(keep, 'ledger.json'))).toBe(true);
    // The links' targets are untouched.
    expect(readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('do not delete');
    expect(existsSync(path.join(root, 'render-bundle-1'))).toBe(false);
    expect(existsSync(path.join(root, 'other-1'))).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(root, 'status', 'status.json'), 'utf8')).totalFreedMB,
    ).toBeGreaterThanOrEqual(0);
  });

  it('never removes a folder that holds a protected path, and refuses a rule on /', async () => {
    const root = tmp('tara-cleanup-');
    const parent = path.join(root, 'parent');
    mkdirSync(path.join(parent, 'keep'), { recursive: true });
    daysAgo(parent, 40);
    const config = path.join(root, 'c.json');
    writeFileSync(
      config,
      JSON.stringify({
        protected: [path.join(parent, 'keep')],
        rules: [{ name: 'All', dir: root, olderThanDays: 30 }],
      }),
    );
    const res = await run(CLEANUP, { TARA_CLEANUP_CONFIG: config }, '--dry-run');
    expect(JSON.parse(res.out).rules[0]).toMatchObject({ removed: 0, skippedProtected: 1 });

    writeFileSync(config, JSON.stringify({ rules: [{ name: 'Root', dir: '/', olderThanDays: 30 }] }));
    const bad = await run(CLEANUP, { TARA_CLEANUP_CONFIG: config });
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('absolute dir (not /)');
  });
});
