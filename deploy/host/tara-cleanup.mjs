#!/usr/bin/env -S node --no-warnings
/**
 * tara-cleanup: housekeeping for the host. Deletes only what the config's rules name, only entries
 * older than each rule's age, and never anything inside a protected path. Anything not named is never
 * touched. A link is removed as a link: its target is never followed.
 *
 *   tara-cleanup            delete, print a JSON summary, write the status file
 *   tara-cleanup --dry-run  only report what would be deleted
 *
 * Config: /etc/tara-agent/cleanup.json (examples/cleanup.json):
 *   rules      [{name, dir, match?, olderThanDays}]  entries directly inside `dir` whose name matches the
 *              glob `match` (default "*"; * and ? only) and whose own time is older than the age. A
 *              matching folder is removed whole.
 *   protected  [paths]   never removed, nor anything inside them, even when a rule matches
 *   dockerDanglingImages  true = also `docker image prune -f` (untagged images only)
 *   statusFile            where the last summary goes (default /var/lib/tara-cleanup/status.json)
 *
 * Run as root from a root-owned copy by tara-cleanup.timer:
 *   sudo install -o root -g root -m 755 deploy/host/tara-cleanup.mjs /usr/local/sbin/tara-cleanup
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const CONFIG =
  (process.getuid?.() !== 0 && process.env.TARA_CLEANUP_CONFIG) || '/etc/tara-agent/cleanup.json';
const DAY = 86_400_000;
const dry = process.argv.includes('--dry-run');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG, 'utf8'));
} catch (err) {
  fail(`Cannot read ${CONFIG}: ${err.message}`);
}
for (const [i, r] of (config.rules ?? []).entries())
  if (!r?.name || !path.isAbsolute(r.dir ?? '') || !(r.olderThanDays > 0) || r.dir === '/')
    fail(`${CONFIG}: rules[${i}] needs a name, an absolute dir (not /) and olderThanDays > 0`);

const resolve = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const protectedPaths = (config.protected ?? []).map(resolve);
/** The entry itself (a link is not followed) is a protected path or inside one. */
function isProtected(entry) {
  const real = path.join(resolve(path.dirname(entry)), path.basename(entry));
  return protectedPaths.some((p) => real === p || real.startsWith(`${p}${path.sep}`) || p.startsWith(`${real}${path.sep}`));
}

const glob = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`);

function sizeOf(p) {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(p)) {
    try {
      total += sizeOf(path.join(p, name));
    } catch {}
  }
  return total;
}

const freeGB = () => {
  const fs = statfsSync('/');
  return Math.round((fs.bavail * fs.bsize) / 1024 ** 3 * 10) / 10;
};
const mb = (b) => Math.round((b / 1024 ** 2) * 10) / 10;

function cleanRule(rule, now) {
  const out = { rule: rule.name, olderThanDays: rule.olderThanDays, removed: 0, freedMB: 0, skippedProtected: 0, items: [] };
  let names;
  try {
    names = readdirSync(rule.dir);
  } catch {
    out.note = 'folder not found';
    return out;
  }
  const re = glob(rule.match ?? '*');
  let freed = 0;
  for (const name of names) {
    if (!re.test(name)) continue;
    const p = path.join(rule.dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < rule.olderThanDays * DAY) continue;
    if (isProtected(p)) {
      out.skippedProtected++;
      continue;
    }
    const size = sizeOf(p);
    if (!dry) {
      try {
        // rmSync never follows a link: a link is unlinked, a folder's links inside are unlinked too.
        rmSync(p, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true });
      } catch (err) {
        out.items.push(`${p}: not removed (${err.code ?? err.message})`);
        continue;
      }
    }
    freed += size;
    out.removed++;
    out.items.push(`${p} (${Math.floor((now - st.mtimeMs) / DAY)}d old, ${mb(size)} MB)`);
  }
  out.freedMB = mb(freed);
  return out;
}

function dockerDangling() {
  const list = spawnSync('docker', ['images', '-f', 'dangling=true', '--format', '{{.ID}} ({{.Size}}, {{.CreatedSince}})'], {
    encoding: 'utf8',
  });
  if (list.status !== 0) return { rule: 'Dangling Docker images', removed: 0, items: [], note: 'docker not available' };
  const items = list.stdout.split('\n').filter(Boolean);
  if (items.length && !dry) spawnSync('docker', ['image', 'prune', '-f']);
  return { rule: 'Dangling Docker images', removed: items.length, items };
}

const now = Date.now();
const before = freeGB();
const rules = (config.rules ?? []).map((r) => cleanRule(r, now));
if (config.dockerDanglingImages) rules.push(dockerDangling());
const summary = {
  at: new Date(now).toISOString(),
  dryRun: dry,
  diskFreeGBBefore: before,
  diskFreeGBAfter: freeGB(),
  totalFreedMB: Math.round(rules.reduce((a, r) => a + (r.freedMB ?? 0), 0) * 10) / 10,
  rules,
};
console.log(JSON.stringify(summary, null, 2));
if (!dry) {
  const file = config.statusFile ?? '/var/lib/tara-cleanup/status.json';
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const brief = { ...summary, rules: rules.map(({ items, ...r }) => ({ ...r, items: items.slice(0, 20) })) };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(brief, null, 2)}\n`);
  chmodSync(`${file}.tmp`, 0o644);
  renameSync(`${file}.tmp`, file);
}
