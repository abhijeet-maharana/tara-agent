import type { StoredRun } from '../store/store.js';
import { addDays, midnight } from '../util/time.js';
import {
  anchor,
  clock,
  type DashboardContext,
  esc,
  jobViewTabs,
  layout,
  pageHead,
  projectTag,
  runHref,
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
  /** A queue's slot: the queue it runs, and how many approved items wait for it. */
  queue?: string;
  waiting?: number;
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
  queue?: string;
  waiting?: number;
}

export interface DayPlan {
  /** Midnight and the next midnight, in the host timezone. */
  start: number;
  end: number;
  slots: Slot[];
  /** Jobs that run too often to draw, with the minutes between their first two starts. */
  often: Array<{ project: string; id: string; name: string; everyMinutes?: number }>;
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
      const [a, b] = job.starts;
      often.push({
        project: job.project,
        id: job.id,
        name: job.name,
        everyMinutes: a !== undefined && b !== undefined ? Math.round((b - a) / 60_000) : undefined,
      });
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
        queue: job.queue,
        waiting: job.waiting,
      });
    }
  }
  slots.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));

  // A queue slot with nothing approved won't run: drawn, but it takes no time and clashes with nothing.
  const real = slots.filter((s) => !(s.queue && !s.waiting && !s.run));
  const overlaps: DayPlan['overlaps'] = [];
  const tight: DayPlan['tight'] = [];
  for (let i = 0; i < real.length; i++) {
    const a = real[i] as Slot;
    for (let j = i + 1; j < real.length && (real[j] as Slot).start < a.end; j++)
      overlaps.push({ a, b: real[j] as Slot });
    const next = real[i + 1];
    if (next) {
      const gap = Math.round((next.start - a.end) / 60_000);
      if (gap >= 0 && gap < TIGHT_GAP_MINUTES) tight.push({ a, b: next, gapMinutes: gap });
    }
  }

  // Busy time is the union of the slots; free windows are the long gaps between them.
  const free: DayPlan['free'] = [];
  let busy = 0;
  let cursor = start;
  for (const s of real) {
    if (s.start - cursor >= FREE_MINUTES * 60_000) free.push({ start: cursor, end: s.start });
    const from = Math.max(cursor, s.start);
    const to = Math.min(end, s.end);
    if (to > from) busy += to - from;
    cursor = Math.max(cursor, s.end);
  }
  if (end - cursor >= FREE_MINUTES * 60_000) free.push({ start: cursor, end });
  return { start, end, slots, often, overlaps, tight, free, busyMinutes: Math.round(busy / 60_000) };
}

/** "Every 10 min", "Hourly", "Every 2h". */
const every = (minutes: number | undefined) =>
  minutes === undefined
    ? 'Often'
    : minutes === 60
      ? 'Hourly'
      : minutes < 60
        ? `Every ${minutes} min`
        : `Every ${span(minutes)}`;

const CSS = `<style>.timeline li.now{border-bottom:2px solid var(--accent);color:var(--accent);font-weight:600;padding:3px 0}.timeline li.now .when{color:var(--accent)}</style>`;

export function schedulePage(
  ctx: DashboardContext,
  plan: DayPlan,
  opts: {
    day: string;
    today: string;
    project?: string;
    now: number;
    /** Running jobs (`project:id`) with the session to watch each in. */
    running?: Map<string, string | undefined>;
    /** Projects that have jobs: the others get no chip. */
    projectsWithJobs?: string[];
  },
): string {
  const tz = ctx.timeZone;
  const { now } = opts;
  const link = (day: string, project = opts.project) => {
    const p = new URLSearchParams({ ...(day !== opts.today && { day }), ...(project && { project }) });
    return `/schedule${p.size ? `?${p}` : ''}`;
  };
  // Yesterday too: its runs show what ran, and "no run" what was missed.
  const dayChips = Array.from({ length: 8 }, (_, n) => {
    const i = n - 1;
    const day = addDays(opts.today, i);
    const label =
      i === 0
        ? 'Today'
        : i === 1
          ? 'Tomorrow'
          : i === -1
            ? 'Yesterday'
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
          ...ctx.projects
            .filter((p) => !opts.projectsWithJobs || opts.projectsWithJobs.includes(p.config.name))
            .map(
              (p) =>
                `<a class="chip${opts.project === p.config.name ? ' on' : ''}" href="${link(opts.day, p.config.name)}">${esc(
                  p.config.title ?? p.config.name,
                )}</a>`,
            ),
        ].join('')
      : '';

  const clashing = new Set(plan.overlaps.flatMap(({ a, b }) => [a, b]));
  // The latest planned slot of a running job that has no run yet: that is the one running.
  const runningSlot = (s: Slot) => {
    const key = `${s.project}:${s.id}`;
    if (s.run || s.start > now || !opts.running?.has(key)) return false;
    return !plan.slots.some(
      (o) => o !== s && o.project === s.project && o.id === s.id && o.start > s.start && o.start <= now,
    );
  };
  const queueTag = (s: Slot) =>
    s.queue
      ? `<span class="tag dim" title="Runs at this time when the queue has approved items">${esc(s.queue)} queue · ${
          s.waiting ? `${s.waiting} approved` : 'nothing approved'
        }</span>`
      : '';
  const rows: Array<{ at: number; html: string }> = [
    ...plan.slots.map((s) => {
      const live = runningSlot(s);
      const session = opts.running?.get(`${s.project}:${s.id}`);
      const idle = s.queue && !s.waiting && !s.run && s.start > now;
      return {
        at: s.start,
        html: `<li${clashing.has(s) ? ' class="clash"' : idle ? ' class="free"' : ''}><span class="when">${esc(clock(s.start, tz))} – ${esc(clock(s.end, tz))}</span>
<span><a href="/jobs#${anchor(s)}">${esc(s.name)}</a> ${projectTag(ctx, s.project)}${queueTag(s)}</span>
<span class="actions">${
          s.run
            ? `<a href="${runHref(s.run)}">${runTag(s.run.status)}</a>`
            : live
              ? `<a class="tag" href="${session ? `/sessions/${esc(session)}` : `/jobs#${anchor(s)}`}">● running now</a>`
              : s.start < now && !s.queue
                ? '<span class="tag dim">no run</span>'
                : ''
        }<span class="dim">${s.minutes} min</span></span></li>`,
      };
    }),
    // Today: where now falls between the runs.
    ...(opts.day === opts.today
      ? [
          {
            at: now,
            html: `<li class="now"><span class="when">Now · ${esc(clock(now, tz))}</span><span></span><span></span></li>`,
          },
        ]
      : []),
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
      `<li><b>${esc(a.name)}</b> (${esc(clock(a.start, tz))}, ${a.minutes} min planned) overlaps <b>${esc(b.name)}</b> (${esc(clock(b.start, tz))}). <a href="/jobs#${anchor(a)}">Check its length →</a></li>`,
  );
  const dayMinutes = Math.round((plan.end - plan.start) / 60_000);
  const summary = `${plan.slots.length} runs · busy ${span(plan.busyMinutes)} · free ${Math.round(
    100 - (plan.busyMinutes / dayMinutes) * 100,
  )}%`;

  return layout(
    ctx,
    'Timeline',
    'Jobs',
    `${CSS}${pageHead('Jobs', `A day of runs: when each job runs and for how long (its planned length, set on the job in List). Times in ${esc(tz)}.`)}
${jobViewTabs('timeline', opts.project)}
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
              `<li><span class="when">${esc(every(o.everyMinutes))}</span><span><a href="/jobs#${anchor(o)}">${esc(o.name)}</a> ${projectTag(ctx, o.project)}</span><span></span></li>`,
          )
          .join('')}</ul>`,
        { sub: 'not drawn on the timeline' },
      )
    : ''
}`,
  );
}
