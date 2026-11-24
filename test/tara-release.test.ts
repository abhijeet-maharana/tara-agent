import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const TOOL = fileURLToPath(new URL('../deploy/release/tara-release.mjs', import.meta.url));

/** Runs the tool without blocking this process (the fake service's health server must keep answering). */
function tool(config: string, args: string[], spec: object = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', TOOL, ...args], {
      env: { PATH: process.env.PATH, TARA_RELEASE_CONFIG: config },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.stdin.end(JSON.stringify(spec));
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

let server: Server | undefined;
afterEach(() => server?.close());

/** A service whose health depends on the live release's VERSION file: "good" answers 200. */
async function setup(keep = 5) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'tara-release-')));
  server = createServer((_req, res) => {
    let v = '';
    try {
      v = readFileSync(path.join(base, 'current', 'app', 'VERSION'), 'utf8').trim();
    } catch {}
    res.writeHead(v.startsWith('good') ? 200 : 500).end(`version ${v}`);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const config = path.join(base, 'services.json');
  const data = path.join(base, 'data');
  mkdirSync(data);
  writeFileSync(
    config,
    JSON.stringify({
      services: {
        shop: {
          base,
          restart: ['true'],
          health: `http://127.0.0.1:${port}/health`,
          healthSeconds: 3,
          keep,
          links: { 'app/data': data },
        },
      },
    }),
  );
  const spec = { app: 'app', check: ['typecheck'] };
  /** Makes a release whose VERSION is `version` and whose typecheck exits with `check`. */
  const release = async (version: string, check = 0) => {
    const made = await tool(config, ['new', 'shop'], spec);
    expect(made.code).toBe(0);
    const dir = made.out.trim();
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    // Owner-only, as files copied from a laptop can be: the release must still be readable by all.
    writeFileSync(path.join(dir, 'app', 'VERSION'), version, { mode: 0o600 });
    writeFileSync(
      path.join(dir, 'app', 'package.json'),
      JSON.stringify({ scripts: { typecheck: `exit ${check}` } }),
    );
    // Release ids are per second.
    await new Promise((r) => setTimeout(r, 1100));
    return path.basename(dir);
  };
  const live = () => path.basename(readlinkSync(path.join(base, 'current')));
  return { base, config, spec, release, live };
}

describe('tara-release', () => {
  it('switches to a healthy release, and rolls a bad one back by itself', async () => {
    const { base, config, spec, release, live } = await setup();
    const first = await release('good 1');
    const ok = await tool(config, ['activate', 'shop', first], spec);
    expect(ok.out).toContain(`✓ shop ${first} is live and healthy: version good 1`);
    expect(ok.code).toBe(0);
    expect(live()).toBe(first);
    // Data folders are linked in, not copied.
    expect(readlinkSync(path.join(base, 'current', 'app', 'data'))).toBe(path.join(base, 'data'));
    // A service running as its own user can read every file, and nobody but the owner can change one.
    expect(statSync(path.join(base, 'current', 'app', 'VERSION')).mode & 0o777).toBe(0o644);

    const bad = await release('broken');
    const res = await tool(config, ['activate', 'shop', bad], spec);
    expect(res.code).toBe(1);
    expect(res.out).toContain(`✗ shop ${bad} is not healthy`);
    expect(res.out).toContain(`↩ shop is back on ${first} and healthy`);
    expect(live()).toBe(first);
    expect(readFileSync(path.join(base, 'releases.log'), 'utf8')).toContain(
      `${bad} unhealthy, rolled back to ${first} (healthy)`,
    );
  }, 30_000);

  it("doesn't switch when a check fails, and rollback goes to the release before", async () => {
    const { config, spec, release, live } = await setup();
    const first = await release('good 1');
    await tool(config, ['activate', 'shop', first], spec);
    const failing = await release('good 2', 3);
    const res = await tool(config, ['activate', 'shop', failing], spec);
    expect(res.code).toBe(1);
    expect(res.out).toContain('not activated, nothing switched: check "npm run typecheck" failed');
    expect(live()).toBe(first);

    const second = await release('good 3');
    expect((await tool(config, ['activate', 'shop', second], spec)).code).toBe(0);
    expect(live()).toBe(second);
    const back = await tool(config, ['rollback', 'shop']);
    expect(back.code).toBe(0);
    // Back to the last healthy release: the one whose check failed was deleted, never a target.
    expect(live()).toBe(first);
    expect(back.out).toContain(`↩ shop is on ${first} and healthy`);
    expect(existsSync(path.join(path.dirname(config), 'releases', failing))).toBe(false);
  }, 30_000);

  it('keeps the newest releases plus the live one and the one before', async () => {
    const { base, config, spec, release } = await setup(2);
    const ids: string[] = [];
    for (const v of ['good 1', 'good 2', 'good 3']) {
      const id = await release(v);
      ids.push(id);
      expect((await tool(config, ['activate', 'shop', id], spec)).code).toBe(0);
    }
    expect(existsSync(path.join(base, 'releases', ids[0] as string))).toBe(false);
    expect(existsSync(path.join(base, 'releases', ids[1] as string))).toBe(true);
    const list = await tool(config, ['list', 'shop']);
    expect(list.out).toContain(`* ${ids[2]}`);
  }, 30_000);

  it('refuses unsafe paths and script names from the repo', async () => {
    const { config } = await setup();
    const res = await tool(config, ['new', 'shop'], { install: ['../../etc'] });
    expect(res.code).toBe(2);
    expect(res.out).toContain('Unsafe path in spec');
    const cmd = await tool(config, ['new', 'shop'], { check: ['typecheck; rm -rf /'] });
    expect(cmd.out).toContain('Not an npm script name');
  });
});
