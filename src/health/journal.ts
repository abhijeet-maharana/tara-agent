import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { redact } from '../runner/activity.js';
import { type LogLine, looksLikeProblem } from './trends.js';

const run = promisify(execFile);

export interface ServiceLogs {
  lines: Array<LogLine & { unit: string }>;
  /** Why they couldn't be read (no permission, no journalctl). */
  error?: string;
}

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (cmd, args) =>
  run(cmd, args, { timeout: 15_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });

/**
 * Warnings and errors of other services (host `health.logUnits`) from the systemd journal. Services
 * log everything at one level, so lines are picked by priority or by their words. Secrets are
 * blanked like on a running session's page.
 */
export async function readJournal(
  units: string[],
  since: number,
  exec: Exec = defaultExec,
): Promise<ServiceLogs> {
  if (!units.length) return { lines: [] };
  let out: { stdout: string; stderr: string };
  try {
    out = await exec('journalctl', [
      '--no-pager',
      '--quiet',
      '--output=json',
      `--since=@${Math.floor(since / 1000)}`,
      '--lines=20000',
      ...units.flatMap((u) => ['--unit', u]),
    ]);
  } catch (err) {
    return { lines: [], error: (err as Error).message.split('\n')[0] };
  }
  const lines: ServiceLogs['lines'] = [];
  for (const raw of out.stdout.split('\n')) {
    if (!raw.trim()) continue;
    let e: { MESSAGE?: unknown; PRIORITY?: string; __REALTIME_TIMESTAMP?: string; _SYSTEMD_UNIT?: string };
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof e.MESSAGE !== 'string') continue;
    const priority = Number(e.PRIORITY ?? 6);
    if (priority > 4 && !looksLikeProblem(e.MESSAGE)) continue;
    const error =
      priority <= 3 ||
      /\b(error|failed|uncaught|unhandled|fatal|crash)/i.test(e.MESSAGE) ||
      e.MESSAGE.includes('❌');
    lines.push({
      unit: (e._SYSTEMD_UNIT ?? '').replace(/\.service$/, ''),
      at: Math.floor(Number(e.__REALTIME_TIMESTAMP ?? 0) / 1000),
      level: error ? 'error' : 'warn',
      message: redact(e.MESSAGE).replace(
        /([?&](?:X-Goog-Signature|X-Goog-Credential|X-Amz-Signature|X-Amz-Credential|Signature|sig|token|key|access_token|api_key)=)[^&\s"']+/gi,
        '$1…',
      ),
    });
  }
  // journalctl says so on stderr (and exits 0) when it may not read the system journal.
  const denied = /insufficient permissions|no journal files were opened/i.test(out.stderr);
  return {
    lines,
    ...(denied &&
      !lines.length && {
        error: `tara-agent may not read the system journal. Allow it once on the host: sudo usermod -aG systemd-journal ${userInfo().username}, then restart tara-agent.`,
      }),
  };
}
