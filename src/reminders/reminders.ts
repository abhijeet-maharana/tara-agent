import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { Project } from '../config/schema.js';
import { openRunThread } from '../scheduler/slack-trigger.js';
import type { ChatPort, IncomingMessage, Logger } from '../sessions/manager.js';
import type { Reminder, Store } from '../store/store.js';

/**
 * Reminders: a line of text posted in a project's channel at a time or on a schedule. Set, listed and
 * cancelled by Claude (tara MCP tools) or the local API. Posting one starts no Claude run, so a reminder
 * costs nothing; it opens a `Run Reminder` thread and mentions the project `owner` there. With `notify`,
 * the text also goes to the project's `reminders.hookUrl` (e.g. a WhatsApp group the project sends to).
 *
 * A scheduled task (`task`) is a one-time reminder for Claude: at its time it opens a fresh `Run <title>`
 * thread, posts its text there as the note of what to do, and starts a chat run on that note, so the work
 * shows in Slack like any other run. A task missed by more than `catchUpMs` (tara-agent was down) is
 * skipped with a note in its thread instead of starting a stale run.
 */

const TICK_MS = 30_000;
const MAX_TEXT = 1_000;
/** A task's note says everything the run will know, so it may be longer than a reminder. */
const MAX_NOTE = 4_000;
const MAX_TITLE = 80;
const SLACK_USER = /^[UW][A-Z0-9]+$/;
const HOOK_TIMEOUT_MS = 30_000;
/** A reminder due longer ago than this (tara-agent was down) says it is late. */
const LATE_MS = 15 * 60_000;
const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export class ReminderError extends Error {
  readonly status = 400;
}

export interface ReminderInput {
  text: string;
  /** Five-field cron in the host timezone, for a repeating reminder. */
  cron?: string;
  /** One time, as epoch ms or an ISO time with its offset. */
  at?: string | number;
  /** Also send to the project's `reminders.hookUrl`. */
  notify?: boolean;
  /** A scheduled task: once, at `at`, start a run with `text` as the note of what to do. */
  task?: boolean;
  /** A task's short name for its `Run <title>` message (default "Scheduled Task"). */
  title?: string;
  by?: string;
}

export interface RemindersDeps {
  store: Store;
  chat: ChatPort;
  projects: Project[];
  timeZone: string;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  newId?: () => string;
  /** Starts a chat run on a due task's note (the session manager's `handle`). Unset: tasks are refused. */
  startRun?: (msg: IncomingMessage) => Promise<void>;
  /** A task this late is skipped instead of run (host `catchUpHours`; default 6 h). */
  catchUpMs?: number;
  /**
   * The channel a project's task runs in: a dashboard thread's (host `delivery: summary`, with the
   * result posted in Slack) or its Slack channel (unset).
   */
  runChannel?: (project: Project) => string;
}

export class Reminders {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: RemindersDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomUUID().slice(0, 8));
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  add(projectName: string, input: ReminderInput): Reminder {
    const project = this.project(projectName);
    const text = input.text?.trim();
    const task = input.task === true;
    const max = task ? MAX_NOTE : MAX_TEXT;
    if (!text) throw new ReminderError(task ? 'The task needs a note of what to do' : '"text" is required');
    if (text.length > max) throw new ReminderError(`"text" is longer than ${max} characters`);
    const title = input.title?.replace(/\s+/g, ' ').trim() || undefined;
    if (title && title.length > MAX_TITLE)
      throw new ReminderError(`"title" is longer than ${MAX_TITLE} characters`);
    if (task) {
      if (!this.deps.startRun) throw new ReminderError('Scheduled tasks are off here');
      if (input.cron || input.at === undefined)
        throw new ReminderError('A task runs once: give "at", not "cron" (repeating work belongs in a job)');
      if (input.notify) throw new ReminderError('A task has no "notify"; its run can send what it needs');
    } else if (Boolean(input.cron) === (input.at !== undefined))
      throw new ReminderError('Give either "cron" (repeating) or "at" (once)');
    if (input.notify && !project.config.reminders?.hookUrl)
      throw new ReminderError(`${projectName} has no reminders.hookUrl, so "notify" can't be sent anywhere`);
    let nextAt: number | undefined;
    if (input.cron) {
      nextAt = this.nextOf(input.cron, this.now());
      if (nextAt === undefined) throw new ReminderError(`"${input.cron}" never comes round`);
    } else {
      nextAt = parseAt(input.at as string | number);
      if (nextAt <= this.now()) throw new ReminderError('"at" is in the past');
    }
    const reminder: Reminder = {
      id: this.newId(),
      project: projectName,
      text,
      cron: input.cron,
      nextAt,
      notify: input.notify === true,
      ...(task && { task: true, title }),
      createdBy: input.by,
      createdAt: this.now(),
    };
    this.deps.store.addReminder(reminder);
    return reminder;
  }

  list(projectName: string): Reminder[] {
    this.project(projectName);
    return this.deps.store.reminders(projectName);
  }

  cancel(projectName: string, id: string): boolean {
    return this.deps.store.cancelReminder(projectName, id, this.now());
  }

  /** Posts every reminder that is due. Each is claimed first, so two ticks never post one twice. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const r of this.deps.store.dueReminders(now)) {
        const due = r.nextAt as number;
        // A repeating reminder that was missed for a while is posted once, then goes on from now.
        const next = r.cron ? this.nextOf(r.cron, Math.max(now, due)) : undefined;
        if (!this.deps.store.claimReminder(r.id, due, next ?? null, now)) continue;
        const posted = r.task
          ? this.runTask(r, due, now)
          : this.post(r, now - due > LATE_MS ? due : undefined);
        await posted.catch((err: Error) => this.deps.log.warn(`Reminder ${r.id}: ${err.message}`));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async post(r: Reminder, lateSince?: number): Promise<void> {
    const project = this.deps.projects.find((p) => p.config.name === r.project);
    if (!project) return;
    const { chat } = this.deps;
    const channel = project.config.slackChannel;
    const ts = await openRunThread(chat, channel, 'Reminder', project.config.words);
    const owner = project.config.owner ? `<@${project.config.owner}> ` : '';
    const late = lateSince ? ` (late: was due ${this.clock(lateSince)})` : '';
    await chat.post(channel, ts, `${owner}⏰ ${r.text}${late}`);
    const hookUrl = project.config.reminders?.hookUrl;
    if (!r.notify || !hookUrl) return;
    const error = await this.callHook(hookUrl, r);
    await chat.post(
      channel,
      ts,
      error ? `⚠️ Not sent to the reminder hook: ${error}` : '✅ Also sent through the reminder hook',
    );
  }

  /**
   * A due task: a fresh `Run <title>` thread, the note in it, then a chat run on that note. The run is
   * not awaited: it can take minutes, and other reminders due now must not wait for it.
   */
  private async runTask(r: Reminder, due: number, now: number): Promise<void> {
    const project = this.deps.projects.find((p) => p.config.name === r.project);
    if (!project) return;
    const { chat } = this.deps;
    const lateMs = now - due;
    const skip = lateMs > (this.deps.catchUpMs ?? 6 * 3_600_000) || !this.deps.startRun;
    // A skipped task needs a person, so it is said in Slack; a run may happen on the dashboard.
    const channel = (!skip && this.deps.runChannel?.(project)) || project.config.slackChannel;
    const name = r.title ?? 'Scheduled Task';
    const ts = await openRunThread(chat, channel, name, project.config.words);
    const by = r.createdBy && SLACK_USER.test(r.createdBy) ? r.createdBy : undefined;
    const setBy = by ? `<@${by}>` : (r.createdBy ?? 'Claude');
    const header = `📝 Scheduled task, set by ${setBy} ${this.clock(r.createdAt)} for ${this.clock(due)}`;
    if (skip || !this.deps.startRun) {
      await chat.post(channel, ts, `${header}:\n${r.text}`);
      await chat.post(
        channel,
        ts,
        '⏭ Skipped: tara-agent was down at its time. Ask here if it is still needed.',
      );
      await chat.react(channel, ts, 'double_vertical_bar').catch(() => {});
      return;
    }
    const late = lateMs > LATE_MS ? ` (late: was due ${this.clock(due)})` : '';
    const noteTs = await chat.post(channel, ts, `${header}${late}:\n${r.text}`);
    const user = by ?? project.config.owner ?? project.config.allowedUsers[0] ?? 'tara';
    void this.deps
      .startRun({
        channel,
        threadTs: ts,
        ts: noteTs,
        user,
        summary: `*${name}*`,
        text: `Scheduled task (set ${this.clock(r.createdAt)} for ${this.clock(due)}, now due). Do what this note says:\n\n${r.text}`,
      })
      .catch((err: Error) => this.deps.log.warn(`Task ${r.id}: ${err.message}`));
  }

  /** POST {id, text}; returns why it failed, or undefined. */
  private async callHook(url: string, r: Reminder): Promise<string | undefined> {
    try {
      const res = await (this.deps.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: r.id, text: `⏰ ${r.text}` }),
        signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      });
      if (res.ok) return undefined;
      return `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim();
    } catch (err) {
      return (err as Error).message;
    }
  }

  private nextOf(cron: string, after: number): number | undefined {
    try {
      return new Cron(cron, { paused: true, timezone: this.deps.timeZone })
        .nextRun(new Date(after))
        ?.getTime();
    } catch (err) {
      throw new ReminderError(`"${cron}" is not a cron: ${(err as Error).message}`);
    }
  }

  private clock(at: number): string {
    return new Date(at).toLocaleString('en-GB', {
      timeZone: this.deps.timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private project(name: string): Project {
    const project = this.deps.projects.find((p) => p.config.name === name);
    if (!project) throw new ReminderError(`No project "${name}"`);
    return project;
  }
}

/** Epoch ms, or an ISO time that names its offset (a bare local time would depend on the machine). */
function parseAt(at: string | number): number {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  const s = String(at).trim();
  const ms = Date.parse(s);
  if (!OFFSET.test(s) || Number.isNaN(ms))
    throw new ReminderError('"at" must be an ISO time with its offset, e.g. 2026-11-19T09:30:00+05:30');
  return ms;
}
