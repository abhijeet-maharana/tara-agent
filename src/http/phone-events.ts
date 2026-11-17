import type { ServerResponse } from 'node:http';
import type { ActivityEvent, Task } from '../runner/activity.js';
import type { Item } from '../store/store.js';
import type { Attention, AttentionItem } from './attention.js';

/**
 * The desk phone's glance screen and its events (docs/jarvis-phone.md, Phase 2).
 *
 * `/phone/events` is a server-sent event stream:
 *   state   the whole glance (needs you, approvals, running, next up, usage, quiet hours, recent alerts);
 *           sent on connect and whenever it changes ("attention changed")
 *   run     {phase: started | ended, task}: a run started or ended (the page shows a short toast)
 *   alert   an urgent item: wake the screen, vibrate, and say one line when `speak` is set
 *
 * Alerts come from `/attention`'s urgent tier (host `attention.urgent` rules). At most one is spoken per
 * gap (30 min); later ones wake the screen but stay silent. In quiet hours (23:00–07:00) they are held:
 * no wake, no sound, just a count on the Night page, and one spoken summary when quiet hours end.
 * Items already urgent when tara-agent starts aren't announced: they are on screen.
 */

export interface QuietHours {
  /** Local `HH:MM` in the host's timezone. */
  from: string;
  to: string;
}

export const DEFAULT_QUIET: QuietHours = { from: '23:00', to: '07:00' };
export const DEFAULT_GAP_MINUTES = 30;

/** The glance is rebuilt this often while a phone is connected (cheap: store and memory only). */
const REFRESH_MS = 5_000;
/** `/attention` (git status, GitHub) is read this often; a run ending reads it sooner. */
const ATTENTION_MS = 60_000;
const POKE_MS = 3_000;
const HEARTBEAT_MS = 20_000;
/** Open event streams at most (a phone uses two: its page and its shell). Beyond it, new ones are refused. */
const MAX_CLIENTS = 16;
/** Alerts shown on screen this long after they came. */
const ALERT_KEEP_MS = 6 * 3_600_000;

export interface PhoneAlert {
  id: string;
  kind: 'urgent' | 'summary';
  /** One line, fit to be read aloud. */
  text: string;
  items: Array<{ title: string; project?: string }>;
  at: number;
  /** Turn the screen on and vibrate. */
  wake: boolean;
  /** Say `text` out loud: at most one spoken alert per gap. */
  speak: boolean;
  /** Came in quiet hours: only counted on the Night page, told in the summary after. */
  held: boolean;
}

export interface GlanceTask {
  id: string;
  project: string;
  kind: Task['kind'];
  title: string;
  jobId?: string;
  startedAt: number;
  endedAt?: number;
  status: Task['status'];
  /** The latest step, e.g. "Reading src/sync.ts". */
  step?: string;
  stepCount: number;
  error?: string;
}

export interface NextRun {
  project: string;
  name: string;
  at: number;
}

export interface GlanceState {
  /** Changes when tara-agent restarts, so an open page reloads into the new version. */
  build: string;
  at: number;
  /** False until `/attention` has been read once. */
  ready: boolean;
  quiet: QuietHours & { now: boolean };
  /** Urgent and waiting items other than approvals (those have their own tile). */
  needs: {
    urgent: number;
    waiting: number;
    top: Array<Pick<AttentionItem, 'tier' | 'kind' | 'title' | 'at'> & { project?: string }>;
  };
  approvals: {
    total: number;
    projects: Array<{ project: string; count: number; oldestAt: number; title: string }>;
  };
  running: GlanceTask[];
  /** Finished in this process, newest first. */
  recent: GlanceTask[];
  next: NextRun[];
  usage?: { share: number; resetsAt?: number };
  alerts: PhoneAlert[];
  /** Urgent items held in quiet hours, told when they end. */
  held: number;
}

export interface PhoneHubOptions {
  attention?: () => Promise<Attention>;
  /** Pending approval items. */
  pending: () => Item[];
  activity?: { tasks: () => Task[]; subscribe?: (listener: (event: ActivityEvent) => void) => () => void };
  next: (at: number) => NextRun[];
  usage: (at: number) => { share: number; resetsAt?: number } | undefined;
  /** How the screen names a project. */
  projectTitle: (name: string) => string;
  timeZone: string;
  quietHours?: QuietHours;
  alertGapMinutes?: number;
  /** false: alerts wake the screen and buzz but are never spoken (the owner asks instead). Default true. */
  speakAlerts?: boolean;
  build: string;
  now?: () => number;
  log?: { warn: (msg: string) => void };
}

const minutesOf = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const clocks = new Map<string, Intl.DateTimeFormat>();
/** Minutes since local midnight in `timeZone`. */
export function localMinutes(at: number, timeZone: string): number {
  let f = clocks.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    clocks.set(timeZone, f);
  }
  const parts = f.formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (part('hour') % 24) * 60 + part('minute');
}

export function inQuietHours(at: number, timeZone: string, q: QuietHours): boolean {
  const now = localMinutes(at, timeZone);
  const from = minutesOf(q.from);
  const to = minutesOf(q.to);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function alertText(kind: PhoneAlert['kind'], items: PhoneAlert['items']): string {
  const first = items[0]?.title ?? '';
  const rest = items.length - 1;
  const list = rest ? `${first}, and ${rest} more` : first;
  if (kind === 'summary') return `Overnight: ${list}.`;
  return rest ? `Heads up: ${items.length} urgent items. ${list}.` : `Heads up: ${first}.`;
}

export class PhoneHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly now: () => number;
  private readonly quiet: QuietHours;
  private readonly gapMs: number;
  private attention?: Attention;
  private checking?: Promise<void>;
  private seen = new Set<string>();
  private primed = false;
  private held: AttentionItem[] = [];
  private lastSaid = Number.NEGATIVE_INFINITY;
  private alerts: PhoneAlert[] = [];
  private count = 0;
  private lastSent = '';
  private wasQuiet?: boolean;
  private readonly running = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private poked?: NodeJS.Timeout;
  private soon?: NodeJS.Timeout;
  private readonly unsubscribe?: () => void;

  constructor(private readonly opts: PhoneHubOptions) {
    this.now = opts.now ?? Date.now;
    this.quiet = opts.quietHours ?? DEFAULT_QUIET;
    this.gapMs = (opts.alertGapMinutes ?? DEFAULT_GAP_MINUTES) * 60_000;
    this.unsubscribe = opts.activity?.subscribe?.((e) => this.onActivity(e));
  }

  close(): void {
    this.unsubscribe?.();
    this.stopTimers();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  isQuiet(at = this.now()): boolean {
    return inQuietHours(at, this.opts.timeZone, this.quiet);
  }

  /** The glance as the screen shows it. */
  state(): GlanceState {
    const at = this.now();
    const title = this.opts.projectTitle;
    const needs = (this.attention?.items ?? []).filter((i) => i.tier !== 'later' && i.kind !== 'approval');
    const groups = new Map<string, GlanceState['approvals']['projects'][number]>();
    const pending = this.opts.pending();
    for (const item of [...pending].sort((a, b) => a.createdAt - b.createdAt)) {
      const g = groups.get(item.project);
      if (g) g.count++;
      else
        groups.set(item.project, {
          project: title(item.project),
          count: 1,
          oldestAt: item.createdAt,
          title: item.title,
        });
    }
    const tasks = this.opts.activity?.tasks() ?? [];
    const slim = (t: Task): GlanceTask => {
      const step = t.steps.at(-1);
      return {
        id: t.id,
        project: title(t.project),
        kind: t.kind,
        title: t.title,
        ...(t.jobId && { jobId: t.jobId }),
        startedAt: t.startedAt,
        ...(t.endedAt && { endedAt: t.endedAt }),
        status: t.status,
        ...(step && { step: step.text }),
        stepCount: t.stepCount,
        ...(t.error && { error: t.error }),
      };
    };
    const usage = this.opts.usage(at);
    return {
      build: this.opts.build,
      at,
      ready: Boolean(this.attention),
      quiet: { ...this.quiet, now: this.isQuiet(at) },
      needs: {
        urgent: needs.filter((i) => i.tier === 'urgent').length,
        waiting: needs.filter((i) => i.tier === 'waiting').length,
        top: needs.slice(0, 3).map((i) => ({
          tier: i.tier,
          kind: i.kind,
          title: i.title,
          ...(i.project && { project: title(i.project) }),
          ...(i.at && { at: i.at }),
        })),
      },
      approvals: {
        total: pending.length,
        projects: [...groups.values()].sort((a, b) => a.oldestAt - b.oldestAt),
      },
      running: tasks.filter((t) => t.status === 'running').map(slim),
      recent: tasks
        .filter((t) => t.status !== 'running')
        .slice(0, 3)
        .map(slim),
      next: this.opts.next(at),
      ...(usage && { usage: { share: usage.share, ...(usage.resetsAt && { resetsAt: usage.resetsAt }) } }),
      alerts: this.alerts.filter((a) => at - a.at < ALERT_KEEP_MS).slice(0, 5),
      held: this.held.length,
    };
  }

  /** A run's full live view (steps and text) for the Run page, while this process remembers it. */
  task(id: string): Task | undefined {
    const task = this.opts.activity?.tasks().find((t) => t.id === id);
    return task && { ...task, project: this.opts.projectTitle(task.project) };
  }

  /** Serves `/phone/events` on this response until the client goes; false (nothing sent) when too many are open. */
  connect(res: ServerResponse): boolean {
    if (this.clients.size >= MAX_CLIENTS) return false;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (!this.clients.size) this.stopTimers();
    });
    if (this.clients.size === 1) this.startTimers();
    const state = this.state();
    this.send(res, 'state', state);
    // Also when the phone comes back: what turned urgent while it was away is announced now.
    void this.check();
    return true;
  }

  get listeners(): number {
    return this.clients.size;
  }

  private startTimers(): void {
    this.lastSent = '';
    this.timers = [
      setInterval(() => this.refresh(), REFRESH_MS),
      setInterval(() => void this.check(), ATTENTION_MS),
      setInterval(() => {
        this.broadcast('ping', {});
      }, HEARTBEAT_MS),
    ];
    for (const t of this.timers) t.unref();
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.poked);
    clearTimeout(this.soon);
  }

  private send(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(event: string, data: unknown): void {
    for (const res of this.clients) this.send(res, event, data);
  }

  /** Sends the glance if it changed; reads `/attention` again when quiet hours have just ended. */
  refresh(): void {
    const state = this.state();
    const quiet = state.quiet.now;
    if (this.wasQuiet && !quiet && this.held.length) void this.check();
    this.wasQuiet = quiet;
    const { at: _at, ...rest } = state;
    const key = JSON.stringify(rest);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.broadcast('state', state);
  }

  /** Something changed: refresh the glance soon (several changes at once send one update). */
  private refreshSoon(): void {
    this.soon ??= setTimeout(() => {
      this.soon = undefined;
      this.refresh();
    }, 300);
    this.soon.unref();
  }

  /** A run ended: its job may now be failing, so read `/attention` shortly. */
  poke(): void {
    clearTimeout(this.poked);
    this.poked = setTimeout(() => void this.check(), POKE_MS);
    this.poked.unref();
  }

  private onActivity(event: ActivityEvent): void {
    if (event.type !== 'task') return;
    const { task } = event;
    const was = this.running.has(task.id);
    if (task.status === 'running') {
      if (was) return;
      this.running.add(task.id);
      if (!this.clients.size) return;
      this.broadcast('run', { phase: 'started', task: this.slimOne(task) });
      this.refreshSoon();
      return;
    }
    if (!was) return;
    this.running.delete(task.id);
    if (!this.clients.size) return;
    this.broadcast('run', { phase: 'ended', task: this.slimOne(task) });
    this.refreshSoon();
    this.poke();
  }

  private slimOne(task: Task): GlanceTask {
    return {
      id: task.id,
      project: this.opts.projectTitle(task.project),
      kind: task.kind,
      title: task.title,
      startedAt: task.startedAt,
      ...(task.endedAt && { endedAt: task.endedAt }),
      status: task.status,
      stepCount: task.stepCount,
      ...(task.error && { error: task.error }),
    };
  }

  /** One `/attention` read at a time; resolves when done (tests await it). */
  check(): Promise<void> {
    this.checking ??= this.run().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async run(): Promise<void> {
    if (!this.opts.attention) return;
    let attention: Attention;
    try {
      attention = await this.opts.attention();
    } catch (err) {
      this.opts.log?.warn(`phone: attention failed: ${(err as Error).message}`);
      return;
    }
    this.attention = attention;
    const urgent = attention.items.filter((i) => i.tier === 'urgent');
    const keys = new Set(urgent.map((i) => i.key));
    // Gone items are forgotten, so coming back counts as new.
    this.seen = new Set([...this.seen].filter((k) => keys.has(k)));
    if (!this.primed) {
      this.primed = true;
      for (const k of keys) this.seen.add(k);
    } else {
      const fresh = urgent.filter((i) => !this.seen.has(i.key));
      for (const i of fresh) this.seen.add(i.key);
      if (this.isQuiet()) {
        if (fresh.length) {
          this.held.push(...fresh.filter((i) => !this.held.some((h) => h.key === i.key)));
          this.raise('urgent', fresh, true);
        }
      } else if (this.held.length) {
        const all = [...this.held, ...fresh.filter((i) => !this.held.some((h) => h.key === i.key))];
        this.held = [];
        this.raise('summary', all, false);
      } else if (fresh.length) this.raise('urgent', fresh, false);
    }
    this.refresh();
  }

  private raise(kind: PhoneAlert['kind'], list: AttentionItem[], held: boolean): void {
    const at = this.now();
    const speak = this.opts.speakAlerts !== false && !held && at - this.lastSaid >= this.gapMs;
    if (speak) this.lastSaid = at;
    const items = list.map((i) => ({
      title: i.title,
      ...(i.project && { project: this.opts.projectTitle(i.project) }),
    }));
    const alert: PhoneAlert = {
      id: `alert-${at}-${++this.count}`,
      kind,
      text: alertText(kind, items),
      items,
      at,
      wake: !held,
      speak,
      held,
    };
    this.alerts = [alert, ...this.alerts].slice(0, 10);
    this.broadcast('alert', alert);
  }
}
