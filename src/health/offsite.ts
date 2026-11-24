/**
 * The off-site backup (deploy/backup/tara-backup.mjs) as Health checks. The tool runs as root from a
 * timer and writes a world-readable status file with no secrets; tara-agent only reads it. Two checks:
 * "Off-site backup" (the nightly run) and "Restore test" (the latest restore of an off-site copy on a
 * machine that holds the key, deploy/backup/restore-test.sh).
 */
import { readFileSync } from 'node:fs';
import { ago, type HealthStatus } from './monitor.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface RunInfo {
  at?: string;
  ok?: boolean;
  error?: string;
  archive?: { bytes?: number; key?: string };
  items?: Array<{ ok?: boolean; skipped?: string }>;
  warnings?: string[];
}

export interface OffsiteStatus {
  lastRun?: RunInfo;
  lastGood?: RunInfo;
  restoreTest?: { at?: string; ok?: boolean; message?: string };
}

export interface OffsiteOptions {
  /** Hours after the last good backup before it shows red (a nightly timer plus slack). */
  maxAgeHours: number;
  /** Days after the last good restore test before it shows amber. */
  restoreTestDays: number;
}

/** The status file, or why it couldn't be read. */
export function readOffsiteStatus(file: string): OffsiteStatus | { error: string } {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as OffsiteStatus;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      error:
        code === 'ENOENT' ? `No status yet at ${file}` : `Cannot read ${file}: ${(err as Error).message}`,
    };
  }
}

const mb = (b = 0) => `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
const time = (iso?: string) => (iso ? Date.parse(iso) : Number.NaN);

export function offsiteChecks(
  s: OffsiteStatus | { error: string },
  o: OffsiteOptions,
  now: number,
): Array<{ id: string; name: string; status: HealthStatus; detail: string }> {
  if ('error' in s) return [{ id: 'offsite', name: 'Off-site backup', status: 'warn', detail: s.error }];
  const out: Array<{ id: string; name: string; status: HealthStatus; detail: string }> = [];

  const last = s.lastRun;
  const good = s.lastGood;
  const goodAt = time(good?.at);
  const goodAge = now - goodAt;
  let status: HealthStatus;
  let detail: string;
  if (!last) {
    status = 'warn';
    detail = 'No backup has run yet';
  } else if (!last.ok) {
    status = 'bad';
    detail = `The last backup (${ago(now - time(last.at))} ago) failed: ${(last.error ?? 'no message').slice(0, 160)}`;
    if (Number.isFinite(goodAt)) detail += ` · last good one ${ago(goodAge)} ago`;
  } else if (!Number.isFinite(goodAt) || goodAge > o.maxAgeHours * HOUR) {
    status = 'bad';
    detail = Number.isFinite(goodAt) ? `No backup for ${ago(goodAge)}` : 'No good backup yet';
  } else {
    const items = (good?.items ?? []).filter((i) => i.ok).length;
    // Warnings are notes (e.g. a live browser profile changed while it was read), not failures.
    status = 'ok';
    detail = `${ago(goodAge)} ago · ${mb(good?.archive?.bytes)} · ${items} items checked${
      good?.archive?.key ? ', encrypted and uploaded' : ', kept locally only'
    }${good?.warnings?.length ? ` · ${good.warnings.length} note${good.warnings.length === 1 ? '' : 's'}` : ''}`;
  }
  out.push({ id: 'offsite', name: 'Off-site backup', status, detail });

  const t = s.restoreTest;
  const tAt = time(t?.at);
  if (!t || !Number.isFinite(tAt))
    out.push({
      id: 'restore-test',
      name: 'Restore test',
      status: 'warn',
      detail: 'Never tested: run deploy/backup/restore-test.sh',
    });
  else if (!t.ok)
    out.push({
      id: 'restore-test',
      name: 'Restore test',
      status: 'bad',
      detail: `Failed ${ago(now - tAt)} ago: ${(t.message ?? '').slice(0, 160)}`,
    });
  else
    out.push({
      id: 'restore-test',
      name: 'Restore test',
      status: now - tAt > o.restoreTestDays * DAY ? 'warn' : 'ok',
      detail: `Passed ${ago(now - tAt)} ago${t.message ? `: ${t.message.slice(0, 120)}` : ''}`,
    });
  return out;
}
