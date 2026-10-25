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
}

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
];

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

  recordRun(r: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (kind, project, job_id, thread_key, session_id, model, started_at, ended_at, status,
           cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_calls,
           rate_limit_util, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  runsSince(since: number): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at')
      .all(since) as Record<string, unknown>[];
    return rows.map((r) => ({
      kind: r.kind as RunRecord['kind'],
      project: r.project as string,
      jobId: (r.job_id as string | null) ?? undefined,
      threadKey: (r.thread_key as string | null) ?? undefined,
      sessionId: (r.session_id as string | null) ?? undefined,
      model: (r.model as string | null) ?? undefined,
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number,
      status: r.status as string,
      costUsd: (r.cost_usd as number | null) ?? undefined,
      inputTokens: (r.input_tokens as number | null) ?? undefined,
      outputTokens: (r.output_tokens as number | null) ?? undefined,
      cacheReadTokens: (r.cache_read_tokens as number | null) ?? undefined,
      cacheCreationTokens: (r.cache_creation_tokens as number | null) ?? undefined,
      toolCalls: (r.tool_calls as number | null) ?? undefined,
      rateLimitUtilization: (r.rate_limit_util as number | null) ?? undefined,
      error: (r.error as string | null) ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}
