import type { Task } from '../runner/activity.js';
import type { Item } from '../store/store.js';
import type { Attention, AttentionItem } from './attention.js';

/**
 * The glance (`GET /glance`): what needs you, approvals waiting, what's running and next, Claude
 * usage, and whether it is quiet hours. One read for a desk panel such as the macOS desk widget
 * (examples/macos-desk-widget), which polls it every 30 s and raises its own notifications.
 */

export interface QuietHours {
  /** Local `HH:MM` in the host's timezone. */
  from: string;
  to: string;
}

export const DEFAULT_QUIET: QuietHours = { from: '23:00', to: '07:00' };

/** `/attention` (git status, GitHub) is read again when the last read is older than this. */
const ATTENTION_MS = 60_000;

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
  /** Claude's 5-hour window (`share` 0–1) and, when known, its 7-day window. */
  usage?: { share: number; resetsAt?: number; week?: { share: number; resetsAt?: number } };
}

export interface GlanceOptions {
  attention?: () => Promise<Attention>;
  /** Pending approval items. */
  pending: () => Item[];
  tasks?: () => Task[];
  next: (at: number) => NextRun[];
  usage: (at: number) => GlanceState['usage'];
  /** How the glance names a project. */
  projectTitle: (name: string) => string;
  timeZone: string;
  quietHours?: QuietHours;
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

export class Glance {
  private readonly now: () => number;
  private readonly quiet: QuietHours;
  private attention?: Attention;
  private attentionAt = Number.NEGATIVE_INFINITY;
  private reading?: Promise<void>;

  constructor(private readonly opts: GlanceOptions) {
    this.now = opts.now ?? Date.now;
    this.quiet = opts.quietHours ?? DEFAULT_QUIET;
  }

  /** The glance, reading `/attention` first when the last read is over a minute old. */
  async read(): Promise<GlanceState> {
    if (this.now() - this.attentionAt >= ATTENTION_MS) await this.refreshAttention();
    return this.state();
  }

  /** One `/attention` read at a time; a failed read keeps the last one. */
  refreshAttention(): Promise<void> {
    this.reading ??= this.readAttention().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private async readAttention(): Promise<void> {
    if (!this.opts.attention) return;
    try {
      this.attention = await this.opts.attention();
      this.attentionAt = this.now();
    } catch (err) {
      this.opts.log?.warn(`glance: attention failed: ${(err as Error).message}`);
    }
  }

  /** The glance from the last `/attention` read. */
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
    const tasks = this.opts.tasks?.() ?? [];
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
      at,
      ready: Boolean(this.attention),
      quiet: { ...this.quiet, now: inQuietHours(at, this.opts.timeZone, this.quiet) },
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
      ...(usage && {
        usage: {
          share: usage.share,
          ...(usage.resetsAt && { resetsAt: usage.resetsAt }),
          ...(usage.week && { week: usage.week }),
        },
      }),
    };
  }
}
