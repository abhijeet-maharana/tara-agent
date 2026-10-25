import { spawn } from 'node:child_process';
import path from 'node:path';

export interface ScriptResult {
  ok: boolean;
  /** stdout on success; stdout + stderr tail on failure. Capped at `MAX_OUTPUT` chars. */
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Same cap Hermes uses for injected context. */
export const MAX_OUTPUT = 8_000;
const KILL_GRACE_MS = 5_000;

function command(script: string): { bin: string; args: string[] } {
  if (script.endsWith('.py')) return { bin: 'python3', args: [script] };
  if (script.endsWith('.sh')) return { bin: 'bash', args: [script] };
  return { bin: script, args: [] };
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (truncated)` : text;
}

/** Runs a job's pre-run script from the repo root. Never rejects. */
export function runScript(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const { bin, args } = command(path.isAbsolute(script) ? script : path.join(cwd, script));
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: Error | undefined;
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const stop = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });

    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += c;
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      stderr = (stderr + c).slice(-4_000);
    });
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      const ok = !spawnError && !timedOut && code === 0;
      let output = stdout.trim();
      if (!ok) {
        const reason = spawnError
          ? `could not start ${bin}: ${spawnError.message}`
          : timedOut
            ? `timed out after ${Math.round(timeoutMs / 1000)}s`
            : `exit code ${code}`;
        output = [output, stderr.trim(), `(${reason})`].filter(Boolean).join('\n');
      }
      resolve({ ok, output: cap(output), exitCode: code, timedOut });
    });
  });
}
