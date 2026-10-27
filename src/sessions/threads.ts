import { KeyedQueue } from '../util/concurrency.js';

/** A thread held by one run: its stop signal, and the call that lets the next run in. */
export interface ThreadHold {
  signal: AbortSignal;
  release(): void;
}

/**
 * Who is working in which Slack thread. Chat turns and job runs share it, so a thread runs one
 * Claude session at a time (a reply waits for the run before it) and a stop reaches whichever runs.
 */
export class Threads {
  private readonly queue = new KeyedQueue();
  private readonly running = new Map<string, AbortController>();

  /** True while a run holds this thread or waits for it. */
  busy(key: string): boolean {
    return this.queue.size(key) > 0;
  }

  /** Waits until the thread is free, then holds it until `release` is called. */
  async enter(key: string): Promise<ThreadHold> {
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    await new Promise<void>((entered) => {
      void this.queue.run(key, () => {
        entered();
        return done;
      });
    });
    const controller = new AbortController();
    this.running.set(key, controller);
    return {
      signal: controller.signal,
      release: () => {
        if (this.running.get(key) === controller) this.running.delete(key);
        release();
      },
    };
  }

  /** Runs `task` once the thread is free, holding it until the task settles. */
  async run<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const hold = await this.enter(key);
    try {
      return await task(hold.signal);
    } finally {
      hold.release();
    }
  }

  /** Stops the run holding this thread; false when nothing is running there. */
  stop(key: string): boolean {
    const controller = this.running.get(key);
    controller?.abort();
    return Boolean(controller);
  }

  /** Stops every run (used on shutdown). */
  stopAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }
}
