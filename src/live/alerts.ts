import type { Attention, AttentionItem } from './attention.js';
import type { LiveState } from './tools.js';

/**
 * The urgent tier (docs/command.md): watches what needs the user and raises an alert when an urgent
 * item appears, for every Command tab to chime and say in one line. At most one spoken alert per
 * `gapMinutes` (later ones are shown, not said); none in focus mode, except for `alwaysInterrupt` jobs.
 * What came up during focus is said in one line when it ends. Items already urgent when tara starts
 * aren't announced: they are on screen.
 */

export interface Alert {
  id: string;
  kind: 'urgent' | 'focus-over';
  items: Array<Pick<AttentionItem, 'title' | 'project' | 'url'>>;
  /** One line, fit to be read aloud. */
  text: string;
  at: number;
  /** Shown but not said: another alert was said less than `gapMinutes` ago. */
  quiet: boolean;
}

export interface AlertsOptions {
  attention: () => Promise<Attention>;
  /** Focus mode, shared with the Command tabs. */
  state: LiveState;
  gapMinutes: number;
  /** `project/jobId`: jobs whose failures interrupt even in focus mode, and without the gap. */
  alwaysInterrupt: string[];
  now?: () => number;
}

/** How often what needs the user is checked; a job ending checks sooner. */
const CHECK_MS = 60_000;
const POKE_MS = 3_000;

export function alertText(kind: Alert['kind'], items: Alert['items']): string {
  const first = items[0]?.title ?? '';
  const rest = items.length - 1;
  const list = rest ? `${first}, and ${rest} more` : first;
  return kind === 'focus-over'
    ? `Focus time is over. While you were away: ${list}.`
    : rest
      ? `Heads up: ${items.length} urgent items. ${list}.`
      : `Heads up: ${first}.`;
}

export class Alerts {
  private readonly listeners = new Set<(alert: Alert) => void>();
  private seen = new Set<string>();
  private held: AttentionItem[] = [];
  private primed = false;
  private lastSaid = Number.NEGATIVE_INFINITY;
  private count = 0;
  private timer?: NodeJS.Timeout;
  private poked?: NodeJS.Timeout;
  private checking?: Promise<void>;

  constructor(private readonly opts: AlertsOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  subscribe(listener: (alert: Alert) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.poked);
  }

  /** Something changed (a job ended): check again shortly. */
  poke(): void {
    clearTimeout(this.poked);
    this.poked = setTimeout(() => void this.check(), POKE_MS);
    this.poked.unref();
  }

  private always(item: AttentionItem): boolean {
    return this.opts.alwaysInterrupt.some((job) => item.key.startsWith(`job-failing:${job}:`));
  }

  /** One check at a time; resolves when done (tests await it). */
  check(): Promise<void> {
    this.checking ??= this.run().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async run(): Promise<void> {
    // Nobody to tell: no Command tab is open, so no git or gh work either.
    if (!this.listeners.size) return;
    let attention: Attention;
    try {
      attention = await this.opts.attention();
    } catch {
      return;
    }
    const urgent = attention.items.filter((i) => i.tier === 'urgent');
    const keys = new Set(urgent.map((i) => i.key));
    // Gone items are forgotten, so coming back counts as new.
    this.seen = new Set([...this.seen].filter((k) => keys.has(k)));
    this.held = this.held.filter((i) => keys.has(i.key));
    if (!this.primed) {
      this.primed = true;
      for (const k of keys) this.seen.add(k);
      return;
    }
    const fresh = urgent.filter((i) => !this.seen.has(i.key));
    for (const i of fresh) this.seen.add(i.key);
    const now = this.now();
    const focused = this.opts.state.focusUntil > now;
    if (focused) {
      this.held.push(...fresh.filter((i) => !this.always(i)));
      const urgentNow = fresh.filter((i) => this.always(i));
      if (urgentNow.length) this.raise('urgent', urgentNow, false);
      return;
    }
    if (this.held.length) {
      const held = this.held;
      this.held = [];
      this.raise('focus-over', [...held, ...fresh], now - this.lastSaid < this.opts.gapMinutes * 60_000);
      return;
    }
    if (!fresh.length) return;
    const quiet = now - this.lastSaid < this.opts.gapMinutes * 60_000 && !fresh.some((i) => this.always(i));
    this.raise('urgent', fresh, quiet);
  }

  private raise(kind: Alert['kind'], list: AttentionItem[], quiet: boolean): void {
    const at = this.now();
    if (!quiet) this.lastSaid = at;
    const items = list.map(({ title, project, url }) => ({ title, project, url }));
    const alert: Alert = {
      id: `alert-${++this.count}`,
      kind,
      items,
      text: alertText(kind, items),
      at,
      quiet,
    };
    for (const listener of this.listeners) {
      try {
        listener(alert);
      } catch {}
    }
  }
}
