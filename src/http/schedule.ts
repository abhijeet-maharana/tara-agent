import type { StoredRun } from '../store/store.js';
import { addDays, midnight } from '../util/time.js';
import {
  anchor,
  clock,
  type DashboardContext,
  esc,
  layout,
  pageHead,
  projectTag,
  runTag,
  section,
  span,
} from './dashboard.js';

/**
 * The schedule view: one day of every project's jobs as a timeline (from the scheduler's own cron
 * clocks, so it always matches what will run), with each job's usual length, the runs that already
 * happened, overlapping jobs, tight gaps and free windows.
 */

/** Usual length of a job without `durationMinutes`. */
export const DEFAULT_MINUTES = 15;
/** Jobs with more runs a day than this are listed as "runs often", not drawn. */
export const MAX_RUNS_PER_DAY = 12;
/** Back-to-back jobs closer than this are flagged. */
const TIGHT_GAP_MINUTES = 10;
/** Gaps at least this long are shown as free windows. */
const FREE_MINUTES = 30;
/** A run belongs to a planned slot when it started this soon before or this long after it. */
const MATCH_BEFORE_MS = 60_000;
const MATCH_AFTER_MS = 2 * 3_600_000;

export interface PlanJob {
  project: string;
  id: string;
  name: string;
  durationMinutes?: number;
  /** Planned start times that day (more than MAX_RUNS_PER_DAY means it runs too often to draw). */
  starts: number[];
}

export interface Slot {
  project: string;
  id: string;
  name: string;
  start: number;
  end: number;
  minutes: number;
  /** The run that already happened for this slot, if any. */
  run?: StoredRun;
}

export interface DayPlan {
  /** Midnight and the next midnight, in the host timezone. */
  start: number;
  end: number;
  slots: Slot[];
  often: Array<{ project: string; id: string; name: string; runs: number }>;
  overlaps: Array<{ a: Slot; b: Slot }>;
  tight: Array<{ a: Slot; b: Slot; gapMinutes: number }>;
  free: Array<{ start: number; end: number }>;
  busyMinutes: number;
}

export const isDayKey = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function planDay(jobs: PlanJob[], runs: StoredRun[], start: number, end: number): DayPlan {
  const slots: Slot[] = [];
  const often: DayPlan['often'] = [];
  for (const job of jobs) {
    if (job.starts.length > MAX_RUNS_PER_DAY) {
      often.push({ project: job.project, id: job.id, name: job.name, runs: job.starts.length });
      continue;
    }
    const minutes = job.durationMinutes ?? DEFAULT_MINUTES;
    for (const at of job.starts) {
      const run = runs.find(
        (r) =>
          r.project === job.project &&
          r.jobId === job.id &&
          r.startedAt >= at - MATCH_BEFORE_MS &&
          r.startedAt < at + MATCH_AFTER_MS,
      );
      slots.push({
        project: job.project,
        id: job.id,
        name: job.name,
        start: at,
        end: at + minutes * 60_000,
        minutes,
        run,
      });
    }
  }
  slots.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));

  const overlaps: DayPlan['overlaps'] = [];
  const tight: DayPlan['tight'] = [];
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i] as Slot;
    for (let j = i + 1; j < slots.length && (slots[j] as Slot).start < a.end; j++)
      overlaps.push({ a, b: slots[j] as Slot });
    const next = slots[i + 1];
    if (next) {
      const gap = Math.round((next.start - a.end) / 60_000);
      if (gap >= 0 && gap < TIGHT_GAP_MINUTES) tight.push({ a, b: next, gapMinutes: gap });
    }
  }

  // Busy time is the union of the slots; free windows are the long gaps between them.
  const free: DayPlan['free'] = [];
  let busy = 0;
  let cursor = start;
  for (const s of slots) {
    if (s.start - cursor >= FREE_MINUTES * 60_000) free.push({ start: cursor, end: s.start });
    const from = Math.max(cursor, s.start);
    const to = Math.min(end, s.end);
    if (to > from) busy += to - from;
    cursor = Math.max(cursor, s.end);
  }
  if (end - cursor >= FREE_MINUTES * 60_000) free.push({ start: cursor, end });
  return { start, end, slots, often, overlaps, tight, free, busyMinutes: Math.round(busy / 60_000) };
}

const DAY_SCRIPT = `
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-duration]');
  if (!b) return;
  const { job, name, duration } = b.dataset;
  const value = prompt('Usual length of "' + name + '" in minutes', duration);
  if (value === null) return;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) return toast('Enter whole minutes, 1 to 600', { error: true });
  try { await post('/jobs/' + job + '/duration', { minutes }); toast(name + ': ' + minutes + ' min'); reload(); }
  catch (err) { toast(err.message, { error: true }); }
});
`;

export function schedulePage(
  ctx: DashboardContext,
  plan: DayPlan,
  opts: { day: string; today: string; project?: string; now: number },
): string {
  const tz = ctx.timeZone;
  const { now } = opts;
  const link = (day: string, project = opts.project) => {
    const p = new URLSearchParams({ ...(day !== opts.today && { day }), ...(project && { project }) });
    return `/schedule${p.size ? `?${p}` : ''}`;
  };
  const dayChips = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(opts.today, i);
    const label =
      i === 0
        ? 'Today'
        : i === 1
          ? 'Tomorrow'
          : new Date(midnight(day, tz)).toLocaleDateString('en-GB', {
              timeZone: tz,
              weekday: 'short',
              day: 'numeric',
            });
    return `<a class="chip${day === opts.day ? ' on' : ''}" href="${link(day)}">${esc(label)}</a>`;
  }).join('');
  const projectChips =
    ctx.projects.length > 1
      ? [
          `<a class="chip${opts.project ? '' : ' on'}" href="${link(opts.day, '')}">All</a>`,
          ...ctx.projects.map(
            (p) =>
              `<a class="chip${opts.project === p.config.name ? ' on' : ''}" href="${link(opts.day, p.config.name)}">${esc(
                p.config.title ?? p.config.name,
              )}</a>`,
          ),
        ].join('')
      : '';

  const clashing = new Set(plan.overlaps.flatMap(({ a, b }) => [a, b]));
  const rows: Array<{ at: number; html: string }> = [
    ...plan.slots.map((s) => ({
      at: s.start,
      html: `<li${clashing.has(s) ? ' class="clash"' : ''}><span class="when">${esc(clock(s.start, tz))} – ${esc(clock(s.end, tz))}</span>
<span><a href="/jobs#${anchor(s)}">${esc(s.name)}</a> ${projectTag(ctx, s.project)}</span>
<span class="actions">${
        s.run
          ? `<a href="/runs/${s.run.id}">${runTag(s.run.status)}</a>`
          : s.start < now
            ? '<span class="tag dim">no run</span>'
            : ''
      }<button type="button" class="btn quiet" data-duration="${s.minutes}" data-job="${esc(s.project)}/${esc(s.id)}" data-name="${esc(
        s.name,
      )}" title="Change the usual length">${s.minutes} min</button></span></li>`,
    })),
    ...plan.free.map((f) => ({
      at: f.start,
      html: `<li class="free"><span class="when">${esc(clock(f.start, tz))} – ${esc(clock(f.end, tz))}</span><span>Free · ${span(
        Math.round((f.end - f.start) / 60_000),
      )}</span><span></span></li>`,
    })),
  ].sort((a, b) => a.at - b.at);

  // Back-to-back jobs are normal (the API and `cron:check` report them); only real overlaps are flagged here.
  const warnings = plan.overlaps.map(
    ({ a, b }) =>
      `<li><b>${esc(a.name)}</b> (${esc(clock(a.start, tz))}, ${a.minutes} min) overlaps <b>${esc(b.name)}</b> (${esc(clock(b.start, tz))})</li>`,
  );
  const dayMinutes = Math.round((plan.end - plan.start) / 60_000);
  const summary = `${plan.slots.length} runs · busy ${span(plan.busyMinutes)} · free ${Math.round(
    100 - (plan.busyMinutes / dayMinutes) * 100,
  )}%`;

  return layout(
    ctx,
    'Schedule',
    'Schedule',
    `${pageHead('Schedule', `When jobs run and how long they usually take. Times in ${esc(tz)}.`)}
<div class="toolbar"><div class="chips">${dayChips}</div></div>
${projectChips ? `<div class="toolbar"><div class="chips">${projectChips}</div></div>` : ''}
${warnings.length ? `<div class="alert"><b>${warnings.length === 1 ? 'Two jobs overlap' : `${warnings.length} overlaps`}</b><ul>${warnings.join('')}</ul></div>` : ''}
${section('Timeline', rows.length ? `<ul class="timeline">${rows.map((r) => r.html).join('')}</ul>` : '<div class="empty">Nothing scheduled this day.</div>', { sub: summary })}
${
  plan.often.length
    ? section(
        'Runs often',
        `<ul class="timeline">${plan.often
          .map(
            (o) =>
              `<li><span class="when">${o.runs} times</span><span><a href="/jobs#${anchor(o)}">${esc(o.name)}</a> ${projectTag(ctx, o.project)}</span><span></span></li>`,
          )
          .join('')}</ul>`,
        { sub: 'not drawn on the timeline' },
      )
    : ''
}`,
    { script: DAY_SCRIPT },
  );
}
