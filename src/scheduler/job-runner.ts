import { randomUUID } from 'node:crypto';
import type { Bridge, RunContext } from '../bridge/bridge.js';
import type { HostConfig, ScheduledJob } from '../config/schema.js';
import { memoryBlock } from '../memory/memory.js';
import { buildAgyArgs } from '../runner/agy.js';
import { buildClaudeArgs } from '../runner/args.js';
import { buildChildEnv } from '../runner/env.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import { jobDataDir, sessionScratch } from '../runner/workspace.js';
import { type LearnRequest, learnFromRun, learnReasons, runUse, typicalRun } from '../sessions/learn.js';
import { type ChatPort, type Logger, threadKey } from '../sessions/manager.js';
import type { ThreadHold, Threads } from '../sessions/threads.js';
import { formatDuration, postMarkdown } from '../slack/format.js';
import { type Incidents, incidentOf } from '../slack/incidents.js';
import { StreamReply } from '../slack/reply.js';
import type { Item, RunRecord, Store } from '../store/store.js';
import { type Locks, type Semaphore, Throttle } from '../util/concurrency.js';
import { deliveryOf, isWebChannel, streamFor, webChannel, webOf } from '../web/chat.js';
import { postSummary, slackSummaryOf } from '../web/summary.js';
import {
  type GateRunner,
  gateRecord,
  gateRunner,
  gateSaysSkip,
  gateSection,
  missingServices,
  skipReason,
} from './gate.js';
import { type LimitHolds, limitResetAt } from './limits.js';
import {
  buildDecisionPrompt,
  buildHandoffPrompt,
  buildJobPrompt,
  type DecidedCard,
  decisionWithCard,
  failedReply,
  identityPrompt,
  JOB_SYSTEM_PROMPT,
} from './prompt.js';
import { openRunThread } from './slack-trigger.js';
import { expandMcpServers, fallbackNote, harnessUnavailable, runSteps, type StepsResult } from './steps.js';

export type JobTrigger =
  /**
   * `thread`: the trigger message in Slack. Posted by the bot, it becomes the run's status line;
   * posted as a person (`byPerson`, which the bot can't edit), the status is its first reply.
   */
  | { kind: 'schedule'; thread?: { channel: string; ts: string }; byPerson?: boolean }
  | { kind: 'catch-up'; thread?: { channel: string; ts: string }; byPerson?: boolean }
  /**
   * `thread`: the chat message that asked for the run; the run then happens in its thread. `replyIn`:
   * a Slack thread it was asked for in ("run <skill>" as a reply): a dashboard run's result summary
   * goes there, as a reply, instead of a new channel message.
   */
  | {
      kind: 'manual';
      by: string;
      thread?: { channel: string; ts: string };
      replyIn?: { channel: string; ts: string };
    }
  /**
   * A decision on the run's approval card: the same session continues in its thread. `channel`: the
   * thread's channel (a dashboard thread's, or a Slack one; unset: the job's Slack channel).
   */
  | { kind: 'resume'; by: string; channel?: string; threadTs: string; text: string; card?: DecidedCard }
  /**
   * A decision on a card with handoff notes: a fresh session acts on it in a new `Run` thread, from the
   * card, its notes and the project memory. `from` is the thread of the run that raised it.
   */
  | {
      kind: 'decision';
      by: string;
      text: string;
      card: DecidedCard;
      from: { channel: string; threadTs: string };
    }
  /** Approved items from one of the project's queues, handed to this (executor) job. */
  | { kind: 'queue'; queue: string; items: Item[] };

const REACTIONS: Record<JobStatus, string> = {
  ok: 'white_check_mark',
  silent: 'white_check_mark',
  failed: 'x',
  error: 'x',
  timeout: 'hourglass',
  limit: 'double_vertical_bar',
  aborted: 'black_square_for_stop',
  skipped: 'white_check_mark',
  blocked: 'no_entry',
  'over-budget': 'moneybag',
};

/**
 * How a run ended; stored on the slot claim and in the run log. Without a model session: `skipped` (the
 * job's gate found nothing to do) and `blocked` (a service in its `requires` didn't answer).
 * `over-budget`: the model session was stopped at the job's `budgetUsd`.
 */
export type JobStatus =
  | 'ok'
  | 'silent'
  | 'failed'
  | 'error'
  | 'timeout'
  | 'limit'
  | 'aborted'
  | 'skipped'
  | 'blocked'
  | 'over-budget';

export interface JobRunnerDeps {
  host: HostConfig;
  store: Store;
  chat: ChatPort;
  run: Runner;
  log: Logger;
  slots: Semaphore;
  locks: Locks;
  /** One run per Slack thread, shared with chat turns. */
  threads: Threads;
  bridge?: Bridge;
  env?: NodeJS.ProcessEnv;
  newSessionId?: () => string;
  now?: () => number;
  /** A thread's link: a Slack thread's once Slack is connected, a dashboard thread's page. */
  threadUrl?: (channel: string, ts: string) => string | undefined;
  /** What the run waits for before it starts; called with undefined once it has its slot and locks. */
  onWait?: (waitingFor: JobWait | undefined) => void;
  /** Usage limits and lost logins: one Slack message per incident instead of one per failed run. */
  incidents?: Incidents;
  /** The Approvals page, linked from a summary whose run left cards there. */
  approvalsUrl?: string;
  /** Usage limits, host-wide: a run that hits one holds scheduled runs on its CLI until it resets. */
  holds?: LimitHolds;
  /** Aborts while the run still waits for its locks or a slot (the job was paused): it then doesn't start. */
  cancelWait?: AbortSignal;
  /** Runs a job's `gate` (as the run user on a host with `claude.runAs`). */
  gate?: GateRunner;
  /** Whether a `requires` URL answers (tests). */
  probe?: (url: string) => Promise<boolean>;
  /** A run acting on an approved card stopped before it finished: fail the card, raise "Not finished". */
  unfinished?: (input: {
    project: string;
    jobId: string;
    card: DecidedCard;
    reason: string;
    thread: { channel: string; threadTs: string };
    link?: string;
  }) => Promise<void>;
}

/** What a run waits for: its thread (a chat turn working in it), a free job slot, or its locks. */
export type JobWait = 'thread' | 'slot' | 'lock';

const SLACK_USER = /^[UW][A-Z0-9]+$/;

/** Adds token counts; unset when neither is known. */
const sum = (a?: number, b?: number) => (a === undefined && !b ? a : (a ?? 0) + (b ?? 0));

/**
 * Who a run's live thread is addressed to (Slack's streaming API needs a recipient). Every run streams
 * its steps into its thread: to whoever started or continued it in Slack, else the project owner.
 */
export function streamRecipient(trigger: JobTrigger, owner: string | undefined): string | undefined {
  const by =
    trigger.kind === 'manual' || trigger.kind === 'resume' || trigger.kind === 'decision'
      ? trigger.by
      : undefined;
  return by && SLACK_USER.test(by) ? by : owner;
}

function triggerLabel(trigger: JobTrigger): string {
  if (trigger.kind === 'catch-up') return ' (catch-up)';
  if (trigger.kind === 'manual') {
    if (/^[UW][A-Z0-9]+$/.test(trigger.by)) return ` (run by <@${trigger.by}>)`;
    // Run now on the dashboard or the API: where, not a made-up person.
    return ['dashboard', 'api'].includes(trigger.by)
      ? ` (run from the ${trigger.by === 'api' ? 'API' : trigger.by})`
      : ` (run by ${trigger.by})`;
  }
  if (trigger.kind === 'resume') return ' (continuing after your decision)';
  if (trigger.kind === 'decision') return ' (acting on your decision)';
  if (trigger.kind === 'queue')
    return ` (${trigger.items.length} approved ${trigger.items.length === 1 ? 'item' : 'items'})`;
  return '';
}

/**
 * Runs one job end to end: wait for a job slot and its locks, run the pre-script, then (unless the
 * script gate says no) a Claude session whose thread can be replied to later. Never rejects.
 */
export async function runJob(
  deps: JobRunnerDeps,
  scheduled: ScheduledJob,
  trigger: JobTrigger,
  signal?: AbortSignal,
  /**
   * Called once with the run's outcome as soon as it is recorded, before its learning turns. The scheduler
   * closes the slot here: a slot still open when the process dies is run again after the restart, and the
   * job's work (a post, an email) is already done by then.
   */
  onDone?: (status: JobStatus, toolCalls?: number) => void,
): Promise<JobStatus> {
  const { project, job } = scheduled;
  const { chat, store, log } = deps;
  const now = deps.now ?? Date.now;
  const slackChannel = job.channel ?? project.config.slackChannel;
  const title = `*${job.name}*${triggerLabel(trigger)}`;
  // "run <skill>" as a reply in a Slack thread: the result summary answers in that thread.
  const askedIn =
    trigger.kind === 'manual' && trigger.replyIn?.channel === slackChannel ? trigger.replyIn.ts : undefined;
  const timeoutMs = job.timeoutMinutes * 60_000;
  // Asked for in chat, or running cards that share a Slack thread (a `slack` queue): run inside that
  // thread instead of posting a new channel message.
  const cardThread =
    trigger.kind === 'queue' &&
    trigger.items.every(
      (i) => i.channel === slackChannel && i.messageTs && i.threadTs === trigger.items[0]?.threadTs,
    )
      ? trigger.items[0]?.threadTs
      : undefined;
  const asked =
    trigger.kind === 'manual' || trigger.kind === 'schedule' || trigger.kind === 'catch-up'
      ? trigger.thread
      : undefined;
  const requestTs = asked?.channel === slackChannel ? asked.ts : cardThread;
  // Where the run happens. Continuing: the thread it ran in. Asked for in a Slack thread: there. Else,
  // with `delivery: summary`, a dashboard thread (Slack gets the result only); otherwise a new Slack thread.
  const web = webOf(chat);
  const channel =
    trigger.kind === 'resume'
      ? (trigger.channel ?? slackChannel)
      : !requestTs && web && deliveryOf(deps.host, project, job) === 'summary'
        ? webChannel(project.config.name)
        : slackChannel;
  const onDashboard = isWebChannel(channel);
  // The thread the run posts in: the trigger or requester's message, or (continuing) the job's earlier
  // thread. A run with none (a queue, Run now) opens its own with a top-level "Run <name>". The top
  // level of the channel only ever holds those "Run" messages; they are never edited.
  let inThread = trigger.kind === 'resume' ? trigger.threadTs : requestTs;
  const thread = async () => {
    if (!inThread)
      inThread = await openRunThread(chat, channel, scheduled.runName ?? job.name, project.config.words);
    return inThread;
  };
  const postMain = async (text: string) => chat.post(channel, await thread(), text);
  const reactTo = requestTs;
  // Before the first await, so the run never looks started while it waits.
  deps.onWait?.(inThread ? 'thread' : 'slot');
  if (reactTo) await chat.react(channel, reactTo, 'eyes').catch(() => {});

  const waitStart = now();
  // An existing thread may have a chat turn in it: wait for it before taking locks and a slot.
  let hold: ThreadHold | undefined = inThread
    ? await deps.threads.enter(threadKey(channel, inThread))
    : undefined;
  // Locks first, then a slot: a job waiting for a busy browser doesn't hold one of the few job slots
  // meanwhile. A slot holder never waits for a lock, so the two can't deadlock.
  const waitSignal = AbortSignal.any([signal, deps.cancelWait].filter((s): s is AbortSignal => Boolean(s)));
  let releaseLocks: () => void = () => {};
  let releaseSlot: () => void = () => {};
  const notStarted = (why: string): JobStatus => {
    releaseSlot();
    releaseLocks();
    hold?.release();
    if (reactTo) void chat.unreact(channel, reactTo, 'eyes').catch(() => {});
    log.info(`[${project.config.name}] job ${job.id} not started: ${why}`);
    return 'aborted';
  };
  try {
    if (job.locks.length) deps.onWait?.('lock');
    releaseLocks = await deps.locks.acquire(job.locks, waitSignal);
    deps.onWait?.('slot');
    releaseSlot = await deps.slots.acquire(waitSignal);
  } catch {
    return notStarted(signal?.aborted ? 'tara-agent is stopping' : 'paused while it waited');
  }
  const scheduledRun = trigger.kind === 'schedule' || trigger.kind === 'catch-up';
  if (scheduledRun && job.maxWaitMinutes && now() - waitStart > job.maxWaitMinutes * 60_000)
    return notStarted(`waited ${formatDuration(now() - waitStart)}, over its maxWaitMinutes`);
  deps.onWait?.(undefined);
  // From here a crash may leave a queue item half done; before, it only waited and goes back on restart.
  if (trigger.kind === 'queue') store.markRunStarted(trigger.items.map((i) => i.id));
  const startedAt = now();
  // The whole run's time (steps included): see `runTimeoutMinutes`.
  const runTimeoutMs = (job.runTimeoutMinutes ?? job.timeoutMinutes * (job.steps.length ? 2 : 1)) * 60_000;
  const deadline = startedAt + runTimeoutMs;
  /** The main session's time: its own limit, within the run's deadline, but always 5 minutes to report. */
  const mainTimeoutMs = () => Math.min(timeoutMs, Math.max(5 * 60_000, deadline - now()));
  const lessons: LearnRequest[] = [];
  /** What the job's gate printed, when it let the run through: kept on the run. */
  let gateOutput: string | undefined;
  const record = (status: JobStatus, extra: Partial<RunRecord> = {}) => {
    store.recordRun({
      kind: 'job',
      project: project.config.name,
      jobId: job.id,
      startedAt,
      endedAt: now(),
      status,
      scriptOutput: gateOutput,
      ...extra,
    });
    log.info(`[${project.config.name}] job ${job.id} ${status} in ${formatDuration(now() - startedAt)}`);
    onDone?.(status, extra.toolCalls);
    if (reactTo) {
      void chat
        .unreact(channel, reactTo, 'eyes')
        .catch(() => {})
        .then(() => chat.react(channel, reactTo, REACTIONS[status]))
        .catch(() => {});
    }
    return status;
  };

  try {
    let env: NodeJS.ProcessEnv;
    const stateDir = deps.host.stateDir as string;
    try {
      env = { ...buildChildEnv(deps.env ?? process.env, project.config.billing), ...scheduled.env };
      env.TARA_JOB_DATA = jobDataDir(project, stateDir, job.id);
      // The skill runs the job's scripts itself: let one Bash call take as long as the job may.
      env.BASH_DEFAULT_TIMEOUT_MS = env.BASH_MAX_TIMEOUT_MS = String(timeoutMs);
    } catch (err) {
      await postMain(`❌ ${title} could not start: ${(err as Error).message}`);
      if (web && inThread && onDashboard)
        await postSummary({
          chat,
          store,
          web,
          log,
          slackChannel,
          thread: { channel, ts: inThread },
          title,
          text: `❌ Could not start: ${(err as Error).message}`,
          link: deps.threadUrl?.(channel, inThread),
          replyIn: askedIn,
        });
      return record('error', { error: (err as Error).message });
    }

    /** A run that ends before its model session: one line in its thread, and the Slack summary. */
    const notice = async (text: string) => {
      await postMain(`${text} · ${title}`);
      if (web && inThread && onDashboard)
        await postSummary({
          chat,
          store,
          web,
          log,
          slackChannel,
          thread: { channel, ts: inThread },
          title,
          text,
          link: deps.threadUrl?.(channel, inThread),
          replyIn: askedIn,
        });
    };
    // Before any model session: the services the job needs (`requires`), then its `gate`.
    const newRun =
      trigger.kind === 'schedule' ||
      trigger.kind === 'catch-up' ||
      trigger.kind === 'manual' ||
      trigger.kind === 'queue';
    if (newRun && job.requires?.length) {
      const missing = await missingServices(job.requires, deps.probe);
      if (missing.length) {
        const why = `not answering: ${missing.join(', ')}`;
        // A queue's items wait for the next try instead of failing: nothing was sent.
        if (trigger.kind === 'queue')
          for (const item of trigger.items) store.deferItem(item.id, now() + 15 * 60_000, `Waiting: ${why}`);
        // One message per streak (a person asking always hears why).
        const before = store.lastJobRun(project.config.name, job.id);
        if (before?.status !== 'blocked' || trigger.kind === 'manual') await notice(`⛔ Blocked, ${why}`);
        return record('blocked', { error: `Blocked, ${why}` });
      }
    }
    let gateText: string | undefined;
    if (
      job.gate &&
      (trigger.kind === 'schedule' || trigger.kind === 'catch-up' || trigger.kind === 'manual')
    ) {
      const result = await (deps.gate ?? gateRunner())({
        command: job.gate,
        cwd: project.dir,
        env,
        timeoutMs,
        signal,
      });
      if (signal?.aborted) return record('aborted');
      if (gateSaysSkip(result)) {
        const said = skipReason(result);
        // Scheduled: nothing posted. A person who pressed Run now hears it.
        if (trigger.kind === 'manual') await notice(said);
        return record('skipped', { output: said, costUsd: 0 });
      }
      gateText = gateSection(job.gate, result);
      gateOutput = gateRecord(result);
    }

    // The status line (⏳ with the current step → ✅ / ❌) is the first reply in the run's thread.
    const statusTs = await postMain(`⏳ ${title}`);
    const rootTs = await thread();
    const key = threadKey(channel, rootTs);
    // Holding the thread makes replies wait for this run, and lets "stop" in the thread end it.
    hold ??= await deps.threads.enter(key);
    const stop = signal ? AbortSignal.any([signal, hold.signal]) : hold.signal;
    const earlier = trigger.kind === 'resume' ? store.getSession(key) : undefined;
    if (trigger.kind === 'resume' && !earlier?.started) {
      await chat.update(channel, statusTs, `❌ ${title}: the run's session is gone, so it can't continue`);
      return record('error', { error: 'no session to continue' });
    }
    // Acting on a decision in a new thread: the run that raised the card, and where each thread points.
    const from = trigger.kind === 'decision' ? trigger.from : undefined;
    const origin = from && store.getSession(threadKey(from.channel, from.threadTs));
    if (trigger.kind === 'decision' && from) {
      const here = deps.threadUrl?.(channel, rootTs);
      const there = deps.threadUrl?.(from.channel, from.threadTs);
      await chat.post(
        channel,
        rootTs,
        `📝 *${trigger.card.title}*${there ? ` · <${there}|earlier thread>` : ''}`,
      );
      await chat
        .post(
          from.channel,
          from.threadTs,
          `➡️ Your decision on "${trigger.card.title}" continues in ${here ? `<${here}|a new thread>` : 'a new thread'}`,
        )
        .catch((err: Error) =>
          log.warn(`could not link the new thread from the earlier one: ${err.message}`),
        );
    }
    // An approved card of a job with a handoff starts on the handoff's CLI, as a resumed one would.
    const fresh =
      trigger.kind === 'decision' && job.handoff && !trigger.card.declined ? job.handoff : undefined;
    const newId = (deps.newSessionId ?? randomUUID)();
    let session = earlier ?? {
      threadKey: key,
      project: project.config.name,
      sessionId: newId,
      model: fresh?.model ?? job.model,
      started: false,
      harness: fresh?.harness ?? job.harness,
      // Acting on a decision keeps the earlier run's scratch folder (its screenshots and downloads).
      scratchId: origin?.scratchId ?? origin?.sessionId ?? newId,
    };
    // The run keeps its scratch folder (and the files in it, e.g. screenshots) across agy's own
    // conversation id and a handoff.
    const scratchId = session.scratchId ?? session.sessionId;
    const ranOn = session.harness ?? 'claude';
    // An approved card of a job with a handoff carries on in a fresh session on the handoff's harness.
    const card = trigger.kind === 'resume' ? trigger.card : undefined;
    const handoff =
      job.handoff && card && !card.declined && ranOn !== job.handoff.harness ? job.handoff : undefined;
    if (handoff)
      session = {
        threadKey: key,
        project: project.config.name,
        sessionId: newId,
        model: handoff.model,
        started: false,
        harness: handoff.harness,
        scratchId,
      };
    // Otherwise a continued run stays on the CLI its session lives in.
    let harness = session.harness ?? 'claude';
    const resuming = trigger.kind === 'resume' && !handoff;
    // A fresh session whose CLI is out of quota or capacity reruns on the job's fallback; a continued
    // conversation can't move, so it stays.
    const fallback = !resuming && job.fallback && harness !== job.fallback.harness ? job.fallback : undefined;
    /** Lines for the thread: each session that moved to the fallback. */
    const fallbackNotes: string[] = [];
    store.saveSession(session);
    const folders = {
      scratch: sessionScratch(project, stateDir, job.id, scratchId),
      jobData: env.TARA_JOB_DATA,
    };
    // TARA_THREAD: a project server that makes a card for this run (the run calls it) passes it on to
    // tara-agent's `/items` API, so the card lands in this run's thread instead of a day thread.
    env = { ...env, TARA_SCRATCH: folders.scratch, TARA_THREAD: key };
    let steps = 0;
    let toolErrors = 0;
    const intervalMs = deps.host.statusIntervalSeconds * 1000;
    const status = new Throttle<string>(intervalMs, (text) => chat.update(channel, statusTs, text));
    // A dashboard thread streams to whoever opens it; Slack's stream needs a person to address.
    const recipient = onDashboard ? 'dashboard' : streamRecipient(trigger, project.config.owner);
    const port = streamFor(chat, channel);
    const live =
      recipient && port
        ? new StreamReply(chat, port, channel, rootTs, recipient, false, Math.min(intervalMs, 1000))
        : undefined;
    /**
     * A dashboard run's result in Slack: one message with its headline (or why it didn't finish), its
     * files in that message's thread. A run with nothing to report, or one a person stopped, posts nothing.
     */
    const summarize = async (text: string, meta?: string, alert = false) => {
      if (!onDashboard || !web) return;
      const cards = cardsLeft();
      // Asked for in a thread: the answer goes back there, whatever it is. The result of your decision
      // belongs with the job: a reply under its summary when it went fine. A problem, a failure or new
      // cards get a message of their own, so they notify.
      const followUp = !askedIn && text.trim().startsWith('✅') && !cards ? followUpOf() : undefined;
      // That summary may be days old, and a reply under a bot message notifies no one who doesn't follow
      // its thread: mention the person who decided (or the owner). A reply where they asked notifies them.
      // A run that timed out or failed (`alert`) mentions them too: it must never go unnoticed.
      const mention = followUp || alert ? streamRecipient(trigger, project.config.owner) : undefined;
      await postSummary({
        chat,
        store,
        web,
        log,
        slackChannel,
        thread: { channel, ts: rootTs },
        title,
        text,
        meta,
        link: deps.threadUrl?.(channel, rootTs),
        since: startedAt,
        cards,
        approvalsUrl: deps.approvalsUrl,
        replyIn: askedIn ?? followUp,
        mention: mention && SLACK_USER.test(mention) ? mention : undefined,
      });
    };
    /**
     * The Slack summary a follow-up belongs under: the run's own (continuing after a decision), the run
     * whose card it acts on, or the run that proposed its queue items.
     */
    const followUpOf = (): string | undefined => {
      if (trigger.kind === 'resume') return slackSummaryOf(store, slackChannel, channel, rootTs);
      if (trigger.kind === 'decision')
        return slackSummaryOf(store, slackChannel, trigger.from.channel, trigger.from.threadTs);
      if (trigger.kind === 'queue')
        for (const item of trigger.items) {
          const at =
            item.channel && item.threadTs
              ? slackSummaryOf(store, slackChannel, item.channel, item.threadTs)
              : undefined;
          if (at) return at;
        }
      return undefined;
    };
    /**
     * Acting on an approved card and stopped before it finished: the card turns failed and a "Not
     * finished" card goes in this thread, so the summary below counts it and copies it to Slack.
     */
    const approvedCard =
      (trigger.kind === 'decision' || trigger.kind === 'resume') && trigger.card && !trigger.card.declined
        ? trigger.card
        : undefined;
    const raiseUnfinished = async (reason: string) => {
      if (!approvedCard || !deps.unfinished) return;
      await deps.unfinished({
        project: project.config.name,
        jobId: job.id,
        card: approvedCard,
        reason,
        thread: { channel, threadTs: rootTs },
        link: deps.threadUrl?.(channel, rootTs),
      });
    };
    /** Cards this run left waiting on the Approvals page (approvals and drafts). */
    const cardsLeft = () =>
      store
        .itemsInThread(channel, rootTs, 200)
        .filter((i) => i.status === 'pending' && i.createdAt >= startedAt).length;
    // The latest text block reaches the thread once the next step starts; the final one when the run
    // ends, so the thread always holds Claude's whole reply.
    let block = '';
    const flushBlock = () => {
      if (!block) return;
      live?.textBreak();
      live?.text(block);
      block = '';
    };

    const mcpServers = expandMcpServers(job.mcpServers, env);
    // A fresh session starts from the project memory; a resumed one has it already.
    const withMemory = (prompt: string) => {
      const memory = memoryBlock(project, store, { now: now(), timeZone: deps.host.timezone });
      return memory ? `${memory}\n\n${prompt}` : prompt;
    };
    // Steps run first (not when continuing after a decision or running queue items), each in its own session.
    let stepsDone: StepsResult | undefined;
    if (
      job.steps.length &&
      trigger.kind !== 'resume' &&
      trigger.kind !== 'decision' &&
      trigger.kind !== 'queue'
    ) {
      stepsDone = await runSteps({
        host: deps.host,
        run: deps.run,
        project,
        job,
        harness,
        env,
        folders,
        mcpServers,
        signal: stop,
        deadline,
        onStep: (i, name) => status.push(`⏳ ${title} · step ${i}/${job.steps.length}: ${name}`),
        fallback,
        onFallback: (note) => {
          fallbackNotes.push(note);
          log.warn(`[${project.config.name}] job ${job.id}: ${note}`);
        },
      });
      // A step found the harness unavailable: the main session starts on the fallback too.
      if (fallback && stepsDone.harness === fallback.harness && harness !== fallback.harness) {
        harness = fallback.harness;
        session = { ...session, harness, model: fallback.model };
        store.saveSession(session);
      }
      if (stop.aborted) {
        await status.flush();
        await chat.update(channel, statusTs, `${title} · ⏹ stopped`);
        return record('aborted');
      }
    }

    // Jobs get approval buttons and file uploads, never permission prompts: nobody is there to answer.
    const bridgeContext: RunContext = {
      project,
      channel,
      threadTs: rootTs,
      kind: 'job',
      permissionPrompts: false,
      jobId: job.id,
      items: trigger.kind === 'queue' ? trigger.items.map((i) => i.id) : undefined,
    };
    const bridged = deps.bridge?.open(bridgeContext);
    const appendSystemPrompt = [
      identityPrompt(deps.host.agentName),
      JOB_SYSTEM_PROMPT,
      bridged && deps.bridge?.prompt(),
      project.systemPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
    const allowedTools = job.allowedTools ?? project.config.allowedTools;
    const runMain = (): Promise<RunOutcome> => {
      const agy =
        harness === 'agy'
          ? buildAgyArgs({
              conversationId: resuming ? session.sessionId : undefined,
              model: session.model,
              permissionMode: project.config.permissionMode,
              permissions: job.agyPermissions,
              timeoutMs: mainTimeoutMs(),
            })
          : undefined;
      return deps.run({
        harness,
        bin: agy ? deps.host.agy.bin : deps.host.claude.bin,
        args:
          agy?.args ??
          buildClaudeArgs({
            sessionId: session.sessionId,
            resume: resuming,
            permissionMode: project.config.permissionMode,
            model: session.model,
            effort: job.effort ?? deps.host.claude.effort,
            allowedTools,
            mcpConfig: bridged?.mcpConfigPath,
            partialMessages: Boolean(live),
            maxBudgetUsd: job.budgetUsd,
          }),
        agy: agy && { mcpConfig: bridged?.mcpConfigPath, settings: agy.settings },
        mcpServers,
        cwd: project.dir,
        env,
        systemPrompt: appendSystemPrompt,
        prompt:
          trigger.kind === 'resume'
            ? handoff && card
              ? withMemory(buildHandoffPrompt(job, ranOn, card, trigger.text, folders))
              : job.handoff && card && harness === job.handoff.harness
                ? decisionWithCard(card, trigger.text)
                : trigger.text
            : trigger.kind === 'decision'
              ? withMemory(
                  buildDecisionPrompt(trigger.card, trigger.text, {
                    job,
                    earlier: from && {
                      url: deps.threadUrl?.(from.channel, from.threadTs),
                      sessionId: origin?.sessionId,
                      harness: origin?.harness,
                    },
                    folders,
                  }),
                )
              : withMemory(
                  buildJobPrompt(
                    job,
                    folders,
                    trigger.kind === 'queue' ? trigger.items : undefined,
                    [gateText, stepsDone?.section].filter(Boolean).join('\n\n') || undefined,
                  ),
                ),
        timeoutMs: mainTimeoutMs(),
        signal: stop,
        label: {
          project: project.config.name,
          kind: 'job',
          title: job.name,
          thread: { channel, ts: rootTs },
          jobId: job.id,
        },
        onEvent: (event) => {
          if (event.kind === 'init' && !session.started) {
            // agy picks its own conversation id; Claude echoes the one it was given.
            session = { ...session, sessionId: event.sessionId || session.sessionId, started: true };
            store.saveSession(session);
          }
          if ('parent' in event && event.parent) return;
          if (event.kind === 'tool') {
            flushBlock();
            steps++;
            status.push(`⏳ ${title} · step ${steps}\n> ${event.status}`);
            live?.toolStart(event.id, event.status);
          } else if (event.kind === 'tool_result') {
            if (event.isError) toolErrors++;
            live?.toolEnd(event.id, !event.isError);
          } else if (event.kind === 'text_start') flushBlock();
          else if (event.kind === 'text' && live) block += event.text;
        },
      });
    };
    let outcome: RunOutcome;
    try {
      outcome = await runMain();
      if (fallback && harness !== fallback.harness && !stop.aborted && harnessUnavailable(outcome)) {
        const note = fallbackNote('The run', harness, fallback, outcome);
        fallbackNotes.push(note);
        log.warn(`[${project.config.name}] job ${job.id}: ${note}`);
        status.push(`⏳ ${title} · ${harness} unavailable, running on ${fallback.harness}`);
        flushBlock();
        // A fresh session on the fallback, in the same scratch folder (the steps' files are there).
        harness = fallback.harness;
        session = {
          threadKey: key,
          project: project.config.name,
          sessionId: (deps.newSessionId ?? randomUUID)(),
          model: fallback.model,
          started: false,
          harness,
          scratchId,
        };
        store.saveSession(session);
        outcome = await runMain();
      }
    } finally {
      bridged?.dispose();
    }
    await status.flush();

    /**
     * Sets up this run's learning turns (`selfImprove`): one for the main session and one for each
     * step's session. They run once the job's locks are released.
     */
    const learnIf = (failure: string | undefined, threadTs: string) => {
      // Learning turns resume the session with Claude, so agy runs don't get one.
      if (harness !== 'claude') return;
      const mode = job.selfImprove ?? project.config.selfImprove;
      // The whole run (steps and the main session) against the job's usual scheduled run. A run after a
      // card or for queue items does other work than the scheduled one, so it isn't compared.
      const main = runUse(outcome);
      const whole = stepsDone && {
        costUsd:
          outcome.costUsd === undefined && stepsDone.costUsd === undefined
            ? undefined
            : (outcome.costUsd ?? 0) + (stepsDone.costUsd ?? 0),
        inputTokens:
          main.inputTokens +
          stepsDone.usage.input +
          stepsDone.usage.cacheRead +
          stepsDone.usage.cacheCreation,
        outputTokens: main.outputTokens + stepsDone.usage.output,
        toolCalls: main.toolCalls + stepsDone.toolCalls,
        durationMs: main.durationMs + stepsDone.durationMs,
      };
      const typical =
        trigger.kind === 'resume' || trigger.kind === 'decision' || trigger.kind === 'queue'
          ? undefined
          : typicalRun(store.jobRuns(project.config.name, job.id, 60), now());
      const common = {
        project,
        env,
        mcpServers,
        channel,
        threadTs,
        threadKey: threadTs ? key : undefined,
        jobId: job.id,
      };
      const reasons = learnReasons(mode, outcome, toolErrors, failure);
      if (reasons)
        lessons.push({
          ...common,
          sessionId: outcome.sessionId ?? session.sessionId,
          model: session.model,
          appendSystemPrompt,
          bridge: bridged ? bridgeContext : undefined,
          allowedTools,
          reasons,
          label: `*${job.name}*`,
          effort: job.effort,
          usage: { session: main, run: whole, typical },
        });
      for (const step of stepsDone?.sessions ?? []) {
        if (step.harness !== 'claude') continue;
        const stepReasons = learnReasons(mode, step.outcome, step.toolErrors);
        if (!stepReasons) continue;
        lessons.push({
          ...common,
          sessionId: step.sessionId,
          model: step.model,
          appendSystemPrompt: step.systemPrompt,
          allowedTools: step.allowedTools,
          reasons: stepReasons,
          label: `*${job.name}* · step "${step.name}"`,
          effort: step.effort,
          step: step.name,
          priorCostUsd: step.outcome.costUsd,
          usage: { session: runUse(step.outcome), run: whole, typical },
        });
      }
    };

    const usage = {
      sessionId: outcome.sessionId ?? session.sessionId,
      model: outcome.model ?? session.model,
      threadKey: key,
      costUsd: outcome.costUsd,
      // Steps count towards the run: each is a fresh session, so its whole cost is this run's.
      extraCostUsd: stepsDone?.costUsd,
      inputTokens: sum(outcome.usage?.input, stepsDone?.usage.input),
      outputTokens: sum(outcome.usage?.output, stepsDone?.usage.output),
      cacheReadTokens: sum(outcome.usage?.cacheRead, stepsDone?.usage.cacheRead),
      cacheCreationTokens: sum(outcome.usage?.cacheCreation, stepsDone?.usage.cacheCreation),
      // The main session only: what a card it raised would continue in.
      contextTokens: outcome.contextTokens,
      toolCalls: outcome.toolCalls + (stepsDone?.toolCalls ?? 0),
      rateLimitUtilization: outcome.rateLimit?.utilization,
    };
    const meta = [
      formatDuration(outcome.durationMs),
      `${outcome.toolCalls} ${outcome.toolCalls === 1 ? 'step' : 'steps'}`,
    ]
      .concat(outcome.model ? [outcome.model] : [])
      .join(' · ');

    if (outcome.status === 'limit') {
      const resetAt = limitResetAt(outcome, deps.host.timezone, now());
      deps.holds?.hit(harness, resetAt);
      log.warn(
        `[${project.config.name}] ${harness} usage limit: scheduled runs on it wait until ${new Date(resetAt).toISOString()}`,
      );
    }
    if (outcome.status !== 'ok') {
      const reason =
        outcome.status === 'limit'
          ? `⏸ skipped: ${harness === 'agy' ? 'agy (Google) quota' : 'Claude usage limit'} reached`
          : outcome.status === 'timeout'
            ? `⌛ timed out after ${formatDuration(outcome.durationMs)}`
            : outcome.status === 'aborted'
              ? '⏹ stopped'
              : outcome.status === 'over-budget'
                ? `💸 ${(outcome.error ?? 'stopped at its budget').replace(/^Stopped/, 'stopped')}`
                : `❌ failed: ${(outcome.error ?? 'unknown error').slice(0, 500)}`;
      await chat.update(channel, statusTs, `${title} · ${reason}`);
      flushBlock();
      await live?.finish({ summary: reason, ok: false, answer: '', notes: fallbackNotes });
      if (!live) for (const note of fallbackNotes) await chat.post(channel, rootTs, note);
      // Not streamed: what Claude wrote before it stopped still goes in the thread, to debug the run.
      if (!live && outcome.text.trim()) await postMarkdown(chat, channel, rootTs, outcome.text);
      // A run a person stopped needs no message; anything else that broke does ("⌛ Timed out after 30m").
      // A usage limit or a lost login hits every run at once: one message for all of them.
      if (outcome.status !== 'aborted') await raiseUnfinished(reason.replace(/^\S+\s+/, ''));
      const incident = onDashboard && deps.incidents ? incidentOf(outcome, harness) : undefined;
      if (incident) await deps.incidents?.report(slackChannel, incident, job.name);
      else if (outcome.status !== 'aborted') {
        await summarize(
          reason.replace(/^(\S+ )(\p{Ll})/u, (_, icon: string, c: string) => icon + c.toUpperCase()),
          formatDuration(outcome.durationMs),
          true,
        );
        // A Slack-thread run has no summary: the edited status line notifies no one, so say it to them.
        const who = streamRecipient(trigger, project.config.owner);
        if (!onDashboard && who && SLACK_USER.test(who))
          await chat
            .post(channel, rootTs, `<@${who}> ${title} · ${reason}`)
            .catch((err: Error) => log.warn(`could not mention the failure: ${err.message}`));
      }
      learnIf(undefined, rootTs);
      return record(outcome.status, { ...usage, error: outcome.error, output: outcome.text });
    }

    if (!outcome.text.trim()) {
      // No reply at all. The thread still says so in words (never left empty), with the steps the run
      // took and its session above it, to see what it checked and to ask about it.
      const said = `🔇 Claude finished without a written reply · ${meta}`;
      // Streamed, the step list below has the numbers; without it the status line keeps them.
      await chat.update(channel, statusTs, `🔇 ${title}${live ? '' : ` · ${meta}`} · nothing to report`);
      flushBlock();
      if (live)
        await live.finish({
          summary: `🔇 Nothing to report · ${meta}`,
          ok: true,
          answer: null,
          notes: [...fallbackNotes, said],
        });
      else for (const note of [...fallbackNotes, said]) await chat.post(channel, rootTs, note);
      await deps.incidents?.resolve(harness);
      // No reply, but cards: they still need you. Asked for in a thread: it says so there.
      const cards = cardsLeft();
      if (cards || askedIn)
        await summarize(
          cards ? `Left ${cards} ${cards === 1 ? 'card' : 'cards'} for you` : '🔇 Nothing to report',
          formatDuration(outcome.durationMs),
        );
      learnIf(undefined, rootTs);
      return record('silent', { ...usage, output: outcome.text });
    }

    const failure = failedReply(outcome.text);
    const icon = failure ? '❌' : '✅';
    // Just the outcome: Claude's reply follows in full below (so no headline), and when streamed the step
    // list holds the time, steps and model (so no numbers either). Without a stream it keeps the numbers.
    await chat.update(channel, statusTs, `${icon} ${title}${live ? '' : ` · ${meta}`}`);
    // Claude's whole reply, exactly as written, always goes in the thread: it is the run's audit log.
    if (live) {
      flushBlock();
      await live.finish({
        summary: failure ? `❌ Failed · ${meta}` : `✅ Done · ${meta}`,
        ok: !failure,
        answer: outcome.text,
        notes: fallbackNotes,
      });
    } else {
      for (const note of fallbackNotes) await chat.post(channel, rootTs, note);
      await postMarkdown(chat, channel, rootTs, outcome.text);
    }
    await deps.incidents?.resolve(harness);
    if (failure) await raiseUnfinished(`it reported a failure: ${failure.split('\n')[0]?.slice(0, 300)}`);
    // Slack gets the time only: steps and model are on the dashboard.
    await summarize(outcome.text, formatDuration(outcome.durationMs), Boolean(failure));
    learnIf(failure, rootTs);
    return record(failure ? 'failed' : 'ok', { ...usage, error: failure, output: outcome.text });
  } catch (err) {
    log.error(`[${project.config.name}] job ${job.id} crashed: ${(err as Error).stack ?? err}`);
    return record('error', { error: (err as Error).message });
  } finally {
    // The job's work is done: its locks and slot go to the next job. Learning turns (up to 5 minutes
    // each) run after, outside jobConcurrency, still holding the thread they resume.
    releaseLocks();
    releaseSlot();
    try {
      for (const lesson of lessons) await learnFromRun(deps, lesson);
    } finally {
      hold?.release();
    }
  }
}
