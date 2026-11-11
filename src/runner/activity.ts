import { randomUUID } from 'node:crypto';
import type { RunLabel, Runner, RunOutcome, RunStatus } from './run.js';
import type { RateLimit, StreamEvent } from './stream.js';

/**
 * Every labelled Claude run, live: a running session's steps and Stop on its dashboard page. `wrap`
 * puts the bus around the one Runner the whole process uses, so chat turns and job runs all report
 * here whoever started them (Slack, a schedule, the dashboard). Each task can be stopped from here: the run
 * gets a second abort signal, and ends as `aborted` the way a "stop" in Slack ends it.
 */

export type { RunLabel };

export interface TaskStep {
  id: string;
  /** What the tool does, e.g. "Reading src/sync.ts" (secrets removed). */
  text: string;
  state: 'running' | 'ok' | 'error';
  /** 1 for a step inside a sub-agent. */
  depth: 0 | 1;
  at: number;
}

export interface Task {
  id: string;
  project: string;
  kind: RunLabel['kind'];
  title: string;
  thread?: RunLabel['thread'];
  jobId?: string;
  /** The Slack thread's link, when the workspace URL is known. */
  url?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | RunStatus;
  /** The latest steps, oldest first (at most MAX_STEPS). */
  steps: TaskStep[];
  stepCount: number;
  /** The end of what Claude wrote last (at most MAX_TEXT characters, secrets removed). */
  text: string;
  costUsd?: number;
  error?: string;
}

export type ActivityEvent =
  | { type: 'task'; task: Task }
  /** The share of the current usage window already used, as the CLI last reported it. */
  | { type: 'usage'; usage: RateLimit };

export const MAX_STEPS = 40;
const MAX_TEXT = 600;
/** Finished tasks kept for tabs that open later. */
const KEEP_DONE = 12;
/** Changes inside a run are sent at most this often; start and end go out at once. */
const FLUSH_MS = 500;

/** Removes things that look like secrets from text shown on screen: keys, tokens, passwords in URLs. */
export function redact(text: string): string {
  return text
    .replace(/\b(xox[abpros]-|gh[pousr]_|github_pat_|sk-(?:ant-)?|AIza|glpat-)[A-Za-z0-9_-]{8,}/g, '$1•••')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA•••')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 •••')
    .replace(/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1•••@')
    .replace(
      /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&,;]+)/gi,
      '$1$2•••',
    );
}

/** A copy fit to leave the process: streamed text redacted (whole, so a secret split across pieces is caught) and trimmed. */
const copy = (task: Task): Task => ({
  ...task,
  steps: task.steps.map((s) => ({ ...s })),
  text: redact(task.text).slice(-MAX_TEXT),
});

interface Live {
  task: Task;
  controller: AbortController;
  timer?: NodeJS.Timeout;
}

export class Activity {
  private readonly live = new Map<string, Live>();
  private done: Task[] = [];
  private readonly listeners = new Set<(event: ActivityEvent) => void>();
  private lastUsage?: RateLimit;

  constructor(
    private readonly opts: {
      /** The thread's link from its channel and ts. */
      threadUrl?: (channel: string, ts: string) => string | undefined;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Calls `listener` for every change; returns the unsubscribe. */
  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Running tasks, then recently finished ones, newest first. */
  tasks(): Task[] {
    // Newest first; the same millisecond keeps the later start first (the sort is stable).
    const running = [...this.live.values()]
      .reverse()
      .map((l) => l.task)
      .sort((a, b) => b.startedAt - a.startedAt);
    return [...running, ...this.done].map(copy);
  }

  usage(): RateLimit | undefined {
    return this.lastUsage;
  }

  /** Stops a running task; false when it isn't running. */
  stop(id: string): boolean {
    const l = this.live.get(id);
    if (!l) return false;
    l.controller.abort();
    return true;
  }

  private emit(event: ActivityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private flush(l: Live): void {
    clearTimeout(l.timer);
    l.timer = undefined;
    this.emit({ type: 'task', task: copy(l.task) });
  }

  private touch(l: Live): void {
    l.timer ??= setTimeout(() => this.flush(l), FLUSH_MS);
  }

  /** The runner, reporting every run that carries a `label`. */
  wrap(run: Runner): Runner {
    return async (options) => {
      const label = options.label;
      if (!label) return run(options);
      const controller = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      const task: Task = {
        id: randomUUID(),
        project: label.project,
        kind: label.kind,
        title: redact(label.title.split('\n')[0]?.trim().slice(0, 140) || label.kind),
        thread: label.thread,
        jobId: label.jobId,
        url: label.thread && this.opts.threadUrl?.(label.thread.channel, label.thread.ts),
        startedAt: this.now(),
        status: 'running',
        steps: [],
        stepCount: 0,
        text: '',
      };
      const l: Live = { task, controller };
      this.live.set(task.id, l);
      this.flush(l);
      let outcome: RunOutcome | undefined;
      try {
        outcome = await run({
          ...options,
          signal,
          onEvent: (event) => {
            options.onEvent?.(event);
            this.event(l, event);
          },
        });
        return outcome;
      } finally {
        this.live.delete(task.id);
        task.endedAt = this.now();
        task.status = outcome?.status ?? 'error';
        task.costUsd = outcome?.costUsd;
        task.error = outcome?.error && redact(outcome.error).slice(0, 300);
        if (outcome?.text.trim()) task.text = redact(outcome.text.trim()).slice(-MAX_TEXT);
        for (const s of task.steps)
          if (s.state === 'running') s.state = task.status === 'ok' ? 'ok' : 'error';
        this.done = [task, ...this.done].slice(0, KEEP_DONE);
        this.flush(l);
      }
    };
  }

  private event(l: Live, event: StreamEvent): void {
    const { task } = l;
    if (event.kind === 'tool') {
      task.stepCount++;
      task.steps.push({
        id: event.id,
        text: redact(event.status).slice(0, 200),
        state: 'running',
        depth: event.parent ? 1 : 0,
        at: this.now(),
      });
      if (task.steps.length > MAX_STEPS) task.steps.splice(0, task.steps.length - MAX_STEPS);
    } else if (event.kind === 'tool_result') {
      const step = task.steps.find((s) => s.id === event.id);
      if (!step) return;
      step.state = event.isError ? 'error' : 'ok';
    } else if (event.kind === 'text_start' && !event.parent) {
      task.text = '';
    } else if (event.kind === 'text' && !event.parent) {
      task.text = (task.text + event.text).slice(-MAX_TEXT * 2);
    } else if (event.kind === 'rate_limit') {
      this.lastUsage = event.rateLimit;
      this.emit({ type: 'usage', usage: event.rateLimit });
      return;
    } else return;
    this.touch(l);
  }
}
