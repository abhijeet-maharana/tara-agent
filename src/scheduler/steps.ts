import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Harness, HostConfig, JobConfig, McpServer, Project } from '../config/schema.js';
import { buildAgyArgs } from '../runner/agy.js';
import { buildClaudeArgs } from '../runner/args.js';
import type { Runner } from '../runner/run.js';
import type { TokenUsage } from '../runner/stream.js';
import { foldersNote, identityPrompt, type RunFolders, STEP_SYSTEM_PROMPT } from './prompt.js';

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
}

export interface StepsResult {
  /** The `## Step Output` section for the main prompt ('' without steps). */
  section: string;
  usage: TokenUsage;
  toolCalls: number;
}

/**
 * Runs a job's steps one after the other, each a fresh session of the job's harness with the job's MCP
 * servers and no Slack tools, and collects their replies for the main prompt. A step that fails or times
 * out is reported there and the next one still runs. Never rejects.
 */
export async function runSteps(input: StepsInput): Promise<StepsResult> {
  const { host, project, job, harness } = input;
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let toolCalls = 0;
  const parts: string[] = [];
  const systemPrompt = [identityPrompt(host.agentName), STEP_SYSTEM_PROMPT, project.systemPrompt]
    .filter(Boolean)
    .join('\n\n');

  for (const [i, step] of job.steps.entries()) {
    if (input.signal.aborted) break;
    input.onStep?.(i + 1, step.name);
    const timeoutMs = (step.timeoutMinutes ?? job.timeoutMinutes) * 60_000;
    let prompt: string;
    try {
      const shared = step.promptFile ? readFileSync(path.join(project.dir, step.promptFile), 'utf8') : '';
      prompt = [shared, step.prompt ?? '', foldersNote(input.folders)].filter((p) => p.trim()).join('\n\n');
    } catch (err) {
      parts.push(`### ${step.name} (not run)\nCould not read its prompt file: ${(err as Error).message}`);
      continue;
    }
    const agy =
      harness === 'agy'
        ? buildAgyArgs({
            model: step.model ?? job.model,
            permissionMode: project.config.permissionMode,
            permissions: step.agyPermissions ?? job.agyPermissions,
            timeoutMs,
          })
        : undefined;
    const outcome = await input.run({
      harness,
      bin: agy ? host.agy.bin : host.claude.bin,
      args:
        agy?.args ??
        buildClaudeArgs({
          sessionId: randomUUID(),
          resume: false,
          permissionMode: project.config.permissionMode,
          model: step.model ?? job.model,
          effort: host.claude.effort,
          allowedTools: job.allowedTools ?? project.config.allowedTools,
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
    });
    toolCalls += outcome.toolCalls;
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreation'] as const)
      usage[k] += outcome.usage?.[k] ?? 0;
    parts.push(
      outcome.status === 'ok'
        ? `### ${step.name}\n${outcome.text.trim()}`
        : `### ${step.name} (${outcome.status})\n${outcome.error ?? 'no answer'}${outcome.text.trim() ? `\n\nIts reply so far:\n${outcome.text.trim()}` : ''}`,
    );
  }

  const section = parts.length
    ? `## Step Output\nThese steps ran before you, each in its own session. Use their results; a step marked (timeout) or (error) did not finish.\n\n${parts.join('\n\n')}`
    : '';
  return { section, usage, toolCalls };
}
