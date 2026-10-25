import type { Bridge, RunContext } from '../bridge/bridge.js';
import type { HostConfig, Project } from '../config/schema.js';
import { buildClaudeArgs } from '../runner/args.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import { isNoLesson, learnPrompt } from '../scheduler/prompt.js';
import { formatDuration, toSlackMrkdwn } from '../slack/format.js';
import type { Store } from '../store/store.js';
import type { ChatPort, Logger } from './manager.js';

/**
 * Learning turns (`selfImprove`): after a job run or chat turn that had trouble, resume its session
 * once and let Claude fix the skill or instruction file behind it. The turn repeats the run's exact
 * system prompt, tools and model, so the prompt cache still applies.
 */

/** Tool calls that returned an error in one run before it counts as trouble worth learning from. */
export const TOOL_ERROR_TROUBLE = 2;
const LEARN_TIMEOUT_MS = 5 * 60_000;

/**
 * Why a finished run is worth a learning turn; empty when it isn't. A usage limit or a stop isn't
 * something better instructions would fix, and neither is a session that no longer exists.
 */
export function troubleReasons(outcome: RunOutcome, toolErrors: number, failure?: string): string[] {
  if (outcome.status === 'limit' || outcome.status === 'aborted') return [];
  const reasons: string[] = [];
  if (outcome.status === 'timeout') reasons.push(`it timed out after ${formatDuration(outcome.durationMs)}`);
  if (outcome.status === 'error' && !/no conversation found/i.test(outcome.error ?? ''))
    reasons.push(`it ended with an error: ${(outcome.error ?? 'unknown').slice(0, 300)}`);
  if (failure) reasons.push(`it reported a failure: ${failure.split('\n')[0]?.slice(0, 300)}`);
  if (toolErrors >= TOOL_ERROR_TROUBLE) reasons.push(`${toolErrors} tool calls returned errors`);
  return reasons;
}

export interface LearnDeps {
  host: HostConfig;
  store: Store;
  chat: ChatPort;
  run: Runner;
  log: Logger;
  bridge?: Bridge;
  now?: () => number;
}

export interface LearnRequest {
  project: Project;
  sessionId: string;
  model: string;
  /** Exactly what the run passed to `--append-system-prompt`. */
  appendSystemPrompt: string;
  /** The run's bridge context, reopened so the turn sees the same tools; omit if the run had none. */
  bridge?: RunContext;
  allowedTools: string[];
  env: NodeJS.ProcessEnv;
  reasons: string[];
  channel: string;
  /** Thread to report a change in; undefined posts in the channel (the job's message was deleted). */
  threadTs?: string;
  threadKey?: string;
  jobId?: string;
  /** Names the run in the Slack note, e.g. "*SLA Report*" or "This conversation". */
  label: string;
}

/** Runs one learning turn and reports a change in Slack. Never rejects. */
export async function learnFromRun(deps: LearnDeps, req: LearnRequest): Promise<void> {
  const now = deps.now ?? Date.now;
  const name = req.project.config.name;
  const startedAt = now();
  const bridged = req.bridge && deps.bridge?.open(req.bridge);
  try {
    const outcome = await deps.run({
      bin: deps.host.claude.bin,
      args: buildClaudeArgs({
        sessionId: req.sessionId,
        resume: true,
        permissionMode: req.project.config.permissionMode,
        model: req.model,
        effort: deps.host.claude.effort,
        appendSystemPrompt: req.appendSystemPrompt,
        allowedTools: req.allowedTools,
        mcpConfig: bridged?.mcpConfigPath,
        permissionPrompts: req.bridge?.permissionPrompts,
      }),
      cwd: req.project.dir,
      env: req.env,
      prompt: learnPrompt(req.reasons),
      timeoutMs: LEARN_TIMEOUT_MS,
    });
    const changed = outcome.status === 'ok' && !isNoLesson(outcome.text);
    deps.store.recordRun({
      kind: 'learn',
      project: name,
      jobId: req.jobId,
      threadKey: req.threadKey,
      sessionId: req.sessionId,
      model: outcome.model ?? req.model,
      startedAt,
      endedAt: now(),
      status: outcome.status,
      costUsd: outcome.costUsd,
      inputTokens: outcome.usage?.input,
      outputTokens: outcome.usage?.output,
      cacheReadTokens: outcome.usage?.cacheRead,
      cacheCreationTokens: outcome.usage?.cacheCreation,
      toolCalls: outcome.toolCalls,
      error: outcome.error,
      output: outcome.text,
    });
    deps.log.info(
      `[${name}] ${req.jobId ? `job ${req.jobId}` : 'chat'} learning turn: ${outcome.status}${changed ? ', changed instructions' : ', nothing to change'}`,
    );
    if (changed) {
      await deps.chat.post(
        req.channel,
        req.threadTs,
        `🔧 ${req.label} learned from this run (${req.reasons.join('; ')}):\n${toSlackMrkdwn(outcome.text.trim().slice(0, 1_500))}`,
      );
    }
  } catch (err) {
    deps.log.error(`[${name}] learning turn crashed: ${(err as Error).message}`);
  } finally {
    bridged?.dispose();
  }
}
