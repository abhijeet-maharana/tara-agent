import { spawn } from 'node:child_process';
import { chmodSync, chownSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
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
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  /** Run as another OS user (host `claude.runAs`). */
  runAs?: RunAs;
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

/** Adds the file flag before `--allowedTools`, which is variadic and must stay last. */
function withSystemPromptFile(args: string[], file: string): string[] {
  const at = args.indexOf('--allowedTools');
  const flag = ['--append-system-prompt-file', file];
  return at === -1 ? [...args, ...flag] : [...args.slice(0, at), ...flag, ...args.slice(at)];
}

/** Runs one headless `claude -p` turn and resolves when the process exits. Never rejects. */
export const runClaude: Runner = (options) =>
  new Promise((resolve) => {
    const started = Date.now();
    let result: Extract<StreamEvent, { kind: 'result' }> | undefined;
    let init: Extract<StreamEvent, { kind: 'init' }> | undefined;
    let rateLimit: RateLimit | undefined;
    let toolCalls = 0;
    let stderr = '';
    let stopReason: 'timeout' | 'aborted' | undefined;
    let spawnError: Error | undefined;

    const prompt = options.systemPrompt ? systemPromptFile(options.systemPrompt, options.runAs) : undefined;
    const args = prompt ? withSystemPromptFile(options.args, prompt.file) : options.args;
    // Own process group, so a timeout also stops whatever the CLI started (shells, MCP servers).
    const cmd = options.runAs
      ? asUser(options.bin, args, options.env, options.runAs)
      : { bin: options.bin, args, env: options.env };
    const child = spawn(cmd.bin, cmd.args, {
      cwd: options.cwd,
      env: cmd.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
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
    child.stdin.end(options.prompt);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });

    createInterface({ input: child.stdout }).on('line', (line) => {
      for (const event of parseStreamLine(line)) {
        if (event.kind === 'init') init = event;
        else if (event.kind === 'tool') toolCalls++;
        else if (event.kind === 'rate_limit') rateLimit = event.rateLimit;
        else if (event.kind === 'result') result = event;
        try {
          options.onEvent?.(event);
        } catch {
          // A failing listener must not break the run.
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      prompt?.dispose();
      options.signal?.removeEventListener('abort', onAbort);

      const base = {
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
      if (spawnError) {
        status = 'error';
        error =
          (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
            ? `Claude Code CLI not found ("${options.bin}"). Install it and log in as this user.`
            : spawnError.message;
      } else if (stopReason) {
        status = stopReason;
      } else if (rateLimit?.status === 'rejected' || (result?.isError && LIMIT_TEXT.test(result.text))) {
        status = 'limit';
        error = result?.text || 'Claude usage limit reached';
      } else if (result && !result.isError && code === 0) {
        status = 'ok';
      } else {
        status = 'error';
        error = result?.isError
          ? result.text || result.subtype
          : stderr.trim() || `claude exited with code ${code}`;
      }
      resolve({ ...base, status, error });
    });
  });
