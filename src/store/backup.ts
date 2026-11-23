import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Store } from './store.js';

/** One copy per day, named by the host's local date. */
const BACKUP_FILE = /^tara-\d{4}-\d{2}-\d{2}\.db$/;

export interface BackupResult {
  /** The copy written today, or undefined when it already existed. */
  file?: string;
  /** Older copies deleted to keep `keep`. */
  removed: number;
}

/**
 * Today's copy of the state database (`<dir>/tara-YYYY-MM-DD.db`), when there isn't one yet, then
 * deletes all but the newest `keep`. The copy is written under a temporary name and checked
 * (`quick_check`) before it takes its real name, so a file with a date is always a good copy. Throws
 * when the copy fails or the check finds damage: the live database is then most likely damaged too.
 */
export function backupDaily(store: Store, dir: string, keep: number, day: string): BackupResult {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `tara-${day}.db`);
  let written: string | undefined;
  if (!existsSync(file)) {
    const tmp = `${file}.tmp`;
    rmSync(tmp, { force: true });
    try {
      const check = store.backupTo(tmp);
      if (check !== 'ok') throw new Error(`the copy failed its integrity check: ${check.slice(0, 300)}`);
      renameSync(tmp, file);
      written = file;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  const copies = readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort();
  const old = copies.slice(0, Math.max(0, copies.length - keep));
  for (const name of old) rmSync(path.join(dir, name), { force: true });
  return { file: written, removed: old.length };
}
