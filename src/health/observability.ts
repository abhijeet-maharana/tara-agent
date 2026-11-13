import type { Project } from '../config/schema.js';
import type { LogsData, TrendsData } from '../http/observe.js';
import type { JobInfo } from '../scheduler/scheduler.js';
import type { Store } from '../store/store.js';
import { readJournal, type ServiceLogs } from './journal.js';
import type { HealthMonitor } from './monitor.js';
import { prometheusText } from './prometheus.js';
import {
  costByDay,
  groupLogs,
  jobTrends,
  type LogLine,
  lastDays,
  runsByDay,
  totals,
  uptimes,
  usageByHour,
} from './trends.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface ObservabilityDeps {
  store: Pick<Store, 'runStats' | 'healthEvents' | 'hostSamples' | 'logs' | 'jobRuns'>;
  projects: Project[];
  jobs: (project: string) => JobInfo[];
  monitor?: Pick<HealthMonitor, 'snapshot' | 'label'>;
  running: () => number;
  usage: () => number | undefined;
  agentName: string;
  timeZone: string;
  logUnits: string[];
  started: number;
  now?: () => number;
  journal?: (units: string[], since: number) => Promise<ServiceLogs>;
}

/** The data behind the Trends and Logs views and `GET /metrics`. */
export class Observability {
  private readonly now: () => number;
  private journalCache: { key: string; at: number; value: ServiceLogs } | undefined;

  constructor(private readonly deps: ObservabilityDeps) {
    this.now = deps.now ?? Date.now;
  }

  trends(days: number): TrendsData {
    const { store, timeZone } = this.deps;
    const now = this.now();
    const dayKeys = lastDays(now, days, timeZone);
    // A rolling window; the day columns hold what started on each of its days.
    const from = now - days * DAY;
    const runs = store.runStats(from - days * DAY);
    const current = runs.filter((r) => r.startedAt >= from);
    const previous = runs.filter((r) => r.startedAt < from);
    const names = new Map(
      this.deps.projects.flatMap((p) =>
        this.deps.jobs(p.config.name).map((j) => [`${p.config.name}:${j.id}`, j.name] as const),
      ),
    );

    const snapshot = this.deps.monitor?.snapshot();
    const currentStatus = new Map(
      (snapshot?.checks ?? []).map((c) => [c.key, c.unconfirmed ? 'ok' : c.status] as const),
    );
    const ups = uptimes(store.healthEvents(0), currentStatus, from, now);
    const label = (key: string) => this.deps.monitor?.label(key) ?? key;
    const checkCount = snapshot?.checks.length ?? 0;
    const downTime = ups.reduce((t, u) => t + (1 - u.uptime), 0);
    return {
      days,
      dayKeys,
      from,
      now,
      current: totals(current),
      previous: totals(previous),
      runs: runsByDay(current, dayKeys, timeZone),
      cost: costByDay(
        current,
        dayKeys,
        this.deps.projects.map((p) => p.config.name),
        timeZone,
      ),
      projects: this.deps.projects.map((p) => ({
        name: p.config.name,
        title: p.config.title ?? p.config.name,
      })),
      usage: usageByHour(current),
      jobs: jobTrends(current, now).map((j) => ({
        ...j,
        name: names.get(`${j.project}:${j.jobId}`) ?? j.jobId,
      })),
      uptimes: ups.map((u) => ({ ...u, label: label(u.key) })),
      steady: Math.max(0, checkCount - ups.length),
      host: store.hostSamples(from),
      overallUptime: checkCount ? 1 - downTime / checkCount : undefined,
    };
  }

  async logs(hours: number): Promise<LogsData> {
    const now = this.now();
    const from = now - hours * HOUR;
    const own: LogLine[] = this.deps.store.logs(from);
    const services = await this.serviceLogs(from);
    const byUnit = new Map<string, LogLine[]>(
      this.deps.logUnits.map((u) => [u.replace(/\.service$/, ''), []]),
    );
    for (const l of services.lines) byUnit.get(l.unit)?.push(l);
    const bucket = hours > 24 ? 6 * HOUR : HOUR;
    const start = Math.floor(from / bucket) * bucket;
    const hourly: LogsData['hourly'] = [];
    for (let t = start; t <= now; t += bucket) hourly.push({ at: t, warn: 0, error: 0 });
    for (const l of [...own, ...services.lines]) {
      const h = hourly[Math.floor((l.at - start) / bucket)];
      if (h) h[l.level]++;
    }
    return {
      hours,
      now,
      from,
      units: this.deps.logUnits,
      hourly,
      sources: [
        { title: `${this.deps.agentName} (tara-agent)`, groups: groupLogs(own), lines: own.length },
        ...[...byUnit.entries()].map(([unit, lines]) => ({
          title: unit,
          groups: groupLogs(lines),
          lines: lines.length,
          ...(services.error && { error: services.error }),
        })),
      ],
    };
  }

  /** Service logs, read at most once a minute per range. */
  private async serviceLogs(from: number): Promise<ServiceLogs> {
    if (!this.deps.logUnits.length) return { lines: [] };
    const key = `${this.deps.logUnits.join(',')}|${Math.round((this.now() - from) / HOUR)}`;
    const cached = this.journalCache;
    if (cached && cached.key === key && this.now() - cached.at < 60_000) return cached.value;
    const value = await (this.deps.journal ?? readJournal)(this.deps.logUnits, from);
    this.journalCache = { key, at: this.now(), value };
    return value;
  }

  metrics(): string {
    const now = this.now();
    const jobs = this.deps.projects.flatMap((p) =>
      this.deps.jobs(p.config.name).map((j) => ({
        ...j,
        project: p.config.name,
        recent: this.deps.store.jobRuns(p.config.name, j.id, 10),
      })),
    );
    return prometheusText({
      uptimeSeconds: Math.floor((now - this.deps.started) / 1000),
      snapshot: this.deps.monitor?.snapshot(),
      runs: this.deps.store.runStats(now - DAY),
      jobs,
      running: this.deps.running(),
      usage: this.deps.usage(),
      host: this.deps.store.hostSamples(now - 15 * 60_000).at(-1),
    });
  }
}
