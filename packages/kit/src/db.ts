import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A project's own database: one SQLite file that only the project's service opens for writing. Agents,
 * scripts and tara-agent's Data tab reach it through the service's data API (data.ts), never the file.
 *
 * Schema: numbered SQL files (`001-name.sql`, `002-…`) in `migrationsDir` (by convention
 * `<repo>/.tara/db/migrations`), applied in order on first open, each in its own transaction, tracked
 * with `PRAGMA user_version`. A gap or a duplicate number throws: it is a bug, not something to skip.
 *
 * Keep the file outside the repo: a file sync (Mutagen, Dropbox) copying a live SQLite file corrupts it.
 */

export interface ProjectDb {
  /** The read-write connection, opened (and migrated) on first use. */
  db(): DatabaseSync;
  /** A read-only connection for ad hoc SQL: it can't change anything, whatever the query. */
  readOnly(): DatabaseSync;
  /** Runs `fn` in one write transaction; rolls back when it throws. */
  transaction<T>(fn: (db: DatabaseSync) => T): T;
  /** Closes both connections (tests, and before swapping the file in a restore). */
  close(): void;
  readonly file: string;
}

export interface OpenDbOptions {
  file: string;
  migrationsDir: string;
  /** Called once per migration applied. */
  log?: (message: string) => void;
}

/** Migration files in order: `001-name.sql` is version 1. */
export function migrationFiles(dir: string): Array<{ version: number; file: string }> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}-[\w-]+\.sql$/.test(f))
    .sort();
  return files.map((file, i) => {
    const version = Number.parseInt(file.slice(0, 3), 10);
    if (version !== i + 1)
      throw new Error(`${dir}: expected ${String(i + 1).padStart(3, '0')}-*.sql, found ${file}`);
    return { version, file };
  });
}

function migrate(db: DatabaseSync, dir: string, log?: (m: string) => void): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const all = migrationFiles(dir);
  if (current > all.length)
    throw new Error(
      `The database is at schema version ${current}, newer than the ${all.length} migrations here. Deploy the newer code, or restore a backup taken before it.`,
    );
  for (const { version, file } of all) {
    if (version <= current) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
      log?.(`[db] applied migration ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`db migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

export function openDb({ file, migrationsDir, log }: OpenDbOptions): ProjectDb {
  let main: DatabaseSync | undefined;
  let reader: DatabaseSync | undefined;
  const db = () => {
    if (main) return main;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const conn = new DatabaseSync(file);
    conn.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;',
    );
    try {
      migrate(conn, migrationsDir, log);
    } catch (err) {
      conn.close();
      throw err;
    }
    main = conn;
    return main;
  };
  return {
    file,
    db,
    readOnly() {
      if (reader) return reader;
      db(); // creates and migrates the file first
      reader = new DatabaseSync(file, { readOnly: true });
      reader.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');
      return reader;
    },
    transaction(fn) {
      const conn = db();
      conn.exec('BEGIN IMMEDIATE');
      try {
        const out = fn(conn);
        conn.exec('COMMIT');
        return out;
      } catch (err) {
        conn.exec('ROLLBACK');
        throw err;
      }
    },
    close() {
      reader?.close();
      main?.close();
      reader = main = undefined;
    },
  };
}
