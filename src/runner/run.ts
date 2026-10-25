import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseStreamLine, type RateLimit, type StreamEvent, type TokenUsage } from './stream.js';

export interface RunOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
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

    // Own process group, so a timeout also stops whatever the CLI started (shells, MCP servers).
    const child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
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
