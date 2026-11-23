import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { backupDaily } from '../src/store/backup.js';
import { Store } from '../src/store/store.js';

describe('state database safety', () => {
  it('writes one checked copy a day and keeps the newest few', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tara-backup-'));
    const store = new Store(path.join(dir, 'tara.db'));
    store.recordRun({ kind: 'job', project: 'shop', jobId: 'sla', startedAt: 1, endedAt: 2, status: 'ok' });
    const backups = path.join(dir, 'backups');

    const first = backupDaily(store, backups, 2, '2026-11-20');
    expect(first.file).toBe(path.join(backups, 'tara-2026-11-20.db'));
    // Already there today: nothing new.
    expect(backupDaily(store, backups, 2, '2026-11-20').file).toBeUndefined();
    backupDaily(store, backups, 2, '2026-11-21');
    writeFileSync(path.join(backups, 'notes.txt'), 'not a copy');
    const third = backupDaily(store, backups, 2, '2026-11-22');
    expect(third.removed).toBe(1);
    expect(readdirSync(backups).sort()).toEqual(['notes.txt', 'tara-2026-11-21.db', 'tara-2026-11-22.db']);

    // The copy is a working database with the data in it.
    const copy = new Store(path.join(backups, 'tara-2026-11-22.db'));
    expect(copy.jobRuns('shop', 'sla', 5)).toHaveLength(1);
    copy.close();
    store.close();
  });

  it('says whether the database takes writes', () => {
    const store = new Store(':memory:');
    expect(store.checkWrite()).toBeUndefined();
    store.close();
    expect(store.checkWrite()).toMatch(/not open|closed/i);
  });

  it('refuses a database from a newer build', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'tara-newer-')), 'tara.db');
    new Store(file).close();
    const db = new DatabaseSync(file);
    const { user_version: v } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.close();
    expect(() => new Store(file)).toThrow(/newer than this build knows/);
  });
});
