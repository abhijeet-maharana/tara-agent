/** Calendar maths in an IANA timezone without a date library (Intl does the zone rules). */

/** Milliseconds the timezone is ahead of UTC at `ms`. */
export function offset(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  const n = (type: string) => Number(parts[type]);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return local - Math.floor(ms / 1000) * 1000;
}

/** "2026-10-25": the calendar day of `ms` in the timezone. */
export const dayKey = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    ms,
  );

/** Midnight of a calendar day (`YYYY-MM-DD`) in the timezone. */
export function midnight(key: string, timeZone: string): number {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  return utc - offset(utc - offset(utc, timeZone), timeZone);
}

/** The calendar day `days` after `key`. */
export function addDays(key: string, days: number): string {
  const [y = 0, m = 1, d = 1] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Day of the week (`mon`…) and minutes after midnight of `ms` in the timezone. */
export function zonedClock(ms: number, timeZone: string): { weekday: string; minutes: number; day: string } {
  const local = ms + offset(ms, timeZone);
  const d = new Date(local);
  return {
    weekday: WEEKDAYS[d.getUTCDay()] as string,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    day: d.toISOString().slice(0, 10),
  };
}

/** True when `weekday` (`mon`…) is in a spec like `mon-fri`, `tue,thu` or `mon-wed,sat`. */
export function dayMatches(spec: string, weekday: string): boolean {
  const idx = (d: string) => (WEEKDAYS.indexOf(d) + 6) % 7; // monday = 0
  const w = idx(weekday);
  return spec.split(',').some((part) => {
    const [from = '', to = from] = part.split('-');
    const a = idx(from);
    const b = idx(to);
    return a <= b ? w >= a && w <= b : w >= a || w <= b;
  });
}

/** "14:40" → 880. */
export const minutesOf = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
