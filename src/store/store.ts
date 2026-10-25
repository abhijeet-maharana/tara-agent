import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SessionRow {
  /** `<channel>:<thread ts>` */
  threadKey: string;
  project: string;
  sessionId: string;
  model: string;
  /** The CLI has created the session, so the next turn uses `--resume`. */
  started: boolean;
}

export interface RunRecord {
  kind: 'chat' | 'job';
  project: string;
  jobId?: string;
  threadKey?: string;
  sessionId?: string;
  model?: string;
  startedAt: number;
  endedAt: number;
  status: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCalls?: number;
  rateLimitUtilization?: number;
  error?: string;
  /** Final reply text (jobs only), capped. */
  output?: string;
  /** Pre-run script output (jobs only), capped. */
  scriptOutput?: string;
}

export interface StoredRun extends RunRecord {
  id: number;
}

const OUTPUT_CAP = 20_000;

const MIGRATIONS = [
  `CREATE TABLE sessions (
     thread_key TEXT PRIMARY KEY,
     project    TEXT NOT NULL,
     session_id TEXT NOT NULL,
     model      TEXT NOT NULL,
     started    INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE runs (
     id                    INTEGER PRIMARY KEY AUTOINCREMENT,
     kind                  TEXT NOT NULL,
     project               TEXT NOT NULL,
     job_id                TEXT,
     thread_key            TEXT,
     session_id            TEXT,
     model                 TEXT,
     started_at            INTEGER NOT NULL,
     ended_at              INTEGER NOT NULL,
     status                TEXT NOT NULL,
     cost_usd              REAL,
     input_tokens          INTEGER,
     output_tokens         INTEGER,
     cache_read_tokens     INTEGER,
     cache_creation_tokens INTEGER,
     tool_calls            INTEGER,
     rate_limit_util       REAL,
     error                 TEXT
   );
   CREATE INDEX runs_started ON runs (started_at);`,
  `CREATE TABLE job_claims (
     job_key    TEXT NOT NULL,
     slot       INTEGER NOT NULL,
     status     TEXT NOT NULL,
     claimed_at INTEGER NOT NULL,
     PRIMARY KEY (job_key, slot)
   );
   CREATE TABLE job_seen (
     job_key    TEXT PRIMARY KEY,
     first_seen INTEGER NOT NULL
   );`,
  `ALTER TABLE runs ADD COLUMN output TEXT;
   ALTER TABLE runs ADD COLUMN script_output TEXT;
   CREATE INDEX runs_job ON runs (project, job_id, started_at);`,
];

function toRun(r: Record<string, unknown>): StoredRun {
  const opt = <T>(v: unknown) => (v ?? undefined) as T | undefined;
  return {
    id: r.id as number,
    kind: r.kind as RunRecord['kind'],
    project: r.project as string,
    jobId: opt(r.job_id),
    threadKey: opt(r.thread_key),
    sessionId: opt(r.session_id),
    model: opt(r.model),
    startedAt: r.started_at as number,
    endedAt: r.ended_at as number,
    status: r.status as string,
    costUsd: opt(r.cost_usd),
    inputTokens: opt(r.input_tokens),
    outputTokens: opt(r.output_tokens),
    cacheReadTokens: opt(r.cache_read_tokens),
    cacheCreationTokens: opt(r.cache_creation_tokens),
    toolCalls: opt(r.tool_calls),
    rateLimitUtilization: opt(r.rate_limit_util),
    error: opt(r.error),
    output: opt(r.output),
    scriptOutput: opt(r.script_output),
  };
}

/** SQLite state: sessions and run history. Lives outside every project repo. */
export class Store {
  private readonly db: DatabaseSync;

  /** `file` is a path, or `:memory:` for tests. */
  constructor(
    file: string,
    private readonly now: () => number = Date.now,
  ) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  getSession(threadKey: string): SessionRow | undefined {
    const row = this.db
      .prepare('SELECT thread_key, project, session_id, model, started FROM sessions WHERE thread_key = ?')
      .get(threadKey) as
      | { thread_key: string; project: string; session_id: string; model: string; started: number }
      | undefined;
    return row
      ? {
          threadKey: row.thread_key,
          project: row.project,
          sessionId: row.session_id,
          model: row.model,
          started: row.started === 1,
        }
      : undefined;
  }

  saveSession(s: SessionRow): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (thread_key, project, session_id, model, started, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_key) DO UPDATE SET
           project = excluded.project, session_id = excluded.session_id, model = excluded.model,
           started = excluded.started, updated_at = excluded.updated_at`,
      )
      .run(s.threadKey, s.project, s.sessionId, s.model, s.started ? 1 : 0, t, t);
  }

  deleteSession(threadKey: string): void {
    this.db.prepare('DELETE FROM sessions WHERE thread_key = ?').run(threadKey);
  }

  /** Stores a finished run and returns its id. */
  recordRun(r: RunRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO runs (kind, project, job_id, thread_key, session_id, model, started_at, ended_at, status,
           cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_calls,
           rate_limit_util, error, output, script_output)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.kind,
        r.project,
        r.jobId ?? null,
        r.threadKey ?? null,
        r.sessionId ?? null,
        r.model ?? null,
        r.startedAt,
        r.endedAt,
        r.status,
        r.costUsd ?? null,
        r.inputTokens ?? null,
        r.outputTokens ?? null,
        r.cacheReadTokens ?? null,
        r.cacheCreationTokens ?? null,
        r.toolCalls ?? null,
        r.rateLimitUtilization ?? null,
        r.error ?? null,
        r.output?.slice(0, OUTPUT_CAP) ?? null,
        r.scriptOutput?.slice(0, OUTPUT_CAP) ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  runsSince(since: number): StoredRun[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at').all(since);
    return (rows as Record<string, unknown>[]).map(toRun);
  }

  /** A job's runs, newest first. */
  jobRuns(project: string, jobId: string, limit: number): StoredRun[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE project = ? AND job_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(project, jobId, limit);
    return (rows as Record<string, unknown>[]).map(toRun);
  }

  getRun(id: number): StoredRun | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRun(row as Record<string, unknown>) : undefined;
  }

  /**
   * Claims one scheduled slot of a job. Returns false when it was already claimed (by an earlier run or
   * a previous process), so every slot runs at most once.
   */
  claimSlot(jobKey: string, slot: number): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO job_claims (job_key, slot, status, claimed_at) VALUES (?, ?, 'running', ?)
         ON CONFLICT (job_key, slot) DO NOTHING`,
      )
      .run(jobKey, slot, this.now());
    return result.changes > 0;
  }

  finishSlot(jobKey: string, slot: number, status: string): void {
    this.db
      .prepare('UPDATE job_claims SET status = ? WHERE job_key = ? AND slot = ?')
      .run(status, jobKey, slot);
  }

  /** When this job was first scheduled on this host. Recorded on the first call. */
  firstSeen(jobKey: string): number {
    this.db
      .prepare('INSERT INTO job_seen (job_key, first_seen) VALUES (?, ?) ON CONFLICT (job_key) DO NOTHING')
      .run(jobKey, this.now());
    const row = this.db.prepare('SELECT first_seen FROM job_seen WHERE job_key = ?').get(jobKey) as {
      first_seen: number;
    };
    return row.first_seen;
  }

  /** Most recent run of a job, if any. */
  lastJobRun(project: string, jobId: string): StoredRun | undefined {
    return this.jobRuns(project, jobId, 1)[0];
  }

  close(): void {
    this.db.close();
  }
}
