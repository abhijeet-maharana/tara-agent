import { randomBytes } from 'node:crypto';
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
  /** `learn`: the follow-up turn after a job run that had trouble (see `selfImprove`). */
  kind: 'chat' | 'job' | 'learn';
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

/** A session with when it was used and its latest run, for the dashboard. */
export interface SessionOverview extends SessionRow {
  createdAt: number;
  updatedAt: number;
  turns: number;
  lastRun?: StoredRun;
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
  `CREATE TABLE approvals (
     id          TEXT PRIMARY KEY,
     project     TEXT NOT NULL,
     channel     TEXT NOT NULL,
     thread_ts   TEXT NOT NULL,
     message_ts  TEXT,
     title       TEXT NOT NULL,
     options     TEXT NOT NULL,
     status      TEXT NOT NULL DEFAULT 'pending',
     decided_by  TEXT,
     decision    TEXT,
     created_at  INTEGER NOT NULL,
     decided_at  INTEGER
   );`,
  `CREATE TABLE inbox (
     id         TEXT PRIMARY KEY,
     project    TEXT NOT NULL,
     key        TEXT,
     title      TEXT NOT NULL,
     details    TEXT,
     level      TEXT NOT NULL,
     source     TEXT NOT NULL,
     link       TEXT,
     due_at     INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     done_at    INTEGER
   );
   CREATE INDEX inbox_open ON inbox (project, done_at);`,
  // Approval items replace the Slack-only approvals table: one card for a paused run (`resume`) or a
  // draft that runs later through a queue (`queue`). Old approvals are kept as decided items.
  `CREATE TABLE items (
     id          TEXT PRIMARY KEY,
     project     TEXT NOT NULL,
     kind        TEXT NOT NULL,
     key         TEXT,
     mode        TEXT NOT NULL,
     title       TEXT NOT NULL,
     body        TEXT,
     media       TEXT NOT NULL DEFAULT '[]',
     fields      TEXT NOT NULL DEFAULT '[]',
     checks      TEXT NOT NULL DEFAULT '[]',
     options     TEXT NOT NULL,
     source      TEXT,
     job_id      TEXT,
     channel     TEXT,
     thread_ts   TEXT,
     message_ts  TEXT,
     queue       TEXT,
     window      TEXT,
     run_after   INTEGER,
     run_now     INTEGER NOT NULL DEFAULT 0,
     status      TEXT NOT NULL,
     decision    TEXT,
     reply       TEXT,
     decided_by  TEXT,
     decided_at  INTEGER,
     seal        TEXT,
     result      TEXT,
     started_at  INTEGER,
     finished_at INTEGER,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   );
   CREATE INDEX items_status ON items (project, status);
   CREATE INDEX items_queue ON items (project, queue, status);
   CREATE TABLE queue_state (
     project   TEXT NOT NULL,
     queue     TEXT NOT NULL,
     last_slot INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (project, queue)
   );
   INSERT INTO items (id, project, kind, mode, title, options, channel, thread_ts, message_ts, status,
       decision, decided_by, decided_at, created_at, updated_at)
     SELECT id, project, 'decision', 'resume', title, options, channel, thread_ts, message_ts,
       CASE WHEN status = 'pending' THEN 'pending'
            WHEN lower(decision) GLOB 'reject*' OR lower(decision) GLOB 'deny*' OR lower(decision) GLOB 'no*'
              OR lower(decision) GLOB 'cancel*' OR lower(decision) GLOB 'stop*' OR lower(decision) GLOB 'decline*'
            THEN 'rejected' ELSE 'approved' END,
       decision, decided_by, decided_at, created_at, COALESCE(decided_at, created_at)
     FROM approvals;
   DROP TABLE approvals;`,
  // A decided paused-run card is finished (the decision went to the run); only drafts wait in a queue.
  `UPDATE items SET status = 'done', finished_at = decided_at WHERE mode = 'resume' AND status = 'approved';`,
];

export const TASK_LEVELS = ['urgent', 'decide', 'later'] as const;
export type TaskLevel = (typeof TASK_LEVELS)[number];

/** Something only a person can do, left by a run (or added by hand) in a project's inbox. */
export interface Task {
  id: string;
  project: string;
  /** Stable dedupe key (`<job-or-skill>:<period-or-entity>`): adding it again updates the open task. */
  key?: string;
  title: string;
  details?: string;
  level: TaskLevel;
  /** Job id or skill that added it, or `manual`. */
  source: string;
  link?: string;
  dueAt?: number;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
}

export type TaskInput = Pick<Task, 'project' | 'title' | 'level'> &
  Partial<Pick<Task, 'key' | 'details' | 'source' | 'link' | 'dueAt' | 'createdAt'>>;

/** Done tasks are kept this long, for "Done today" and Undo. */
const DONE_RETENTION_MS = 30 * 86_400_000;

function toTask(r: Record<string, unknown>): Task {
  const opt = <T>(v: unknown) => (v ?? undefined) as T | undefined;
  return {
    id: r.id as string,
    project: r.project as string,
    key: opt(r.key),
    title: r.title as string,
    details: opt(r.details),
    level: r.level as TaskLevel,
    source: r.source as string,
    link: opt(r.link),
    dueAt: opt(r.due_at),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    doneAt: opt(r.done_at),
  };
}

export const ITEM_STATUSES = [
  'pending',
  'approved',
  'running',
  'done',
  'failed',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** An editable value on an approval card (a note, an email body, a caption). */
export interface ItemField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'list';
  value: string | string[];
  maxLength?: number;
  required?: boolean;
  readOnly?: boolean;
}

/** A problem with an item; a blocking one stops it from being approved. */
export interface ItemCheck {
  text: string;
  blocking: boolean;
}

export interface ItemMedia {
  /** `file`: a link (e.g. a PDF carousel), shown as a link chip. */
  type: 'image' | 'video' | 'file';
  url: string;
  caption?: string;
  /** Videos: the still shown before play (e.g. a reel's cover). */
  poster?: string;
}

/**
 * An approval card. `resume`: a run stopped for a decision and continues with it. `queue`: a draft
 * that, once approved, runs later through one of the project's queues (`.tara/queues.json`).
 */
export interface Item {
  id: string;
  project: string;
  kind: string;
  /** Proposing the same key again updates the pending item instead of adding one. */
  key?: string;
  mode: 'resume' | 'queue';
  title: string;
  body?: string;
  media: ItemMedia[];
  fields: ItemField[];
  checks: ItemCheck[];
  options: string[];
  /** Job id or skill that proposed it. */
  source?: string;
  /** The job whose run asked (resume mode continues that job). */
  jobId?: string;
  channel?: string;
  threadTs?: string;
  /** The Slack card, for resume items. */
  messageTs?: string;
  queue?: string;
  /** Window key in the queue's config, e.g. `EU`. */
  window?: string;
  /** Not before this time. */
  runAfter?: number;
  /** Approved with "run now": skips the queue's windows and slots (caps still apply). */
  runNow: boolean;
  status: ItemStatus;
  decision?: string;
  reply?: string;
  decidedBy?: string;
  decidedAt?: number;
  seal?: string;
  result?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ItemInput = Pick<Item, 'project' | 'kind' | 'mode' | 'title' | 'options'> &
  Partial<
    Pick<
      Item,
      | 'id'
      | 'key'
      | 'body'
      | 'media'
      | 'fields'
      | 'checks'
      | 'source'
      | 'jobId'
      | 'channel'
      | 'threadTs'
      | 'queue'
      | 'window'
      | 'runAfter'
    >
  >;

/** Done, failed and other finished items are kept this long. */
const ITEM_RETENTION_MS = 60 * 86_400_000;

function toItem(r: Record<string, unknown>): Item {
  const opt = <T>(v: unknown) => (v ?? undefined) as T | undefined;
  return {
    id: r.id as string,
    project: r.project as string,
    kind: r.kind as string,
    key: opt(r.key),
    mode: r.mode as Item['mode'],
    title: r.title as string,
    body: opt(r.body),
    media: JSON.parse(r.media as string) as ItemMedia[],
    fields: JSON.parse(r.fields as string) as ItemField[],
    checks: JSON.parse(r.checks as string) as ItemCheck[],
    options: JSON.parse(r.options as string) as string[],
    source: opt(r.source),
    jobId: opt(r.job_id),
    channel: opt(r.channel),
    threadTs: opt(r.thread_ts),
    messageTs: opt(r.message_ts),
    queue: opt(r.queue),
    window: opt(r.window),
    runAfter: opt(r.run_after),
    runNow: r.run_now === 1,
    status: r.status as ItemStatus,
    decision: opt(r.decision),
    reply: opt(r.reply),
    decidedBy: opt(r.decided_by),
    decidedAt: opt(r.decided_at),
    seal: opt(r.seal),
    result: opt(r.result),
    startedAt: opt(r.started_at),
    finishedAt: opt(r.finished_at),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

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

  /** Sessions, most recently active first, each with its latest run. */
  sessionsOverview(opts: { project?: string; sessionId?: string; limit?: number } = {}): SessionOverview[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.project) {
      where.push('s.project = ?');
      args.push(opts.project);
    }
    if (opts.sessionId) {
      where.push('s.session_id = ?');
      args.push(opts.sessionId);
    }
    const rows = this.db
      .prepare(
        `SELECT s.thread_key, s.project, s.session_id, s.model, s.started, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM runs x WHERE x.thread_key = s.thread_key) AS turns,
           (SELECT id FROM runs x WHERE x.thread_key = s.thread_key ORDER BY x.started_at DESC LIMIT 1) AS last_run_id
         FROM sessions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY COALESCE((SELECT MAX(x.started_at) FROM runs x WHERE x.thread_key = s.thread_key), s.updated_at) DESC
         LIMIT ?`,
      )
      .all(...args, opts.limit ?? 200) as Record<string, unknown>[];
    return rows.map((r) => ({
      threadKey: r.thread_key as string,
      project: r.project as string,
      sessionId: r.session_id as string,
      model: r.model as string,
      started: r.started === 1,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      turns: r.turns as number,
      lastRun: r.last_run_id ? this.getRun(r.last_run_id as number) : undefined,
    }));
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
      .prepare(
        "SELECT * FROM runs WHERE kind = 'job' AND project = ? AND job_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(project, jobId, limit);
    return (rows as Record<string, unknown>[]).map(toRun);
  }

  /** The latest job runs of every project, newest first. */
  recentJobRuns(limit: number): StoredRun[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE kind = 'job' ORDER BY started_at DESC LIMIT ?")
      .all(limit);
    return (rows as Record<string, unknown>[]).map(toRun);
  }

  getRun(id: number): StoredRun | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRun(row as Record<string, unknown>) : undefined;
  }

  /**
   * Claims one scheduled slot of a job. Returns false when it was already claimed, so every slot runs
   * at most once. Two exceptions may be claimed again: a run stopped by a shutdown (`aborted`), and a
   * claim still `running` from before `retakeBefore` (its process died without finishing it).
   */
  claimSlot(jobKey: string, slot: number, retakeBefore = 0): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO job_claims (job_key, slot, status, claimed_at) VALUES (?, ?, 'running', ?)
         ON CONFLICT (job_key, slot) DO UPDATE SET status = 'running', claimed_at = excluded.claimed_at
         WHERE job_claims.status = 'aborted' OR (job_claims.status = 'running' AND job_claims.claimed_at < ?)`,
      )
      .run(jobKey, slot, this.now(), retakeBefore);
    return result.changes > 0;
  }

  /** Slots of a job claimed in [from, to], for spotting missed runs. */
  claimedSlots(jobKey: string, from: number, to: number): Set<number> {
    const rows = this.db
      .prepare('SELECT slot FROM job_claims WHERE job_key = ? AND slot BETWEEN ? AND ?')
      .all(jobKey, from, to) as { slot: number }[];
    return new Set(rows.map((r) => r.slot));
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

  /** Adds an approval item, or updates the pending item of the same project with the same `key`. */
  proposeItem(input: ItemInput): Item {
    const t = this.now();
    const existing = input.key
      ? (this.db
          .prepare("SELECT id FROM items WHERE project = ? AND key = ? AND status = 'pending'")
          .get(input.project, input.key) as { id: string } | undefined)
      : undefined;
    const values = {
      kind: input.kind,
      mode: input.mode,
      title: input.title.trim(),
      body: input.body?.trim() || null,
      media: JSON.stringify(input.media ?? []),
      fields: JSON.stringify(input.fields ?? []),
      checks: JSON.stringify(input.checks ?? []),
      options: JSON.stringify(input.options),
      source: input.source ?? null,
      job_id: input.jobId ?? null,
      channel: input.channel ?? null,
      thread_ts: input.threadTs ?? null,
      queue: input.queue ?? null,
      window: input.window ?? null,
      run_after: input.runAfter ?? null,
    };
    const cols = Object.keys(values);
    if (existing) {
      this.db
        .prepare(
          `UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')}, reply = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(...(Object.values(values) as (string | number | null)[]), t, existing.id);
      return this.getItem(existing.id) as Item;
    }
    const id = input.id ?? randomBytes(6).toString('hex');
    this.db
      .prepare(
        `INSERT INTO items (id, project, key, status, created_at, updated_at, ${cols.join(', ')})
         VALUES (?, ?, ?, 'pending', ?, ?, ${cols.map(() => '?').join(', ')})`,
      )
      .run(
        id,
        input.project,
        input.key ?? null,
        t,
        t,
        ...(Object.values(values) as (string | number | null)[]),
      );
    return this.getItem(id) as Item;
  }

  getItem(id: string): Item | undefined {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    return row ? toItem(row as Record<string, unknown>) : undefined;
  }

  /** Items, newest first (or by approval for `approved`, the order queues run them). */
  items(
    filter: {
      project?: string;
      kind?: string;
      queue?: string;
      statuses?: ItemStatus[];
      since?: number;
      limit?: number;
    } = {},
  ): Item[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const add = (sql: string, ...values: (string | number)[]) => {
      where.push(sql);
      args.push(...values);
    };
    if (filter.project) add('project = ?', filter.project);
    if (filter.kind) add('kind = ?', filter.kind);
    if (filter.queue) add('queue = ?', filter.queue);
    if (filter.statuses?.length)
      add(`status IN (${filter.statuses.map(() => '?').join(', ')})`, ...filter.statuses);
    if (filter.since !== undefined) add('updated_at >= ?', filter.since);
    const order =
      filter.statuses?.length === 1 && filter.statuses[0] === 'approved'
        ? 'decided_at, created_at'
        : 'created_at DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`,
      )
      .all(...args, filter.limit ?? 500);
    return (rows as Record<string, unknown>[]).map(toItem);
  }

  setItemMessage(id: string, messageTs: string): void {
    this.db.prepare('UPDATE items SET message_ts = ? WHERE id = ?').run(messageTs, id);
  }

  /** New field values (and the checks for them) on a pending item. */
  updateItemFields(id: string, fields: ItemField[], checks: ItemCheck[]): Item | undefined {
    this.db
      .prepare("UPDATE items SET fields = ?, checks = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(JSON.stringify(fields), JSON.stringify(checks), this.now(), id);
    return this.getItem(id);
  }

  /**
   * Records the decision once. Undefined when the item was already decided (double tap, two people,
   * Slack and the dashboard at the same time).
   */
  decideItem(
    id: string,
    d: {
      status: 'approved' | 'rejected' | 'done';
      decision: string;
      by: string;
      reply?: string;
      seal?: string;
      runNow?: boolean;
    },
  ): Item | undefined {
    const t = this.now();
    const result = this.db
      .prepare(
        `UPDATE items SET status = ?, decision = ?, decided_by = ?, decided_at = ?, reply = ?, seal = ?, run_now = ?,
           finished_at = CASE WHEN ? = 'approved' THEN NULL ELSE ? END, updated_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(
        d.status,
        d.decision,
        d.by,
        t,
        d.reply ?? null,
        d.seal ?? null,
        d.runNow ? 1 : 0,
        d.status,
        t,
        t,
        id,
      );
    return result.changes > 0 ? this.getItem(id) : undefined;
  }

  /** A revise request on a pending item: it stays pending until the new draft replaces it. */
  noteRevision(id: string, reply: string): Item | undefined {
    this.db
      .prepare("UPDATE items SET reply = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(reply, this.now(), id);
    return this.getItem(id);
  }

  /** Moves approved items to running; returns the ones it moved (never one twice). */
  startItems(ids: string[]): Item[] {
    const t = this.now();
    const started: Item[] = [];
    for (const id of ids) {
      const r = this.db
        .prepare(
          "UPDATE items SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'",
        )
        .run(t, t, id);
      if (r.changes > 0) started.push(this.getItem(id) as Item);
    }
    return started;
  }

  /** The executor's report for one running item. */
  finishItem(id: string, status: 'done' | 'failed', result?: string): Item | undefined {
    const t = this.now();
    const r = this.db
      .prepare(
        "UPDATE items SET status = ?, result = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(status, result?.slice(0, 4_000) ?? null, t, t, id);
    return r.changes > 0 ? this.getItem(id) : undefined;
  }

  /** A status line on an approved or running item ("comment posted; the note goes out Wednesday"), or why it was withdrawn. */
  noteItem(id: string, result: string | undefined): Item | undefined {
    this.db
      .prepare(
        "UPDATE items SET result = ?, updated_at = ? WHERE id = ? AND status IN ('approved', 'running', 'cancelled')",
      )
      .run(result?.slice(0, 4_000) ?? null, this.now(), id);
    return this.getItem(id);
  }

  /**
   * The executor could not take a running item yet (a daily cap, a pause): back to approved, not
   * before `runAfter`, with why in `result`. It no longer counts against the queue's caps.
   */
  deferItem(id: string, runAfter: number, note?: string): Item | undefined {
    const r = this.db
      .prepare(
        "UPDATE items SET status = 'approved', started_at = NULL, run_after = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(runAfter, note?.slice(0, 4_000) ?? null, this.now(), id);
    return r.changes > 0 ? this.getItem(id) : undefined;
  }

  /** Running items nobody reported (the run ended or tara-agent restarted): failed, never run again. */
  failRunning(reason: string, ids?: string[]): Item[] {
    if (ids && !ids.length) return [];
    const running = this.items({ statuses: ['running'], limit: 1000 }).filter(
      (i) => !ids || ids.includes(i.id),
    );
    return running.map((i) => this.finishItem(i.id, 'failed', reason)).filter((i): i is Item => Boolean(i));
  }

  cancelItem(id: string, by: string): Item | undefined {
    const t = this.now();
    const r = this.db
      .prepare(
        `UPDATE items SET status = 'cancelled', decided_by = COALESCE(decided_by, ?), updated_at = ?
         WHERE id = ? AND status IN ('pending', 'approved')`,
      )
      .run(by, t, id);
    return r.changes > 0 ? this.getItem(id) : undefined;
  }

  /** Pending items (of one project) older than `before` expire; old finished items are deleted. */
  expireItems(before: number, project?: string): number {
    const t = this.now();
    const changed = this.db
      .prepare(
        `UPDATE items SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at < ?${
          project ? ' AND project = ?' : ''
        }`,
      )
      .run(t, before, ...(project ? [project] : [])).changes;
    this.db
      .prepare(
        "DELETE FROM items WHERE status IN ('done', 'failed', 'rejected', 'expired', 'cancelled') AND updated_at < ?",
      )
      .run(t - ITEM_RETENTION_MS);
    return Number(changed);
  }

  /** Items of a queue that started since `since` (for caps), newest first. */
  queueStarts(project: string, queue: string, since: number): Item[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM items WHERE project = ? AND queue = ? AND started_at >= ? ORDER BY started_at DESC',
      )
      .all(project, queue, since);
    return (rows as Record<string, unknown>[]).map(toItem);
  }

  /** The latest item a queue started, whenever it was. */
  lastQueueStart(project: string, queue: string): Item | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM items WHERE project = ? AND queue = ? AND started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1',
      )
      .get(project, queue);
    return row ? toItem(row as Record<string, unknown>) : undefined;
  }

  lastSlot(project: string, queue: string): number {
    const row = this.db
      .prepare('SELECT last_slot FROM queue_state WHERE project = ? AND queue = ?')
      .get(project, queue) as { last_slot: number } | undefined;
    return row?.last_slot ?? 0;
  }

  setLastSlot(project: string, queue: string, slot: number): void {
    this.db
      .prepare(
        `INSERT INTO queue_state (project, queue, last_slot) VALUES (?, ?, ?)
         ON CONFLICT (project, queue) DO UPDATE SET last_slot = excluded.last_slot`,
      )
      .run(project, queue, slot);
  }

  /** Adds a task, or updates the open task of the same project with the same `key`. */
  addTask(input: TaskInput): Task {
    const t = this.now();
    const existing = input.key
      ? (this.db
          .prepare('SELECT id FROM inbox WHERE project = ? AND key = ? AND done_at IS NULL')
          .get(input.project, input.key) as { id: string } | undefined)
      : undefined;
    const fields = [
      input.title.trim(),
      input.details?.trim() || null,
      input.level,
      input.source || 'manual',
      input.link || null,
      input.dueAt ?? null,
    ];
    if (existing) {
      this.db
        .prepare(
          'UPDATE inbox SET title = ?, details = ?, level = ?, source = ?, link = ?, due_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(...fields, t, existing.id);
      return this.getTask(existing.id) as Task;
    }
    const id = randomBytes(5).toString('hex');
    this.db
      .prepare(
        `INSERT INTO inbox (id, project, key, title, details, level, source, link, due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.project, input.key || null, ...fields, input.createdAt ?? t, t);
    return this.getTask(id) as Task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
    return row ? toTask(row as Record<string, unknown>) : undefined;
  }

  /** Open tasks (or done since `doneSince`), most urgent first, then by due date and age. */
  tasks(opts: { project?: string; doneSince?: number } = {}): Task[] {
    const where = [opts.doneSince === undefined ? 'done_at IS NULL' : 'done_at >= ?'];
    const args: (string | number)[] = opts.doneSince === undefined ? [] : [opts.doneSince];
    if (opts.project) {
      where.push('project = ?');
      args.push(opts.project);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox WHERE ${where.join(' AND ')}
         ORDER BY CASE level WHEN 'urgent' THEN 0 WHEN 'decide' THEN 1 ELSE 2 END,
           COALESCE(due_at, 9e15), created_at`,
      )
      .all(...args);
    return (rows as Record<string, unknown>[]).map(toTask);
  }

  /** Marks a task done (or open again). Returns it, or undefined when there is no such task. */
  setTaskDone(id: string, done: boolean): Task | undefined {
    const t = this.now();
    this.db.prepare('UPDATE inbox SET done_at = ?, updated_at = ? WHERE id = ?').run(done ? t : null, t, id);
    this.db.prepare('DELETE FROM inbox WHERE done_at < ?').run(t - DONE_RETENTION_MS);
    return this.getTask(id);
  }

  /**
   * Marks done the open tasks of a project with this key, or, with `suffix`, every open task whose
   * key ends in `:<entity>` (all tasks about one content item, whichever job added them).
   */
  closeTasks(project: string, match: { key?: string; suffix?: string }): Task[] {
    const open = this.tasks({ project }).filter((task) =>
      match.key ? task.key === match.key : match.suffix ? task.key?.endsWith(`:${match.suffix}`) : false,
    );
    return open.map((task) => this.setTaskDone(task.id, true) as Task);
  }

  close(): void {
    this.db.close();
  }
}
