import type { RateLimit } from '../runner/stream.js';
import { midnight, zonedClock } from '../util/time.js';

/**
 * Usage limits, host-wide: once a run hits one, scheduled jobs and queue runs on that CLI wait until it
 * resets instead of each starting and failing. Their slots are kept (`held`) and the latest one of each
 * job runs once the hold ends (`Scheduler.retryHeld`).
 */

const HOUR = 3_600_000;
/** When the reset time can't be read: look again this much later. */
export const UNKNOWN_RESET_MS = HOUR;
/** A held slot older than this when the limit resets is dropped rather than run late. */
export const HELD_RETRY_MS = 24 * HOUR;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "resets Nov 22, 3:30pm (Asia/Kolkata)", "resets 3pm", "resets at 10:15 PM". */
const RESET_TEXT =
  /resets(?:\s+at)?\s+(?:([a-z]{3,9})\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)(?:\s*\(([^)]+)\))?/i;

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The reset time in a CLI's limit message, read in its own timezone (else `timeZone`). */
export function parseResetText(text: string, timeZone: string, now: number): number | undefined {
  const m = RESET_TEXT.exec(text);
  if (!m) return undefined;
  const [, monthName, dayText, hourText, minuteText, ampm, zone] = m;
  const tz = zone && validZone(zone.trim()) ? zone.trim() : timeZone;
  let hour = Number(hourText) % 12;
  if (ampm?.toLowerCase() === 'pm') hour += 12;
  const minutes = hour * 60 + Number(minuteText ?? 0);
  const today = zonedClock(now, tz).day;
  const at = (day: string) => midnight(day, tz) + minutes * 60_000;
  if (monthName && dayText) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (month < 0) return undefined;
    const year = Number(today.slice(0, 4));
    const day = (y: number) => `${y}-${String(month + 1).padStart(2, '0')}-${dayText.padStart(2, '0')}`;
    const thisYear = at(day(year));
    // "Jan 2" read on Dec 30 is next year's.
    return thisYear < now - 2 * 86_400_000 ? at(day(year + 1)) : thisYear;
  }
  const todayAt = at(today);
  if (todayAt > now) return todayAt;
  const [y, mo, d] = today.split('-').map(Number) as [number, number, number];
  return at(new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10));
}

/**
 * When a run's usage limit resets (ms): the rejected window's reset time the CLI reported, else the time
 * in its message, else an hour from now. Never earlier than a minute from now.
 */
export function limitResetAt(
  outcome: { rateLimit?: RateLimit; error?: string; text?: string },
  timeZone: string,
  now: number,
): number {
  const ms = (t: number) => (t > 1e12 ? t : t * 1000);
  const rl = outcome.rateLimit;
  const rejected = Object.values(rl?.windows ?? {})
    .filter((w) => w.status === 'rejected' && w.resetsAt)
    .map((w) => ms(w.resetsAt as number));
  const reported = rejected.length
    ? Math.max(...rejected)
    : rl?.status === 'rejected' && rl.resetsAt
      ? ms(rl.resetsAt)
      : undefined;
  const at =
    reported ??
    parseResetText(`${outcome.error ?? ''}\n${outcome.text ?? ''}`, timeZone, now) ??
    now + UNKNOWN_RESET_MS;
  return Math.max(at, now + 60_000);
}

/** Per CLI (`claude`, `agy`): held until its limit resets. */
export class LimitHolds {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A run on `harness` hit its limit, which resets at `resetAt`. */
  hit(harness: string, resetAt: number): void {
    this.until.set(harness, Math.max(this.until.get(harness) ?? 0, resetAt));
  }

  /** When `harness` may run again, while it is held; else undefined. */
  heldUntil(harness: string): number | undefined {
    const t = this.until.get(harness);
    return t !== undefined && t > this.now() ? t : undefined;
  }

  /** The harnesses whose hold ended since the last call (each once). */
  ended(): string[] {
    const out: string[] = [];
    for (const [harness, t] of this.until)
      if (t <= this.now()) {
        this.until.delete(harness);
        out.push(harness);
      }
    return out;
  }

  /** Every hold still on, for the dashboard and `/health`. */
  active(): Record<string, number> {
    return Object.fromEntries([...this.until].filter(([, t]) => t > this.now()));
  }
}
