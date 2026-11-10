import { spawn } from 'node:child_process';
import { chmodSync, chownSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Harness, McpServer } from '../config/schema.js';
import { asUser, type RunAs, signalGroup } from './as-user.js';
import { parseStreamLine, type RateLimit, type StreamEvent, type TokenUsage } from './stream.js';

export interface RunOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  /**
   * Appended to Claude's system prompt. It goes in a file (`--append-system-prompt-file`), never on
   * the command line, where it would fill sudo's log on every run and show in `ps`.
   */
  systemPrompt?: string;
  timeoutMs: number;
  /** How long a process the CLI left behind may hold its pipes after it exits (default 10 s; tests). */
  exitGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  /** Run as another OS user (host `claude.runAs`). */
  runAs?: RunAs;
  /** What the run is for, so Command can show it live (src/live/activity.ts). */
  label?: RunLabel;
  /** The CLI to run (default `claude`); `args` must come from that harness's builder. */
  harness?: Harness;
  /** `agy` runs: tara's MCP config (from the bridge) and session-only settings (permissions). */
  agy?: { mcpConfig?: string; settings?: object };
  /** The job's own MCP servers (`${VAR}` already replaced), next to tara's. */
  mcpServers?: Record<string, McpServer>;
}

/** What a run is for. Runs without one (e.g. learning after a session) aren't shown on Command. */
export interface RunLabel {
  project: string;
  kind: 'chat' | 'job' | 'ask';
  /** One short line: the message, the job's name, the question. */
  title: string;
  /** The Slack thread it works in. */
  thread?: { channel: string; ts: string };
  jobId?: string;
}

export type RunStatus = 'ok' | 'error' | 'timeout' | 'limit' | 'aborted';

export interface RunOutcome {
  status: RunStatus;
  text: string;
  sessionId?: string;
  model?: string;
  costUsd?: number;
  durationMs: number;
  numTurns?: number;
  toolCalls: number;
  usage?: TokenUsage;
  rateLimit?: RateLimit;
  permissionDenials: string[];
  error?: string;
}

export type Runner = (options: RunOptions) => Promise<RunOutcome>;

const KILL_GRACE_MS = 5_000;
/**
 * After the CLI exits, how long what it left in its process group (a browser, an MCP server) may keep
 * its output pipes open before the group is killed and the pipes closed, so the run can end.
 */
const EXIT_GRACE_MS = 10_000;
const STDERR_TAIL = 4_000;
const LIMIT_TEXT = /usage limit|rate limit|out of extra usage/i;

/** Writes the system prompt where only this process and the run's user can read it; removed after the run. */
function systemPromptFile(text: string, runAs: RunAs | undefined): { file: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-prompt-'));
  const file = path.join(dir, 'system-prompt.md');
  writeFileSync(file, text, { mode: 0o600 });
  if (runAs) {
    chownSync(dir, process.getuid?.() ?? -1, runAs.gid);
    chownSync(file, process.getuid?.() ?? -1, runAs.gid);
    chmodSync(dir, 0o750);
    chmodSync(file, 0o640);
  }
  return { file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Adds flags before `--allowedTools`, which is variadic and must stay last. */
function beforeAllowedTools(args: string[], flag: string[]): string[] {
  const at = args.indexOf('--allowedTools');
  return at === -1 ? [...args, ...flag] : [...args.slice(0, at), ...flag, ...args.slice(at)];
}

/**
 * Writes the job's MCP servers to their own config file for `--mcp-config` (variadic: the file goes
 * right after tara's config when there is one). Mode like the system prompt file; removed after the run.
 */
function withMcpServers(
  args: string[],
  servers: Record<string, McpServer>,
  runAs: RunAs | undefined,
): { args: string[]; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-mcp-job-'));
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  if (runAs) {
    chownSync(dir, process.getuid?.() ?? -1, runAs.gid);
    chownSync(file, process.getuid?.() ?? -1, runAs.gid);
    chmodSync(dir, 0o750);
    chmodSync(file, 0o640);
  }
  const at = args.indexOf('--mcp-config');
  const next =
    at === -1
      ? beforeAllowedTools(args, ['--mcp-config', file])
      : [...args.slice(0, at + 2), file, ...args.slice(at + 2)];
  return { args: next, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface CliExit {
  code: number | null;
  stderr: string;
  stopReason?: 'timeout' | 'aborted';
  spawnError?: Error;
}

/**
 * Starts a CLI in its own process group (so a timeout also stops whatever it started: shells, MCP
 * servers), feeds `stdin`, hands each stdout line to `onLine` and resolves when it exits. Never rejects.
 */
export function spawnCli(
  options: RunOptions,
  args: string[],
  stdin: string,
  onLine: (line: string) => void,
): Promise<CliExit> {
  return new Promise((resolve) => {
    let stderr = '';
    let stopReason: CliExit['stopReason'];
    let spawnError: Error | undefined;
    const cmd = options.runAs
      ? asUser(options.bin, args, options.env, options.runAs)
      : { bin: options.bin, args, env: options.env };
    const child = spawn(cmd.bin, cmd.args, {
      cwd: options.cwd,
      env: cmd.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    // The whole group, even once the CLI itself has exited: what it started may still be running.
    let closed = false;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined || closed) return;
      signalGroup(child.pid, signal, options.runAs);
    };
    const stop = (reason: 'timeout' | 'aborted') => {
      stopReason ??= reason;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const onAbort = () => stop('aborted');
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      spawnError = err;
    });
    child.stdin.on('error', () => {}); // CLI exiting early closes stdin; the exit handler reports it.
    child.stdin.end(stdin);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    createInterface({ input: child.stdout }).on('line', onLine);

    // A process the CLI left behind can hold stdout open, and then 'close' never comes: the run would
    // hang (holding its thread, job slot and locks) even past its timeout. Give it a moment after the
    // CLI exits, then end the group and close the pipes ourselves.
    let leftover: NodeJS.Timeout | undefined;
    child.on('exit', () => {
      leftover = setTimeout(() => {
        killGroup('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, options.exitGraceMs ?? EXIT_GRACE_MS);
      leftover.unref();
    });

    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(leftover);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stderr, stopReason, spawnError });
    });
  });
}

/** Hands an event to the run's listener; a failing listener must not break the run. */
export function emit(options: RunOptions, event: StreamEvent): void {
  try {
    options.onEvent?.(event);
  } catch {}
}

/** Runs one headless `claude -p` turn and resolves when the process exits. Never rejects. */
export const runClaude: Runner = async (options) => {
  const started = Date.now();
  let result: Extract<StreamEvent, { kind: 'result' }> | undefined;
  let init: Extract<StreamEvent, { kind: 'init' }> | undefined;
  let rateLimit: RateLimit | undefined;
  let toolCalls = 0;

  const prompt = options.systemPrompt ? systemPromptFile(options.systemPrompt, options.runAs) : undefined;
  const servers =
    options.mcpServers && Object.keys(options.mcpServers).length
      ? withMcpServers(options.args, options.mcpServers, options.runAs)
      : undefined;
  const base = servers?.args ?? options.args;
  const args = prompt ? beforeAllowedTools(base, ['--append-system-prompt-file', prompt.file]) : base;
  const exit = await spawnCli(options, args, options.prompt, (line) => {
    for (const event of parseStreamLine(line)) {
      if (event.kind === 'init') init = event;
      else if (event.kind === 'tool') toolCalls++;
      else if (event.kind === 'rate_limit') rateLimit = event.rateLimit;
      else if (event.kind === 'result') result = event;
      emit(options, event);
    }
  }).finally(() => {
    prompt?.dispose();
    servers?.dispose();
  });

  const outcome = {
    text: result?.text ?? '',
    sessionId: result?.sessionId || init?.sessionId,
    model: init?.model,
    costUsd: result?.costUsd,
    durationMs: Date.now() - started,
    numTurns: result?.numTurns,
    toolCalls,
    usage: result?.usage,
    rateLimit,
    permissionDenials: result?.permissionDenials ?? [],
  };

  let status: RunStatus;
  let error: string | undefined;
  if (exit.spawnError) {
    status = 'error';
    error =
      (exit.spawnError as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Claude Code CLI not found ("${options.bin}"). Install it and log in as this user.`
        : exit.spawnError.message;
  } else if (exit.stopReason) {
    status = exit.stopReason;
  } else if (rateLimit?.status === 'rejected' || (result?.isError && LIMIT_TEXT.test(result.text))) {
    status = 'limit';
    error = result?.text || 'Claude usage limit reached';
  } else if (result && !result.isError && exit.code === 0) {
    status = 'ok';
  } else {
    status = 'error';
    error = result?.isError
      ? result.text || result.subtype
      : exit.stderr.trim() || `claude exited with code ${exit.code}`;
  }
  return { ...outcome, status, error };
};
