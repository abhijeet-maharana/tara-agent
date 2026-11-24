import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TOOL = fileURLToPath(new URL('../deploy/backup/tara-backup.mjs', import.meta.url));
const hasAge = spawnSync('age', ['--version']).status === 0;

function tool(config: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--no-warnings', TOOL, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TARA_BACKUP_CONFIG: config },
  });
}

/** A host with a live WAL database (rows only in the -wal file), a folder and an age key pair. */
function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tara-backup-')));
  const db = path.join(root, 'app.db');
  const live = new DatabaseSync(db);
  live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  live.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE tags (name TEXT);');
  for (let i = 0; i < 25; i++) live.prepare('INSERT INTO notes (body) VALUES (?)').run(`note ${i}`);
  live.exec("INSERT INTO tags VALUES ('a'), ('b')");
  const big = path.join(root, 'big.db');
  const b = new DatabaseSync(big);
  b.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  b.close();
  const files = path.join(root, 'files');
  mkdirSync(path.join(files, 'Cache'), { recursive: true });
  writeFileSync(path.join(files, 'settings.json'), '{"a":1}');
  writeFileSync(path.join(files, 'Cache', 'junk.bin'), 'x'.repeat(1000));
  const keyFile = path.join(root, 'key.txt');
  spawnSync('age-keygen', ['-o', keyFile]);
  const recipient = /public key: (age1\S+)/.exec(readFileSync(keyFile, 'utf8'))?.[1] ?? '';
  const config = path.join(root, 'backup.json');
  const write = (extra: object[] = []) =>
    writeFileSync(
      config,
      JSON.stringify({
        host: 'test',
        localDir: path.join(root, 'out'),
        statusFile: path.join(root, 'status', 'status.json'),
        recipients: [recipient],
        items: [
          { name: 'app/app.db', sqlite: db },
          { name: 'app/big.db', sqlite: big, every: 'week' },
          { name: 'files', path: files, exclude: ['*Cache*'] },
          { name: 'gone', path: path.join(root, 'nope'), optional: true },
          ...extra,
        ],
      }),
    );
  write();
  return { root, live, config, keyFile, write };
}

function unpack(root: string, keyFile: string) {
  const out = path.join(root, 'out');
  const archive =
    readdirSync(out)
      .filter((f) => f.endsWith('.tar.gz.age'))
      .sort()
      .at(-1) ?? '';
  const dest = mkdtempSync(path.join(root, 'restore-'));
  const res = spawnSync('sh', [
    '-c',
    `age -d -i "$1" "$2" | tar -xzf - -C "$3"`,
    'sh',
    keyFile,
    path.join(out, archive),
    dest,
  ]);
  expect(res.status).toBe(0);
  return dest;
}

describe.skipIf(!hasAge)('tara-backup', () => {
  it('backs up a live WAL database and a folder, encrypted, and the copy restores and verifies', () => {
    const { root, live, config, keyFile } = setup();
    const res = tool(config, 'run');
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ok   app/app.db · 2 tables, 27 rows');
    expect(res.stdout).toContain('skip gone · not on this host');

    const status = JSON.parse(readFileSync(path.join(root, 'status', 'status.json'), 'utf8'));
    expect(status.lastRun.ok).toBe(true);
    expect(status.lastGood.archive.file).toMatch(/^test-\d{8}T\d{9}Z\.tar\.gz\.age$/);
    expect(status.included['app/big.db']).toBeDefined();
    // The archive on disk is encrypted: no table name in it.
    const enc = readFileSync(path.join(root, 'out', status.lastGood.archive.file));
    expect(enc.subarray(0, 21).toString()).toBe('age-encryption.org/v1');

    const dest = unpack(root, keyFile);
    const verified = tool(config, 'verify', dest);
    expect(verified.status).toBe(0);
    expect(
      JSON.parse(verified.stdout).items.map((i: { name: string; ok: boolean }) => [i.name, i.ok]),
    ).toEqual([
      ['app/app.db', true],
      ['app/big.db', true],
      ['files', true],
    ]);
    // The folder's excluded cache isn't in its tar.
    const listing = spawnSync('tar', ['-tzf', path.join(dest, 'files', 'files.tar.gz')], {
      encoding: 'utf8',
    }).stdout;
    expect(listing).toContain('settings.json');
    expect(listing).not.toContain('junk.bin');

    // Tampering with a restored database is caught.
    const copy = new DatabaseSync(path.join(dest, 'sqlite', 'app', 'app.db'));
    copy.exec('DELETE FROM notes WHERE id = 1');
    copy.close();
    const bad = tool(config, 'verify', dest);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).items[0].problems).toEqual(['sha256 differs', 'row counts differ']);
    live.close();
  });

  it('takes weekly items once a week, and a missing item fails the run but still writes the archive', () => {
    const { root, config, write } = setup();
    expect(tool(config, 'run').status).toBe(0);
    write([{ name: 'must', path: path.join(root, 'missing') }]);
    const second = tool(config, 'run');
    expect(second.status).toBe(1);
    expect(second.stdout).toMatch(/skip app\/big\.db · weekly, last in \d{4}-\d{2}-\d{2}/);
    expect(second.stdout).toContain('FAIL must · missing');
    const status = JSON.parse(readFileSync(path.join(root, 'status', 'status.json'), 'utf8'));
    expect(status.lastRun.ok).toBe(false);
    expect(status.lastRun.error).toContain('must:');
    expect(status.lastGood.ok).toBe(true);
    expect(readdirSync(path.join(root, 'out')).filter((f) => f.endsWith('.age'))).toHaveLength(2);
  });

  it('records restore test results and refuses a bad config', () => {
    const { root, config } = setup();
    expect(tool(config, 'restore-result', 'ok', 'x/test.tar.gz.age', '3 items').status).toBe(0);
    const status = JSON.parse(readFileSync(path.join(root, 'status', 'status.json'), 'utf8'));
    expect(status.restoreTest).toMatchObject({ ok: true, archive: 'x/test.tar.gz.age', message: '3 items' });

    writeFileSync(config, JSON.stringify({ recipients: ['nope'], items: [{ name: '../x', sqlite: 'rel' }] }));
    const res = tool(config, 'run');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('age public keys');
    expect(res.stderr).toContain('a/b/c style');
    expect(res.stderr).toContain('absolute path');
  });
});
