import type { Bridge, RunContext } from '../bridge/bridge.js';
import type { HostConfig, Project, SelfImprove } from '../config/schema.js';
import { buildClaudeArgs } from '../runner/args.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import { isNoLesson, learnPrompt } from '../scheduler/prompt.js';
import { formatDuration, toSlackMrkdwn } from '../slack/format.js';
import type { Store } from '../store/store.js';
import type { ChatPort, Logger } from './manager.js';

/**
 * Learning turns (`selfImprove`): after a job run or chat turn (every one that used a tool, or only
 * those with trouble), resume its session once and let Claude fix the skill or instruction file behind it. The turn repeats the run's exact
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

/**
 * Whether a finished run gets a learning turn: undefined for none, the trouble reasons for a run that
 * had trouble, or an empty list for a clean run in `always` mode (a short look back). A clean run that
 * used no tool followed no procedure, so there is nothing to write down.
 */
export function learnReasons(
  mode: SelfImprove,
  outcome: RunOutcome,
  toolErrors: number,
  failure?: string,
): string[] | undefined {
  if (mode === 'off') return undefined;
  const reasons = troubleReasons(outcome, toolErrors, failure);
  if (reasons.length) return reasons;
  if (mode === 'always' && outcome.status === 'ok' && outcome.toolCalls > 0) return [];
  return undefined;
}

/** Tools that only read: everything else a learning turn does is checked against its rules. */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite']);
const INSTRUCTION_FILE = /\.md$/i;
/** A skill's own files (its scripts too) and the job scripts skills run: a learning turn may fix them. */
const SKILL_FILE = /\/\.(?:claude|agents)\/skills\/|\/\.tara\/scripts\//;

/**
 * What a learning turn did beyond its rules ("instruction .md files and the skill's own scripts, with
 * the edit tools"): edits of other files, and other tools that may write (a shell, MCP tools). Empty
 * when it kept to them.
 */
export function learnOverreach(calls: Array<{ name: string; file?: string }>): string[] {
  const out = new Set<string>();
  for (const c of calls) {
    if (READ_ONLY_TOOLS.has(c.name)) continue;
    if (c.file) {
      if (!INSTRUCTION_FILE.test(c.file) && !SKILL_FILE.test(c.file)) out.add(`edited ${c.file}`);
    } else out.add(`used ${c.name}`);
  }
  return [...out];
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
  /** Exactly the system prompt the run had (passed to Claude in a file). */
  appendSystemPrompt: string;
  /** The run's bridge context, reopened so the turn sees the same tools; omit if the run had none. */
  bridge?: RunContext;
  allowedTools: string[];
  env: NodeJS.ProcessEnv;
  /** What went wrong; empty for a clean run (`selfImprove: "always"`). */
  reasons: string[];
  channel: string;
  /** The run's thread, where a change is reported. */
  threadTs: string;
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
  let bridged: ReturnType<Bridge['open']> | undefined;
  try {
    // Inside the try: callers rely on this never rejecting to release their job or chat slot.
    bridged = req.bridge && deps.bridge?.open(req.bridge);
    const calls: Array<{ name: string; file?: string }> = [];
    const outcome = await deps.run({
      bin: deps.host.claude.bin,
      args: buildClaudeArgs({
        sessionId: req.sessionId,
        resume: true,
        permissionMode: req.project.config.permissionMode,
        model: req.model,
        effort: deps.host.claude.effort,
        allowedTools: req.allowedTools,
        mcpConfig: bridged?.mcpConfigPath,
        permissionPrompts: req.bridge?.permissionPrompts,
      }),
      cwd: req.project.dir,
      env: req.env,
      systemPrompt: req.appendSystemPrompt,
      prompt: learnPrompt(req.reasons),
      timeoutMs: LEARN_TIMEOUT_MS,
      onEvent: (event) => {
        if (event.kind === 'tool') calls.push({ name: event.name, file: event.file });
      },
    });
    // The rules are in the prompt only, so what the turn really did is checked and shown to people.
    const overreach = learnOverreach(calls);
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
      `[${name}] ${req.jobId ? `job ${req.jobId}` : 'chat'} learning turn: ${outcome.status}${changed ? ', changed instructions' : ', nothing to change'}${overreach.length ? `; beyond its rules: ${overreach.join(', ')}` : ''}`,
    );
    const warning = overreach.length
      ? `\n⚠️ It also did more than edit instruction files, please check: ${overreach.slice(0, 10).join(', ')}`
      : '';
    // Only in the run's thread: a channel holds only "Run" threads.
    if (changed || warning) {
      await deps.chat.post(
        req.channel,
        req.threadTs,
        `🔧 ${req.label} learned from this run${req.reasons.length ? ` (${req.reasons.join('; ')})` : ''}:\n${toSlackMrkdwn(outcome.text.trim().slice(0, 1_500))}${warning}`,
      );
    }
  } catch (err) {
    deps.log.error(`[${name}] learning turn crashed: ${(err as Error).message}`);
  } finally {
    bridged?.dispose();
  }
}
