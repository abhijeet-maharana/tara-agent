/** Limits how many tasks run at once; extra callers wait in FIFO order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get busy(): boolean {
    return this.active >= this.limit;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // slot handed over by release()
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
        if (this.tails.get(key) === next) this.tails.delete(key);
      } else {
        this.sizes.set(key, left);
      }
    });
    // Later tasks wait for this one to settle, whether it failed or not.
    this.tails.set(
      key,
      next.catch(() => {}),
    );
    return next;
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
