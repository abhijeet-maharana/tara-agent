import { randomUUID } from 'node:crypto';
import type { Bridge, RunContext } from '../bridge/bridge.js';
import type { HostConfig, ScheduledJob } from '../config/schema.js';
import { buildAgyArgs } from '../runner/agy.js';
import { buildClaudeArgs } from '../runner/args.js';
import { buildChildEnv } from '../runner/env.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import { jobDataDir, sessionScratch } from '../runner/workspace.js';
import { type LearnRequest, learnFromRun, troubleReasons } from '../sessions/learn.js';
import { type ChatPort, type Logger, threadKey } from '../sessions/manager.js';
import type { ThreadHold, Threads } from '../sessions/threads.js';
import { formatDuration, splitMessage, toSlackMrkdwn } from '../slack/format.js';
import { StreamReply } from '../slack/reply.js';
import type { Item, RunRecord, Store } from '../store/store.js';
import { type Locks, type Semaphore, Throttle } from '../util/concurrency.js';
import {
  buildHandoffPrompt,
  buildJobPrompt,
  cronFailure,
  type DecidedCard,
  decisionWithCard,
  identityPrompt,
  isSilentReply,
  JOB_SYSTEM_PROMPT,
  parseWakeGate,
  splitHeadline,
} from './prompt.js';
import { runScript, type ScriptResult } from './script.js';
import { expandMcpServers, runSteps, type StepsResult } from './steps.js';

export type JobTrigger =
  | { kind: 'schedule' }
  | { kind: 'catch-up' }
  /** `thread`: the chat message that asked for the run; the run then happens in its thread. */
  | { kind: 'manual'; by: string; thread?: { channel: string; ts: string } }
  /** A decision on the run's approval card: the same session continues in its thread. */
  | { kind: 'resume'; by: string; threadTs: string; text: string; card?: DecidedCard }
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
};

/** How a run ended; stored on the slot claim and in the run log. */
export type JobStatus = 'ok' | 'silent' | 'failed' | 'error' | 'timeout' | 'limit' | 'aborted';

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
  runScript?: typeof runScript;
  newSessionId?: () => string;
  now?: () => number;
}

const SLACK_USER = /^[UW][A-Z0-9]+$/;

/** Adds token counts; unset when neither is known. */
const sum = (a?: number, b?: number) => (a === undefined && !b ? a : (a ?? 0) + (b ?? 0));

/**
 * Who a run's live thread is addressed to (Slack's streaming API needs a recipient). Every run streams
 * its steps into its thread: to whoever started or continued it in Slack, else the project owner.
 */
export function streamRecipient(trigger: JobTrigger, owner: string | undefined): string | undefined {
  const by = trigger.kind === 'manual' || trigger.kind === 'resume' ? trigger.by : undefined;
  return by && SLACK_USER.test(by) ? by : owner;
}

function triggerLabel(trigger: JobTrigger): string {
  if (trigger.kind === 'catch-up') return ' (catch-up)';
  if (trigger.kind === 'manual') {
    return ` (run by ${/^[UW][A-Z0-9]+$/.test(trigger.by) ? `<@${trigger.by}>` : trigger.by})`;
  }
  if (trigger.kind === 'resume') return ' (continuing after your decision)';
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
): Promise<JobStatus> {
  const { project, job } = scheduled;
  const { chat, store, log } = deps;
  const now = deps.now ?? Date.now;
  const channel = job.channel ?? project.config.slackChannel;
  const title = `*${job.name}*${triggerLabel(trigger)}`;
  const timeoutMs = job.timeoutMinutes * 60_000;
  // Asked for in chat, or running cards that share a Slack thread (a `slack` queue): run inside that
  // thread instead of posting a new channel message.
  const cardThread =
    trigger.kind === 'queue' &&
    trigger.items.every(
      (i) => i.channel === channel && i.messageTs && i.threadTs === trigger.items[0]?.threadTs,
    )
      ? trigger.items[0]?.threadTs
      : undefined;
  const requestTs =
    trigger.kind === 'manual' && trigger.thread?.channel === channel ? trigger.thread.ts : cardThread;
  // The thread the run posts in: the requester's message, or (continuing) the job's earlier thread.
  const inThread = trigger.kind === 'resume' ? trigger.threadTs : requestTs;
  const postMain = (text: string) => chat.post(channel, inThread, text);
  if (requestTs) await chat.react(channel, requestTs, 'eyes').catch(() => {});

  // An existing thread may have a chat turn in it: wait for it before taking a slot and locks.
  let hold: ThreadHold | undefined = inThread
    ? await deps.threads.enter(threadKey(channel, inThread))
    : undefined;
  const releaseSlot = await deps.slots.acquire();
  const releaseLocks = await deps.locks.acquire(job.locks);
  const startedAt = now();
  let script: ScriptResult | undefined;
  let lesson: LearnRequest | undefined;
  const record = (status: JobStatus, extra: Partial<RunRecord> = {}) => {
    store.recordRun({
      kind: 'job',
      project: project.config.name,
      jobId: job.id,
      startedAt,
      endedAt: now(),
      status,
      scriptOutput: script?.output,
      ...extra,
    });
    log.info(`[${project.config.name}] job ${job.id} ${status} in ${formatDuration(now() - startedAt)}`);
    if (requestTs) {
      void chat
        .unreact(channel, requestTs, 'eyes')
        .catch(() => {})
        .then(() => chat.react(channel, requestTs, REACTIONS[status]))
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
    } catch (err) {
      await postMain(`❌ ${title} could not start: ${(err as Error).message}`);
      return record('error', { error: (err as Error).message });
    }

    // A queue already decided what to run, and a continued run is past its gate.
    if (job.preScript && trigger.kind !== 'resume' && trigger.kind !== 'queue') {
      script = await (deps.runScript ?? runScript)(job.preScript, project.dir, env, timeoutMs, signal);
      if (signal?.aborted) return record('aborted');
      if (script.ok && (!script.output.trim() || !parseWakeGate(script.output))) {
        // Someone asked for this run: say why nothing happened instead of staying silent.
        if (requestTs) {
          const reason = script.output.split('\n').find((l) => l.trim() && !l.includes('wakeAgent'));
          await postMain(
            `🔇 ${title}: nothing to do right now.${reason ? `\n> ${reason.trim().slice(0, 300)}` : ''}`,
          );
        }
        return record('silent');
      }
      if (!job.agent) {
        // The result line in the channel, the script's output in its thread.
        const icon = script.ok ? '✅' : '❌';
        const meta = formatDuration(now() - startedAt);
        const ts = await postMain(`${icon} ${title} · ${meta}`);
        if (script.output.trim())
          await chat.post(channel, inThread ?? ts, `\`\`\`\n${script.output.slice(0, 3_000)}\n\`\`\``);
        return record(script.ok ? 'ok' : 'failed', {
          error: script.ok ? undefined : script.output.slice(-500),
        });
      }
    }

    // The job's thread: the requester's message, or a new channel message. The status line (⏳ → ✅
    // with the headline) is that channel message, or the first reply in the requester's thread.
    const statusTs = await postMain(`⏳ ${title}`);
    const rootTs = inThread ?? statusTs;
    const key = threadKey(channel, rootTs);
    // Holding the thread makes replies wait for this run, and lets "stop" in the thread end it.
    hold ??= await deps.threads.enter(key);
    const stop = signal ? AbortSignal.any([signal, hold.signal]) : hold.signal;
    const earlier = trigger.kind === 'resume' ? store.getSession(key) : undefined;
    if (trigger.kind === 'resume' && !earlier?.started) {
      await chat.update(channel, statusTs, `❌ ${title}: the run's session is gone, so it can't continue`);
      return record('error', { error: 'no session to continue' });
    }
    const newId = (deps.newSessionId ?? randomUUID)();
    let session = earlier ?? {
      threadKey: key,
      project: project.config.name,
      sessionId: newId,
      model: job.model,
      started: false,
      harness: job.harness,
      scratchId: newId,
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
    const harness = session.harness ?? 'claude';
    const resuming = trigger.kind === 'resume' && !handoff;
    store.saveSession(session);
    // Made only now, when the model runs: gate-skipped runs leave no empty folders behind.
    const folders = {
      scratch: sessionScratch(project, stateDir, job.id, scratchId),
      jobData: env.TARA_JOB_DATA,
    };
    env = { ...env, TARA_SCRATCH: folders.scratch };
    let steps = 0;
    let toolErrors = 0;
    const intervalMs = deps.host.statusIntervalSeconds * 1000;
    const status = new Throttle<string>(intervalMs, (text) => chat.update(channel, statusTs, text));
    const recipient = streamRecipient(trigger, project.config.owner);
    const live =
      recipient && chat.stream && !chat.stream.disabled
        ? new StreamReply(chat, chat.stream, channel, rootTs, recipient, false, Math.min(intervalMs, 1000))
        : undefined;

    const mcpServers = expandMcpServers(job.mcpServers, env);
    // Steps run first (not when continuing after a decision or running queue items), each in its own session.
    let stepsDone: StepsResult | undefined;
    if (job.steps.length && trigger.kind !== 'resume' && trigger.kind !== 'queue') {
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
        onStep: (i, name) => status.push(`⏳ ${title} · step ${i}/${job.steps.length}: ${name}`),
      });
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
    const agy =
      harness === 'agy'
        ? buildAgyArgs({
            conversationId: resuming ? session.sessionId : undefined,
            model: session.model,
            permissionMode: project.config.permissionMode,
            permissions: job.agyPermissions,
            timeoutMs,
          })
        : undefined;
    const outcome: RunOutcome = await deps
      .run({
        harness,
        bin: agy ? deps.host.agy.bin : deps.host.claude.bin,
        args:
          agy?.args ??
          buildClaudeArgs({
            sessionId: session.sessionId,
            resume: resuming,
            permissionMode: project.config.permissionMode,
            model: session.model,
            effort: deps.host.claude.effort,
            allowedTools,
            mcpConfig: bridged?.mcpConfigPath,
            partialMessages: Boolean(live),
          }),
        agy: agy && { mcpConfig: bridged?.mcpConfigPath, settings: agy.settings },
        mcpServers,
        cwd: project.dir,
        env,
        systemPrompt: appendSystemPrompt,
        prompt:
          trigger.kind === 'resume'
            ? handoff && card
              ? buildHandoffPrompt(job, ranOn, card, trigger.text, folders)
              : job.handoff && card && harness === job.handoff.harness
                ? decisionWithCard(card, trigger.text)
                : trigger.text
            : buildJobPrompt(
                job,
                script,
                folders,
                trigger.kind === 'queue' ? trigger.items : undefined,
                stepsDone?.section,
              ),
        timeoutMs,
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
            steps++;
            status.push(`⏳ ${title} · step ${steps}\n> ${event.status}`);
            live?.toolStart(event.id, event.status);
          } else if (event.kind === 'tool_result') {
            if (event.isError) toolErrors++;
            live?.toolEnd(event.id, !event.isError);
          } else if (event.kind === 'text_start') live?.textBreak();
          else if (event.kind === 'text') live?.text(event.text);
        },
      })
      .finally(() => bridged?.dispose());
    await status.flush();

    /** Sets up a learning turn when this run had trouble; it runs once the job's locks are released. */
    const learnIf = (failure: string | undefined, threadTs: string | undefined) => {
      const reasons = troubleReasons(outcome, toolErrors, failure);
      // Learning turns resume the session with Claude, so agy runs don't get one.
      if (!project.config.selfImprove || harness !== 'claude' || !reasons.length) return;
      lesson = {
        project,
        sessionId: outcome.sessionId ?? session.sessionId,
        model: session.model,
        appendSystemPrompt,
        bridge: bridged ? bridgeContext : undefined,
        allowedTools,
        env,
        reasons,
        channel,
        threadTs,
        threadKey: threadTs ? key : undefined,
        jobId: job.id,
        label: `*${job.name}*`,
      };
    };

    const usage = {
      sessionId: outcome.sessionId ?? session.sessionId,
      model: outcome.model ?? job.model,
      threadKey: key,
      costUsd: outcome.costUsd,
      // Steps count towards the run.
      inputTokens: sum(outcome.usage?.input, stepsDone?.usage.input),
      outputTokens: sum(outcome.usage?.output, stepsDone?.usage.output),
      cacheReadTokens: sum(outcome.usage?.cacheRead, stepsDone?.usage.cacheRead),
      cacheCreationTokens: sum(outcome.usage?.cacheCreation, stepsDone?.usage.cacheCreation),
      toolCalls: outcome.toolCalls + (stepsDone?.toolCalls ?? 0),
      rateLimitUtilization: outcome.rateLimit?.utilization,
    };
    const meta = [
      formatDuration(outcome.durationMs),
      `${outcome.toolCalls} ${outcome.toolCalls === 1 ? 'step' : 'steps'}`,
    ]
      .concat(outcome.model ? [outcome.model] : [])
      .join(' · ');

    if (outcome.status !== 'ok') {
      const reason =
        outcome.status === 'limit'
          ? `⏸ skipped: ${harness === 'agy' ? 'agy (Google) quota' : 'Claude usage limit'} reached`
          : outcome.status === 'timeout'
            ? `⌛ timed out after ${formatDuration(outcome.durationMs)}`
            : outcome.status === 'aborted'
              ? '⏹ stopped'
              : `❌ failed: ${(outcome.error ?? 'unknown error').slice(0, 500)}`;
      await chat.update(channel, statusTs, `${title} · ${reason}`);
      await live?.finish({ summary: reason, ok: false, answer: '', notes: [] });
      learnIf(undefined, rootTs);
      return record(outcome.status, { ...usage, error: outcome.error, output: outcome.text });
    }

    if (isSilentReply(outcome.text)) {
      await live?.discard();
      if (inThread) {
        // The requester's thread stays (and its session, for follow-up questions).
        await chat.update(channel, statusTs, `🔇 ${title} · nothing to report`);
      } else {
        await chat
          .delete(channel, rootTs)
          .catch(() => chat.update(channel, rootTs, `🔇 ${title} · nothing to report`));
        store.deleteSession(key);
      }
      learnIf(undefined, inThread);
      return record('silent', { ...usage, output: outcome.text });
    }

    const failure = cronFailure(outcome.text);
    const { headline, details } = failure
      ? { headline: failure.split('\n')[0] ?? '', details: failure }
      : splitHeadline(outcome.text);
    const icon = failure ? '❌' : '✅';
    await chat.update(channel, statusTs, `${icon} ${title} · ${meta}\n${toSlackMrkdwn(headline)}`);
    if (live) {
      // The whole reply was streamed into the thread already.
      await live.finish({
        summary: failure ? `❌ ${headline}` : `✅ Done · ${meta}`,
        ok: !failure,
        answer: outcome.text,
        notes: [],
      });
    } else if (details) {
      for (const chunk of splitMessage(toSlackMrkdwn(details))) await chat.post(channel, rootTs, chunk);
    }
    learnIf(failure, rootTs);
    return record(failure ? 'failed' : 'ok', { ...usage, error: failure, output: outcome.text });
  } catch (err) {
    log.error(`[${project.config.name}] job ${job.id} crashed: ${(err as Error).stack ?? err}`);
    return record('error', { error: (err as Error).message });
  } finally {
    releaseLocks();
    // Still inside the job slot, so learning turns count towards jobConcurrency.
    if (lesson) await learnFromRun(deps, lesson);
    hold?.release();
    releaseSlot();
  }
}
