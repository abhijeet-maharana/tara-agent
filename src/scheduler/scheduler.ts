import { statSync } from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import type { Bridge } from '../bridge/bridge.js';
import { JOBS_FILE, loadJobs } from '../config/load.js';
import type { HostConfig, Project, ScheduledJob } from '../config/schema.js';
import type { Runner } from '../runner/run.js';
import type { ChatPort, Logger } from '../sessions/manager.js';
import type { Store } from '../store/store.js';
import { Locks, Semaphore } from '../util/concurrency.js';
import { type JobStatus, type JobTrigger, runJob } from './job-runner.js';
import type { runScript } from './script.js';

export interface JobInfo {
  id: string;
  name: string;
  enabled: boolean;
  running: boolean;
  cron: string;
  tz: string;
  skills: string[];
  model: string;
  nextRun?: Date;
  lastStatus?: string;
  lastRunAt?: Date;
  lastError?: string;
}

/** What chat commands (`!jobs`, `!run`) need from the scheduler. */
export interface JobControl {
  list(project: string): JobInfo[];
  trigger(project: string, id: string, by: string): 'started' | 'unknown' | 'running';
}

export interface SchedulerDeps {
  projects: Project[];
  host: HostConfig;
  store: Store;
  chat: ChatPort;
  run: Runner;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  runScript?: typeof runScript;
  bridge?: Bridge;
  newSessionId?: () => string;
  now?: () => number;
  /** How often job files are checked for changes. */
  reloadIntervalMs?: number;
}

interface Entry {
  scheduled: ScheduledJob;
  /** Fires the job; absent for disabled jobs. */
  cron?: Cron;
  /** Paused copy used only for date maths (previous/next slot). */
  clock: Cron;
}

const jobKey = (project: string, id: string) => `${project}:${id}`;

export class Scheduler implements JobControl {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<string>();
  private readonly fileStamps = new Map<string, number>();
  private readonly slots: Semaphore;
  private readonly locks = new Locks();
  private readonly controller = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private poller: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    this.slots = new Semaphore(deps.host.jobConcurrency);
    this.now = deps.now ?? Date.now;
  }

  /** Loads every project's jobs, runs missed slots, and starts watching the job files. */
  start(): void {
    for (const project of this.deps.projects) this.reload(project, { catchUp: true });
    this.poller = setInterval(() => this.checkFiles(), this.deps.reloadIntervalMs ?? 30_000);
    this.poller.unref();
  }

  /** Stops scheduling and aborts running jobs; resolves when they have wound down. */
  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    for (const entry of this.entries.values()) this.stopEntry(entry);
    this.entries.clear();
    this.controller.abort();
    await Promise.allSettled([...this.inflight]);
  }

  list(project: string): JobInfo[] {
    return [...this.entries.values()]
      .filter((e) => e.scheduled.project.config.name === project)
      .map(({ scheduled: { job }, cron }) => {
        const last = this.deps.store.lastJobRun(project, job.id);
        return {
          id: job.id,
          name: job.name,
          enabled: job.enabled,
          running: this.running.has(jobKey(project, job.id)),
          cron: job.cron,
          tz: job.tz ?? this.deps.host.timezone,
          skills: job.skills,
          model: job.model,
          nextRun: cron?.nextRun() ?? undefined,
          lastStatus: last?.status,
          lastRunAt: last ? new Date(last.startedAt) : undefined,
          lastError: last?.error,
        };
      })
      .sort((a, b) => (a.nextRun?.getTime() ?? Infinity) - (b.nextRun?.getTime() ?? Infinity));
  }

  /** Re-reads every project's job file now (normally polled every 30 s). */
  reloadAll(): void {
    for (const project of this.deps.projects) this.reload(project, { catchUp: false });
  }

  trigger(project: string, id: string, by: string): 'started' | 'unknown' | 'running' {
    const entry = this.entries.get(jobKey(project, id));
    if (!entry) return 'unknown';
    if (this.running.has(jobKey(project, id))) return 'running';
    this.launch(entry.scheduled, { kind: 'manual', by });
    return 'started';
  }

  private reload(project: Project, opts: { catchUp: boolean }): void {
    const name = project.config.name;
    const file = path.join(project.dir, JOBS_FILE);
    this.fileStamps.set(project.dir, this.stamp(file));
    let jobs: ScheduledJob[];
    try {
      jobs = loadJobs(project);
      for (const { job } of jobs)
        new Cron(job.cron, { paused: true, timezone: job.tz ?? this.deps.host.timezone }).stop();
    } catch (err) {
      const message = (err as Error).message;
      this.deps.log.error(`[${name}] jobs not reloaded: ${message}`);
      void this.deps.chat
        .post(
          project.config.slackChannel,
          undefined,
          `⚠️ \`${JOBS_FILE}\` was not reloaded:\n\`\`\`\n${message.slice(0, 2_500)}\n\`\`\``,
        )
        .catch(() => {});
      return;
    }

    for (const [key, entry] of this.entries) {
      if (entry.scheduled.project.config.name === name) {
        this.stopEntry(entry);
        this.entries.delete(key);
      }
    }
    for (const scheduled of jobs) {
      const { job } = scheduled;
      const key = jobKey(name, job.id);
      const timezone = job.tz ?? this.deps.host.timezone;
      const clock = new Cron(job.cron, { paused: true, timezone });
      const entry: Entry = { scheduled, clock };
      this.entries.set(key, entry);
      if (!job.enabled) continue;
      const firstSeen = this.deps.store.firstSeen(key);
      entry.cron = new Cron(job.cron, { timezone, catch: true }, () => {
        const slot = this.slotAtOrBefore(clock, this.now() + 1_000);
        if (slot !== undefined) this.fire(scheduled, slot, { kind: 'schedule' });
      });
      if (opts.catchUp) this.catchUp(scheduled, clock, firstSeen);
    }
    const enabled = jobs.filter((j) => j.job.enabled).length;
    this.deps.log.info(`[${name}] ${enabled}/${jobs.length} jobs scheduled`);
  }

  private catchUp(scheduled: ScheduledJob, clock: Cron, firstSeen: number): void {
    const windowMs = this.deps.host.catchUpHours * 3_600_000;
    if (!scheduled.job.catchUp || windowMs <= 0) return;
    const slot = this.slotAtOrBefore(clock, this.now());
    // Only slots after the job was first seen here: a newly added job must not fire for its past.
    if (slot === undefined || slot < firstSeen || this.now() - slot > windowMs) return;
    this.fire(scheduled, slot, { kind: 'catch-up' });
  }

  private slotAtOrBefore(clock: Cron, at: number): number | undefined {
    return clock.previousRuns(1, new Date(at))[0]?.getTime();
  }

  /** Runs a scheduled slot once: skipped when the job is still running or the slot was already claimed. */
  private fire(scheduled: ScheduledJob, slot: number, trigger: JobTrigger): void {
    const key = jobKey(scheduled.project.config.name, scheduled.job.id);
    if (this.running.has(key)) {
      this.deps.log.warn(`[${key}] still running; skipped slot ${new Date(slot).toISOString()}`);
      return;
    }
    if (!this.deps.store.claimSlot(key, slot)) return;
    this.launch(scheduled, trigger, (status) => this.deps.store.finishSlot(key, slot, status));
  }

  private launch(scheduled: ScheduledJob, trigger: JobTrigger, done?: (status: JobStatus) => void): void {
    const key = jobKey(scheduled.project.config.name, scheduled.job.id);
    this.running.add(key);
    const task = runJob(
      {
        host: this.deps.host,
        store: this.deps.store,
        chat: this.deps.chat,
        run: this.deps.run,
        log: this.deps.log,
        slots: this.slots,
        locks: this.locks,
        env: this.deps.env,
        runScript: this.deps.runScript,
        bridge: this.deps.bridge,
        newSessionId: this.deps.newSessionId,
        now: this.deps.now,
      },
      scheduled,
      trigger,
      this.controller.signal,
    )
      .then((status) => done?.(status))
      .catch((err: Error) => this.deps.log.error(`[${key}] ${err.message}`))
      .finally(() => {
        this.running.delete(key);
        this.inflight.delete(task);
      });
    this.inflight.add(task);
  }

  private checkFiles(): void {
    for (const project of this.deps.projects) {
      const stamp = this.stamp(path.join(project.dir, JOBS_FILE));
      if (stamp !== this.fileStamps.get(project.dir)) this.reload(project, { catchUp: false });
    }
  }

  private stamp(file: string): number {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }

  private stopEntry(entry: Entry): void {
    entry.cron?.stop();
    entry.clock.stop();
  }

  /** For tests: resolves when every launched job has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }
}
