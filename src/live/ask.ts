import { randomUUID } from 'node:crypto';
import type { Project } from '../config/schema.js';
import { buildChildEnv } from '../runner/env.js';
import type { Runner } from '../runner/run.js';
import { identityPrompt } from '../scheduler/prompt.js';
import type { Store } from '../store/store.js';

/** Read-only: no edits, no shell, no MCP servers (theirs could write). */
export const ASK_TOOLS = ['Read', 'Grep', 'Glob'];

export function askArgs(sessionId: string, model: string): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--model',
    model,
    '--session-id',
    sessionId,
    '--strict-mcp-config',
    '--tools',
    ...ASK_TOOLS,
    // Variadic, so it goes last.
    '--allowedTools',
    ...ASK_TOOLS,
  ];
}

const ASK_PROMPT = `You are answering a question asked out loud; your answer will be read aloud by a voice assistant.
Look at the repository as needed (you can only read). Answer in at most three short sentences of plain text: no Markdown, code, file paths or URLs unless the question is about them.`;

export interface AskDeps {
  run: Runner;
  bin: string;
  agentName: string;
  model: string;
  timeoutMs: number;
  store: Store;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** One read-only Claude turn in the project; resolves with the answer, rejects when the turn failed. */
export async function askProject(
  deps: AskDeps,
  project: Project,
  question: string,
  signal: AbortSignal,
): Promise<string> {
  const now = deps.now ?? Date.now;
  const sessionId = randomUUID();
  const startedAt = now();
  const outcome = await deps.run({
    bin: deps.bin,
    args: askArgs(sessionId, deps.model),
    cwd: project.dir,
    env: buildChildEnv(deps.env ?? process.env, project.config.billing),
    prompt: question,
    systemPrompt: `${identityPrompt(deps.agentName)}\n\n${ASK_PROMPT}`,
    timeoutMs: deps.timeoutMs,
    signal,
  });
  deps.store.recordRun({
    kind: 'chat',
    project: project.config.name,
    threadKey: `live:${sessionId}`,
    sessionId: outcome.sessionId ?? sessionId,
    model: outcome.model ?? deps.model,
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
  });
  if (outcome.status !== 'ok')
    throw new Error(
      outcome.error ?? `the question ${outcome.status === 'timeout' ? 'took too long' : outcome.status}`,
    );
  return outcome.text.trim() || 'Claude gave no answer.';
}
