import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Harness } from '../config/schema.js';
import type { VmHostSample } from '../health/vmhost.js';

export interface SessionRow {
  /** `<channel>:<thread ts>` */
  threadKey: string;
  project: string;
  sessionId: string;
  model: string;
  /** The CLI has created the session, so the next turn uses `--resume`. */
  started: boolean;
  /** The CLI the session lives in (unset: claude); a later turn must use the same one. */
  harness?: Harness;
  /**
   * The id the job's scratch folder is named after (unset: `sessionId`): the id the run started with,
   * kept when agy reports its own conversation id or a handoff starts a new session.
   */
  scratchId?: string;
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
  /** As the CLI reports it: the session's running total (recordRun stores this run's share). */
  costUsd?: number;
  /**
   * Cost of other sessions that belong to this run (a job's steps, each a fresh session), added to the
   * stored cost but not to the session's running total. Only set when recording.
   */
  extraCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** The session's context size when the run ended (its last model call's input + cache tokens). */
  contextTokens?: number;
  toolCalls?: number;
  rateLimitUtilization?: number;
  error?: string;
  /** Final reply text (jobs only), capped. */
  output?: string;
  /** Pre-run script output (jobs only), capped. */
  scriptOutput?: string;
}

/** A chat message waiting for (or in) its turn (`Store.addInbox`). */
export interface InboxMessage {
  id: number;
  channel: string;
  threadTs: string;
  ts: string;
  user: string;
  text: string;
  summary?: string;
  mention?: string;
  /** How many files came with it (they can't be fetched again after a restart). */
  files: number;
  receivedAt: number;
  /** When its turn started; unset: it was still waiting. */
  startedAt?: number;
}

/** Where a decision on a card is acted on: a fresh session, or the one that raised the card. */
export type SessionMode = 'new' | 'continue';

/** A thread's session as a card's advice sees it (`Store.threadState`). */
export interface ThreadState {
  turns: number;
  /** When its latest run ended. */
  lastAt: number;
  contextTokens?: number;
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
  /** The job whose thread this is, when any run in it belongs to a job (a reply in a job's thread too). */
  jobId?: string;
}

export type HealthStatus = 'ok' | 'warn' | 'bad';

/** A health check's confirmed state: since when, and whether its problem was sent to Slack. */
export interface HealthState {
  status: HealthStatus;
  since: number;
  detail?: string;
  /** The check's name and group as last shown ("WhatsApp (Services)"), for a message after it is gone. */
  label?: string;
  alerted: boolean;
}

export interface HealthEvent {
  key: string;
  status: HealthStatus;
  detail?: string;
  at: number;
}

/** A run without its texts, for charts and tables over many runs. */
export type RunStat = Pick<
  StoredRun,
  | 'kind'
  | 'project'
  | 'jobId'
  | 'model'
  | 'startedAt'
  | 'endedAt'
  | 'status'
  | 'costUsd'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'toolCalls'
  | 'rateLimitUtilization'
  | 'error'
>;

export interface HostSample {
  at: number;
  /** 1-minute load average. */
  load: number;
  /** 0–1. */
  memUsed: number;
  diskUsed?: number;
  /** Swap in use, 0–1 (Linux; includes zram). */
  swapUsed?: number;
}

export interface LogEvent {
  at: number;
  level: 'warn' | 'error';
  message: string;
}

const OUTPUT_CAP = 20_000;
const LOG_CAP = 2_000;

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
  // The inbox is gone (2026-10-26): everything that needs a person is an approval card.
  `DROP TABLE inbox;`,
  // An approved item's place in its queue once a person moved it (otherwise its approval time).
  `ALTER TABLE items ADD COLUMN queue_rank REAL;`,
  // Sessions of jobs that run on agy (Antigravity CLI) continue on agy.
  `ALTER TABLE sessions ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';`,
  // A job's scratch folder outlives a change of session id (agy's own id, a handoff).
  `ALTER TABLE sessions ADD COLUMN scratch_id TEXT;`,
  // The Sessions list looks up each thread's runs, and a session page its latest run.
  `CREATE INDEX runs_thread ON runs (thread_key, started_at);
   CREATE INDEX runs_session ON runs (session_id, started_at);`,
  // A draft card with its own channel message keeps its full text in the first reply of its thread.
  `ALTER TABLE items ADD COLUMN detail_ts TEXT;`,
  // The CLI's cost is the session's running total (it carries over --resume), so a thread of turns was
  // counted again on every turn. Keep the total in session_cost_usd and make cost_usd each run's own
  // share. A total lower than the one before (a counter that started over) is left as it is.
  `ALTER TABLE runs ADD COLUMN session_cost_usd REAL;
   UPDATE runs SET session_cost_usd = cost_usd WHERE session_id IS NOT NULL;
   WITH d AS (
     SELECT id, session_cost_usd - LAG(session_cost_usd) OVER (PARTITION BY session_id ORDER BY started_at, id) AS delta
     FROM runs WHERE session_id IS NOT NULL AND session_cost_usd IS NOT NULL
   )
   UPDATE runs SET cost_usd = (SELECT delta FROM d WHERE d.id = runs.id)
   WHERE id IN (SELECT id FROM d WHERE delta IS NOT NULL AND delta >= 0);`,
  // One "Run <name>" thread per project, name and day for cards no run proposed (approvals.dayThread).
  `CREATE TABLE day_threads (
     key        TEXT PRIMARY KEY,
     channel    TEXT NOT NULL,
     ts         TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // The Health page: each check's confirmed state (so a restart neither re-alerts nor forgets an
  // outage) and its changes over time (src/health/monitor.ts).
  `CREATE TABLE health_state (
     key        TEXT PRIMARY KEY,
     status     TEXT NOT NULL,
     since      INTEGER NOT NULL,
     detail     TEXT,
     label      TEXT,
     alerted    INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE health_events (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     key        TEXT NOT NULL,
     status     TEXT NOT NULL,
     detail     TEXT,
     at         INTEGER NOT NULL
   );
   CREATE INDEX health_events_at ON health_events (at);`,
  // Observability: the machine every few minutes, and tara-agent's own warnings and errors.
  `CREATE TABLE host_samples (
     at         INTEGER PRIMARY KEY,
     load       REAL NOT NULL,
     mem_used   REAL NOT NULL,
     disk_used  REAL
   );
   CREATE TABLE log_events (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     at         INTEGER NOT NULL,
     level      TEXT NOT NULL,
     message    TEXT NOT NULL
   );
   CREATE INDEX log_events_at ON log_events (at);`,
  // A proposer's ranking (higher first): the Approvals page lists a kind's drafts by it, and an approved
  // item goes into its queue ahead of approved items ranked lower.
  `ALTER TABLE items ADD COLUMN priority REAL;`,
  // Reminders (reminders/reminders.ts): next_at is the next time it is posted, null once done or cancelled.
  `CREATE TABLE reminders (
     id           TEXT PRIMARY KEY,
     project      TEXT NOT NULL,
     text         TEXT NOT NULL,
     cron         TEXT,
     next_at      INTEGER,
     notify       INTEGER NOT NULL DEFAULT 0,
     created_by   TEXT,
     created_at   INTEGER NOT NULL,
     last_at      INTEGER,
     cancelled_at INTEGER
   );
   CREATE INDEX reminders_next ON reminders (next_at);`,
  // Scheduled tasks: a one-time reminder that starts a run with its text as the note of what to do.
  `ALTER TABLE reminders ADD COLUMN task INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE reminders ADD COLUMN title TEXT;`,
  // A paused run's handoff notes: what a fresh session needs to act on the decision in a new thread.
  `ALTER TABLE items ADD COLUMN handoff TEXT;`,
  // Paired desk phones (http/phone.ts): the shell app's key is kept only as its SHA-256.
  `CREATE TABLE phone_devices (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     key_hash     TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     last_seen_at INTEGER,
     app_version  TEXT
   );`,
  // The desk phone's battery, reported by its shell every 10 min (Health: hot, stuck full, running down).
  `CREATE TABLE phone_battery (
     device_id   TEXT NOT NULL,
     at          INTEGER NOT NULL,
     level       INTEGER NOT NULL,
     charging    INTEGER NOT NULL,
     plugged     INTEGER NOT NULL,
     temperature REAL,
     PRIMARY KEY (device_id, at)
   );`,
  // Dashboard threads (src/web/): runs that live on the dashboard instead of a Slack thread. Each row is
  // one message of such a thread; `web_mirrors` are their Slack copies (cards with buttons), and
  // `thread_aliases` send replies in a Slack thread (a run's summary, a card) to the dashboard thread's session.
  `CREATE TABLE web_messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     channel    TEXT NOT NULL,
     thread_ts  TEXT NOT NULL,
     ts         TEXT NOT NULL UNIQUE,
     kind       TEXT NOT NULL,
     user       TEXT,
     text       TEXT NOT NULL DEFAULT '',
     data       TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX web_messages_thread ON web_messages (channel, thread_ts, id);
   CREATE TABLE web_mirrors (
     web_ts        TEXT PRIMARY KEY,
     slack_channel TEXT NOT NULL,
     slack_ts      TEXT NOT NULL,
     created_at    INTEGER NOT NULL
   );
   CREATE TABLE thread_aliases (
     slack_key  TEXT PRIMARY KEY,
     web_key    TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // The VM host's own reports (src/health/vmhost.ts): the machine tara-agent's VM runs on.
  `CREATE TABLE vmhost_samples (
     at           INTEGER PRIMARY KEY,
     name         TEXT,
     cpu_temp     REAL,
     thermal      TEXT,
     cpu          REAL,
     mem_used     REAL,
     swap_bytes   REAL,
     pressure     TEXT,
     vm_cpu       REAL,
     vm_mem_bytes REAL,
     power_w      REAL
   );`,
  // The desk phone was retired (2026-11-21): the macOS desk widget reads GET /glance instead.
  `DROP TABLE IF EXISTS phone_battery;
   DROP TABLE IF EXISTS phone_devices;`,
  // Capacity history (e.g. deciding whether the VM host is big enough): the machine's swap, and how
  // long the VM host's keyboard and mouse had been idle, i.e. whether someone was using it.
  `ALTER TABLE host_samples ADD COLUMN swap_used REAL;
   ALTER TABLE vmhost_samples ADD COLUMN idle_sec REAL;`,
  // A waiting card's chat on the Approvals page: the owner's notes and Jarvis's answers to them.
  `CREATE TABLE item_chat (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     item_id TEXT NOT NULL,
     role    TEXT NOT NULL,
     text    TEXT NOT NULL,
     at      INTEGER NOT NULL
   );
   CREATE INDEX item_chat_item ON item_chat (item_id, id);`,
  // Keys that ever had a decided or closed card, kept after the cards themselves are deleted (60 days),
  // so auto-approve never treats an old key as new. Filled by a trigger wherever a card leaves `pending`.
  `CREATE TABLE decided_keys (
     project TEXT NOT NULL,
     key     TEXT NOT NULL,
     at      INTEGER NOT NULL,
     PRIMARY KEY (project, key)
   );
   INSERT OR IGNORE INTO decided_keys (project, key, at)
     SELECT project, key, MIN(updated_at) FROM items WHERE key IS NOT NULL AND status <> 'pending' GROUP BY project, key;
   CREATE TRIGGER items_decided_key AFTER UPDATE OF status ON items
     WHEN NEW.key IS NOT NULL AND NEW.status <> 'pending'
     BEGIN
       INSERT OR IGNORE INTO decided_keys (project, key, at) VALUES (NEW.project, NEW.key, NEW.updated_at);
     END;`,
  // When an item's executor actually started on it (its run past its slot and locks, or the POST to a URL
  // executor). An item still `running` without it at a restart never reached the executor: it goes back.
  `ALTER TABLE items ADD COLUMN run_started_at INTEGER;`,
  // One row the Health page writes on every check: a disk gone read-only or a damaged file shows at once.
  `CREATE TABLE heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL);`,
  // A run's context size when it ended (what a card's "new or same session" advice looks at); a card's
  // session choice (shown while it waits, then the one used); the card chat moved to the session page.
  `ALTER TABLE runs ADD COLUMN context_tokens INTEGER;
   ALTER TABLE items ADD COLUMN session_mode TEXT;
   DROP TABLE IF EXISTS item_chat;`,
  // Chat messages not yet answered, so a crash loses none: kept from arrival until their turn ends.
  `CREATE TABLE inbox (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     channel     TEXT NOT NULL,
     thread_ts   TEXT NOT NULL,
     ts          TEXT NOT NULL,
     user        TEXT NOT NULL,
     text        TEXT NOT NULL,
     summary     TEXT,
     mention     TEXT,
     files       INTEGER NOT NULL DEFAULT 0,
     received_at INTEGER NOT NULL,
     started_at  INTEGER
   );`,
  // The vault (src/vault/): website logins whose secrets tara-agent types in itself, encrypted with
  // TARA_VAULT_KEY; every use, reveal and change; and the key's fingerprint, so a wrong key is noticed.
  `CREATE TABLE vault_logins (
     id         TEXT PRIMARY KEY,
     projects   TEXT NOT NULL,
     service    TEXT NOT NULL,
     account    TEXT,
     sites      TEXT NOT NULL,
     login_url  TEXT NOT NULL,
     secret     TEXT NOT NULL,
     has_totp   INTEGER NOT NULL DEFAULT 0,
     note       TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE vault_uses (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     login_id TEXT NOT NULL,
     project  TEXT,
     action   TEXT NOT NULL,
     status   TEXT NOT NULL,
     detail   TEXT,
     by       TEXT,
     at       INTEGER NOT NULL
   );
   CREATE INDEX vault_uses_login ON vault_uses(login_id, at);
   CREATE TABLE vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

/** A saved login as stored (`secret` is sealed; see vault/crypto.ts). */
export interface VaultRow {
  /** Short fixed name, e.g. "meesho"; part of the encryption's bound data, so it never changes. */
  id: string;
  /** Projects whose runs may sign in with it. */
  projects: string[];
  service: string;
  account?: string;
  /** Hosts it may be typed into; `*.example.com` covers example.com and its subdomains. */
  sites: string[];
  /** The sign-in page tara-agent opens. */
  loginUrl: string;
  secret: string;
  hasTotp: boolean;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/** One line of the vault's log. */
export interface VaultUse {
  id: number;
  loginId: string;
  project?: string;
  /** sign-in, reveal, saved, deleted. */
  action: string;
  /** e.g. signed-in, failed, captcha, needs-code, refused, ok. */
  status: string;
  detail?: string;
  /** Who: `<project>/<job>` or `<project>/chat` for runs, `dashboard` for a person. */
  by?: string;
  at: number;
}

/** One message of a dashboard thread (src/web/). */
export interface WebMessage {
  id: number;
  channel: string;
  threadTs: string;
  ts: string;
  /** text: a plain message; blocks: a Block Kit card; file: an uploaded file; stream: a live reply. */
  kind: 'text' | 'blocks' | 'file' | 'stream';
  /** Who wrote it: a person's id for a message from the dashboard; unset for the agent. */
  user?: string;
  text: string;
  /** blocks: the blocks; file: {name, path, comment}; stream: {title, tasks, done}. */
  data?: unknown;
  createdAt: number;
  updatedAt: number;
}

/** A line posted in a project's channel at `nextAt`, then again at each `cron` time (none = once). */
export interface Reminder {
  id: string;
  project: string;
  text: string;
  cron?: string;
  /** Next time it is posted; undefined once it is done or cancelled. */
  nextAt?: number;
  /** Also sent to the project's `reminders.hookUrl`. */
  notify: boolean;
  /** A scheduled task: at `nextAt` it starts a run in a fresh thread, with `text` as the note of what to do. */
  task?: boolean;
  /** A task's short name, for its `Run <title>` message. */
  title?: string;
  createdBy?: string;
  createdAt: number;
  lastAt?: number;
}

export const ITEM_STATUSES = [
  'pending',
  'approved',
  'running',
  // Its run started but never said how it went (a crash, a restart, a run that ended without a
  // report): it may or may not have gone out, so it is never run again on its own. A person says.
  'uncertain',
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
  /**
   * A paused run's notes for whoever acts on the decision (`request_approval` `handoff`): everything a
   * fresh session needs. With them, a decision starts a new `Run` thread instead of resuming the run.
   */
  handoff?: string;
  /**
   * Where a decision is acted on (see approvals/session-choice.ts): while the card waits, the advice it
   * shows; once decided, the one used. Unset for cards with no choice (drafts, notices).
   */
  session?: SessionMode;
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
  /** A draft card's full text, the first reply in the thread of its own channel message. */
  detailTs?: string;
  queue?: string;
  /** Window key in the queue's config, e.g. `EU`. */
  window?: string;
  /** Not before this time. */
  runAfter?: number;
  /** Approved with "run now": skips the queue's windows and slots (caps still apply). */
  runNow: boolean;
  /** Place in its queue once moved on the Approvals page; unset = its approval time. */
  queueRank?: number;
  /** The proposer's ranking, higher first (e.g. a lead's match score). */
  priority?: number;
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
      | 'handoff'
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
      | 'priority'
    >
  >;

/** Where an approved item sits in its queue: where a person moved it, or its approval time. */
export const queueKey = (i: Item): number => i.queueRank ?? i.decidedAt ?? 0;

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
    handoff: opt(r.handoff),
    session: opt(r.session_mode),
    media: JSON.parse(r.media as string) as ItemMedia[],
    fields: JSON.parse(r.fields as string) as ItemField[],
    checks: JSON.parse(r.checks as string) as ItemCheck[],
    options: JSON.parse(r.options as string) as string[],
    source: opt(r.source),
    jobId: opt(r.job_id),
    channel: opt(r.channel),
    threadTs: opt(r.thread_ts),
    messageTs: opt(r.message_ts),
    detailTs: opt(r.detail_ts),
    queue: opt(r.queue),
    window: opt(r.window),
    runAfter: opt(r.run_after),
    runNow: r.run_now === 1,
    queueRank: opt(r.queue_rank),
    priority: opt(r.priority),
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
    contextTokens: opt(r.context_tokens),
    toolCalls: opt(r.tool_calls),
    rateLimitUtilization: opt(r.rate_limit_util),
    error: opt(r.error),
    output: opt(r.output),
    scriptOutput: opt(r.script_output),
  };
}

function toReminder(r: Record<string, unknown>): Reminder {
  const opt = <T>(v: unknown) => (v ?? undefined) as T | undefined;
  return {
    id: r.id as string,
    project: r.project as string,
    text: r.text as string,
    cron: opt(r.cron),
    nextAt: opt(r.next_at),
    notify: r.notify === 1,
    ...(r.task === 1 && { task: true }),
    title: opt(r.title),
    createdBy: opt(r.created_by),
    createdAt: r.created_at as number,
    lastAt: opt(r.last_at),
  };
}

/** SQLite state: sessions and run history. Lives outside every project repo. */
function vmHostRow(r: Record<string, unknown>): VmHostSample {
  const n = (k: string) => (r[k] == null ? undefined : (r[k] as number));
  const t = (k: string) => (r[k] == null ? undefined : (r[k] as string));
  const s: VmHostSample = {
    at: r.at as number,
    name: t('name'),
    cpuTemp: n('cpu_temp'),
    thermal: t('thermal') as VmHostSample['thermal'],
    cpu: n('cpu'),
    memUsed: n('mem_used'),
    swapBytes: n('swap_bytes'),
    pressure: t('pressure') as VmHostSample['pressure'],
    vmCpu: n('vm_cpu'),
    vmMemBytes: n('vm_mem_bytes'),
    powerW: n('power_w'),
    idleSec: n('idle_sec'),
  };
  for (const k of Object.keys(s) as Array<keyof VmHostSample>) if (s[k] === undefined) delete s[k];
  return s;
}

export class Store {
  private readonly db: DatabaseSync;

  /** `file` is a path, or `:memory:` for tests. */
  constructor(
    file: string,
    private readonly now: () => number = Date.now,
  ) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // synchronous=FULL: every commit is on disk before the call returns. Sending at most once rests on
    // that: an item marked `running` (or a slot claimed) before a send must still say so after a power
    // cut, or the send happens again. NORMAL would drop the last commits in WAL mode. Writes are a few a
    // minute, so the fsyncs cost little.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    // A database from a newer build: its migrations are unknown here, and running on it would quietly
    // use the wrong schema.
    if (version > MIGRATIONS.length)
      throw new Error(
        `The state database is at schema version ${version}, newer than this build knows (${MIGRATIONS.length}). Deploy the newer build, or restore a backup taken before it.`,
      );
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
      .prepare(
        'SELECT thread_key, project, session_id, model, started, harness, scratch_id FROM sessions WHERE thread_key = ?',
      )
      .get(threadKey) as
      | {
          thread_key: string;
          project: string;
          session_id: string;
          model: string;
          started: number;
          harness: Harness;
          scratch_id: string | null;
        }
      | undefined;
    return row
      ? {
          threadKey: row.thread_key,
          project: row.project,
          sessionId: row.session_id,
          model: row.model,
          started: row.started === 1,
          harness: row.harness,
          scratchId: row.scratch_id ?? undefined,
        }
      : undefined;
  }

  /** The job that ran in this thread most recently (unset: a chat-only thread). */
  threadJob(threadKey: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT job_id FROM runs WHERE thread_key = ? AND kind = 'job' AND job_id IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(threadKey) as { job_id: string } | undefined;
    return row?.job_id;
  }

  saveSession(s: SessionRow): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (thread_key, project, session_id, model, started, harness, scratch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_key) DO UPDATE SET
           project = excluded.project, session_id = excluded.session_id, model = excluded.model,
           started = excluded.started, harness = excluded.harness, scratch_id = excluded.scratch_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        s.threadKey,
        s.project,
        s.sessionId,
        s.model,
        s.started ? 1 : 0,
        s.harness ?? 'claude',
        s.scratchId ?? null,
        t,
        t,
      );
  }

  /** Sessions, most recently active first, each with its latest run. */
  sessionsOverview(
    opts: {
      project?: string;
      sessionId?: string;
      kind?: 'job' | 'chat';
      limit?: number;
      offset?: number;
    } = {},
  ): SessionOverview[] {
    const { where, args } = this.sessionFilter(opts);
    const rows = this.db
      .prepare(
        `SELECT s.thread_key, s.project, s.session_id, s.model, s.started, s.harness, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM runs x WHERE x.thread_key = s.thread_key) AS turns,
           (SELECT id FROM runs x WHERE x.thread_key = s.thread_key AND x.kind != 'learn' ORDER BY x.started_at DESC LIMIT 1) AS last_run_id,
           (SELECT job_id FROM runs x WHERE x.thread_key = s.thread_key AND x.job_id IS NOT NULL ORDER BY x.started_at LIMIT 1) AS job_id
         FROM sessions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY COALESCE((SELECT MAX(x.started_at) FROM runs x WHERE x.thread_key = s.thread_key), s.updated_at) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit ?? 200, opts.offset ?? 0) as Record<string, unknown>[];
    return rows.map((r) => ({
      threadKey: r.thread_key as string,
      project: r.project as string,
      sessionId: r.session_id as string,
      model: r.model as string,
      started: r.started === 1,
      harness: r.harness as Harness,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      turns: r.turns as number,
      lastRun: r.last_run_id ? this.getRun(r.last_run_id as number) : undefined,
      jobId: (r.job_id as string | null) ?? undefined,
    }));
  }

  /** How many sessions `sessionsOverview` would list without a limit (for its pages). */
  sessionsCount(opts: { project?: string; kind?: 'job' | 'chat' } = {}): number {
    const { where, args } = this.sessionFilter(opts);
    return (
      this.db
        .prepare(`SELECT COUNT(*) n FROM sessions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
        .get(...args) as { n: number }
    ).n;
  }

  /** A session is a job's when a run of a job happened in its thread; otherwise a chat. */
  private sessionFilter(opts: { project?: string; sessionId?: string; kind?: 'job' | 'chat' }) {
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
    if (opts.kind)
      where.push(
        `${opts.kind === 'chat' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM runs x WHERE x.thread_key = s.thread_key AND x.job_id IS NOT NULL)`,
      );
    return { where, args };
  }

  /**
   * Forgets what is older than `before` (host `retentionDays`): runs, slot claims, and sessions not
   * used since (Claude Code deletes its own session files after 30 days by default, so such a thread
   * could not resume anyway; a reply there starts a new session). The latest run of each job is kept
   * whatever its age, so a job that runs rarely still shows its last result. Approval cards stay.
   */
  prune(before: number): { runs: number; claims: number; sessions: number } {
    const runs = this.db
      .prepare(
        `DELETE FROM runs WHERE started_at < ? AND id NOT IN (
           SELECT MAX(id) FROM runs WHERE kind = 'job' AND job_id IS NOT NULL GROUP BY project, job_id
         )`,
      )
      .run(before).changes;
    // Catch-up only ever looks hours back, so no claim this old (even one left `running`) is needed.
    const claims = this.db.prepare('DELETE FROM job_claims WHERE slot < ?').run(before).changes;
    const sessions = this.db.prepare('DELETE FROM sessions WHERE updated_at < ?').run(before).changes;
    this.db.prepare('DELETE FROM day_threads WHERE created_at < ?').run(before);
    // Dashboard threads go with their sessions' history (their files are swept by web/chat.ts).
    this.db.prepare('DELETE FROM web_messages WHERE updated_at < ?').run(before);
    this.db.prepare('DELETE FROM web_mirrors WHERE created_at < ?').run(before);
    this.db.prepare('DELETE FROM thread_aliases WHERE created_at < ?').run(before);
    this.db.prepare('DELETE FROM health_events WHERE at < ?').run(before);
    // Machine samples are small (one row per 5 min) and answer capacity questions over months, so
    // they are kept as long as runs. Log lines are only read for weeks; a month is plenty.
    this.db.prepare('DELETE FROM host_samples WHERE at < ?').run(before);
    this.db.prepare('DELETE FROM vmhost_samples WHERE at < ?').run(before);
    const month = Math.max(before, this.now() - 31 * 86_400_000);
    this.db.prepare('DELETE FROM log_events WHERE at < ?').run(month);
    // The vault's log answers "who used this login": tiny, kept a year.
    this.db
      .prepare('DELETE FROM vault_uses WHERE at < ?')
      .run(Math.min(before, this.now() - 365 * 86_400_000));
    return { runs: Number(runs), claims: Number(claims), sessions: Number(sessions) };
  }

  deleteSession(threadKey: string): void {
    this.db.prepare('DELETE FROM sessions WHERE thread_key = ?').run(threadKey);
  }

  /**
   * Stores a finished run and returns its id. `costUsd` is what the CLI reports: the session's running total, which carries over `--resume`. The
   * run is stored with its own share (the total minus the session's previous total), and the total
   * itself in `session_cost_usd`, so summing runs never counts a turn twice.
   */
  recordRun(r: RunRecord): number {
    let cost = r.costUsd;
    if (cost !== undefined && r.sessionId) {
      const prev = this.db
        .prepare(
          `SELECT session_cost_usd t FROM runs WHERE session_id = ? AND session_cost_usd IS NOT NULL
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(r.sessionId) as { t: number } | undefined;
      if (prev && r.costUsd !== undefined && r.costUsd >= prev.t) cost = r.costUsd - prev.t;
    }
    if (r.extraCostUsd !== undefined) cost = (cost ?? 0) + r.extraCostUsd;
    const result = this.db
      .prepare(
        `INSERT INTO runs (kind, project, job_id, thread_key, session_id, model, started_at, ended_at, status,
           cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_calls,
           rate_limit_util, error, output, script_output, session_cost_usd, context_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        cost ?? null,
        r.inputTokens ?? null,
        r.outputTokens ?? null,
        r.cacheReadTokens ?? null,
        r.cacheCreationTokens ?? null,
        r.toolCalls ?? null,
        r.rateLimitUtilization ?? null,
        r.error ?? null,
        r.output?.slice(0, OUTPUT_CAP) ?? null,
        r.scriptOutput?.slice(0, OUTPUT_CAP) ?? null,
        r.sessionId && r.costUsd !== undefined ? r.costUsd : null,
        r.contextTokens ?? null,
      );
    const id = Number(result.lastInsertRowid);
    if (r.threadKey)
      for (const listener of this.runListeners) {
        try {
          listener(r.threadKey, r);
        } catch {}
      }
    return id;
  }

  private readonly runListeners: Array<(threadKey: string, run: RunRecord) => void> = [];

  /** Called after each run recorded in a thread (cards there refresh their session advice). */
  onRun(listener: (threadKey: string, run: RunRecord) => void): void {
    this.runListeners.push(listener);
  }

  /**
   * What a thread's session looks like now: its turns (runs other than learning turns), the context
   * size its latest run ended with, and when that run ended. Undefined when nothing ran in it.
   */
  threadState(threadKey: string): ThreadState | undefined {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS turns, MAX(ended_at) AS last_at,
           (SELECT context_tokens FROM runs x WHERE x.thread_key = ? AND x.kind != 'learn'
             ORDER BY x.ended_at DESC, x.id DESC LIMIT 1) AS context
         FROM runs WHERE thread_key = ? AND kind != 'learn'`,
      )
      .get(threadKey, threadKey) as { turns: number; last_at: number | null; context: number | null };
    if (!row.turns || row.last_at === null) return undefined;
    return { turns: row.turns, lastAt: row.last_at, contextTokens: row.context ?? undefined };
  }

  runsSince(since: number): StoredRun[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at').all(since);
    return (rows as Record<string, unknown>[]).map(toRun);
  }

  /** Runs started since `since`, oldest first, without their texts (errors cut to one line). */
  runStats(since: number): RunStat[] {
    const rows = this.db
      .prepare(
        `SELECT kind, project, job_id, model, started_at, ended_at, status, cost_usd, input_tokens, output_tokens,
           cache_read_tokens, tool_calls, rate_limit_util, substr(error, 1, 300) AS error
         FROM runs WHERE started_at >= ? ORDER BY started_at`,
      )
      .all(since) as Record<string, unknown>[];
    const opt = <T>(v: unknown) => (v ?? undefined) as T | undefined;
    return rows.map((r) => ({
      kind: r.kind as RunStat['kind'],
      project: r.project as string,
      jobId: opt(r.job_id),
      model: opt(r.model),
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number,
      status: r.status as string,
      costUsd: opt(r.cost_usd),
      inputTokens: opt(r.input_tokens),
      outputTokens: opt(r.output_tokens),
      cacheReadTokens: opt(r.cache_read_tokens),
      toolCalls: opt(r.tool_calls),
      rateLimitUtilization: opt(r.rate_limit_util),
      error: opt(r.error),
    }));
  }

  addReminder(r: Reminder): void {
    this.db
      .prepare(
        `INSERT INTO reminders (id, project, text, cron, next_at, notify, task, title, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.project,
        r.text,
        r.cron ?? null,
        r.nextAt ?? null,
        r.notify ? 1 : 0,
        r.task ? 1 : 0,
        r.title ?? null,
        r.createdBy ?? null,
        r.createdAt,
      );
  }

  /** A project's reminders still to come, soonest first. */
  reminders(project: string): Reminder[] {
    return (
      this.db
        .prepare('SELECT * FROM reminders WHERE project = ? AND next_at IS NOT NULL ORDER BY next_at')
        .all(project) as Record<string, unknown>[]
    ).map(toReminder);
  }

  dueReminders(now: number): Reminder[] {
    return (
      this.db
        .prepare('SELECT * FROM reminders WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at')
        .all(now) as Record<string, unknown>[]
    ).map(toReminder);
  }

  /** Moves a due reminder on to `next` (null: done); false when another tick already did. */
  claimReminder(id: string, due: number, next: number | null, now: number): boolean {
    const { changes } = this.db
      .prepare('UPDATE reminders SET next_at = ?, last_at = ? WHERE id = ? AND next_at = ?')
      .run(next, now, id, due);
    return Number(changes) === 1;
  }

  cancelReminder(project: string, id: string, now: number): boolean {
    const { changes } = this.db
      .prepare(
        'UPDATE reminders SET next_at = NULL, cancelled_at = ? WHERE id = ? AND project = ? AND next_at IS NOT NULL',
      )
      .run(now, id, project);
    return Number(changes) === 1;
  }

  addHostSample(s: HostSample): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO host_samples (at, load, mem_used, disk_used, swap_used) VALUES (?, ?, ?, ?, ?)',
      )
      .run(s.at, s.load, s.memUsed, s.diskUsed ?? null, s.swapUsed ?? null);
  }

  hostSamples(since: number): HostSample[] {
    return (
      this.db
        .prepare(
          'SELECT at, load, mem_used, disk_used, swap_used FROM host_samples WHERE at >= ? ORDER BY at',
        )
        .all(since) as Array<{
        at: number;
        load: number;
        mem_used: number;
        disk_used: number | null;
        swap_used: number | null;
      }>
    ).map((r) => ({
      at: r.at,
      load: r.load,
      memUsed: r.mem_used,
      diskUsed: r.disk_used ?? undefined,
      ...(r.swap_used != null && { swapUsed: r.swap_used }),
    }));
  }

  addVmHostSample(s: VmHostSample): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO vmhost_samples (at, name, cpu_temp, thermal, cpu, mem_used, swap_bytes, pressure, vm_cpu, vm_mem_bytes, power_w, idle_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.at,
        s.name ?? null,
        s.cpuTemp ?? null,
        s.thermal ?? null,
        s.cpu ?? null,
        s.memUsed ?? null,
        s.swapBytes ?? null,
        s.pressure ?? null,
        s.vmCpu ?? null,
        s.vmMemBytes ?? null,
        s.powerW ?? null,
        s.idleSec ?? null,
      );
  }

  vmHostSamples(since: number): VmHostSample[] {
    return (
      this.db.prepare('SELECT * FROM vmhost_samples WHERE at >= ? ORDER BY at').all(since) as Record<
        string,
        unknown
      >[]
    ).map(vmHostRow);
  }

  /** The VM host's latest report, however old. */
  lastVmHostSample(): VmHostSample | undefined {
    const r = this.db.prepare('SELECT * FROM vmhost_samples ORDER BY at DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    return r ? vmHostRow(r) : undefined;
  }

  addLog(e: LogEvent): void {
    this.db
      .prepare('INSERT INTO log_events (at, level, message) VALUES (?, ?, ?)')
      .run(e.at, e.level, e.message.slice(0, LOG_CAP));
  }

  /** tara-agent's own warnings and errors since `since`, newest first. */
  logs(since: number, limit = 5_000): LogEvent[] {
    return this.db
      .prepare('SELECT at, level, message FROM log_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(since, limit) as unknown as LogEvent[];
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

  /** The latest run of a Claude (or agy) session, whatever thread it ran in. */
  /** A session's latest run, not counting learning turns (their reply is notes, not the run's result). */
  latestSessionRun(sessionId: string): StoredRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE session_id = ?
         ORDER BY kind = 'learn', started_at DESC LIMIT 1`,
      )
      .get(sessionId);
    return row ? toRun(row as Record<string, unknown>) : undefined;
  }

  /** Session id → the job it ran, for sessions with a job run started since `since`. */
  sessionJobs(since: number): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT session_id, MIN(job_id) AS job_id FROM runs
         WHERE session_id IS NOT NULL AND job_id IS NOT NULL AND started_at >= ? GROUP BY session_id`,
      )
      .all(since) as { session_id: string; job_id: string }[];
    return new Map(rows.map((r) => [r.session_id, r.job_id]));
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
  claimSlot(jobKey: string, slot: number, retakeBefore = 0, alsoRetake: string[] = []): boolean {
    // `alsoRetake`: other finished statuses that may be claimed again, e.g. `held` after a usage limit reset.
    const extra = alsoRetake.length
      ? ` OR job_claims.status IN (${alsoRetake.map(() => '?').join(', ')})`
      : '';
    const result = this.db
      .prepare(
        `INSERT INTO job_claims (job_key, slot, status, claimed_at) VALUES (?, ?, 'running', ?)
         ON CONFLICT (job_key, slot) DO UPDATE SET status = 'running', claimed_at = excluded.claimed_at
         WHERE job_claims.status = 'aborted' OR (job_claims.status = 'running' AND job_claims.claimed_at < ?)${extra}`,
      )
      .run(jobKey, slot, this.now(), retakeBefore, ...alsoRetake);
    return result.changes > 0;
  }

  /** A job's latest claimed slot, whatever its status. */
  latestClaim(jobKey: string): { slot: number; status: string } | undefined {
    return this.db
      .prepare('SELECT slot, status FROM job_claims WHERE job_key = ? ORDER BY slot DESC LIMIT 1')
      .get(jobKey) as { slot: number; status: string } | undefined;
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

  /** A scheduled slot's claim status (`running`, `ok`, `skipped`, `aborted`…), or undefined if never claimed. */
  slotClaim(jobKey: string, slot: number): { status: string; claimedAt: number } | undefined {
    const row = this.db
      .prepare('SELECT status, claimed_at FROM job_claims WHERE job_key = ? AND slot = ?')
      .get(jobKey, slot) as { status: string; claimed_at: number } | undefined;
    return row && { status: row.status, claimedAt: row.claimed_at };
  }

  /** Every health check's confirmed state, by key. */
  healthStates(): Map<string, HealthState> {
    const rows = this.db
      .prepare('SELECT key, status, since, detail, label, alerted FROM health_state')
      .all() as Array<{
      key: string;
      status: string;
      since: number;
      detail: string | null;
      label: string | null;
      alerted: number;
    }>;
    return new Map(
      rows.map((r) => [
        r.key,
        {
          status: r.status as HealthStatus,
          since: r.since,
          detail: r.detail ?? undefined,
          label: r.label ?? undefined,
          alerted: r.alerted === 1,
        },
      ]),
    );
  }

  /** Saves a check's confirmed state; a change of status is also kept as an event. */
  saveHealthState(key: string, state: HealthState, changed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO health_state (key, status, since, detail, label, alerted) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET status = excluded.status, since = excluded.since,
           detail = excluded.detail, label = excluded.label, alerted = excluded.alerted`,
      )
      .run(key, state.status, state.since, state.detail ?? null, state.label ?? null, state.alerted ? 1 : 0);
    if (changed)
      this.db
        .prepare('INSERT INTO health_events (key, status, detail, at) VALUES (?, ?, ?, ?)')
        .run(key, state.status, state.detail ?? null, state.since);
  }

  /** Forgets a check's state (it is no longer reported). */
  dropHealthState(key: string): void {
    this.db.prepare('DELETE FROM health_state WHERE key = ?').run(key);
  }

  /** Health status changes since `since`, oldest first. */
  healthEvents(since: number): HealthEvent[] {
    return (
      this.db
        .prepare('SELECT key, status, detail, at FROM health_events WHERE at >= ? ORDER BY at, id')
        .all(since) as Array<{ key: string; status: string; detail: string | null; at: number }>
    ).map((r) => ({ key: r.key, status: r.status as HealthStatus, detail: r.detail ?? undefined, at: r.at }));
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
      handoff: input.handoff?.trim() || null,
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
      priority: input.priority ?? null,
    };
    const cols = Object.keys(values);
    if (existing) {
      // A refresh keeps where the card lives in Slack unless the new proposal names a thread itself.
      const set = (c: string) =>
        c === 'channel' || c === 'thread_ts' ? `${c} = COALESCE(?, ${c})` : `${c} = ?`;
      this.db
        .prepare(`UPDATE items SET ${cols.map(set).join(', ')}, reply = NULL, updated_at = ? WHERE id = ?`)
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

  /**
   * Moves a project's job ids to new ones (`old → new`), e.g. after jobs were renamed to their skill:
   * run history, cards (so a waiting one still resumes its job) and slot claims. Returns rows changed.
   */
  renameJobs(project: string, renames: Record<string, string>): number {
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const [from, to] of Object.entries(renames)) {
        if (from === to) continue;
        const run = (sql: string, ...args: string[]) => {
          changed += Number(this.db.prepare(sql).run(...args).changes);
        };
        run('UPDATE runs SET job_id = ? WHERE project = ? AND job_id = ?', to, project, from);
        run('UPDATE items SET job_id = ? WHERE project = ? AND job_id = ?', to, project, from);
        run('UPDATE items SET source = ? WHERE project = ? AND source = ?', to, project, from);
        run(
          'UPDATE OR REPLACE job_claims SET job_key = ? WHERE job_key = ?',
          `${project}:${to}`,
          `${project}:${from}`,
        );
        run(
          'UPDATE OR REPLACE job_seen SET job_key = ? WHERE job_key = ?',
          `${project}:${to}`,
          `${project}:${from}`,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return changed;
  }

  /** The items posted in one Slack thread, oldest first (at most `limit`). */
  itemsInThread(channel: string, threadTs: string, limit = 20): Item[] {
    return (
      this.db
        .prepare('SELECT * FROM items WHERE channel = ? AND thread_ts = ? ORDER BY created_at DESC LIMIT ?')
        .all(channel, threadTs, limit) as Record<string, unknown>[]
    )
      .map(toItem)
      .reverse();
  }

  /** True when the project has ever had an item with this key (any status). */
  hasKey(project: string, key: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM items WHERE project = ? AND key = ? LIMIT 1').get(project, key),
    );
  }

  /**
   * True when an item with this key was ever decided or closed (anything but pending), even one since
   * deleted by retention (`decided_keys`).
   */
  hasDecidedKey(project: string, key: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM decided_keys WHERE project = ? AND key = ?').get(project, key),
    );
  }

  /** Items, newest first (or in queue order for `approved`, the order queues run them). */
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
        ? 'COALESCE(queue_rank, decided_at), created_at'
        : 'created_at DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`,
      )
      .all(...args, filter.limit ?? 500);
    return (rows as Record<string, unknown>[]).map(toItem);
  }

  /** A card posted as a reply in a thread it doesn't own (a run's, or a day's `Run <queue>` thread). */
  setItemThread(id: string, channel: string, threadTs: string, messageTs: string): void {
    this.db
      .prepare('UPDATE items SET channel = ?, thread_ts = ?, message_ts = ? WHERE id = ?')
      .run(channel, threadTs, messageTs, id);
  }

  /** The `Run <name>` thread opened under `key` (project, name and day), if any. */
  dayThread(key: string): { channel: string; ts: string } | undefined {
    const row = this.db.prepare('SELECT channel, ts FROM day_threads WHERE key = ?').get(key) as
      | { channel: string; ts: string }
      | undefined;
    return row ? { channel: row.channel, ts: row.ts } : undefined;
  }

  saveDayThread(key: string, channel: string, ts: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO day_threads (key, channel, ts, created_at) VALUES (?, ?, ?, ?)')
      .run(key, channel, ts, this.now());
  }

  setItemMessage(id: string, messageTs: string): void {
    this.db.prepare('UPDATE items SET message_ts = ? WHERE id = ?').run(messageTs, id);
  }

  /** Keeps a chat message until its turn ends (`removeInbox`), so a crash doesn't lose it. */
  addInbox(m: Omit<InboxMessage, 'id' | 'receivedAt' | 'startedAt'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO inbox (channel, thread_ts, ts, user, text, summary, mention, files, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.channel,
        m.threadTs,
        m.ts,
        m.user,
        m.text,
        m.summary ?? null,
        m.mention ?? null,
        m.files,
        this.now(),
      );
    return Number(r.lastInsertRowid);
  }

  /** Its turn has started (a crash now interrupts it, rather than leaving it unread). */
  startInbox(id: number): void {
    this.db.prepare('UPDATE inbox SET started_at = ? WHERE id = ?').run(this.now(), id);
  }

  removeInbox(id: number): void {
    this.db.prepare('DELETE FROM inbox WHERE id = ?').run(id);
  }

  /** Messages left from before a restart, oldest first. */
  inbox(): InboxMessage[] {
    const rows = this.db.prepare('SELECT * FROM inbox ORDER BY id').all() as Record<string, unknown>[];
    const opt = <T>(v: unknown) => (v ?? undefined) as T | undefined;
    return rows.map((r) => ({
      id: r.id as number,
      channel: r.channel as string,
      threadTs: r.thread_ts as string,
      ts: r.ts as string,
      user: r.user as string,
      text: r.text as string,
      summary: opt(r.summary),
      mention: opt(r.mention),
      files: r.files as number,
      receivedAt: r.received_at as number,
      startedAt: opt(r.started_at),
    }));
  }

  /** A card's session choice: the advice it shows while it waits, the one used once decided. */
  setItemSession(id: string, mode: SessionMode | undefined): void {
    this.db.prepare('UPDATE items SET session_mode = ? WHERE id = ?').run(mode ?? null, id);
  }

  setItemDetail(id: string, detailTs: string): void {
    this.db.prepare('UPDATE items SET detail_ts = ? WHERE id = ?').run(detailTs, id);
  }

  /** A card posted as its own Slack message: that message is also the thread its run replies in. */
  setItemSlack(id: string, channel: string, messageTs: string): void {
    this.db
      .prepare('UPDATE items SET channel = ?, thread_ts = ?, message_ts = ? WHERE id = ?')
      .run(channel, messageTs, messageTs, id);
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
    if (result.changes === 0) return undefined;
    const item = this.getItem(id) as Item;
    if (d.status === 'approved' && item.queue && item.priority !== undefined) this.placeByPriority(item);
    return this.getItem(id);
  }

  /**
   * Puts a newly approved item ahead of the first approved item in its queue ranked lower (or
   * unranked), so a queue runs its best items first. Places a person set by moving items keep theirs.
   */
  private placeByPriority(item: Item): void {
    const queue = this.items({
      project: item.project,
      queue: item.queue,
      statuses: ['approved'],
      limit: 1000,
    }).filter((i) => i.id !== item.id);
    const at = queue.findIndex((i) => i.priority === undefined || i.priority < (item.priority as number));
    if (at < 0) return; // the lowest: its approval time already puts it last
    const next = queueKey(queue[at] as Item);
    const prev = at > 0 ? queueKey(queue[at - 1] as Item) : next - 1;
    this.db.prepare('UPDATE items SET queue_rank = ? WHERE id = ?').run((prev + next) / 2, item.id);
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
          "UPDATE items SET status = 'running', started_at = ?, run_started_at = NULL, updated_at = ? WHERE id = ? AND status = 'approved'",
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

  /**
   * A paused run's card is `done` once decided; when the run acting on it then times out or fails, it
   * becomes `failed`, so the Approvals page never shows an unfinished action as done.
   */
  failDecidedItem(id: string, result: string): Item | undefined {
    const t = this.now();
    const r = this.db
      .prepare(
        "UPDATE items SET status = 'failed', result = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'done'",
      )
      .run(result.slice(0, 4_000), t, t, id);
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

  /** The executor started on these running items (see `run_started_at`). */
  markRunStarted(ids: string[]): void {
    const t = this.now();
    const mark = this.db.prepare("UPDATE items SET run_started_at = ? WHERE id = ? AND status = 'running'");
    for (const id of ids) mark.run(t, id);
  }

  /**
   * Running items their executor never started on (they waited for its run when tara-agent stopped):
   * back to approved, so a restart doesn't fail drafts nobody tried to send. Returns them.
   */
  restoreUnstarted(note: string): Item[] {
    const ids = (
      this.db
        .prepare("SELECT id FROM items WHERE status = 'running' AND run_started_at IS NULL")
        .all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    return ids.map((id) => this.deferItem(id, this.now(), note)).filter((i): i is Item => Boolean(i));
  }

  /** Running items nobody reported (the run ended or tara-agent restarted): failed, never run again. */
  failRunning(reason: string, ids?: string[]): Item[] {
    if (ids && !ids.length) return [];
    const running = this.items({ statuses: ['running'], limit: 1000 }).filter(
      (i) => !ids || ids.includes(i.id),
    );
    return running.map((i) => this.finishItem(i.id, 'failed', reason)).filter((i): i is Item => Boolean(i));
  }

  /**
   * Running items nobody reported, whose run had started: maybe sent, maybe not. Marked `uncertain`
   * (never run again on their own) for a person to settle (`resolveUncertain`). Returns them.
   */
  markUncertain(reason: string, ids?: string[]): Item[] {
    if (ids && !ids.length) return [];
    const t = this.now();
    const out: Item[] = [];
    for (const i of this.items({ statuses: ['running'], limit: 1000 })) {
      if (ids && !ids.includes(i.id)) continue;
      const r = this.db
        .prepare(
          "UPDATE items SET status = 'uncertain', result = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(reason.slice(0, 4_000), t, t, i.id);
      if (r.changes > 0) out.push(this.getItem(i.id) as Item);
    }
    return out;
  }

  /**
   * A person settles an uncertain item: it went out (`done`), send it again (back to `approved`, at
   * the front of nothing: its queue's next turn), or drop it (`failed`).
   */
  resolveUncertain(id: string, outcome: 'sent' | 'retry' | 'drop', by: string): Item | undefined {
    const t = this.now();
    const note = {
      sent: `Marked as sent by ${by}`,
      retry: `Queued again by ${by} (it had not gone out)`,
      drop: `Dropped by ${by} (not sent)`,
    }[outcome];
    const r =
      outcome === 'retry'
        ? this.db
            .prepare(
              "UPDATE items SET status = 'approved', started_at = NULL, finished_at = NULL, run_started_at = NULL, run_after = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'uncertain'",
            )
            .run(t, note, t, id)
        : this.db
            .prepare(
              "UPDATE items SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'uncertain'",
            )
            .run(outcome === 'sent' ? 'done' : 'failed', note, t, id);
    return r.changes > 0 ? this.getItem(id) : undefined;
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

  /**
   * Moves an approved item up, down, to the top or bottom of its queue, or to a place in it (0 is
   * first) (`sameKind`: among the items of its kind, for a queue that alternates kinds). The moved
   * items keep their sort keys, handed out in the new order, so items approved later still go after
   * them. Undefined when it is not an approved queue item.
   */
  moveItem(id: string, to: 'up' | 'down' | 'top' | 'bottom' | number, sameKind = false): Item | undefined {
    const item = this.getItem(id);
    if (item?.status !== 'approved' || !item.queue) return undefined;
    const queue = this.items({
      project: item.project,
      queue: item.queue,
      kind: sameKind ? item.kind : undefined,
      statuses: ['approved'],
      limit: 10_000,
    });
    const from = queue.findIndex((i) => i.id === id);
    const last = queue.length - 1;
    const target =
      typeof to === 'number'
        ? Math.min(Math.max(0, Math.trunc(to)), last)
        : to === 'top'
          ? 0
          : to === 'bottom'
            ? last
            : to === 'up'
              ? Math.max(0, from - 1)
              : Math.min(last, from + 1);
    if (target === from) return item;
    const keys = queue.map(queueKey);
    const order = [...queue];
    order.splice(target, 0, ...order.splice(from, 1));
    const update = this.db.prepare('UPDATE items SET queue_rank = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      let last = Number.NEGATIVE_INFINITY;
      order.forEach((i, n) => {
        // Equal keys (a bulk approval in one millisecond) would leave the order to chance.
        last = Math.max(keys[n] as number, last + 0.001);
        update.run(last, i.id);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getItem(id);
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

  addWebMessage(m: Omit<WebMessage, 'id' | 'createdAt' | 'updatedAt'>): number {
    const t = this.now();
    const r = this.db
      .prepare(
        `INSERT INTO web_messages (channel, thread_ts, ts, kind, user, text, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.channel,
        m.threadTs,
        m.ts,
        m.kind,
        m.user ?? null,
        m.text,
        m.data === undefined ? null : JSON.stringify(m.data),
        t,
        t,
      );
    return Number(r.lastInsertRowid);
  }

  /** Changes a dashboard message's text and/or data; false when there is no such message. */
  updateWebMessage(
    channel: string,
    ts: string,
    change: { text?: string; data?: unknown; kind?: string },
  ): boolean {
    const sets: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [this.now()];
    if (change.text !== undefined) {
      sets.push('text = ?');
      args.push(change.text);
    }
    if (change.data !== undefined) {
      sets.push('data = ?');
      args.push(JSON.stringify(change.data));
    }
    if (change.kind !== undefined) {
      sets.push('kind = ?');
      args.push(change.kind);
    }
    const r = this.db
      .prepare(`UPDATE web_messages SET ${sets.join(', ')} WHERE channel = ? AND ts = ?`)
      .run(...args, channel, ts);
    return Number(r.changes) > 0;
  }

  deleteWebMessage(channel: string, ts: string): void {
    this.db.prepare('DELETE FROM web_messages WHERE channel = ? AND ts = ?').run(channel, ts);
  }

  getWebMessage(channel: string, ts: string): WebMessage | undefined {
    const row = this.db.prepare('SELECT * FROM web_messages WHERE channel = ? AND ts = ?').get(channel, ts) as
      | Record<string, unknown>
      | undefined;
    return row ? webMessageRow(row) : undefined;
  }

  webMessageById(id: number): WebMessage | undefined {
    const row = this.db.prepare('SELECT * FROM web_messages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? webMessageRow(row) : undefined;
  }

  /** A dashboard thread's messages, oldest first: its root and every reply (`afterId`: only newer ones). */
  webThread(
    channel: string,
    threadTs: string,
    opts: { afterId?: number; limit?: number } = {},
  ): WebMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM web_messages WHERE channel = ? AND (thread_ts = ? OR ts = ?) AND id > ?
         ORDER BY id LIMIT ?`,
      )
      .all(channel, threadTs, threadTs, opts.afterId ?? 0, opts.limit ?? 500) as Record<string, unknown>[];
    return rows.map(webMessageRow);
  }

  /** A dashboard message's Slack copy (a card with buttons). */
  webMirror(webTs: string): { channel: string; ts: string } | undefined {
    const row = this.db
      .prepare('SELECT slack_channel, slack_ts FROM web_mirrors WHERE web_ts = ?')
      .get(webTs) as { slack_channel: string; slack_ts: string } | undefined;
    return row && { channel: row.slack_channel, ts: row.slack_ts };
  }

  saveWebMirror(webTs: string, channel: string, ts: string): void {
    this.db
      .prepare(
        `INSERT INTO web_mirrors (web_ts, slack_channel, slack_ts, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (web_ts) DO UPDATE SET slack_channel = excluded.slack_channel, slack_ts = excluded.slack_ts`,
      )
      .run(webTs, channel, ts, this.now());
  }

  /** The dashboard thread a Slack thread stands for (a run's summary, a card's copy), if any. */
  threadAlias(slackKey: string): string | undefined {
    const row = this.db.prepare('SELECT web_key FROM thread_aliases WHERE slack_key = ?').get(slackKey) as
      | { web_key: string }
      | undefined;
    return row?.web_key;
  }

  saveThreadAlias(slackKey: string, webKey: string): void {
    this.db
      .prepare(
        `INSERT INTO thread_aliases (slack_key, web_key, created_at) VALUES (?, ?, ?)
         ON CONFLICT (slack_key) DO UPDATE SET web_key = excluded.web_key`,
      )
      .run(slackKey, webKey, this.now());
  }

  /** Whether a Slack message (`<channel>:<ts>`) is a copy of a dashboard card. */
  isMirror(slackKey: string): boolean {
    const at = slackKey.indexOf(':');
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM web_mirrors WHERE slack_channel = ? AND slack_ts = ?')
        .get(slackKey.slice(0, at), slackKey.slice(at + 1)),
    );
  }

  /** The Slack threads that stand for a dashboard thread (its summaries), oldest first. */
  aliasesOf(webKey: string): string[] {
    return (
      this.db
        .prepare('SELECT slack_key FROM thread_aliases WHERE web_key = ? ORDER BY created_at')
        .all(webKey) as { slack_key: string }[]
    ).map((r) => r.slack_key);
  }

  /** Writes one row and reads it back: undefined when the database takes writes, else what failed. */
  checkWrite(): string | undefined {
    try {
      const at = this.now();
      this.db.prepare('INSERT OR REPLACE INTO heartbeat (id, at) VALUES (1, ?)').run(at);
      const row = this.db.prepare('SELECT at FROM heartbeat WHERE id = 1').get() as
        | { at: number }
        | undefined;
      return row?.at === at ? undefined : 'the row written was not read back';
    } catch (err) {
      return (err as Error).message;
    }
  }

  /**
   * Writes a consistent copy of the database to `file` (which must not exist) and checks the copy.
   * Returns `ok`, or what `quick_check` found wrong with it.
   */
  backupTo(file: string): string {
    this.db.prepare('VACUUM INTO ?').run(file);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = copy.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
      return rows.map((r) => r.quick_check).join('; ');
    } finally {
      copy.close();
    }
  }

  vaultMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setVaultMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO vault_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  vaultLogins(): VaultRow[] {
    return (
      this.db.prepare('SELECT * FROM vault_logins ORDER BY service, id').all() as Record<string, unknown>[]
    ).map(vaultRow);
  }

  vaultLogin(id: string): VaultRow | undefined {
    const r = this.db.prepare('SELECT * FROM vault_logins WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? vaultRow(r) : undefined;
  }

  /** Adds or replaces a login (created_at kept). */
  saveVaultLogin(r: VaultRow): void {
    this.db
      .prepare(
        `INSERT INTO vault_logins (id, projects, service, account, sites, login_url, secret, has_totp, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET projects = excluded.projects, service = excluded.service,
           account = excluded.account, sites = excluded.sites, login_url = excluded.login_url,
           secret = excluded.secret, has_totp = excluded.has_totp, note = excluded.note,
           updated_at = excluded.updated_at`,
      )
      .run(
        r.id,
        JSON.stringify(r.projects),
        r.service,
        r.account ?? null,
        JSON.stringify(r.sites),
        r.loginUrl,
        r.secret,
        r.hasTotp ? 1 : 0,
        r.note ?? null,
        r.createdAt,
        r.updatedAt,
      );
  }

  deleteVaultLogin(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM vault_logins WHERE id = ?').run(id).changes) === 1;
  }

  addVaultUse(u: Omit<VaultUse, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO vault_uses (login_id, project, action, status, detail, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(u.loginId, u.project ?? null, u.action, u.status, u.detail ?? null, u.by ?? null, u.at);
  }

  /** Newest first; one login's, or all. */
  vaultUses(opts: { loginId?: string; since?: number; limit?: number } = {}): VaultUse[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM vault_uses WHERE (? IS NULL OR login_id = ?) AND at >= ? ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(opts.loginId ?? null, opts.loginId ?? null, opts.since ?? 0, opts.limit ?? 100) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: r.id as number,
      loginId: r.login_id as string,
      project: (r.project as string | null) ?? undefined,
      action: r.action as string,
      status: r.status as string,
      detail: (r.detail as string | null) ?? undefined,
      by: (r.by as string | null) ?? undefined,
      at: r.at as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function vaultRow(r: Record<string, unknown>): VaultRow {
  const list = (v: unknown) => {
    try {
      const parsed = JSON.parse(v as string);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    id: r.id as string,
    projects: list(r.projects),
    service: r.service as string,
    account: (r.account as string | null) ?? undefined,
    sites: list(r.sites),
    loginUrl: r.login_url as string,
    secret: r.secret as string,
    hasTotp: r.has_totp === 1,
    note: (r.note as string | null) ?? undefined,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function webMessageRow(r: Record<string, unknown>): WebMessage {
  let data: unknown;
  try {
    data = r.data ? JSON.parse(r.data as string) : undefined;
  } catch {
    data = undefined;
  }
  return {
    id: r.id as number,
    channel: r.channel as string,
    threadTs: r.thread_ts as string,
    ts: r.ts as string,
    kind: r.kind as WebMessage['kind'],
    user: (r.user as string | null) ?? undefined,
    text: r.text as string,
    data,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}
