import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import type { Bridge } from '../bridge/bridge.js';
import { JOBS_FILE, loadJobs } from '../config/load.js';
import type {
  AgyPermissions,
  Harness,
  HostConfig,
  JobConfig,
  Project,
  ScheduledJob,
} from '../config/schema.js';
import type { Runner } from '../runner/run.js';
import type { ChatPort, Logger } from '../sessions/manager.js';
import { Threads } from '../sessions/threads.js';
import { splitMessage } from '../slack/format.js';
import type { Item, Store } from '../store/store.js';
import { Locks, Semaphore } from '../util/concurrency.js';
import { buildDigest, type MissedJob } from './health.js';
import { type JobStatus, type JobTrigger, runJob } from './job-runner.js';
import type { DecidedCard } from './prompt.js';
import {
  openRunThread,
  runName,
  SCHEDULE_BY,
  type ScheduledKind,
  scheduledRunText,
} from './slack-trigger.js';

export interface JobInfo {
  id: string;
  name: string;
  enabled: boolean;
  running: boolean;
  /** Unset: runs only from a queue or by hand. */
  cron?: string;
  tz: string;
  skills: string[];
  model: string;
  /** The CLI the job runs on (unset: claude). */
  harness?: Harness;
  /** Models its steps run on where they differ from `model` (same harness). */
  stepModels?: string[];
  /** The harness and model an approved card continues on, when not the job's own. */
  handoff?: { harness: Harness; model: string };
  /** Typical run time from the jobs file. */
  durationMinutes?: number;
  /** Named locks it holds while running (e.g. a browser's). */
  locks?: string[];
  nextRun?: Date;
  lastStatus?: string;
  lastRunAt?: Date;
  lastError?: string;
}

/** What chat ("run <job name>") and the `list_jobs` / `run_job` tools need from the scheduler. */
export interface JobControl {
  list(project: string): JobInfo[];
  /**
   * Runs a job now; with `thread`, inside that chat message's thread. `by` = SCHEDULE_BY: the bot
   * saw its own trigger message, and the run is that scheduled slot (once; 'unknown' otherwise).
   */
  trigger(
    project: string,
    id: string,
    by: string,
    thread?: { channel: string; ts: string },
  ): 'started' | 'unknown' | 'running';
  /** A job's `agyPermissions`, for a thread reply that continues its agy session. */
  agyPermissions?(project: string, id: string): AgyPermissions | undefined;
}

export interface SchedulerDeps {
  projects: Project[];
  host: HostConfig;
  store: Store;
  chat: ChatPort;
  run: Runner;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  bridge?: Bridge;
  /** Shared with the chat sessions, so replies in a job's thread wait for it and "stop" reaches it. */
  threads?: Threads;
  newSessionId?: () => string;
  now?: () => number;
  /** How often job files are checked for changes. */
  reloadIntervalMs?: number;
  /** How long a posted trigger may wait for the bot before the scheduler starts it itself. */
  pickupTimeoutMs?: number;
}

interface Entry {
  scheduled: ScheduledJob;
  /** Fires the job; absent for disabled jobs. */
  cron?: Cron;
  /** Paused copy used only for date maths (previous/next slot); absent for queue-only jobs. */
  clock?: Cron;
}

const jobKey = (project: string, id: string) => `${project}:${id}`;

export class Scheduler implements JobControl {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<string>();
  /** Slots whose trigger message is posted in Slack, waiting for the bot to pick it up. */
  private readonly pending = new Map<string, { slot: number; kind: ScheduledKind; byPerson: boolean }>();
  /** Watchdogs of posted triggers, cleared on stop. */
  private readonly pickups = new Set<NodeJS.Timeout>();
  private readonly fileStamps = new Map<string, number>();
  private readonly slots: Semaphore;
  private readonly locks = new Locks();
  private readonly threads: Threads;
  private readonly controller = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly now: () => number;
  /** Claims older than this belong to an earlier process. */
  private readonly startedAt: number;
  private poller: NodeJS.Timeout | undefined;
  private healthCron: Cron | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    this.slots = new Semaphore(deps.host.jobConcurrency);
    this.threads = deps.threads ?? new Threads();
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Loads every project's jobs, runs missed slots, and starts watching the job files. */
  start(): void {
    for (const project of this.deps.projects) this.reload(project, { catchUp: true });
    this.poller = setInterval(() => this.checkFiles(), this.deps.reloadIntervalMs ?? 30_000);
    this.poller.unref();
    const { healthDigest, timezone } = this.deps.host;
    if (healthDigest.enabled) {
      this.healthCron = new Cron(healthDigest.cron, { timezone, catch: true }, () => this.postDigests());
    }
  }

  /** Stops scheduling and aborts running jobs; resolves when they have wound down. */
  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.healthCron?.stop();
    for (const entry of this.entries.values()) this.stopEntry(entry);
    this.entries.clear();
    for (const timer of this.pickups) clearTimeout(timer);
    this.pickups.clear();
    this.controller.abort();
    await Promise.allSettled([...this.inflight]);
  }

  agyPermissions(project: string, id: string): AgyPermissions | undefined {
    return this.entries.get(jobKey(project, id))?.scheduled.job.agyPermissions;
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
          harness: job.harness,
          stepModels: [
            ...new Set(job.steps.flatMap((s) => (s.model && s.model !== job.model ? [s.model] : []))),
          ],
          handoff: job.handoff,
          durationMinutes: job.durationMinutes,
          locks: job.locks,
          nextRun: cron?.nextRun() ?? undefined,
          lastStatus: last?.status,
          lastRunAt: last ? new Date(last.startedAt) : undefined,
          lastError: last?.error,
        };
      })
      .sort((a, b) => (a.nextRun?.getTime() ?? Infinity) - (b.nextRun?.getTime() ?? Infinity));
  }

  /** The last 24 hours of one project, or null when nothing ran or was missed. */
  digest(project: string): { headline: string; details: string } | null {
    const now = this.now();
    const from = now - 24 * 3_600_000;
    // A slot needs a few minutes to be claimed (it may wait for a job slot or a lock).
    const until = now - 10 * 60_000;
    const missed: MissedJob[] = [];
    for (const [key, { scheduled, clock, cron }] of this.entries) {
      if (scheduled.project.config.name !== project || !cron || !clock) continue;
      const since = Math.max(from, this.deps.store.firstSeen(key));
      const claimed = this.deps.store.claimedSlots(key, since, until);
      const slots: number[] = [];
      for (
        let next = clock.nextRun(new Date(since));
        next && next.getTime() <= until && slots.length < 500;
      ) {
        if (!claimed.has(next.getTime())) slots.push(next.getTime());
        next = clock.nextRun(next);
      }
      if (slots.length) missed.push({ id: scheduled.job.id, name: scheduled.job.name, slots });
    }
    return buildDigest({
      project,
      runs: this.deps.store.runsSince(from).filter((r) => r.project === project),
      missed,
      timeZone: this.deps.host.timezone,
    });
  }

  /** Posts each project's digest in a "Run health-digest" thread: the headline, then the details. */
  async postDigests(): Promise<void> {
    for (const project of this.deps.projects) {
      const digest = this.digest(project.config.name);
      if (!digest) continue;
      try {
        const ts = await openRunThread(this.deps.chat, project.config.slackChannel, 'health-digest');
        await this.deps.chat.post(project.config.slackChannel, ts, digest.headline);
        for (const chunk of splitMessage(digest.details))
          await this.deps.chat.post(project.config.slackChannel, ts, chunk);
      } catch (err) {
        this.deps.log.error(`[${project.config.name}] health digest not posted: ${(err as Error).message}`);
      }
    }
  }

  /** Re-reads every project's job file now (normally polled every 30 s). */
  /** Whether a job exists and is on (not paused). */
  enabled(project: string, id: string): boolean {
    return this.entries.get(jobKey(project, id))?.scheduled.job.enabled === true;
  }

  reloadAll(): void {
    for (const project of this.deps.projects) this.reload(project, { catchUp: false });
  }

  /**
   * Pauses or resumes a job: flips its `enabled` in the project's jobs file (which stays the source
   * of truth) and reloads that project so the change takes effect at once.
   */
  setEnabled(project: string, id: string, enabled: boolean): 'ok' | 'unknown' {
    return this.editJob(project, id, (job) => {
      // A missing `enabled` means on, so resuming removes the key: a pause + resume leaves the file as it was.
      const changed = enabled ? 'enabled' in job : job.enabled !== false;
      if (enabled) delete job.enabled;
      else job.enabled = false;
      return changed;
    });
  }

  /** Sets a job's typical run time (`durationMinutes`), which the schedule view uses. */
  setDuration(project: string, id: string, minutes: number): 'ok' | 'unknown' {
    return this.editJob(project, id, (job) => {
      const changed = job.durationMinutes !== minutes;
      job.durationMinutes = minutes;
      return changed;
    });
  }

  /** Changes one job in the project's jobs file (the source of truth) and reloads that project at once. */
  private editJob(
    project: string,
    id: string,
    edit: (job: { id?: string; enabled?: boolean; durationMinutes?: number }) => boolean,
  ): 'ok' | 'unknown' {
    const owner = this.deps.projects.find((p) => p.config.name === project);
    if (!owner) return 'unknown';
    const file = path.join(owner.dir, JOBS_FILE);
    if (!existsSync(file)) return 'unknown';
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      jobs?: Array<{ id?: string; enabled?: boolean; durationMinutes?: number }>;
    };
    const job = doc.jobs?.find((j) => j.id === id);
    if (!job) return 'unknown';
    if (edit(job)) {
      // Written the way these files are kept (2-space JSON), so nothing else in them changes.
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      renameSync(tmp, file);
    }
    this.reload(owner, { catchUp: false });
    return 'ok';
  }

  /** Start times of a project's enabled jobs in [from, to); more than `limit` means the job runs too often to plan. */
  plannedRuns(
    project: string,
    from: number,
    to: number,
    limit: number,
  ): Array<{ id: string; starts: number[] }> {
    return [...this.entries.values()]
      .filter((e) => e.scheduled.project.config.name === project && e.scheduled.job.enabled)
      .map(({ scheduled: { job }, clock }) => {
        const starts: number[] = [];
        let next = clock?.nextRun(new Date(from - 1));
        while (clock && next && next.getTime() < to && starts.length <= limit) {
          starts.push(next.getTime());
          next = clock.nextRun(next);
        }
        return { id: job.id, starts };
      });
  }

  trigger(
    project: string,
    id: string,
    by: string,
    thread?: { channel: string; ts: string },
  ): 'started' | 'unknown' | 'running' {
    const key = jobKey(project, id);
    const entry = this.entries.get(key);
    if (by === SCHEDULE_BY) {
      // Taken once: a redelivered Slack event (or an old trigger message) starts nothing.
      const pending = this.pending.get(key);
      this.pending.delete(key);
      if (!entry || !pending) return 'unknown';
      // Paused (Pause, or the project's emergency stop) between the trigger post and its pickup: the
      // slot is skipped, never started by the pickup watchdog after all.
      if (!entry.scheduled.job.enabled) {
        this.deps.store.finishSlot(key, pending.slot, 'skipped');
        return 'unknown';
      }
      if (this.running.has(key)) {
        this.deps.store.finishSlot(key, pending.slot, 'skipped');
        return 'running';
      }
      this.launch(entry.scheduled, { kind: pending.kind, thread, byPerson: pending.byPerson }, (status) =>
        this.deps.store.finishSlot(key, pending.slot, status),
      );
      return 'started';
    }
    if (!entry) return 'unknown';
    if (this.running.has(key)) return 'running';
    this.launch(entry.scheduled, { kind: 'manual', by, thread });
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
        if (job.cron)
          new Cron(job.cron, { paused: true, timezone: job.tz ?? this.deps.host.timezone }).stop();
    } catch (err) {
      const message = (err as Error).message;
      this.deps.log.error(`[${name}] jobs not reloaded: ${message}`);
      void openRunThread(this.deps.chat, project.config.slackChannel, 'jobs-reload')
        .then((ts) =>
          this.deps.chat.post(
            project.config.slackChannel,
            ts,
            `⚠️ \`${JOBS_FILE}\` was not reloaded:\n\`\`\`\n${message.slice(0, 2_500)}\n\`\`\``,
          ),
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
      const clock = job.cron ? new Cron(job.cron, { paused: true, timezone }) : undefined;
      const entry: Entry = { scheduled, clock };
      this.entries.set(key, entry);
      if (!job.enabled || !job.cron || !clock) continue;
      const firstSeen = this.deps.store.firstSeen(key);
      entry.cron = new Cron(job.cron, { timezone, catch: true }, () => {
        const slot = this.slotAtOrBefore(clock, this.now() + 1_000);
        if (slot !== undefined) this.fire(scheduled, slot, 'schedule');
      });
      if (opts.catchUp) this.catchUp(scheduled, clock, firstSeen);
    }
    const scheduled = jobs.filter((j) => j.job.enabled && j.job.cron).length;
    const unscheduled = jobs.filter((j) => !j.job.cron).length;
    this.deps.log.info(
      `[${name}] ${scheduled}/${jobs.length} jobs scheduled${unscheduled ? ` (${unscheduled} run from queues or on demand)` : ''}`,
    );
  }

  private catchUp(scheduled: ScheduledJob, clock: Cron, firstSeen: number): void {
    const windowMs = this.deps.host.catchUpHours * 3_600_000;
    if (!scheduled.job.catchUp || windowMs <= 0) return;
    const slot = this.slotAtOrBefore(clock, this.now());
    // Only slots after the job was first seen here: a newly added job must not fire for its past.
    if (slot === undefined || slot < firstSeen || this.now() - slot > windowMs) return;
    this.fire(scheduled, slot, 'catch-up');
  }

  private slotAtOrBefore(clock: Cron, at: number): number | undefined {
    return clock.previousRuns(1, new Date(at))[0]?.getTime();
  }

  /**
   * A scheduled slot, once: claims it and posts its trigger message in the project channel. The bot
   * picks that message up and starts the run in its thread (see `trigger`). Skipped when the job is
   * still running or the slot was already claimed. A slot whose message never comes back stays
   * claimed as `running`, so the next start catches it up.
   */
  private fire(scheduled: ScheduledJob, slot: number, kind: ScheduledKind): void {
    const { project, job } = scheduled;
    const key = jobKey(project.config.name, job.id);
    if (this.running.has(key)) {
      this.deps.log.warn(`[${key}] still running; skipped slot ${new Date(slot).toISOString()}`);
      return;
    }
    if (!this.deps.store.claimSlot(key, slot, this.startedAt)) return;
    const { chat } = this.deps;
    const channel = project.config.slackChannel;
    const text = scheduledRunText(runName(job, this.jobsOf(project.config.name)));
    const asBot = () => {
      // Set before posting: Slack can deliver the message event before the post call returns.
      this.pending.set(key, { slot, kind, byPerson: false });
      return chat.post(channel, undefined, text);
    };
    const asPerson = chat.postAsUser?.bind(chat);
    const post = asPerson
      ? (() => {
          this.pending.set(key, { slot, kind, byPerson: true });
          return asPerson(channel, text).catch((err: Error) => {
            // e.g. not_in_channel: that person isn't in the channel. The bot posts it instead.
            this.deps.log.warn(
              `[${key}] trigger not posted as the user (${err.message}); posting as the bot`,
            );
            return asBot();
          });
        })()
      : asBot();
    post.then(
      (ts) => this.watchPickup(key, slot, { channel, ts }),
      (err: Error) => {
        this.deps.log.error(`[${key}] trigger message not posted: ${err.message}`);
        this.pending.delete(key);
        // Aborted slots are claimed again on the next start.
        this.deps.store.finishSlot(key, slot, 'aborted');
      },
    );
  }

  /**
   * Slack can drop a message event (a socket reconnect, an outage). A trigger the bot hasn't picked
   * up in time is started by the scheduler itself, in the same thread, as if the bot had.
   */
  private watchPickup(key: string, slot: number, thread: { channel: string; ts: string }): void {
    const timer = setTimeout(() => {
      this.pickups.delete(timer);
      if (this.pending.get(key)?.slot !== slot) return; // picked up already
      const at = key.lastIndexOf(':'); // ids have no ':'
      const [project, id] = [key.slice(0, at), key.slice(at + 1)];
      this.deps.log.warn(`[${key}] trigger not picked up from Slack in time; starting it here`);
      this.trigger(project, id, SCHEDULE_BY, thread);
    }, this.deps.pickupTimeoutMs ?? 120_000);
    timer.unref();
    this.pickups.add(timer);
  }

  /**
   * Continues a job's session after a decision on its approval card, as that job (its slot, locks,
   * prompt and timeout), once any run of it in progress has finished.
   */
  async resume(
    project: string,
    id: string,
    r: { threadTs: string; text: string; by: string; card?: DecidedCard },
  ): Promise<JobStatus | 'unknown'> {
    // A job with a handoff runs no model for a declined card: the card and its Slack message already
    // show the decision, and a turn would only say "skipped" (on the paid harness, after a handoff).
    if (r.card?.declined && this.entries.get(jobKey(project, id))?.scheduled.job.handoff) return 'silent';
    return this.whenFree(project, id, { kind: 'resume', ...r });
  }

  /** Runs a job with approved queue items in its prompt; resolves when the run has ended. */
  async runQueue(project: string, id: string, queue: string, items: Item[]): Promise<JobStatus | 'unknown'> {
    return this.whenFree(project, id, { kind: 'queue', queue, items });
  }

  private async whenFree(project: string, id: string, trigger: JobTrigger): Promise<JobStatus | 'unknown'> {
    const key = jobKey(project, id);
    while (this.running.has(key)) await new Promise((r) => setTimeout(r, 2_000));
    const entry = this.entries.get(key);
    if (!entry) return 'unknown';
    return this.launch(entry.scheduled, trigger);
  }

  /** The jobs of one project, as loaded. */
  private jobsOf(project: string): JobConfig[] {
    return [...this.entries.values()]
      .filter((e) => e.scheduled.project.config.name === project)
      .map((e) => e.scheduled.job);
  }

  private launch(
    scheduled: ScheduledJob,
    trigger: JobTrigger,
    done?: (status: JobStatus | 'stopped') => void,
  ): Promise<JobStatus> {
    const key = jobKey(scheduled.project.config.name, scheduled.job.id);
    this.running.add(key);
    let result: JobStatus = 'error';
    const named = {
      ...scheduled,
      runName: runName(scheduled.job, this.jobsOf(scheduled.project.config.name)),
    };
    const task = runJob(
      {
        host: this.deps.host,
        store: this.deps.store,
        chat: this.deps.chat,
        run: this.deps.run,
        log: this.deps.log,
        slots: this.slots,
        locks: this.locks,
        threads: this.threads,
        env: this.deps.env,
        bridge: this.deps.bridge,
        newSessionId: this.deps.newSessionId,
        now: this.deps.now,
      },
      named,
      trigger,
      this.controller.signal,
    )
      .then((status) => {
        result = status;
        // Only a shutdown's `aborted` leaves the slot open to be claimed again after the restart; a run a
        // person stopped ("stop" in its thread, Stop on the dashboard) stays stopped.
        done?.(status === 'aborted' && !this.controller.signal.aborted ? 'stopped' : status);
      })
      .catch((err: Error) => this.deps.log.error(`[${key}] ${err.message}`))
      .finally(() => {
        this.running.delete(key);
        this.inflight.delete(task);
      });
    this.inflight.add(task);
    return task.then(() => result);
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
    entry.clock?.stop();
  }

  /** For tests: resolves when every launched job has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }
}
