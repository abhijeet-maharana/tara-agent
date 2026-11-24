import { spawn } from 'node:child_process';
import { asUser, type RunAs, signalGroup } from '../runner/as-user.js';

/**
 * Before a job's model session: its `requires` (services that must answer) and its `gate` (a command
 * that says whether there is any work). Both run without the model, so a run with nothing to do, or
 * one that can't work, costs no session (plan rule: gate before model, preflight before a run).
 */

export interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GateOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type GateRunner = (options: GateOptions) => Promise<GateResult>;

/**
 * At most this much of each stream is kept: the start of stdout (a gate's briefing leads with what
 * matters, and it all goes into the prompt) and the end of stderr (where an error ends up).
 */
export const MAX_GATE_OUTPUT = 128_000;

/** Adds a chunk to stdout, keeping its first `max` characters and counting what was cut. */
export function keepHead(kept: { text: string; cut: number }, chunk: string, max = MAX_GATE_OUTPUT) {
  const room = Math.max(0, max - kept.text.length);
  kept.text += chunk.slice(0, room);
  kept.cut += Math.max(0, chunk.length - room);
}

/** Runs a gate with `sh -c` in the repo, as the run user when there is one (like the model's own runs). */
export function gateRunner(runAs?: RunAs): GateRunner {
  return ({ command, cwd, env, timeoutMs, signal }) =>
    new Promise((resolve) => {
      const cmd = runAs
        ? asUser('/bin/sh', ['-c', command], env, runAs)
        : { bin: '/bin/sh', args: ['-c', command], env };
      const child = spawn(cmd.bin, cmd.args, {
        cwd,
        env: cmd.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = { text: '', cut: 0 };
      let stderr = '';
      let timedOut = false;
      // The whole output, cut or not, with a line saying so when it was.
      const stdoutText = () =>
        out.cut
          ? `${out.text}\n[tara-agent cut the rest of the gate output here: ${out.cut} more characters]`
          : out.text;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => keepHead(out, d));
      child.stderr.on(
        'data',
        (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-MAX_GATE_OUTPUT)),
      );
      const kill = () => child.pid && signalGroup(child.pid, 'SIGKILL', runAs);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      signal?.addEventListener('abort', kill, { once: true });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout: stdoutText(), stderr: `${stderr}${err.message}`, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        resolve({ code: timedOut ? 124 : (code ?? 1), stdout: stdoutText(), stderr, timedOut });
      });
    });
}

/** A gate's whole output when it says why there is nothing to do: one line starting `Skipping`. */
const SKIPPING = /^Skipping\b[^\n]*$/;

/** Nothing to do: the gate exited 0 and printed nothing, or only one `Skipping…` line (the reason). */
export const gateSaysSkip = (r: GateResult) =>
  r.code === 0 && !r.timedOut && (!r.stdout.trim() || SKIPPING.test(r.stdout.trim()));

/** What a skipped run records as its output. */
export const skipReason = (r: GateResult) =>
  r.stdout.trim()
    ? `✅ ${r.stdout.trim()}`
    : '✅ Nothing to do: the gate found no work, so no model session ran';

/** The prompt section for a run the gate let through. */
export function gateSection(command: string, r: GateResult): string {
  const how = r.timedOut
    ? 'did not finish in time (it was stopped)'
    : r.code === 0
      ? 'printed this'
      : `exited with code ${r.code}`;
  const parts = [
    '## Gate output',
    `Before this session, tara-agent ran the job's gate \`${command}\`; it ${how}. Work from this output: don't run the gate again.${
      r.code !== 0 ? ' If the gate itself is broken, fix it or report it.' : ''
    }`,
  ];
  if (r.stdout.trim()) parts.push(`\`\`\`\n${r.stdout.trim()}\n\`\`\``);
  if (r.code !== 0 && r.stderr.trim())
    parts.push(`Error output:\n\`\`\`\n${r.stderr.trim().slice(-4000)}\n\`\`\``);
  return parts.join('\n\n');
}

/** Up = any HTTP answer below 500 (an auth error still means the service is there). */
export async function serviceUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'manual' });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

/** The `requires` URLs that don't answer. */
export async function missingServices(
  urls: string[],
  probe: (url: string) => Promise<boolean> = serviceUp,
): Promise<string[]> {
  const up = await Promise.all(urls.map(probe));
  return urls.filter((_, i) => !up[i]);
}
