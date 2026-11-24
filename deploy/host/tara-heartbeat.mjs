#!/usr/bin/env -S node --no-warnings
/**
 * tara-heartbeat: the host's own check of its services, every few minutes, outside tara-agent (so it
 * still sees a problem when tara-agent itself is down). Nothing leaves the host.
 *
 *   tara-heartbeat            check, write the files below
 *   tara-heartbeat --dry-run  print the checks, write nothing
 *
 * Config: /etc/tara-agent/heartbeat.json (examples/heartbeat.json):
 *   http      [{name, url}]           up = any HTTP answer that isn't 5xx (an auth error still means up)
 *   files     [{name, path, maxAgeHours, jsonTime?}]   fresh = the file's time, or the ISO time at
 *                                     `jsonTime` (a dot path, e.g. "lastGood.at") inside it, is recent
 *   diskPercent, memoryPercent       thresholds for / and RAM
 *   bootGraceSeconds                  no checks this soon after boot (services are still starting)
 *   stampFile, failsFile, statusFile  where results go (defaults /var/tmp/tara-heartbeat.*)
 *
 * Files written in place (world-readable, they survive reboots; never replaced, so a bind mount of them
 * stays current):
 *   stampFile   touched every run: when the host was last seen up
 *   statusFile  the problems, one per line, once they failed twice in a row (a blip stays quiet);
 *               empty when all is fine
 *
 * Run as root from a root-owned copy by tara-heartbeat.timer:
 *   sudo install -o root -g root -m 755 deploy/host/tara-heartbeat.mjs /usr/local/sbin/tara-heartbeat
 */
import { chmodSync, existsSync, readFileSync, statfsSync, statSync, utimesSync, writeFileSync } from 'node:fs';

// Under sudo the config is always this one; only a caller that isn't root (the tests) may point elsewhere.
const CONFIG =
  (process.getuid?.() !== 0 && process.env.TARA_HEARTBEAT_CONFIG) || '/etc/tara-agent/heartbeat.json';
const dry = process.argv.includes('--dry-run');

function loadConfig() {
  let c;
  try {
    c = JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (err) {
    process.stderr.write(`Cannot read ${CONFIG}: ${err.message}\n`);
    process.exit(2);
  }
  return {
    http: c.http ?? [],
    files: c.files ?? [],
    diskPercent: c.diskPercent ?? 90,
    memoryPercent: c.memoryPercent ?? 92,
    bootGraceSeconds: c.bootGraceSeconds ?? 300,
    stampFile: c.stampFile ?? '/var/tmp/tara-heartbeat.last',
    failsFile: c.failsFile ?? '/var/tmp/tara-heartbeat.fails',
    statusFile: c.statusFile ?? '/var/tmp/tara-heartbeat.status',
    uptimeFile: c.uptimeFile ?? '/proc/uptime',
    meminfoFile: c.meminfoFile ?? '/proc/meminfo',
  };
}

async function httpUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'manual' });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

function fileAgeHours(f, now) {
  let at;
  if (f.jsonTime) {
    let v = JSON.parse(readFileSync(f.path, 'utf8'));
    for (const k of f.jsonTime.split('.')) v = v?.[k];
    at = Date.parse(v);
    if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  } else at = statSync(f.path).mtimeMs;
  return (now - at) / 3_600_000;
}

async function checks(c) {
  const problems = [];
  const uptime = Number.parseFloat(readFileSync(c.uptimeFile, 'utf8'));
  if (uptime < c.bootGraceSeconds) return { uptime, problems, skipped: true };
  const results = await Promise.all(c.http.map(async (h) => [h, await httpUp(h.url)]));
  for (const [h, up] of results) if (!up) problems.push(h.message ?? `${h.name} not answering`);
  const now = Date.now();
  for (const f of c.files) {
    let age;
    try {
      age = fileAgeHours(f, now);
    } catch {
      age = Number.POSITIVE_INFINITY;
    }
    if (age > f.maxAgeHours)
      problems.push(
        f.message ??
          (Number.isFinite(age) ? `${f.name}: nothing new for ${Math.round(age)}h` : `${f.name}: missing or unreadable`),
      );
  }
  try {
    const fs = statfsSync('/');
    const disk = Math.round(100 - (fs.bavail * 100) / fs.blocks);
    if (disk >= c.diskPercent) problems.push(`disk ${disk}% full`);
  } catch {}
  try {
    const info = readFileSync(c.meminfoFile, 'utf8');
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1]);
    const mem = Math.round(100 - (kb('MemAvailable') * 100) / kb('MemTotal'));
    if (mem >= c.memoryPercent) problems.push(`memory ${mem}% used`);
  } catch {}
  return { uptime, problems };
}

/**
 * Written in place (same inode), never replaced: a service that bind-mounts these files into its own
 * namespace (systemd BindReadOnlyPaths with PrivateTmp) keeps seeing the live file. The files are tiny.
 */
function write(file, text) {
  writeFileSync(file, text);
  chmodSync(file, 0o644);
}

/** `touch`: a new time on the same inode. */
function touch(file) {
  const now = new Date();
  try {
    utimesSync(file, now, now);
  } catch {
    write(file, '');
  }
}

const c = loadConfig();
const { uptime, problems, skipped } = await checks(c);
if (dry) {
  console.log(`uptime ${Math.round(uptime)}s${skipped ? ' (just booted: no checks)' : ''}`);
  console.log(problems.length ? problems.map((p) => `problem: ${p}`).join('\n') : 'all fine');
  process.exit(0);
}
touch(c.stampFile);
if (!problems.length) {
  write(c.failsFile, '0\n');
  write(c.statusFile, '');
} else {
  let n = 0;
  try {
    n = Number.parseInt(readFileSync(c.failsFile, 'utf8'), 10) || 0;
  } catch {}
  n++;
  write(c.failsFile, `${n}\n`);
  // A first failure changes nothing: the next run either recovers or confirms it.
  if (n >= 2) write(c.statusFile, `${problems.join('\n')}\n`);
  else if (!existsSync(c.statusFile)) write(c.statusFile, '');
}
