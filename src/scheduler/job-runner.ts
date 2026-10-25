import { randomUUID } from 'node:crypto';
import { BRIDGE_PROMPT, type Bridge } from '../bridge/bridge.js';
import type { HostConfig, ScheduledJob } from '../config/schema.js';
import { buildClaudeArgs } from '../runner/args.js';
import { buildChildEnv } from '../runner/env.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import { type ChatPort, type Logger, threadKey } from '../sessions/manager.js';
import { formatDuration, splitMessage, toSlackMrkdwn } from '../slack/format.js';
import type { RunRecord, Store } from '../store/store.js';
import { type Locks, type Semaphore, Throttle } from '../util/concurrency.js';
import {
  buildJobPrompt,
  cronFailure,
  isSilentReply,
  JOB_SYSTEM_PROMPT,
  parseWakeGate,
  splitHeadline,
} from './prompt.js';
import { runScript, type ScriptResult } from './script.js';

export type JobTrigger = { kind: 'schedule' } | { kind: 'catch-up' } | { kind: 'manual'; by: string };

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

  const releaseSlot = await deps.slots.acquire();
  const releaseLocks = await deps.locks.acquire(job.locks);
  const startedAt = now();
  let script: ScriptResult | undefined;
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
    return status;
  };

  try {
    let env: NodeJS.ProcessEnv;
    try {
      env = { ...buildChildEnv(deps.env ?? process.env, project.config.billing), ...scheduled.env };
    } catch (err) {
      await chat.post(channel, undefined, `❌ ${title} could not start: ${(err as Error).message}`);
      return record('error', { error: (err as Error).message });
    }

    if (job.preScript) {
      script = await (deps.runScript ?? runScript)(job.preScript, project.dir, env, timeoutMs, signal);
      if (signal?.aborted) return record('aborted');
      if (script.ok && (!script.output.trim() || !parseWakeGate(script.output))) return record('silent');
      if (!job.agent) {
        const icon = script.ok ? '✅' : '❌';
        const meta = formatDuration(now() - startedAt);
        await chat.post(
          channel,
          undefined,
          `${icon} ${title} · ${meta}\n\`\`\`\n${script.output.slice(0, 3_000)}\n\`\`\``,
        );
        return record(script.ok ? 'ok' : 'failed', {
          error: script.ok ? undefined : script.output.slice(-500),
        });
      }
    }

    const rootTs = await chat.post(channel, undefined, `⏳ ${title}`);
    const key = threadKey(channel, rootTs);
    let session = {
      threadKey: key,
      project: project.config.name,
      sessionId: (deps.newSessionId ?? randomUUID)(),
      model: job.model,
      started: false,
    };
    store.saveSession(session);
    let steps = 0;
    const status = new Throttle<string>(deps.host.statusIntervalSeconds * 1000, (text) =>
      chat.update(channel, rootTs, text),
    );

    // Jobs get approval buttons and file uploads, never permission prompts: nobody is watching live.
    const bridged = deps.bridge?.open({
      project,
      channel,
      threadTs: rootTs,
      kind: 'job',
      permissionPrompts: false,
    });
    const outcome: RunOutcome = await deps
      .run({
        bin: deps.host.claude.bin,
        args: buildClaudeArgs({
          sessionId: session.sessionId,
          resume: false,
          permissionMode: project.config.permissionMode,
          model: job.model,
          appendSystemPrompt: [JOB_SYSTEM_PROMPT, bridged && BRIDGE_PROMPT, project.systemPrompt]
            .filter(Boolean)
            .join('\n\n'),
          allowedTools: job.allowedTools ?? project.config.allowedTools,
          mcpConfig: bridged?.mcpConfigPath,
        }),
        cwd: project.dir,
        env,
        prompt: buildJobPrompt(job, script),
        timeoutMs,
        signal,
        onEvent: (event) => {
          if (event.kind === 'init' && !session.started) {
            session = { ...session, started: true };
            store.saveSession(session);
          } else if (event.kind === 'tool') {
            steps++;
            status.push(`⏳ ${title} · step ${steps}\n> ${event.status}`);
          }
        },
      })
      .finally(() => bridged?.dispose());
    await status.flush();

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
      await chat.update(channel, rootTs, `${title} · ${reason}`);
      return record(outcome.status, { ...usage, error: outcome.error, output: outcome.text });
    }

    if (isSilentReply(outcome.text)) {
      await chat
        .delete(channel, rootTs)
        .catch(() => chat.update(channel, rootTs, `🔇 ${title} · nothing to report`));
      store.deleteSession(key);
      return record('silent', { ...usage, output: outcome.text });
    }

    const failure = cronFailure(outcome.text);
    const { headline, details } = failure
      ? { headline: failure.split('\n')[0] ?? '', details: failure }
      : splitHeadline(outcome.text);
    const icon = failure ? '❌' : '✅';
    await chat.update(channel, rootTs, `${icon} ${title} · ${meta}\n${toSlackMrkdwn(headline)}`);
    if (details)
      for (const chunk of splitMessage(toSlackMrkdwn(details))) await chat.post(channel, rootTs, chunk);
    return record(failure ? 'failed' : 'ok', { ...usage, error: failure, output: outcome.text });
  } catch (err) {
    log.error(`[${project.config.name}] job ${job.id} crashed: ${(err as Error).stack ?? err}`);
    return record('error', { error: (err as Error).message });
  } finally {
    releaseLocks();
    releaseSlot();
  }
}
