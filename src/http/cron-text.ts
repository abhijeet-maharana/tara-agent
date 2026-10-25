/**
 * Plain-English schedules for the dashboard ("Mon–Fri 3:05 PM"). Anything outside the usual
 * "minute hour day * weekday" shape is shown as the raw expression.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const time = (h: number, m: number) =>
  `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;

const ordinal = (n: number) => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${suffix}`;
};

/** "1-5" → "Mon–Fri", "1,3,5" → "Mon, Wed, Fri"; undefined unless it is numbers, commas and ranges. */
function list(field: string, name: (n: number) => string | undefined): string | undefined {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(field)) return undefined;
  const parts = field.split(',').map((part) => part.split('-').map((n) => name(Number(n))));
  if (parts.flat().some((p) => p === undefined)) return undefined;
  return parts.map((p) => p.join('–')).join(', ');
}

/**
 * Whether two zone names keep the same clock, so aliases such as Asia/Calcutta and Asia/Kolkata
 * count as one. Compared in January and July so zones that differ only in daylight saving don't match.
 */
export function sameZone(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const year = new Date().getUTCFullYear();
    return [0, 6].every((month) => {
      const at = new Date(Date.UTC(year, month, 1, 12));
      const fmt = (timeZone: string) => at.toLocaleString('en-GB', { timeZone, hour12: false });
      return fmt(a) === fmt(b);
    });
  } catch {
    return false;
  }
}

/** `tz` is shown only when it differs from `hostTz`, the zone every other time on the page is in. */
export function cronText(cron: string, tz?: string, hostTz?: string): string {
  const parts = cron.trim().split(/\s+/);
  const [min = '', hour = '', dom = '', month = '', dow = ''] = parts;
  if (parts.length !== 5 || !/^\d+$/.test(min) || !/^\d+(,\d+)*$/.test(hour) || month !== '*') return cron;
  const times = hour
    .split(',')
    .map((h) => time(Number(h), Number(min)))
    .join(' & ');
  const zone = tz && !(hostTz && sameZone(tz, hostTz)) ? ` (${tz})` : '';
  if (dom === '*' && dow === '*') return `Daily ${times}${zone}`;
  if (dom === '*') {
    const days = list(dow, (n) => DAYS[n]);
    if (!days) return cron;
    return `${/^\d+$/.test(dow) ? `Every ${days}` : days} ${times}${zone}`;
  }
  if (dow === '*') {
    const dates = list(dom, (n) => (n >= 1 && n <= 31 ? ordinal(n) : undefined));
    return dates ? `${dates} of the month, ${times}${zone}` : cron;
  }
  return cron;
}
