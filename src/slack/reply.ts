import type { ChatPort } from '../sessions/manager.js';
import { Throttle } from '../util/concurrency.js';
import { splitMessage, toSlackMrkdwn } from './format.js';

export type TaskStatus = 'in_progress' | 'complete' | 'error';

/** Chunks of Slack's native streaming API (`chat.appendStream`). */
export type StreamChunk =
  | { type: 'markdown_text'; text: string }
  | { type: 'plan_update'; title: string }
  | { type: 'task_update'; id: string; title: string; status: TaskStatus };

/** Slack's native message streaming (needs the app's "Agents & AI Apps" feature). */
export interface StreamPort {
  /** Set once Slack says the app can't stream; later turns use edited messages instead. */
  disabled: boolean;
  start(channel: string, threadTs: string, recipientUserId: string): Promise<string>;
  append(channel: string, ts: string, chunks: StreamChunk[]): Promise<void>;
  stop(channel: string, ts: string): Promise<void>;
}

/** A Slack API error, with Slack's error code (e.g. `message_not_in_streaming_state`). */
export class StreamError extends Error {
  constructor(readonly code: string) {
    super(`Slack streaming failed: ${code}`);
  }
}

/** Errors meaning this app or workspace can't use native streaming at all. */
const UNSUPPORTED =
  /not_allowed|missing_scope|feature_not_enabled|invalid_method|unknown_method|method_deprecated|not_authed|streaming_not_allowed/;

export interface Finish {
  /** One line for the card/status, e.g. "✅ Done · 12s · 3 steps · claude-opus-5-5". */
  summary: string;
  ok: boolean;
  /** The final answer (posted only when it wasn't already streamed). */
  answer: string;
  /** Extra notes after the answer (e.g. blocked tools). */
  notes: string[];
}

/** How one chat turn shows up in its thread while Claude works. */
export interface TurnReply {
  /** Called once the turn got a slot and Claude starts. */
  working(): void;
  text(delta: string): void;
  /** A new text block starts (after tool calls): keep it apart from the previous one. */
  textBreak(): void;
  toolStart(id: string, title: string): void;
  toolEnd(id: string, ok: boolean): void;
  finish(result: Finish): Promise<void>;
}

/**
 * Fallback without native streaming: one status message, edited with the current step, then the
 * answer as new messages.
 */
export class EditReply implements TurnReply {
  private statusTs: Promise<string>;
  private steps = 0;
  private readonly status: Throttle<string>;

  constructor(
    private readonly chat: ChatPort,
    private readonly channel: string,
    private readonly threadTs: string,
    waiting: boolean,
    intervalMs: number,
  ) {
    this.statusTs = chat.post(channel, threadTs, waiting ? '⏳ Waiting for a free slot…' : '⏳ Working…');
    this.statusTs.catch(() => {});
    this.status = new Throttle<string>(intervalMs, async (text) =>
      chat.update(channel, await this.statusTs, text),
    );
  }

  working(): void {}
  text(): void {}
  textBreak(): void {}

  toolStart(_id: string, title: string): void {
    this.steps++;
    this.status.push(`⏳ Working · step ${this.steps}\n> ${title}`);
  }

  toolEnd(): void {}

  async finish({ summary, ok, answer, notes }: Finish): Promise<void> {
    await this.status.flush();
    await this.chat.update(this.channel, await this.statusTs, summary);
    if (ok) {
      for (const chunk of splitMessage(toSlackMrkdwn(answer.trim() || '_(no text reply)_'))) {
        await this.chat.post(this.channel, this.threadTs, chunk);
      }
    }
    for (const note of notes) await this.chat.post(this.channel, this.threadTs, note);
  }
}

/**
 * Native streaming, like Slack's AI apps: one message per turn with a live task card (one line per
 * tool, ticked off as it finishes) and Claude's text typed out below it as it is written.
 * Falls back to EditReply when the app can't stream, and to plain messages for anything Slack
 * refuses mid-stream, so no text is ever lost.
 */
export class StreamReply implements TurnReply {
  private ts: string | undefined;
  private title: string;
  private readonly tasks = new Map<string, { title: string; status: TaskStatus }>();
  private pendingTasks = new Set<string>();
  private pendingTitle = true;
  private buffer = '';
  /** Text Slack accepted (to know what still needs posting if streaming breaks). */
  private streamed = '';
  /** Text Slack refused; posted as plain messages at the end. */
  private leftover = '';
  private broken = false;
  private fallback: EditReply | undefined;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly chat: ChatPort,
    private readonly port: StreamPort,
    private readonly channel: string,
    private readonly threadTs: string,
    private readonly user: string,
    waiting: boolean,
    private readonly intervalMs: number,
  ) {
    this.title = waiting ? '⏳ Waiting for a free slot…' : '⏳ Working…';
    this.enqueue();
  }

  working(): void {
    this.setTitle('⏳ Working…');
  }

  text(delta: string): void {
    if (this.fallback) return;
    this.buffer += delta;
    this.schedule();
  }

  textBreak(): void {
    if (this.fallback) return;
    const sofar = this.streamed + this.leftover + this.buffer;
    if (sofar.trim() && !sofar.endsWith('\n\n')) this.buffer += sofar.endsWith('\n') ? '\n' : '\n\n';
  }

  toolStart(id: string, title: string): void {
    if (this.fallback) {
      this.fallback.toolStart(id, title);
      return;
    }
    this.tasks.set(id, { title: title.slice(0, 256), status: 'in_progress' });
    this.pendingTasks.add(id);
    this.schedule();
  }

  toolEnd(id: string, ok: boolean): void {
    const task = this.tasks.get(id);
    if (this.fallback || !task) return;
    task.status = ok ? 'complete' : 'error';
    this.pendingTasks.add(id);
    this.schedule();
  }

  async finish(result: Finish): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.chain;
    if (this.fallback) return this.fallback.finish(result);
    // Anything still running when the turn ends is done.
    for (const [id, task] of this.tasks) {
      if (task.status === 'in_progress') {
        task.status = result.ok ? 'complete' : 'error';
        this.pendingTasks.add(id);
      }
    }
    if (result.ok && !(this.streamed + this.leftover + this.buffer).trim()) {
      this.buffer += result.answer.trim() || '_(no text reply)_';
    }
    if (!result.ok) {
      this.textBreak();
      this.buffer += result.summary;
    }
    for (const note of result.notes) {
      this.textBreak();
      this.buffer += note;
    }
    this.title = result.summary;
    this.pendingTitle = true;
    this.enqueue();
    await this.chain;
    // send() may have switched to the fallback while we waited.
    const fallback = this.fallback as EditReply | undefined;
    if (fallback) return fallback.finish(result);
    if (this.ts) await this.port.stop(this.channel, this.ts).catch(() => {});
    for (const chunk of splitMessage(toSlackMrkdwn(this.leftover.trim()))) {
      if (chunk.trim()) await this.chat.post(this.channel, this.threadTs, chunk);
    }
  }

  private setTitle(title: string): void {
    if (this.fallback || this.title === title) return;
    this.title = title;
    this.pendingTitle = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueue();
    }, this.intervalMs);
  }

  /** Sends what is pending, one request at a time, in order. */
  private enqueue(): void {
    this.chain = this.chain.then(() => this.send()).catch(() => {});
  }

  private takeChunks(): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    if (this.pendingTitle) chunks.push({ type: 'plan_update', title: this.title.slice(0, 256) });
    for (const id of this.pendingTasks) {
      const task = this.tasks.get(id);
      if (task) chunks.push({ type: 'task_update', id, title: task.title, status: task.status });
    }
    if (this.buffer) chunks.push({ type: 'markdown_text', text: this.buffer });
    this.pendingTitle = false;
    this.pendingTasks = new Set();
    return chunks;
  }

  private async send(): Promise<void> {
    if (this.fallback) return;
    const text = this.buffer;
    const chunks = this.takeChunks();
    this.buffer = '';
    if (chunks.length === 0) return;
    if (this.broken) {
      this.leftover += text;
      return;
    }
    try {
      if (!this.ts) this.ts = await this.port.start(this.channel, this.threadTs, this.user);
      await this.port.append(this.channel, this.ts, chunks);
      this.streamed += text;
    } catch (err) {
      const code = err instanceof StreamError ? err.code : (err as Error).message;
      if (!this.ts && UNSUPPORTED.test(code)) {
        // This app can't stream at all: switch this turn (and later ones) to edited messages.
        this.port.disabled = true;
        this.fallback = new EditReply(this.chat, this.channel, this.threadTs, false, this.intervalMs);
        for (const task of this.tasks.values()) this.fallback.toolStart('', task.title);
        return;
      }
      if (this.ts && code === 'message_not_in_streaming_state') {
        // Slack seals long streams after a few minutes: continue in a fresh card with the full state.
        try {
          this.ts = await this.port.start(this.channel, this.threadTs, this.user);
          const state: StreamChunk[] = [
            { type: 'plan_update', title: this.title.slice(0, 256) },
            ...[...this.tasks].map(([id, t]) => ({
              type: 'task_update' as const,
              id,
              title: t.title,
              status: t.status,
            })),
            ...(text ? [{ type: 'markdown_text' as const, text }] : []),
          ];
          await this.port.append(this.channel, this.ts, state);
          this.streamed += text;
          return;
        } catch {
          // fall through: stop streaming and post the rest as messages
        }
      }
      this.broken = true;
      this.leftover += text;
    }
  }
}
