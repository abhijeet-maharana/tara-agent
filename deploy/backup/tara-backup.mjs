#!/usr/bin/env -S node --no-warnings
/**
 * tara-backup: nightly, checked, encrypted off-site backup of a host's databases and files.
 *
 *   tara-backup run                       copy every item, check it, pack, encrypt, upload, prune, write status
 *   tara-backup status                    the status file, as JSON
 *   tara-backup presign                   the latest good archive: {key, url, sha256, bytes}, for a restore test
 *   tara-backup restore-result <ok|failed> <archive key> [message]   records a restore test's result
 *   tara-backup verify <dir>              checks an unpacked archive against its manifest.json (exit 1 = bad)
 *
 * How a run works:
 *  1. SQLite items are copied with `VACUUM INTO` from a read-only connection: a consistent copy that
 *     includes the WAL, taken while the owner keeps writing, and never touching the owner's -wal/-shm.
 *     Each copy gets `integrity_check` and per-table row counts. Path items (files, folders) become one
 *     tar.gz each, with their own excludes.
 *  2. Everything plus manifest.json is packed into one tar.gz and encrypted with `age` to the config's
 *     public recipients. The private key is never on this host, so a copy of this disk can't open the
 *     backups.
 *  3. The archive is kept locally (`keepLocal` newest) and uploaded with the AWS CLI to any S3-compatible
 *     store (R2, S3, B2); the upload is checked by size and sha256 metadata. Remote copies older than
 *     `keepDays` are deleted, always keeping the `minKeep` newest. Only the configured prefix is touched.
 *  4. A status file (no secrets, world-readable) says what happened; tara-agent's Health page reads it.
 *
 * Items with `"every": "week"` go in at most once every 7 days (large, slow-changing databases).
 * A failing item doesn't stop the others: the run uploads what it has and is marked failed.
 *
 * The restore test runs on a machine that has the private key (deploy/backup/restore-test.sh): it gets a
 * short-lived download link from `presign`, decrypts, unpacks, runs `verify`, and reports back with
 * `restore-result`.
 *
 * Config: /etc/tara-agent/backup.json (see examples/backup.json); the store's keys come from its
 * `remote.envFile` (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY). Install a root-owned copy, never run the
 * checkout's file as root (other users may be able to write the checkout):
 *   sudo install -o root -g root -m 755 deploy/backup/tara-backup.mjs /usr/local/sbin/tara-backup
 * No dependencies: Node 22.13+ (node:sqlite), tar, age, aws.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
// Under sudo the config is always this one; only a caller that isn't root (the tests) may point elsewhere.
const CONFIG_FILE =
  (process.getuid?.() !== 0 && process.env.TARA_BACKUP_CONFIG) || '/etc/tara-agent/backup.json';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function loadConfig() {
  let c;
  try {
    c = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    fail(`Cannot read ${CONFIG_FILE}: ${err.message}`);
  }
  const problems = [];
  if (!Array.isArray(c.recipients) || !c.recipients.length || !c.recipients.every((r) => /^age1[0-9a-z]+$/.test(r)))
    problems.push('"recipients" must be a list of age public keys (age1…)');
  if (!Array.isArray(c.items) || !c.items.length) problems.push('"items" must be a non-empty list');
  const seen = new Set();
  for (const [i, it] of (c.items ?? []).entries()) {
    if (!NAME.test(it?.name ?? '') || it.name.includes('..')) problems.push(`items[${i}].name must be a/b/c style`);
    if (seen.has(it?.name)) problems.push(`items[${i}].name "${it.name}" is used twice`);
    seen.add(it?.name);
    if (!!it?.sqlite === !!it?.path) problems.push(`items[${i}] needs exactly one of "sqlite" or "path"`);
    if ((it?.sqlite ?? it?.path ?? '/')[0] !== '/') problems.push(`items[${i}]: the source must be an absolute path`);
    if (it?.every && it.every !== 'week') problems.push(`items[${i}].every can only be "week"`);
  }
  const r = c.remote;
  if (r && (!r.bucket || !r.endpoint || !r.envFile))
    problems.push('"remote" needs bucket, endpoint and envFile');
  if (problems.length) fail(`${CONFIG_FILE}:\n  ${problems.join('\n  ')}`);
  return {
    host: c.host ?? 'host',
    localDir: c.localDir ?? '/var/backups/tara-backup',
    keepLocal: c.keepLocal ?? 7,
    statusFile: c.statusFile ?? '/var/lib/tara-backup/status.json',
    recipients: c.recipients,
    items: c.items,
    remote: r && {
      bucket: r.bucket,
      prefix: (r.prefix ?? 'tara-backup/').replace(/^\/+/, ''),
      endpoint: r.endpoint,
      envFile: r.envFile,
      keepDays: r.keepDays ?? 30,
      minKeep: r.minKeep ?? 7,
    },
  };
}

// ---------- status file ----------

function readStatus(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeStatus(file, status) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
}

// ---------- helpers ----------

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
  return res;
}

function envFile(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** The AWS CLI pointed at the configured store. Newer CLIs send checksums some S3-compatible stores reject. */
function aws(remote, args) {
  const env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/root',
    AWS_DEFAULT_REGION: 'auto',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
    ...envFile(remote.envFile),
  };
  const res = run('aws', [...args, '--endpoint-url', remote.endpoint, '--output', 'json'], { env });
  if (res.status !== 0) throw new Error(`aws ${args[0]} ${args[1]}: ${(res.stderr || res.stdout).trim().slice(0, 400)}`);
  return res.stdout.trim() ? JSON.parse(res.stdout) : {};
}

function rowCounts(db) {
  const tables = db
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all()
    .map((r) => r.name);
  return Object.fromEntries(
    tables.map((t) => [t, Number(db.prepare(`select count(*) as n from "${t.replaceAll('"', '""')}"`).get().n)]),
  );
}

function checkSqlite(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('pragma integrity_check').all().map((r) => Object.values(r)[0]).join('; ');
    return { integrity, rows: rowCounts(db) };
  } finally {
    db.close();
  }
}

const sum = (rows) => Object.values(rows ?? {}).reduce((a, b) => a + b, 0);

// ---------- run ----------

function copySqlite(item, dest) {
  mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  rmSync(dest, { force: true });
  const src = new DatabaseSync(item.sqlite, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  } finally {
    src.close();
  }
  const { integrity, rows } = checkSqlite(dest);
  if (integrity !== 'ok') throw new Error(`the copy failed integrity_check: ${integrity.slice(0, 200)}`);
  return { rows };
}

function packPath(item, dest) {
  mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const rel = path.relative('/', item.path);
  const excludes = (item.exclude ?? []).map((p) => `--exclude=${p}`);
  const res = run('tar', ['-czf', dest, ...excludes, '-C', '/', rel]);
  // GNU tar: 1 = a file changed while it was read (live folders, e.g. a browser profile): kept, noted.
  if (res.status === 1) return { warning: res.stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200) };
  if (res.status !== 0) throw new Error(`tar: ${res.stderr.trim().slice(0, 300)}`);
  return {};
}

/** tar the staging folder and encrypt it with age, as one stream (no unencrypted archive on disk). */
function packAndEncrypt(staging, out, recipients) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', '-', '-C', staging, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const age = spawn('age', [...recipients.flatMap((r) => ['-r', r]), '-o', out], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    tar.stderr.on('data', (d) => (err += d));
    age.stderr.on('data', (d) => (err += d));
    tar.stdout.pipe(age.stdin);
    let left = 2;
    let failed = false;
    const done = (who) => (code) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(new Error(`${who} exited ${code}: ${err.trim().slice(0, 300)}`));
      }
      if (--left === 0 && !failed) resolve();
    };
    tar.on('error', reject);
    age.on('error', reject);
    tar.on('close', done('tar'));
    age.on('close', done('age'));
  });
}

function pruneLocal(dir, keep) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz.age'))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(path.join(dir, f), { force: true });
}

function pruneRemote(remote, now) {
  const listed = aws(remote, ['s3api', 'list-objects-v2', '--bucket', remote.bucket, '--prefix', remote.prefix]);
  const objects = (listed.Contents ?? [])
    .filter((o) => o.Key.endsWith('.tar.gz.age'))
    .sort((a, b) => Date.parse(b.LastModified) - Date.parse(a.LastModified));
  let removed = 0;
  for (const o of objects.slice(remote.minKeep)) {
    if (now - Date.parse(o.LastModified) < remote.keepDays * DAY) continue;
    aws(remote, ['s3api', 'delete-object', '--bucket', remote.bucket, '--key', o.Key]);
    removed++;
  }
  return { kept: objects.length - removed, removed };
}

async function runBackup() {
  const cfg = loadConfig();
  const started = Date.now();
  const stamp = new Date(started).toISOString().replace(/[-:.]/g, '');
  const previous = readStatus(cfg.statusFile);
  const included = { ...(previous.included ?? {}) };
  mkdirSync(cfg.localDir, { recursive: true, mode: 0o700 });
  chmodSync(cfg.localDir, 0o700);
  const staging = path.join(cfg.localDir, `.staging-${stamp}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o700 });

  const manifest = { host: cfg.host, createdAt: new Date(started).toISOString(), items: [] };
  const items = [];
  const errors = [];
  const warnings = [];
  try {
    for (const item of cfg.items) {
      const due = item.every !== 'week' || !included[item.name] || started - Date.parse(included[item.name]) >= 6.5 * DAY;
      if (!due) {
        items.push({ name: item.name, skipped: `weekly, last in ${included[item.name].slice(0, 10)}` });
        continue;
      }
      const source = item.sqlite ?? item.path;
      if (!existsSync(source)) {
        if (item.optional) items.push({ name: item.name, skipped: 'not on this host' });
        else {
          errors.push(`${item.name}: ${source} is missing`);
          items.push({ name: item.name, ok: false, error: 'missing' });
        }
        continue;
      }
      const t0 = Date.now();
      try {
        let entry;
        if (item.sqlite) {
          const file = `sqlite/${item.name}`;
          const { rows } = copySqlite(item, path.join(staging, file));
          entry = { name: item.name, kind: 'sqlite', file, rows, sha256: await sha256File(path.join(staging, file)) };
        } else {
          const file = `files/${item.name}.tar.gz`;
          const { warning } = packPath(item, path.join(staging, file));
          if (warning) warnings.push(`${item.name}: ${warning}`);
          entry = { name: item.name, kind: 'path', file, source: item.path, sha256: await sha256File(path.join(staging, file)) };
        }
        entry.bytes = statSync(path.join(staging, entry.file)).size;
        manifest.items.push(entry);
        included[item.name] = new Date(started).toISOString();
        items.push({
          name: item.name,
          ok: true,
          bytes: entry.bytes,
          ...(entry.rows ? { tables: Object.keys(entry.rows).length, rows: sum(entry.rows) } : {}),
          secs: Math.round((Date.now() - t0) / 100) / 10,
        });
      } catch (err) {
        errors.push(`${item.name}: ${err.message}`);
        items.push({ name: item.name, ok: false, error: err.message.slice(0, 300) });
      }
    }
    writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const fileName = `${cfg.host}-${stamp}.tar.gz.age`;
    const out = path.join(cfg.localDir, fileName);
    await packAndEncrypt(staging, `${out}.tmp`, cfg.recipients);
    renameSync(`${out}.tmp`, out);
    chmodSync(out, 0o600);
    const archive = { file: fileName, bytes: statSync(out).size, sha256: await sha256File(out) };
    pruneLocal(cfg.localDir, cfg.keepLocal);

    let remote;
    if (cfg.remote) {
      const key = `${cfg.remote.prefix}${fileName}`;
      aws(cfg.remote, ['s3', 'cp', out, `s3://${cfg.remote.bucket}/${key}`, '--only-show-errors', '--metadata', `sha256=${archive.sha256}`]);
      const head = aws(cfg.remote, ['s3api', 'head-object', '--bucket', cfg.remote.bucket, '--key', key]);
      if (Number(head.ContentLength) !== archive.bytes || head.Metadata?.sha256 !== archive.sha256)
        throw new Error(`the uploaded copy doesn't match (size ${head.ContentLength} vs ${archive.bytes})`);
      archive.key = key;
      remote = pruneRemote(cfg.remote, started);
    }

    const result = {
      at: new Date(started).toISOString(),
      ok: errors.length === 0,
      secs: Math.round((Date.now() - started) / 1000),
      archive,
      ...(remote ? { remote } : {}),
      items,
      ...(errors.length ? { error: errors.join(' · ') } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
    writeStatus(cfg.statusFile, {
      ...previous,
      lastRun: result,
      ...(result.ok ? { lastGood: result } : {}),
      included,
    });
    printRun(result);
    return result.ok ? 0 : 1;
  } catch (err) {
    const result = { at: new Date(started).toISOString(), ok: false, error: err.message.slice(0, 500), items };
    writeStatus(cfg.statusFile, { ...previous, lastRun: result, included: previous.included ?? {} });
    process.stderr.write(`Backup failed: ${err.message}\n`);
    return 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function printRun(r) {
  const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
  console.log(`${r.ok ? 'OK' : 'FAILED'} ${r.archive.file} · ${mb(r.archive.bytes)} · ${r.secs}s${r.archive.key ? ' · uploaded' : ''}`);
  for (const i of r.items)
    console.log(
      `  ${i.ok ? 'ok  ' : i.skipped ? 'skip' : 'FAIL'} ${i.name}${i.rows !== undefined ? ` · ${i.tables} tables, ${i.rows} rows` : ''}${i.bytes ? ` · ${mb(i.bytes)}` : ''}${i.skipped ? ` · ${i.skipped}` : ''}${i.error ? ` · ${i.error}` : ''}`,
    );
  for (const w of r.warnings ?? []) console.log(`  warning: ${w}`);
  if (r.remote) console.log(`  remote: ${r.remote.kept} kept, ${r.remote.removed} removed`);
}

// ---------- restore test support ----------

function presign() {
  const cfg = loadConfig();
  const good = readStatus(cfg.statusFile).lastGood;
  if (!good?.archive?.key) fail('No uploaded good backup yet');
  if (!cfg.remote) fail('No "remote" in the config');
  const res = run('aws', ['s3', 'presign', `s3://${cfg.remote.bucket}/${good.archive.key}`, '--expires-in', '3600', '--endpoint-url', cfg.remote.endpoint], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/root', AWS_DEFAULT_REGION: 'auto', ...envFile(cfg.remote.envFile) },
  });
  if (res.status !== 0) fail(`aws s3 presign: ${res.stderr.trim()}`);
  console.log(JSON.stringify({ key: good.archive.key, url: res.stdout.trim(), sha256: good.archive.sha256, bytes: good.archive.bytes, at: good.at }));
}

function restoreResult(outcome, key, message = '') {
  if (!['ok', 'failed'].includes(outcome) || !key) fail('usage: tara-backup restore-result <ok|failed> <archive key> [message]');
  const cfg = loadConfig();
  const status = readStatus(cfg.statusFile);
  status.restoreTest = { at: new Date().toISOString(), ok: outcome === 'ok', archive: String(key).slice(0, 300), message: String(message).slice(0, 500) };
  writeStatus(cfg.statusFile, status);
  console.log(`Recorded restore test: ${outcome}`);
}

/** Checks an unpacked archive: every file's sha256, every database's integrity and row counts, every tar readable. */
async function verify(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (err) {
    fail(`No readable manifest.json in ${dir}: ${err.message}`, 1);
  }
  const results = [];
  for (const item of manifest.items) {
    const file = path.join(dir, item.file);
    const problems = [];
    if (!existsSync(file)) problems.push('missing');
    else {
      if ((await sha256File(file)) !== item.sha256) problems.push('sha256 differs');
      if (item.kind === 'sqlite') {
        const { integrity, rows } = checkSqlite(file);
        if (integrity !== 'ok') problems.push(`integrity: ${integrity.slice(0, 100)}`);
        if (JSON.stringify(rows) !== JSON.stringify(item.rows)) problems.push('row counts differ');
      } else if (run('tar', ['-tzf', file]).status !== 0) problems.push('tar unreadable');
    }
    results.push({ name: item.name, ok: problems.length === 0, problems, ...(item.rows ? { rows: sum(item.rows) } : {}) });
  }
  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, host: manifest.host, createdAt: manifest.createdAt, items: results }, null, 2));
  return ok ? 0 : 1;
}

// ---------- main ----------

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'run':
    process.exit(await runBackup());
    break;
  case 'status':
    console.log(JSON.stringify(readStatus(loadConfig().statusFile), null, 2));
    break;
  case 'presign':
    presign();
    break;
  case 'restore-result':
    restoreResult(...args);
    break;
  case 'verify':
    if (!args[0]) fail('usage: tara-backup verify <unpacked archive dir>');
    process.exit(await verify(args[0]));
    break;
  default:
    fail('usage: tara-backup run | status | presign | restore-result <ok|failed> <key> [message] | verify <dir>');
}
