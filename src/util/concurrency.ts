/** Limits how many tasks run at once; extra callers wait in FIFO order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get busy(): boolean {
    return this.active >= this.limit;
  }

  /** Waits for a place; with `signal`, gives up (rejects) when it aborts while still waiting. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) this.active++;
    else
      await new Promise<void>((resolve, reject) => {
        // The place is handed over by release().
        const take = () => {
          signal?.removeEventListener('abort', give);
          resolve();
        };
        const give = () => {
          const at = this.waiting.indexOf(take);
          if (at !== -1) this.waiting.splice(at, 1);
          reject(signal?.reason ?? new Error('aborted'));
        };
        this.waiting.push(take);
        signal?.addEventListener('abort', give, { once: true });
      });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** Runs tasks one at a time per key, in arrival order. Different keys run independently. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly sizes = new Map<string, number>();

  /** Tasks queued or running for this key. */
  size(key: string): number {
    return this.sizes.get(key) ?? 0;
  }

  run(key: string, task: () => Promise<void>): Promise<void> {
    this.sizes.set(key, this.size(key) + 1);
    const next = (this.tails.get(key) ?? Promise.resolve()).then(task).finally(() => {
      const left = this.size(key) - 1;
      if (left === 0) {
        this.sizes.delete(key);
        // The stored tail is `next.catch(…)`: compare with it, or no key would ever be removed.
        if (this.tails.get(key) === tail) this.tails.delete(key);
      } else {
        this.sizes.set(key, left);
      }
    });
    // Later tasks wait for this one to settle, whether it failed or not.
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    return next;
  }

  /** Keys with tasks queued or running (for tests: none are kept once their tasks are done). */
  get keys(): number {
    return this.tails.size;
  }
}

/**
 * Calls `send` with the latest value at most once per interval. `flush` sends any pending value now and
 * waits for in-flight sends, so callers can order a final update after it.
 */
export class Throttle<T> {
  private last = 0;
  private pending: { value: T } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly intervalMs: number,
    private readonly send: (value: T) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  push(value: T): void {
    this.pending = { value };
    if (this.timer) return;
    const wait = Math.max(0, this.last + this.intervalMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fire();
    }, wait);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.fire();
    await this.inflight;
  }

  /** Drops any pending value without sending it. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private fire(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.last = this.now();
    this.inflight = this.inflight.then(() => this.send(pending.value).catch(() => {}));
  }
}

/** Named mutexes (e.g. "chrome"). Acquired in sorted order, so two holders of overlapping sets can't deadlock. */
export class Locks {
  private readonly locks = new Map<string, Semaphore>();

  /** Names among `names` that someone holds right now. */
  held(names: string[]): string[] {
    return names.filter((n) => this.locks.get(n)?.busy);
  }

  /** Takes every lock in `names`; with `signal`, gives back what it took and rejects when it aborts. */
  async acquire(names: string[], signal?: AbortSignal): Promise<() => void> {
    const releases: Array<() => void> = [];
    const releaseAll = () => {
      for (const release of releases.reverse()) release();
    };
    try {
      for (const name of [...new Set(names)].sort()) {
        let lock = this.locks.get(name);
        if (!lock) {
          lock = new Semaphore(1);
          this.locks.set(name, lock);
        }
        releases.push(await lock.acquire(signal));
      }
    } catch (err) {
      releaseAll();
      throw err;
    }
    return releaseAll;
  }
}
