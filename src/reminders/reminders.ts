import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { Project } from '../config/schema.js';
import { openRunThread } from '../scheduler/slack-trigger.js';
import type { ChatPort, Logger } from '../sessions/manager.js';
import type { Reminder, Store } from '../store/store.js';

/**
 * Reminders: a line of text posted in a project's channel at a time or on a schedule. Set, listed and
 * cancelled by Claude (tara MCP tools) or the local API. Posting one starts no Claude run, so a reminder
 * costs nothing; it opens a `Run Reminder` thread and mentions the project `owner` there. With `notify`,
 * the text also goes to the project's `reminders.hookUrl` (e.g. a WhatsApp group the project sends to).
 */

const TICK_MS = 30_000;
const MAX_TEXT = 1_000;
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
    if (!text) throw new ReminderError('"text" is required');
    if (text.length > MAX_TEXT) throw new ReminderError(`"text" is longer than ${MAX_TEXT} characters`);
    if (Boolean(input.cron) === (input.at !== undefined))
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
        await this.post(r, now - due > LATE_MS ? due : undefined).catch((err: Error) =>
          this.deps.log.warn(`Reminder ${r.id}: ${err.message}`),
        );
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
