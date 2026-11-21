import { randomUUID } from 'node:crypto';
import type { Harness, HostConfig, JobConfig, McpServer, Project } from '../config/schema.js';
import { buildAgyArgs } from '../runner/agy.js';
import { buildClaudeArgs } from '../runner/args.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import type { TokenUsage } from '../runner/stream.js';
import {
  foldersNote,
  identityPrompt,
  type RunFolders,
  STEP_SYSTEM_PROMPT,
  stepInstructions,
} from './prompt.js';

/** `${VAR}` in a job's MCP server config, replaced from the run's environment (unknown names stay). */
export function expandMcpServers(
  servers: Record<string, McpServer> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, McpServer> | undefined {
  if (!servers) return undefined;
  const expand = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/gi, (m, name: string) => env[name] ?? m);
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [
      name,
      {
        command: expand(s.command),
        args: s.args.map(expand),
        env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, expand(v)])),
      },
    ]),
  );
}

/** Where a harness that is out of quota or capacity says so: agy's 429 / 503, Claude's usage limit. */
const UNAVAILABLE_TEXT = /\b(429|503)\b|unavailable|overloaded|capacity|resource.?exhausted/i;

/**
 * The session never really ran because its harness had no quota or capacity left, so the same work
 * can be rerun on another harness. A timeout or a plain error is the job's own trouble and isn't.
 */
export function harnessUnavailable(outcome: RunOutcome): boolean {
  return (
    outcome.status === 'limit' || (outcome.status === 'error' && UNAVAILABLE_TEXT.test(outcome.error ?? ''))
  );
}

/** The harness and model a job's sessions move to when its own harness is unavailable. */
export interface Fallback {
  harness: Harness;
  model: string;
}

/** One line for the run's thread: which session moved to which harness, and why. */
export function fallbackNote(what: string, from: Harness, to: Fallback, outcome: RunOutcome): string {
  const why = (outcome.error ?? outcome.status).split('\n')[0]?.slice(0, 160);
  return `↪️ ${what} ran on ${to.harness} (${to.model}): ${from} was unavailable (${why})`;
}

export interface StepsInput {
  host: HostConfig;
  run: Runner;
  project: Project;
  job: JobConfig;
  harness: Harness;
  env: NodeJS.ProcessEnv;
  folders: RunFolders;
  mcpServers?: Record<string, McpServer>;
  signal: AbortSignal;
  /** Called as each step starts (1-based), for the status line. */
  onStep?: (index: number, name: string) => void;
  /** Where a step goes when `harness` is out of quota or capacity; the steps after it start there. */
  fallback?: Fallback;
  /** Called when a step moved to the fallback, with a line for the run's thread. */
  onFallback?: (note: string) => void;
}

/** One step's finished session, for its learning turn. */
export interface StepSession {
  name: string;
  harness: Harness;
  sessionId: string;
  model: string;
  effort?: string;
  systemPrompt: string;
  allowedTools: string[];
  outcome: RunOutcome;
  /** Tool calls that returned an error. */
  toolErrors: number;
}

export interface StepsResult {
  /** The `## Step Output` section for the main prompt ('' without steps). */
  section: string;
  usage: TokenUsage;
  toolCalls: number;
  /** All steps' cost at API prices; undefined when no step reported one. */
  costUsd?: number;
  /** All steps' time. */
  durationMs: number;
  sessions: StepSession[];
  /** The harness the last step ran on: the fallback's once a step moved there. */
  harness: Harness;
}

/**
 * Runs a job's steps one after the other, each a fresh session of the job's harness with the job's MCP
 * servers and no Slack tools, and collects their replies for the main prompt. A step that fails or times
 * out is reported there and the next one still runs. Never rejects.
 */
export async function runSteps(input: StepsInput): Promise<StepsResult> {
  const { host, project, job } = input;
  let harness = input.harness;
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let toolCalls = 0;
  let costUsd: number | undefined;
  let durationMs = 0;
  const sessions: StepSession[] = [];
  const parts: string[] = [];
  const systemPrompt = [identityPrompt(host.agentName), STEP_SYSTEM_PROMPT, project.systemPrompt]
    .filter(Boolean)
    .join('\n\n');

  for (const [i, step] of job.steps.entries()) {
    if (input.signal.aborted) break;
    input.onStep?.(i + 1, step.name);
    const timeoutMs = (step.timeoutMinutes ?? job.timeoutMinutes) * 60_000;
    const effort = step.effort ?? job.effort ?? host.claude.effort;
    const allowedTools = job.allowedTools ?? project.config.allowedTools;
    const prompt = `${stepInstructions(job, step)}\n\n${foldersNote(input.folders)}`;
    const once = async (on: Harness, model: string) => {
      const sessionId = randomUUID();
      let toolErrors = 0;
      const agy =
        on === 'agy'
          ? buildAgyArgs({
              model,
              permissionMode: project.config.permissionMode,
              permissions: step.agyPermissions ?? job.agyPermissions,
              timeoutMs,
            })
          : undefined;
      const outcome = await input.run({
        harness: on,
        bin: agy ? host.agy.bin : host.claude.bin,
        args:
          agy?.args ??
          buildClaudeArgs({
            sessionId,
            resume: false,
            permissionMode: project.config.permissionMode,
            model,
            effort,
            allowedTools,
          }),
        agy: agy && { settings: agy.settings },
        mcpServers: input.mcpServers,
        cwd: project.dir,
        env: input.env,
        prompt,
        systemPrompt,
        timeoutMs,
        signal: input.signal,
        label: {
          project: project.config.name,
          kind: 'job',
          title: `${job.name} · ${step.name}`,
          jobId: job.id,
        },
        onEvent: (event) => {
          if (event.kind === 'tool_result' && event.isError && !event.parent) toolErrors++;
        },
      });
      toolCalls += outcome.toolCalls;
      durationMs += outcome.durationMs;
      if (outcome.costUsd !== undefined) costUsd = (costUsd ?? 0) + outcome.costUsd;
      for (const k of ['input', 'output', 'cacheRead', 'cacheCreation'] as const)
        usage[k] += outcome.usage?.[k] ?? 0;
      return { outcome, sessionId: outcome.sessionId ?? sessionId, toolErrors };
    };
    // A step model is for the job's own harness; on the fallback the fallback's model runs it.
    const onOwn = !input.fallback || harness !== input.fallback.harness;
    let model = onOwn ? (step.model ?? job.model) : (input.fallback?.model as string);
    let ran = await once(harness, model);
    if (input.fallback && onOwn && !input.signal.aborted && harnessUnavailable(ran.outcome)) {
      input.onFallback?.(fallbackNote(`Step "${step.name}"`, harness, input.fallback, ran.outcome));
      harness = input.fallback.harness;
      model = input.fallback.model;
      ran = await once(harness, model);
    }
    const { outcome, toolErrors } = ran;
    sessions.push({
      name: step.name,
      harness,
      sessionId: ran.sessionId,
      model,
      effort: step.effort ?? job.effort,
      systemPrompt,
      allowedTools,
      outcome,
      toolErrors,
    });
    parts.push(
      outcome.status === 'ok'
        ? `### ${step.name}\n${outcome.text.trim()}`
        : `### ${step.name} (${outcome.status})\n${outcome.error ?? 'no answer'}${outcome.text.trim() ? `\n\nIts reply so far:\n${outcome.text.trim()}` : ''}`,
    );
  }

  const section = parts.length
    ? `## Step Output\nThese steps ran before you, each in its own session. Use their results; a step marked (timeout) or (error) did not finish.\n\n${parts.join('\n\n')}`
    : '';
  return { section, usage, toolCalls, costUsd, durationMs, sessions, harness };
}
