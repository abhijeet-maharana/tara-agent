#!/usr/bin/env -S node --no-warnings
/**
 * tara-deploy: deploys one service of a project repo to its host, with automatic rollback.
 *
 *   node deploy/release/tara-deploy.mjs <service> [--repo <dir>] [--config <file>] [--host <ssh host>] [--no-activate]
 *
 * Reads <repo>/.tara/deploy.json (default repo: the current folder; --config for another file, e.g.
 * deploy/release/tara-agent.json, which deploys tara-agent itself):
 *
 *   { "host": "myhost",
 *     "services": {
 *       "shop-api": {
 *         "copy": [ { "from": "api/", "to": "shop/api/", "exclude": ["node_modules", ".env*"] } ],
 *         "install": ["shop/api"],          folders to `npm ci` (only when the lockfile changed)
 *         "build": ["build"],               npm scripts run in the app folder before the switch
 *         "check": ["typecheck"],           same, after the build; a failure stops the deploy
 *         "app": "shop/api",                the app folder (default: the first install folder)
 *         "unitFile": "shop/api/shop-api.service"   installed when it changed (optional) } } }
 *
 * Then, on the host (tara-release, see deploy/release/tara-release.mjs): makes a release folder, copies
 * the files into it with rsync, installs, builds, checks, switches, restarts and checks health, and
 * rolls back by itself when the new release isn't healthy. The code goes from this machine straight to
 * the release folder; the host's own checkout of the repo is never used.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const repo = path.resolve(opt('--repo') ?? '.');
const hostArg = opt('--host');
const configFile = path.resolve(repo, opt('--config') ?? path.join('.tara', 'deploy.json'));
const noActivate = args.includes('--no-activate');
const name = args.find((a) => !a.startsWith('--'));
if (!name) fail('usage: tara-deploy.mjs <service> [--repo <dir>] [--config <file>] [--host <ssh host>] [--no-activate]');

let config;
try {
  config = JSON.parse(readFileSync(configFile, 'utf8'));
} catch (err) {
  fail(`Cannot read ${configFile}: ${err.message}`);
}
const svc = config.services?.[name];
if (!svc) fail(`No service "${name}" in ${configFile} (have: ${Object.keys(config.services ?? {}).join(', ')})`);
const host = hostArg ?? config.host;
if (!host) fail(`No host: set "host" in ${configFile} or pass --host`);
const spec = JSON.stringify({
  install: svc.install ?? [],
  build: svc.build ?? [],
  check: svc.check ?? [],
  app: svc.app,
  unitFile: svc.unitFile,
});

const ssh = (remote, input, inherit = false) =>
  spawnSync('ssh', ['-o', 'BatchMode=yes', host, remote], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', inherit ? 'inherit' : 'pipe', 'inherit'],
  });

const made = ssh(`tara-release new ${name}`, spec);
if (made.status !== 0) fail(`tara-release new failed on ${host}`, 1);
const dir = made.stdout.trim().split('\n').at(-1);
const id = path.basename(dir);
console.log(`→ ${name}: release ${id} on ${host}`);

for (const c of svc.copy ?? []) {
  if (!c.from || !c.to || c.to.split('/').includes('..')) fail(`Bad copy entry: ${JSON.stringify(c)}`);
  const src = path.join(repo, c.from) + (c.from.endsWith('/') ? '/' : '');
  const dest = path.posix.join(dir, c.to);
  const parent = c.to.endsWith('/') ? dest : path.posix.dirname(dest);
  if (ssh(`mkdir -p '${parent}'`).status !== 0) fail(`mkdir failed on ${host}`, 1);
  const excludes = (c.exclude ?? []).flatMap((e) => ['--exclude', e]);
  const r = spawnSync('rsync', ['-rlt', '--delete', ...excludes, src, `${host}:${dest}${c.to.endsWith('/') ? '/' : ''}`], {
    stdio: 'inherit',
  });
  if (r.status !== 0) fail(`rsync of ${c.from} failed`, 1);
}
console.log(`→ copied ${svc.copy?.length ?? 0} part(s)`);

if (noActivate) {
  console.log(`Not activated. Later: ssh ${host} tara-release activate ${name} ${id}  (with the spec on stdin)`);
  process.exit(0);
}
const act = ssh(`tara-release activate ${name} ${id}`, spec, true);
process.exit(act.status ?? 1);
