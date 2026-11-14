import { openRunThread } from '../scheduler/slack-trigger.js';
import type { Logger } from '../sessions/manager.js';
import type { HealthEvent, HealthState, HealthStatus, Store } from '../store/store.js';

export type { HealthStatus };

/**
 * One thing that is fine, needs a look soon (`warn`) or is broken (`bad`), as the Health page shows it.
 * `key` is stable across checks, so a change of status can be told from the same status again.
 */
export interface Check {
  key: string;
  /** Whose channel hears about it; unset = tara-agent itself (host `health.alertProject`). */
  project?: string;
  /** The section it shows under, e.g. "tara-agent", "Jobs", "Services". */
  group: string;
  name: string;
  status: HealthStatus;
  /** One plain line: what is wrong, or what was seen when fine. */
  detail: string;
  link?: string;
  /** Never posted to Slack (it already has its own message there, e.g. a job's ❌ reply). */
  quiet?: boolean;
}

/** A check as the page shows it: with since when it has been in this state and its recent outages. */
export interface CheckView extends Check {
  since: number;
  /** Times it turned red in the last 7 days. */
  outages: number;
  /** Red, but not yet confirmed (a second check in a row makes it count and alerts). */
  unconfirmed?: boolean;
}

/** Where a group of checks comes from: tara-agent, a project's jobs, a project's own `healthUrl`. */
export interface HealthSource {
  id: string;
  title: string;
  project?: string;
  run: () => Promise<Check[]>;
}

export interface SourceView {
  id: string;
  title: string;
  project?: string;
  ms: number;
  error?: string;
}

export interface HealthSnapshot {
  checkedAt: number;
  checks: CheckView[];
  sources: SourceView[];
  counts: Record<HealthStatus, number>;
}

/** Where alerts about a project (or, with undefined, about tara-agent) go. */
export interface AlertTarget {
  /** Project name: the day's `Run Health Alert` thread is the project's. */
  name: string;
  title: string;
  channel: string;
  owner?: string;
}

export interface MonitorDeps {
  sources: () => HealthSource[];
  store: Pick<
    Store,
    'healthStates' | 'saveHealthState' | 'dropHealthState' | 'healthEvents' | 'dayThread' | 'saveDayThread'
  >;
  chat?: { post(channel: string, threadTs: string | undefined, text: string): Promise<string> };
  /** Undefined: alerts about that project go nowhere. */
  target: (project: string | undefined) => AlertTarget | undefined;
  alerts: boolean;
  timeZone: string;
  log: Logger;
  intervalMs: number;
  now?: () => number;
  /** Red this many checks in a row before it counts (and alerts). Default 2: one blip says nothing. */
  confirmAfter?: number;
  /** Each source gets this long. */
  timeoutMs?: number;
}

const WEEK_MS = 7 * 86_400_000;
const RANK: Record<HealthStatus, number> = { bad: 0, warn: 1, ok: 2 };

/** "2h 5m", "3d 4h", "40s". */
export function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)}h` : ''}`;
}

/**
 * A project's `healthUrl` answer as checks: `{checks: [...]}`, `{result: {checks}}` or a bare list of
 * `{name, ok, warn?, detail, group?, link?}`.
 */
export function parseProjectChecks(body: unknown, sourceId: string, project: string): Check[] {
  const wrapped = body as { checks?: unknown; result?: { checks?: unknown } } | undefined;
  const list = Array.isArray(body) ? body : (wrapped?.checks ?? wrapped?.result?.checks);
  if (!Array.isArray(list)) throw new Error('the answer has no "checks" list');
  const used = new Set<string>();
  return list.flatMap((raw): Check[] => {
    const c = raw as {
      name?: unknown;
      ok?: unknown;
      warn?: unknown;
      status?: unknown;
      detail?: unknown;
      group?: unknown;
      link?: unknown;
    };
    if (typeof c?.name !== 'string' || !c.name) return [];
    const status: HealthStatus =
      c.status === 'bad' || c.status === 'warn' || c.status === 'ok'
        ? c.status
        : c.ok === false
          ? 'bad'
          : c.warn
            ? 'warn'
            : 'ok';
    const group = typeof c.group === 'string' && c.group ? c.group : 'Checks';
    let key = `${sourceId}:${group}:${c.name}`;
    for (let i = 2; used.has(key); i++) key = `${sourceId}:${group}:${c.name}#${i}`;
    used.add(key);
    const link = typeof c.link === 'string' && /^https?:\/\//.test(c.link) ? c.link : undefined;
    return [
      {
        key,
        project,
        group,
        name: c.name.slice(0, 120),
        status,
        detail: typeof c.detail === 'string' ? c.detail.slice(0, 500) : '',
        ...(link && { link }),
      },
    ];
  });
}

/**
 * Runs every source on an interval and keeps the latest answers for the page. A check counts as red
 * only after `confirmAfter` red checks in a row; that change, and its recovery, are stored (the history
 * on the page) and posted once in Slack. The confirmed state lives in the database, so a restart
 * neither repeats an alert nor misses a recovery.
 */
export class HealthMonitor {
  private latest: HealthSnapshot | undefined;
  private running: Promise<HealthSnapshot> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly states: Map<string, HealthState>;
  /** Red checks in a row, for checks whose confirmed state isn't red yet. */
  private readonly redStreak = new Map<string, number>();
  /** Day threads being opened, so two alerts at once share one. */
  private readonly opening = new Map<string, Promise<string>>();
  private readonly now: () => number;

  constructor(private readonly deps: MonitorDeps) {
    this.now = deps.now ?? Date.now;
    this.states = deps.store.healthStates();
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The latest checks, without waiting (undefined before the first one finishes). */
  snapshot(): HealthSnapshot | undefined {
    return this.latest;
  }

  /** Checks everything now; a check already going is shared. */
  check(): Promise<HealthSnapshot> {
    this.running ??= this.checkNow()
      .catch((err: Error) => {
        this.deps.log.error(`Health check failed: ${err.stack ?? err.message}`);
        return (
          this.latest ?? {
            checkedAt: this.now(),
            checks: [],
            sources: [],
            counts: { ok: 0, warn: 0, bad: 0 },
          }
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async checkNow(): Promise<HealthSnapshot> {
    const sources = this.deps.sources();
    const timeoutMs = this.deps.timeoutMs ?? 15_000;
    const results = await Promise.all(
      sources.map(async (source) => {
        const started = this.now();
        try {
          const checks = await withTimeout(source.run(), timeoutMs);
          return {
            source,
            checks,
            view: { id: source.id, title: source.title, project: source.project, ms: this.now() - started },
          };
        } catch (err) {
          const error = (err as Error).message || String(err);
          const check: Check = {
            key: `${source.id}:unreachable`,
            project: source.project,
            group: source.title,
            name: `${source.title} checks`,
            status: 'bad',
            detail: `Could not check: ${error}`.slice(0, 500),
          };
          return {
            source,
            checks: [check],
            failed: true,
            view: {
              id: source.id,
              title: source.title,
              project: source.project,
              ms: this.now() - started,
              error,
            },
          };
        }
      }),
    );
    const at = this.now();
    const checks: Check[] = [];
    const seen = new Set<string>();
    for (const r of results)
      for (const c of r.checks) {
        if (seen.has(c.key)) continue;
        seen.add(c.key);
        checks.push(c);
      }
    // A red check that a source no longer lists (a job that recovered, a removed probe) is fine again,
    // but only if that source answered: one that couldn't be read says nothing about its checks.
    const answered = results.filter((r) => !r.failed).map((r) => `${r.source.id}:`);
    for (const [key, state] of this.states)
      if (!seen.has(key) && answered.some((p) => key.startsWith(p))) {
        if (state.status !== 'ok') {
          const source = results.find((r) => key.startsWith(`${r.source.id}:`))?.source;
          const name = state.label ?? key.slice(key.lastIndexOf(':') + 1);
          await this.apply({ key, project: source?.project, group: '', name, status: 'ok', detail: '' }, at);
        }
        this.states.delete(key);
        this.deps.store.dropHealthState(key);
      }

    const events = this.deps.store.healthEvents(at - WEEK_MS);
    const outages = new Map<string, number>();
    for (const e of events) if (e.status === 'bad') outages.set(e.key, (outages.get(e.key) ?? 0) + 1);

    const views: CheckView[] = [];
    for (const c of checks) {
      const unconfirmed = await this.apply(c, at);
      const state = this.states.get(c.key);
      views.push({
        ...c,
        since: state?.since ?? at,
        outages: outages.get(c.key) ?? 0,
        ...(unconfirmed && { unconfirmed: true }),
      });
    }
    views.sort((a, b) => RANK[a.status] - RANK[b.status]);
    const counts = { ok: 0, warn: 0, bad: 0 };
    for (const v of views) counts[v.status]++;
    this.latest = { checkedAt: at, checks: views, sources: results.map((r) => r.view), counts };
    return this.latest;
  }

  /** Moves a check's confirmed state; returns true when it is red but not confirmed yet. */
  private async apply(c: Check, at: number): Promise<boolean> {
    const prev = this.states.get(c.key);
    if (c.status === 'bad' && prev?.status !== 'bad') {
      const streak = (this.redStreak.get(c.key) ?? 0) + 1;
      this.redStreak.set(c.key, streak);
      if (streak < (this.deps.confirmAfter ?? 2)) return true;
    }
    this.redStreak.delete(c.key);
    const label = c.group ? `${c.name} (${c.group})` : c.name;
    if (prev?.status === c.status) {
      if (prev.detail !== c.detail || prev.label !== label) {
        prev.detail = c.detail;
        prev.label = label;
        this.deps.store.saveHealthState(c.key, prev, false);
      }
      return false;
    }
    // First sight of a check that is fine: remembered quietly, not an event.
    const next: HealthState = { status: c.status, since: at, detail: c.detail, label, alerted: false };
    if (!prev && c.status !== 'bad') {
      this.states.set(c.key, next);
      this.deps.store.saveHealthState(c.key, next, false);
      return false;
    }
    if (c.status === 'bad' && !c.quiet) next.alerted = await this.alert(c, 'bad');
    if (prev?.status === 'bad' && prev.alerted) await this.alert(c, 'recovered', at - prev.since);
    this.states.set(c.key, next);
    this.deps.store.saveHealthState(c.key, next, true);
    return false;
  }

  private async alert(c: Check, kind: 'bad' | 'recovered', downMs = 0): Promise<boolean> {
    const { chat, alerts } = this.deps;
    const target = this.deps.target(c.project);
    if (!alerts || !chat || !target) return false;
    const what = c.group ? `*${c.name}* (${c.group})` : `*${c.name}*`;
    const text =
      kind === 'bad'
        ? `${target.owner ? `<@${target.owner}> ` : ''}❌ ${what}: ${c.detail}`
        : `✅ ${what} is fine again${downMs ? ` after ${ago(downMs)}` : ''}${c.detail ? `: ${c.detail}` : ''}`;
    try {
      const ts = await this.dayThread(target);
      await chat.post(target.channel, ts, text);
      return true;
    } catch (err) {
      this.deps.log.warn(`Health alert not posted for ${c.key}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * The day's `Run Health Alert` thread in the target's channel, opened by its first alert: like every
   * message tara starts in a channel, a `Run <Name>` one, with the alerts and recoveries in its thread.
   */
  private async dayThread(target: AlertTarget): Promise<string> {
    const at = new Date(this.now());
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.deps.timeZone }).format(at);
    // Not `:health:` (the old `📌 Health` threads), so today's alerts move to the new thread at once.
    const key = `${target.name}:health-alert:${day}`;
    const known = this.deps.store.dayThread(key);
    if (known && known.channel === target.channel) return known.ts;
    let opening = this.opening.get(key);
    if (!opening) {
      const chat = this.deps.chat as NonNullable<MonitorDeps['chat']>;
      opening = openRunThread(chat, target.channel, 'Health Alert')
        .then((ts) => {
          this.deps.store.saveDayThread(key, target.channel, ts);
          return ts;
        })
        .finally(() => this.opening.delete(key));
      this.opening.set(key, opening);
    }
    return opening;
  }

  /** A check's name for the history: as last shown, or as remembered for a check no longer listed. */
  label(key: string): string {
    const c = this.latest?.checks.find((x) => x.key === key);
    if (c) return c.group && !key.startsWith('jobs:') ? `${c.name} (${c.group})` : c.name;
    return this.states.get(key)?.label ?? key.slice(key.lastIndexOf(':') + 1);
  }

  /** Status changes in the last `days` days, newest first, for the page's history. */
  history(days = 7): HealthEvent[] {
    return this.deps.store.healthEvents(this.now() - days * 86_400_000).reverse();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
