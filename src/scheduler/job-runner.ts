import { randomUUID } from 'node:crypto';
import { BRIDGE_PROMPT, type Bridge, type RunContext } from '../bridge/bridge.js';
import type { HostConfig, ScheduledJob } from '../config/schema.js';
import { buildClaudeArgs } from '../runner/args.js';
import { buildChildEnv } from '../runner/env.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import { jobDataDir, sessionScratch } from '../runner/workspace.js';
import { type LearnRequest, learnFromRun, troubleReasons } from '../sessions/learn.js';
import { type ChatPort, type Logger, threadKey } from '../sessions/manager.js';
import { formatDuration, splitMessage, toSlackMrkdwn } from '../slack/format.js';
import { StreamReply } from '../slack/reply.js';
import type { RunRecord, Store } from '../store/store.js';
import { type Locks, type Semaphore, Throttle } from '../util/concurrency.js';
import {
  buildJobPrompt,
  cronFailure,
  identityPrompt,
  isSilentReply,
  JOB_SYSTEM_PROMPT,
  parseWakeGate,
  splitHeadline,
} from './prompt.js';
import { runScript, type ScriptResult } from './script.js';

export type JobTrigger =
  | { kind: 'schedule' }
  | { kind: 'catch-up' }
  /** `thread`: the chat message that asked for the run; the run then happens in its thread. */
  | { kind: 'manual'; by: string; thread?: { channel: string; ts: string } };

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
  bridge?: Bridge;
  env?: NodeJS.ProcessEnv;
  runScript?: typeof runScript;
  newSessionId?: () => string;
  now?: () => number;
}

const SLACK_USER = /^[UW][A-Z0-9]+$/;

/**
 * Who a run streams live to. Scheduled runs don't stream (nobody is waiting); a run someone started
 * streams to them, or to the project owner when it came from the API or a dashboard.
 */
export function streamRecipient(trigger: JobTrigger, owner: string | undefined): string | undefined {
  if (trigger.kind !== 'manual') return undefined;
  return SLACK_USER.test(trigger.by) ? trigger.by : owner;
}

function triggerLabel(trigger: JobTrigger): string {
  if (trigger.kind === 'catch-up') return ' (catch-up)';
  if (trigger.kind === 'manual') {
    return ` (run by ${/^[UW][A-Z0-9]+$/.test(trigger.by) ? `<@${trigger.by}>` : trigger.by})`;
  }
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
  // Asked for in chat: run inside that message's thread instead of posting a new channel message.
  const requestTs =
    trigger.kind === 'manual' && trigger.thread?.channel === channel ? trigger.thread.ts : undefined;
  const postMain = (text: string) => chat.post(channel, requestTs, text);
  if (requestTs) await chat.react(channel, requestTs, 'eyes').catch(() => {});

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

    if (job.preScript) {
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
        const icon = script.ok ? '✅' : '❌';
        const meta = formatDuration(now() - startedAt);
        await postMain(`${icon} ${title} · ${meta}\n\`\`\`\n${script.output.slice(0, 3_000)}\n\`\`\``);
        return record(script.ok ? 'ok' : 'failed', {
          error: script.ok ? undefined : script.output.slice(-500),
        });
      }
    }

    // The job's thread: the requester's message, or a new channel message. The status line (⏳ → ✅
    // with the headline) is that channel message, or the first reply in the requester's thread.
    const statusTs = await postMain(`⏳ ${title}`);
    const rootTs = requestTs ?? statusTs;
    const key = threadKey(channel, rootTs);
    let session = {
      threadKey: key,
      project: project.config.name,
      sessionId: (deps.newSessionId ?? randomUUID)(),
      model: job.model,
      started: false,
    };
    store.saveSession(session);
    // Made only now, when the model runs: gate-skipped runs leave no empty folders behind.
    const folders = {
      scratch: sessionScratch(project, stateDir, job.id, session.sessionId),
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

    // Jobs get approval buttons and file uploads, never permission prompts: nobody is watching live.
    const bridgeContext: RunContext = {
      project,
      channel,
      threadTs: rootTs,
      kind: 'job',
      permissionPrompts: false,
    };
    const bridged = deps.bridge?.open(bridgeContext);
    const appendSystemPrompt = [
      identityPrompt(deps.host.agentName),
      JOB_SYSTEM_PROMPT,
      bridged && BRIDGE_PROMPT,
      project.systemPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
    const allowedTools = job.allowedTools ?? project.config.allowedTools;
    const outcome: RunOutcome = await deps
      .run({
        bin: deps.host.claude.bin,
        args: buildClaudeArgs({
          sessionId: session.sessionId,
          resume: false,
          permissionMode: project.config.permissionMode,
          model: job.model,
          effort: deps.host.claude.effort,
          appendSystemPrompt,
          allowedTools,
          mcpConfig: bridged?.mcpConfigPath,
          partialMessages: Boolean(live),
        }),
        cwd: project.dir,
        env,
        prompt: buildJobPrompt(job, script, folders),
        timeoutMs,
        signal,
        onEvent: (event) => {
          if (event.kind === 'init' && !session.started) {
            session = { ...session, started: true };
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
      if (!project.config.selfImprove || !reasons.length) return;
      lesson = {
        project,
        sessionId: outcome.sessionId ?? session.sessionId,
        model: job.model,
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
      inputTokens: outcome.usage?.input,
      outputTokens: outcome.usage?.output,
      cacheReadTokens: outcome.usage?.cacheRead,
      cacheCreationTokens: outcome.usage?.cacheCreation,
      toolCalls: outcome.toolCalls,
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
          ? '⏸ skipped: Claude usage limit reached'
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
      if (requestTs) {
        // The requester's thread stays (and its session, for follow-up questions).
        await chat.update(channel, statusTs, `🔇 ${title} · nothing to report`);
      } else {
        await chat
          .delete(channel, rootTs)
          .catch(() => chat.update(channel, rootTs, `🔇 ${title} · nothing to report`));
        store.deleteSession(key);
      }
      learnIf(undefined, requestTs);
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
    releaseSlot();
  }
}
