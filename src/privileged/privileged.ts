import { execFile } from 'node:child_process';

/**
 * Privileged actions (host `privileged`): the few root commands a run may ask for, like fixing file
 * permissions or restarting a project's service. The allowlist and the checks live in the root-owned
 * helper (deploy/tara-priv.mjs), which tara-agent reaches through one sudoers rule; tara-agent only
 * asks it what an action would run and runs it after a person approved (or at once for `auto`
 * actions). A run never gets root itself. See docs/security.md "Privileged actions".
 */

export interface PrivilegedAction {
  id: string;
  description: string;
  /** Argument name → pattern its value must match in full. */
  args: Record<string, string>;
  /** Runs without a card (harmless and often needed, e.g. re-applying permissions). */
  auto: boolean;
}

export interface PrivilegedPlan extends PrivilegedAction {
  argv: string[];
  /** The command as one line, for cards and messages. */
  command: string;
}

export interface PrivilegedResult {
  ok: boolean;
  exitCode: number;
  command: string;
  /** The end of stdout and stderr together. */
  output: string;
}

export class PrivilegedError extends Error {}

const OUTPUT_MAX = 3_000;
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export class Privileged {
  /** Known after `load()`; empty when the helper is missing. */
  actions: PrivilegedAction[] = [];

  /** `command`: how to start the helper, e.g. ['sudo', '-n', '/usr/local/sbin/tara-priv']. */
  constructor(
    private readonly command: string[],
    private readonly env: NodeJS.ProcessEnv = { PATH: process.env.PATH },
  ) {}

  async load(): Promise<PrivilegedAction[]> {
    const { code, stdout, stderr } = await this.helper(['--list'], 30_000);
    if (code !== 0) throw new PrivilegedError(stderr.trim() || `helper exited ${code}`);
    this.actions = JSON.parse(stdout) as PrivilegedAction[];
    return this.actions;
  }

  /** What an action would run; throws with the helper's reason when it refuses. */
  async plan(id: string, args: Record<string, string> = {}): Promise<PrivilegedPlan> {
    const { code, stdout, stderr } = await this.helper(['--plan', id, JSON.stringify(args)], 30_000);
    if (code !== 0) throw new PrivilegedError(stderr.trim() || `helper exited ${code}`);
    const p = JSON.parse(stdout) as { argv: string[]; description: string; auto: boolean };
    const known = this.actions.find((a) => a.id === id);
    return {
      id,
      description: p.description,
      args: known?.args ?? {},
      auto: p.auto,
      argv: p.argv,
      command: p.argv.map(quote).join(' '),
    };
  }

  /** Runs an action as root. The helper checks it again, so a stale plan can't run anything else. */
  async run(id: string, args: Record<string, string> = {}): Promise<PrivilegedResult> {
    const plan = await this.plan(id, args).catch((err: Error) => err);
    const { code, stdout, stderr } = await this.helper([id, JSON.stringify(args)], 15 * 60_000);
    const output = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim();
    return {
      ok: code === 0,
      exitCode: code,
      command: plan instanceof Error ? id : plan.command,
      output: output.length > OUTPUT_MAX ? `…${output.slice(-OUTPUT_MAX)}` : output,
    };
  }

  /** The system prompt lines that tell Claude what it can ask for. */
  prompt(): string {
    if (!this.actions.length) return '';
    const lines = this.actions.map((a) => {
      const args = Object.keys(a.args);
      return `  - \`${a.id}\`${args.length ? ` (${args.join(', ')})` : ''}: ${a.description}${a.auto ? ' (runs at once, no approval needed)' : ''}`;
    });
    return `Root actions (you have no sudo):
- When something fails because of permissions (Permission denied, EACCES, Operation not permitted) or needs root (restarting a service), call \`request_privileged\` with one of these actions instead of giving up:
${lines.join('\n')}
- An action that runs at once returns its output: check it and carry on in the same turn. Any other becomes an approval card (Approvals page and this thread): end your turn; the decision and the command's output arrive as your next message.
- If no action fits, call \`request_privileged\` with \`command\` (the exact shell command a person should run on this machine) and end your turn; you continue once they have run it.`;
  }

  private helper(
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const [bin, ...pre] = this.command as [string, ...string[]];
    return new Promise((resolve) => {
      execFile(
        bin,
        [...pre, ...args],
        { env: this.env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({
            code,
            stdout: String(stdout),
            stderr: String(stderr || (err && !stderr ? err.message : '')),
          });
        },
      );
    });
  }
}
