import { execFile, execFileSync } from 'node:child_process';

/**
 * Running Claude (and pre-run scripts) as another OS user than tara-agent itself (host
 * `claude.runAs`). tara-agent keeps its database and secrets (the approvals key and seal key) where
 * that user can't read them, so a run can never approve its own drafts. It needs one sudoers rule:
 *   Defaults:tara-agent !use_pty
 *   tara-agent ALL=(<runAs>) NOPASSWD: ALL
 * See docs/security.md.
 */

export interface RunAs {
  user: string;
  home: string;
  gid: number;
}

/** Looks the user up once at startup (home and primary group). */
export function resolveRunAs(user: string): RunAs {
  const line = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim();
  const [, , , gid, , home] = line.split(':');
  if (!home || gid === undefined) throw new Error(`claude.runAs: no user "${user}"`);
  return { user, home, gid: Number(gid) };
}

/**
 * The command that runs `bin args` as the other user with exactly `env` (sudo resets the
 * environment, so it is passed through `env -i`). The child stays in sudo's process group, so
 * stopping the group stops it.
 */
export function asUser(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  runAs: RunAs,
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  const childEnv = { ...env, HOME: runAs.home, USER: runAs.user, LOGNAME: runAs.user };
  const pairs = Object.entries(childEnv)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  return {
    bin: 'sudo',
    args: ['-n', '-u', runAs.user, '--', '/usr/bin/env', '-i', ...pairs, bin, ...args],
    env: { PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
  };
}

/**
 * Signals a process group. Members owned by the other user can't be signalled by tara-agent, so the
 * same signal is also sent as that user.
 */
export function signalGroup(pid: number, signal: NodeJS.Signals, runAs?: RunAs): void {
  try {
    process.kill(-pid, signal);
  } catch {}
  if (runAs) execFile('sudo', ['-n', '-u', runAs.user, '/bin/kill', `-${signal}`, '--', `-${pid}`], () => {});
}
