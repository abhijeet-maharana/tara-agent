#!/usr/bin/env -S node --no-warnings
/**
 * tara-release: release folders with automatic rollback for the services on a tara-agent host.
 *
 *   tara-release new <service>              makes an empty release folder (dependencies carried over from
 *                                           the live release as hard links) and prints its path
 *   tara-release activate <service> <id>    installs, checks, switches `current` to it, restarts, checks
 *                                           health; when unhealthy, switches back and restarts by itself
 *   tara-release rollback <service>         back to the release before the live one
 *   tara-release list [service]             the releases and which one is live
 *
 * `new` and `activate` read the project's part of the deploy on stdin (JSON, from the repo's
 * .tara/deploy.json, sent by tara-deploy.mjs): {install: [dirs], check: [npm scripts], build: [npm
 * scripts], unitFile: "path in the release"}. The host's part is /etc/tara-agent/services.json (see
 * examples/services.json): where the releases live, the systemd unit, the health URL, links to data
 * folders, `waitFor` (wait until a URL stops showing a text, e.g. a running job that calls this service),
 * and for tara-agent itself a drain (wait until no run is going before the restart).
 *
 * Layout: <base>/releases/<id>/ and <base>/current -> releases/<id>. The unit's WorkingDirectory points
 * into <base>/current, so a restart starts whatever `current` points at. Switching is one rename, so
 * `current` is never missing or half-written. The newest `keep` releases stay (5 by default), always
 * including the live one and the one before it.
 *
 * Release folders are readable by everyone and writable only by the deploying user (go-w,a+rX), so a
 * service's own user and the Claude run user can read them but never change the code that runs next.
 *
 * Runs as the deploying user (it uses `sudo -n` for systemctl, installing unit files and reading a drain
 * token). Install a copy outside any checkout other users can write:
 *   sudo install -o root -g root -m 755 deploy/release/tara-release.mjs /usr/local/bin/tara-release
 * No dependencies: Node 22, cp, npm, sudo, systemctl.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

const CONFIG = process.env.TARA_RELEASE_CONFIG || '/etc/tara-agent/services.json';
const ID = /^\d{8}-\d{6}$/;
const SAFE_REL = /^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`${m}\n`);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** The host settings; a root-only folder (/etc/tara-agent) is read through `sudo -n cat`. */
function readConfig() {
  try {
    return readFileSync(CONFIG, 'utf8');
  } catch (err) {
    if (err.code !== 'EACCES') throw err;
    const res = spawnSync('sudo', ['-n', 'cat', CONFIG], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`${err.message}, and sudo -n cat failed`);
    return res.stdout;
  }
}

function service(name) {
  let all;
  try {
    all = JSON.parse(readConfig()).services ?? {};
  } catch (err) {
    fail(`Cannot read ${CONFIG}: ${err.message}`, 2);
  }
  if (!name) return all;
  const s = all[name];
  if (!s) fail(`No service "${name}" in ${CONFIG} (have: ${Object.keys(all).join(', ')})`, 2);
  if (!s.base?.startsWith('/')) fail(`${name}: "base" must be an absolute path`, 2);
  return {
    name,
    keep: 5,
    healthSeconds: 90,
    restart: ['sudo', '-n', 'systemctl', 'restart', s.unit],
    ...s,
  };
}

/** The project's part, from stdin: only plain relative paths and npm script names. */
function readSpec() {
  let spec = {};
  try {
    const text = readFileSync(0, 'utf8').trim();
    if (text) spec = JSON.parse(text);
  } catch (err) {
    fail(`The deploy spec on stdin isn't JSON: ${err.message}`, 2);
  }
  const rels = [...(spec.install ?? []), ...(spec.unitFile ? [spec.unitFile] : []), ...(spec.app ? [spec.app] : [])];
  for (const r of rels) if (!SAFE_REL.test(r) || r.split('/').includes('..')) fail(`Unsafe path in spec: ${r}`, 2);
  for (const s of [...(spec.check ?? []), ...(spec.build ?? [])])
    if (!/^[A-Za-z0-9:._-]+$/.test(s)) fail(`Not an npm script name: ${s}`, 2);
  const install = spec.install ?? [];
  return { install, check: spec.check ?? [], build: spec.build ?? [], unitFile: spec.unitFile, app: spec.app ?? install[0] ?? '.' };
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
  return res.status ?? 1;
}

const releasesDir = (s) => path.join(s.base, 'releases');
const currentLink = (s) => path.join(s.base, 'current');

function liveId(s) {
  try {
    return path.basename(readlinkSync(currentLink(s)));
  } catch {
    return undefined;
  }
}

function releases(s) {
  try {
    return readdirSync(releasesDir(s)).filter((d) => ID.test(d)).sort();
  } catch {
    return [];
  }
}

/** Points `current` at a release in one rename. */
function point(s, id) {
  const tmp = `${currentLink(s)}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(path.join('releases', id), tmp);
  renameSync(tmp, currentLink(s));
}

function history(s, line) {
  appendFileSync(path.join(s.base, 'releases.log'), `${new Date().toISOString()} ${line}\n`);
}

/** Releases that were live and healthy at some point (releases.log), oldest first. */
function goodIds(s) {
  let text = '';
  try {
    text = readFileSync(path.join(s.base, 'releases.log'), 'utf8');
  } catch {}
  const ids = [...text.matchAll(/^\S+ (\d{8}-\d{6}) ok$/gm)].map((m) => m[1]);
  return [...new Set(ids)].filter((id) => existsSync(path.join(releasesDir(s), id))).sort();
}

const removeRelease = (s, id) => rmSync(path.join(releasesDir(s), id), { recursive: true, force: true });

// ---------- new ----------

function cmdNew(name) {
  const s = service(name);
  const spec = readSpec();
  mkdirSync(releasesDir(s), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = stamp;
  if (existsSync(path.join(releasesDir(s), id))) fail(`Release ${id} already exists: wait a second and retry`);
  const dir = path.join(releasesDir(s), id);
  mkdirSync(dir);
  // Dependencies from the live release (or the old single copy, `seedFrom`) as hard links: no download
  // when the lockfile didn't change. npm ci deletes the folder before installing, so it never writes
  // into the live release's files.
  const from = liveId(s) ? path.join(releasesDir(s), liveId(s)) : s.seedFrom;
  for (const rel of spec.install) {
    const src = from && path.join(from, rel, 'node_modules');
    if (src && existsSync(src)) {
      mkdirSync(path.join(dir, rel), { recursive: true });
      if (sh('cp', ['-al', src, path.join(dir, rel, 'node_modules')]) !== 0) fail(`Could not link ${src}`);
    }
  }
  log(dir);
}

// ---------- activate ----------

async function healthy(s, seconds) {
  const until = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < until) {
    try {
      const res = await fetch(s.health, { signal: AbortSignal.timeout(5000) });
      const body = await res.text();
      if (res.ok && (!s.healthExpect || body.includes(s.healthExpect))) return { ok: true, body: body.slice(0, 200) };
      last = `HTTP ${res.status}: ${body.slice(0, 150)}`;
    } catch (err) {
      last = err.cause?.code ?? err.message;
    }
    await sleep(2000);
  }
  return { ok: false, last };
}

function secret(file, name) {
  const res = spawnSync('sudo', ['-n', 'sed', '-n', `s/^${name}=//p`, file], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

/** tara-agent: stop starting runs, wait until nothing runs. Returns an undo for when we don't restart. */
async function drain(s) {
  const d = s.drain;
  const token = secret(d.tokenFile, d.tokenVar ?? 'TARA_ADMIN_TOKEN');
  const post = (on) =>
    fetch(`${d.url}/drain`, {
      method: 'POST',
      headers: { 'x-tara-admin': token, 'content-type': 'application/json' },
      body: JSON.stringify({ on }),
    });
  const res = await post(true);
  if (!res.ok) throw new Error(`drain: HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
  const undo = () => post(false).catch(() => {});
  const until = Date.now() + (d.waitSeconds ?? 1800) * 1000;
  log(`  draining: waiting until nothing runs (up to ${Math.round((d.waitSeconds ?? 1800) / 60)} min)`);
  while (Date.now() < until) {
    try {
      const h = await (await fetch(`${d.url}/health`)).json();
      if (h.idle) return undo;
    } catch {}
    await sleep(5000);
  }
  await undo();
  throw new Error('drain: still busy at the time limit; drain undone, nothing restarted');
}

/**
 * Waits until a URL's answer no longer contains a text (e.g. a project's job list without
 * `"running":true`), so a restart doesn't cut off work that calls this service. Throws at the limit.
 */
async function waitFor(s) {
  const w = s.waitFor;
  const until = Date.now() + (w.seconds ?? 1800) * 1000;
  log(`  waiting until ${w.url} no longer shows ${w.absent} (up to ${Math.round((w.seconds ?? 1800) / 60)} min)`);
  while (Date.now() < until) {
    try {
      const res = await fetch(w.url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok && !(await res.text()).includes(w.absent)) return;
    } catch {}
    await sleep(10_000);
  }
  throw new Error(`still busy at the time limit (${w.url} shows ${w.absent}); nothing switched`);
}

function installDeps(dir) {
  const lock = path.join(dir, 'package-lock.json');
  if (!existsSync(lock)) return;
  const sha = createHash('sha256').update(readFileSync(lock)).digest('hex');
  const stamp = path.join(dir, 'node_modules', '.deploy-lock-sha');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === sha) {
    // npm ci would also have run the package's own `prepare` (e.g. building its type files): do that.
    const scripts = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
    if (scripts.prepare && sh('npm', ['run', '-s', 'prepare'], { cwd: dir }) !== 0)
      throw new Error(`npm run prepare failed in ${dir}`);
    return;
  }
  log(`  npm ci in ${dir}`);
  const code = sh('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    env: { ...process.env, CI: '1', PUPPETEER_SKIP_DOWNLOAD: 'true' },
  });
  if (code !== 0) throw new Error(`npm ci failed in ${dir}`);
  spawnSync('sh', ['-c', 'printf %s "$1" > "$2"', 'sh', sha, stamp]);
}

function npmScripts(dir, names, what) {
  for (const n of names) {
    log(`  ${what}: npm run ${n}`);
    if (sh('npm', ['run', '-s', n], { cwd: dir }) !== 0) throw new Error(`${what} "npm run ${n}" failed`);
  }
}

async function restartAndCheck(s) {
  if (sh(s.restart[0], s.restart.slice(1)) !== 0) return { ok: false, last: 'restart command failed' };
  return healthy(s, s.healthSeconds);
}

async function cmdActivate(name, id) {
  const s = service(name);
  const spec = readSpec();
  if (!ID.test(id ?? '')) fail('usage: tara-release activate <service> <id>', 2);
  const dir = path.join(releasesDir(s), id);
  if (!existsSync(dir)) fail(`No release ${dir}`);
  const before = liveId(s);
  if (before === id) fail(`${id} is already live`);

  let undoDrain;
  try {
    // 1. Prepare the new folder; nothing live changes until the switch.
    for (const [rel, target] of Object.entries(s.links ?? {})) {
      if (!SAFE_REL.test(rel)) throw new Error(`Unsafe link path: ${rel}`);
      const at = path.join(dir, rel);
      mkdirSync(path.dirname(at), { recursive: true });
      if (existsSync(at) && !readlinkSafe(at)) throw new Error(`${at} is a real folder, expected a link to ${target}`);
      rmSync(at, { force: true });
      symlinkSync(target, at);
    }
    // The first build runs with the folder writable; then nobody but the owner may change it, and
    // everyone may read it: the service can run as its own user, and files copied from a laptop can
    // arrive owner-only (e.g. 0600), which that user could not read.
    for (const rel of spec.install) installDeps(path.join(dir, rel));
    const app = path.join(dir, spec.app);
    npmScripts(app, spec.build, 'build');
    npmScripts(app, spec.check, 'check');
    sh('chmod', ['-R', 'go-w,a+rX', dir]);

    if (spec.unitFile && s.unit) {
      const unitPath = `/etc/systemd/system/${s.unit}`;
      if (sh('cmp', ['-s', path.join(dir, spec.unitFile), unitPath]) !== 0) {
        log(`  installing the updated ${s.unit} (old one kept in /var/backups)`);
        sh('sudo', ['-n', 'cp', unitPath, `/var/backups/${s.unit}.${id}`]);
        if (sh('sudo', ['-n', 'install', '-o', 'root', '-g', 'root', '-m', '644', path.join(dir, spec.unitFile), unitPath]) !== 0)
          throw new Error('could not install the unit file');
        sh('sudo', ['-n', 'systemctl', 'daemon-reload']);
      }
    }

    // 2. Switch and restart.
    if (s.waitFor) await waitFor(s);
    if (s.drain) undoDrain = await drain(s);
    point(s, id);
    log(`  switched ${name} to ${id}${before ? ` (was ${before})` : ''}; restarting`);
    const h = await restartAndCheck(s);
    undoDrain = undefined; // a restart clears the drain
    if (h.ok) {
      history(s, `${id} ok`);
      log(`✓ ${name} ${id} is live and healthy: ${h.body}`);
      prune(s);
      return 0;
    }

    // 3. Unhealthy: back to the release before.
    log(`✗ ${name} ${id} is not healthy after ${s.healthSeconds}s: ${h.last}`);
    if (!before) {
      history(s, `${id} unhealthy, nothing to roll back to`);
      log('  nothing to roll back to (first release)');
      return 1;
    }
    point(s, before);
    log(`  rolled back to ${before}; restarting`);
    const back = await restartAndCheck(s);
    history(s, `${id} unhealthy, rolled back to ${before} (${back.ok ? 'healthy' : `STILL UNHEALTHY: ${back.last}`})`);
    removeRelease(s, id);
    log(back.ok ? `↩ ${name} is back on ${before} and healthy` : `✗ ${name} is still unhealthy on ${before}: ${back.last}`);
    return 1;
  } catch (err) {
    if (undoDrain) await undoDrain();
    history(s, `${id} not activated: ${err.message}`);
    if (liveId(s) !== id) removeRelease(s, id);
    log(`✗ ${name} ${id} not activated, nothing switched: ${err.message}`);
    return 1;
  }
}

function readlinkSafe(p) {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}

function prune(s) {
  // Only releases older than the live one: a newer folder may be a deploy that is still being copied.
  const live = liveId(s);
  if (!live) return;
  const older = releases(s).filter((id) => id < live);
  const keep = new Set(goodIds(s).filter((id) => id < live).slice(-(s.keep - 1)));
  for (const id of older) if (!keep.has(id)) removeRelease(s, id);
}

async function cmdRollback(name) {
  const s = service(name);
  const live = liveId(s);
  const to = goodIds(s)
    .filter((id) => id < (live ?? ''))
    .at(-1);
  if (!to) fail(`No earlier healthy release of ${name} to go back to (live: ${live ?? 'none'})`);
  if (s.drain) await drain(s);
  point(s, to);
  log(`  ${name}: ${live} → ${to}; restarting`);
  const h = await restartAndCheck(s);
  history(s, `rollback ${live} → ${to} (${h.ok ? 'healthy' : `unhealthy: ${h.last}`})`);
  log(h.ok ? `↩ ${name} is on ${to} and healthy` : `✗ ${name} is unhealthy on ${to}: ${h.last}`);
  return h.ok ? 0 : 1;
}

function cmdList(name) {
  const names = name ? [name] : Object.keys(service());
  for (const n of names) {
    const s = service(n);
    const live = liveId(s);
    log(`${n}${s.unit ? ` (${s.unit})` : ''}`);
    const all = releases(s);
    if (!all.length) log('  no releases yet');
    for (const id of all) log(`  ${id === live ? '*' : ' '} ${id}`);
  }
  return 0;
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'new':
    cmdNew(args[0]);
    break;
  case 'activate':
    process.exit(await cmdActivate(args[0], args[1]));
    break;
  case 'rollback':
    process.exit(await cmdRollback(args[0]));
    break;
  case 'list':
    process.exit(cmdList(args[0]));
    break;
  default:
    fail('usage: tara-release new <service> | activate <service> <id> | rollback <service> | list [service]', 2);
}
