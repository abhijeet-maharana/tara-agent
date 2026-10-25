import { Cron } from 'croner';
import { loadQueues } from '../config/load.js';
import type { Project, QueueConfig, QueueWindow } from '../config/schema.js';
import type { Logger } from '../sessions/manager.js';
import type { Item, Store } from '../store/store.js';
import { addDays, dayKey, dayMatches, midnight, minutesOf, zonedClock } from '../util/time.js';

/**
 * Runs approved items (approvals/approvals.ts) through each project's queues (`.tara/queues.json`),
 * one batch at a time per queue: inside the item's window (or at the queue's cron slots, taking turns
 * between kinds), within the daily and weekly caps, with a gap between runs. A job executor gets the
 * items in its prompt; a URL executor gets one POST per item with its seal and answers done, failed,
 * or later (it can't take the item yet: back in the queue until `retryAt`). Items an executor never
 * reports end as failed and are never run again, so nothing goes out twice.
 */

const TICK_MS = 60_000;
const DAY_MS = 86_400_000;
/** URL executors answer one item within this time. */
const URL_TIMEOUT_MS = 120_000;
/** A URL executor that answers "later" without a time is asked again after this long. */
const LATER_MS = 3_600_000;
/** A queue slot is still taken this long after its time (a restart, a busy queue). */
const SLOT_GRACE_MS = 2 * 3_600_000;

export interface QueueRunner {
  runQueue(project: string, jobId: string, queue: string, items: Item[]): Promise<string>;
  /** False when the executor job is paused (or missing): its items wait. */
  enabled(project: string, jobId: string): boolean;
}

export interface QueueWorkerDeps {
  projects: Project[];
  store: Store;
  log: Logger;
  jobs: QueueRunner;
  /** Host timezone (queue default). */
  timeZone: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Told about every item that finished (done or failed), e.g. Approvals.notify. */
  onFinished?: (item: Item) => void;
  /** For tests: a queue file per project instead of reading `.tara/queues.json`. */
  queues?: (project: Project) => Record<string, QueueConfig>;
}

/** True while `window` is open at `now`. */
export function windowOpen(window: QueueWindow, defaultTz: string, now: number): boolean {
  const { weekday, minutes } = zonedClock(now, window.tz ?? defaultTz);
  if (!dayMatches(window.days, weekday)) return false;
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** When `window` next opens (now when it is open), within two weeks. */
export function nextWindowStart(window: QueueWindow, defaultTz: string, now: number): number | undefined {
  if (windowOpen(window, defaultTz, now)) return now;
  const tz = window.tz ?? defaultTz;
  const today = dayKey(now, tz);
  for (let i = 0; i < 15; i++) {
    const day = addDays(today, i);
    const start = midnight(day, tz) + minutesOf(window.from) * 60_000;
    if (start > now && dayMatches(window.days, zonedClock(start, tz).weekday)) return start;
  }
  return undefined;
}

/** When an approved item can next run, for the page ("goes out Tue 14:40"). */
export function nextRun(
  item: Item,
  queue: QueueConfig | undefined,
  hostTz: string,
  now: number,
): number | undefined {
  if (!queue) return undefined;
  const after = Math.max(now, item.runAfter ?? 0);
  if (item.runNow) return after;
  const tz = queue.tz ?? hostTz;
  if (queue.slots)
    return new Cron(queue.slots, { timezone: tz, paused: true }).nextRun(new Date(after))?.getTime();
  if (!queue.windows) return after;
  const windows = item.window ? [queue.windows[item.window]] : Object.values(queue.windows);
  const starts = windows
    .filter((w): w is QueueWindow => Boolean(w))
    .map((w) => nextWindowStart(w, tz, after))
    .filter((t): t is number => t !== undefined);
  return starts.length ? Math.min(...starts) : undefined;
}

export class QueueWorker {
  private readonly running = new Set<string>();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: QueueWorkerDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    const stuck = this.deps.store.failRunning(
      'tara-agent restarted while this item was running; check before running it again',
    );
    for (const item of stuck) this.deps.onFinished?.(item);
    if (stuck.length)
      this.deps.log.warn(
        `${stuck.length} running ${stuck.length === 1 ? 'item' : 'items'} marked failed after a restart`,
      );
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  queues(project: Project): Record<string, QueueConfig> {
    try {
      return (this.deps.queues ?? loadQueues)(project);
    } catch (err) {
      this.deps.log.error(`[${project.config.name}] queues not loaded: ${(err as Error).message}`);
      return {};
    }
  }

  /** One pass over every queue: start what is due. Exposed for tests. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const project of this.deps.projects) {
      const days = project.config.approvals?.expireDays ?? 7;
      this.deps.store.expireItems(now - days * DAY_MS, project.config.name);
      for (const [name, queue] of Object.entries(this.queues(project)))
        this.consider(project, name, queue, now);
    }
  }

  /** For tests: resolves when every started batch has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private consider(project: Project, name: string, queue: QueueConfig, now: number): void {
    const p = project.config.name;
    const key = `${p}:${name}`;
    if (this.running.has(key)) return;
    // The project's server runs these itself and reports them (Approvals.report).
    if ('external' in queue.executor) return;
    // A paused executor (Pause, or a project's emergency stop) holds its queue.
    if ('job' in queue.executor && !this.deps.jobs.enabled(p, queue.executor.job)) return;
    const { store } = this.deps;
    const tz = queue.tz ?? this.deps.timeZone;

    // A slot that passed counts once, whether or not there was anything to send in it. The first slot
    // a queue ever sees is only recorded (a new queue must not fire for its past), and a slot missed by
    // more than SLOT_GRACE_MS (tara-agent was down) is skipped.
    let slotFired = false;
    if (queue.slots) {
      const slot = new Cron(queue.slots, { timezone: tz, paused: true })
        .previousRuns(1, new Date(now))[0]
        ?.getTime();
      const last = store.lastSlot(p, name);
      if (slot && slot > last) {
        store.setLastSlot(p, name, slot);
        slotFired = last > 0 && now - slot < SLOT_GRACE_MS;
      }
    }

    const approved = store.items({ project: p, queue: name, statuses: ['approved'] });
    if (!approved.length) return;
    const last = store.lastQueueStart(p, name);
    if (queue.gapMinutes && last?.startedAt && now - last.startedAt < queue.gapMinutes * 60_000) return;

    let room = queue.batch;
    if (queue.caps.perDay) {
      const today = store.queueStarts(p, name, midnight(dayKey(now, tz), tz)).length;
      room = Math.min(room, queue.caps.perDay - today);
    }
    if (queue.caps.perWeek)
      room = Math.min(room, queue.caps.perWeek - store.queueStarts(p, name, now - 7 * DAY_MS).length);
    if (room <= 0) return;

    let due = approved.filter((i) => (i.runAfter ?? 0) <= now);
    if (queue.slots) {
      due = slotFired ? due : due.filter((i) => i.runNow);
      if (slotFired && queue.alternate?.length) {
        const order = queue.alternate;
        const after = last ? order.indexOf(last.kind) : -1;
        const turns = order.map((_, i) => order[(after + 1 + i) % order.length] as string);
        const kind = turns.find((k) => due.some((i) => i.kind === k));
        due = kind ? due.filter((i) => i.kind === kind) : due;
      }
    } else if (queue.windows) {
      const windows = queue.windows;
      due = due.filter(
        (i) =>
          i.runNow ||
          (i.window
            ? windows[i.window] && windowOpen(windows[i.window] as QueueWindow, tz, now)
            : Object.values(windows).some((w) => windowOpen(w, tz, now))),
      );
    }
    const batch = store.startItems(due.slice(0, room).map((i) => i.id));
    if (!batch.length) return;

    this.running.add(key);
    const task = this.execute(project, name, queue, batch)
      .catch((err: Error) => this.deps.log.error(`[${key}] queue run failed: ${err.message}`))
      .finally(() => {
        this.running.delete(key);
        this.inflight.delete(task);
      });
    this.inflight.add(task);
  }

  private finished(item: Item | undefined): void {
    if (item) this.deps.onFinished?.(item);
  }

  private async execute(project: Project, name: string, queue: QueueConfig, items: Item[]): Promise<void> {
    const p = project.config.name;
    const { store, log } = this.deps;
    const ids = items.map((i) => i.id);
    log.info(`[${p}] queue ${name}: running ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`);
    if ('job' in queue.executor) {
      const status = await this.deps.jobs.runQueue(p, queue.executor.job, name, items);
      const reason =
        status === 'unknown'
          ? `No job "${queue.executor.job}" in ${p}`
          : `The ${queue.executor.job} run ended (${status}) without reporting this item`;
      for (const item of store.failRunning(reason, ids)) this.deps.onFinished?.(item);
      return;
    }
    if (!('url' in queue.executor)) return;
    const { url } = queue.executor;
    for (const item of items) {
      try {
        const res = await (this.deps.fetch ?? fetch)(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ item: executorPayload(item) }),
          signal: AbortSignal.timeout(URL_TIMEOUT_MS),
        });
        const json = (await res.json().catch(() => ({}))) as {
          status?: string;
          result?: string;
          error?: string;
          retryAt?: number | string;
        };
        if (res.ok && json.status === 'later') {
          const at = typeof json.retryAt === 'string' ? Date.parse(json.retryAt) : json.retryAt;
          const runAfter =
            Number.isFinite(at) && (at as number) > this.now() ? (at as number) : this.now() + LATER_MS;
          store.deferItem(item.id, runAfter, json.result);
          log.info(`[${p}] queue ${name}: ${item.id} not yet (${json.result ?? 'no reason'})`);
          continue;
        }
        const ok = res.ok && json.status !== 'failed';
        this.finished(
          store.finishItem(
            item.id,
            ok ? 'done' : 'failed',
            json.result ?? json.error ?? (res.ok ? undefined : `HTTP ${res.status}`),
          ),
        );
      } catch (err) {
        this.finished(store.finishItem(item.id, 'failed', (err as Error).message));
      }
    }
  }
}

/** What an executor gets for one item: what was approved, and the seal proving it. */
export function executorPayload(item: Item) {
  return {
    id: item.id,
    project: item.project,
    kind: item.kind,
    key: item.key,
    title: item.title,
    window: item.window,
    fields: item.fields,
    note: item.reply,
    decidedBy: item.decidedBy,
    decidedAt: item.decidedAt,
    seal: item.seal,
  };
}
