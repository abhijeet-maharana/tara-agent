import type { HealthStatus } from '../health/monitor.js';
import type { DayRuns, JobTrend, LogGroup, Totals, Uptime } from '../health/trends.js';
import type { HostSample } from '../store/store.js';
import { type DashboardContext, esc, layout, pageHead, relative, section } from './dashboard.js';

/**
 * The Health page's other two views: Trends (runs, cost, usage, job lengths, uptime and the machine
 * over days) and Logs (warnings and errors, grouped). Charts are plain HTML and SVG in the dashboard's
 * dark look; every mark has a hover tip and every chart a table view.
 */

export type HealthView = 'now' | 'trends' | 'logs';

export const healthTabs = (view: HealthView, query = '') => {
  const tab = (v: HealthView, href: string, label: string) =>
    `<a class="chip${view === v ? ' on' : ''}" href="${href}${v === view ? '' : query}"${view === v ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<div class="toolbar"><div class="chips views">${tab('now', '/health', 'Now')}${tab('trends', '/health/trends', 'Trends')}${tab(
    'logs',
    '/health/logs',
    'Logs',
  )}</div></div>`;
};

// Colours: run results are states (status palette, always with a label); projects are identities
// (categorical slots in fixed order, dark steps, validated on --card-bg); one-series charts use slot 1.
const RESULT_COLOR = { worked: '#0ca30c', quiet: '#64748b', failed: '#d03b3b', stopped: '#fab219' } as const;
const RESULT_LABEL = {
  worked: 'Did work',
  quiet: 'Nothing to do',
  failed: 'Failed',
  stopped: 'Stopped',
} as const;
const PROJECT_COLORS = ['#3987e5', '#d95926', '#199e70'];
const OTHER_COLOR = '#64748b';
const SERIES_1 = '#3987e5';
const STATUS_COLOR: Record<HealthStatus, string> = { ok: '#0ca30c', warn: '#fab219', bad: '#d03b3b' };
const STATUS_WORD: Record<HealthStatus, string> = { ok: 'fine', warn: 'needs a look', bad: 'broken' };

export const VIZ_STYLE = `<style>
.viz{margin:0;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px 10px}
.viz-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin-bottom:10px}
.viz-head h3{margin:0;font-size:14px;color:var(--text-heading);font-weight:600}
.viz-head .note{font-size:12.5px;color:var(--text-dim)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--text);margin-left:auto}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.plot{position:relative;height:var(--h,150px);margin-left:40px}
.yaxis span{position:absolute;left:-40px;width:34px;text-align:right;font-size:11px;color:var(--text-dim);transform:translateY(50%);font-variant-numeric:tabular-nums}
.gridline{position:absolute;left:0;right:0;border-top:1px solid #1c2638}
.gridline.base{border-top-color:#2e3e5c}
.bars{position:absolute;inset:0;display:flex;align-items:flex-end;gap:3px}
.bars .col{flex:1;height:100%;display:flex;align-items:flex-end;cursor:default;border-radius:4px 4px 0 0;outline-offset:2px}
.bars .col:hover,.bars .col:focus-visible{background:rgba(148,163,184,.08)}
.bars .stack{width:100%;display:flex;flex-direction:column-reverse;gap:2px;border-radius:4px 4px 0 0;overflow:hidden}
.bars .stack i{display:block;min-height:2px}
.xaxis{position:relative;height:18px;margin-left:40px;font-size:11px;color:var(--text-dim)}
.xaxis span{position:absolute;top:4px;transform:translateX(-50%);white-space:nowrap}
.xaxis span.first{transform:none}.xaxis span.last{transform:translateX(-100%)}
.lplot svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.lplot polyline{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.lplot .ref{stroke:#94a3b8;stroke-width:1;stroke-dasharray:4 4;vector-effect:non-scaling-stroke}
.lplot .cross{position:absolute;top:0;bottom:0;width:1px;background:#94a3b8;display:none;pointer-events:none}
.lplot .pt{position:absolute;width:10px;height:10px;border-radius:50%;border:2px solid var(--card-bg);transform:translate(-50%,50%);display:none;pointer-events:none}
.lplot.on .cross,.lplot.on .pt{display:block}
.reflabel{position:absolute;right:0;font-size:11px;color:var(--text-dim);transform:translateY(-110%)}
.viz details{margin-top:6px;font-size:12.5px;color:var(--text-dim)}
.viz summary{cursor:pointer;width:max-content}
.viz table,.tbl{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
.viz th,.viz td,.tbl th,.tbl td{text-align:right;padding:5px 8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;white-space:nowrap}
.viz th:first-child,.viz td:first-child,.tbl th:first-child,.tbl td:first-child{text-align:left}
.tbl th{color:var(--text-dim);font-weight:500;font-size:12px}
.tbl td.name{white-space:normal;min-width:160px}.tbl td.name a{color:var(--text-heading);text-decoration:none;font-weight:600}
.tbl td.name small{display:block;color:var(--text-dim);font-weight:400;overflow-wrap:anywhere}
.tbl-wrap{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:4px 10px;overflow-x:auto}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:24px}
.kpi{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px}
.kpi b{display:block;font-size:22px;color:var(--text-heading);font-weight:650}
.kpi span{display:block;font-size:12.5px;color:var(--text-dim)}
.kpi small{display:block;font-size:12px;color:var(--text-dim);margin-top:2px}
.kpi small.up-bad,.kpi small.down-bad{color:var(--amber)}.kpi small.up-good,.kpi small.down-good{color:var(--green)}
.strips{display:flex;flex-direction:column;gap:10px}
.strip-row{display:grid;grid-template-columns:minmax(140px,240px) 1fr 64px;gap:12px;align-items:center;font-size:13px}
.strip-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-heading)}
.strip-row .pc{text-align:right;color:var(--text-dim);font-variant-numeric:tabular-nums}
.strip{position:relative;height:14px;border-radius:4px;background:#1c2638;overflow:hidden}
.strip i{position:absolute;top:0;bottom:0;border-right:2px solid var(--card-bg)}
.viztip{position:fixed;z-index:50;pointer-events:none;background:#020617;border:1px solid var(--border-light);color:var(--text);border-radius:8px;padding:7px 9px;font-size:12.5px;line-height:1.45;max-width:280px;white-space:pre-line;display:none;box-shadow:0 6px 20px rgba(0,0,0,.4)}
.loggroups{display:flex;flex-direction:column;gap:6px}
.logrow{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px}
.logrow summary{display:flex;gap:10px;align-items:flex-start;cursor:pointer;list-style:none}
.logrow summary::-webkit-details-marker{display:none}
.logrow .dot{margin-top:5px}
.logrow code{font-size:12.5px;color:var(--text);overflow-wrap:anywhere;white-space:pre-wrap}
.logrow .cnt{margin-left:auto;white-space:nowrap;font-size:12.5px;color:var(--text-dim);font-variant-numeric:tabular-nums}
.logrow pre{margin:8px 0 2px;padding:8px 10px;background:#0b1220;border-radius:6px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
@media (max-width:760px){.strip-row{grid-template-columns:1fr 56px}.strip-row .strip{grid-column:1/-1;grid-row:2}}
@media (forced-colors:active){.bars .stack i,.strip i,.legend i{forced-color-adjust:none}}
</style>`;

/** Hover tips for any [data-tip], and the crosshair of line charts (their points are in data-points). */
export const VIZ_SCRIPT = `
(() => {
  const tip = document.createElement('div'); tip.className = 'viztip'; tip.setAttribute('role', 'tooltip'); document.body.append(tip);
  const show = (text, x, y) => { tip.textContent = text; tip.style.display = 'block';
    const r = tip.getBoundingClientRect(); tip.style.left = Math.min(innerWidth - r.width - 8, x + 14) + 'px'; tip.style.top = Math.max(8, y - r.height - 10) + 'px'; };
  const hide = () => { tip.style.display = 'none'; };
  document.addEventListener('mouseover', (e) => { const t = e.target.closest('[data-tip]'); if (t) show(t.dataset.tip, e.clientX, e.clientY); });
  document.addEventListener('mousemove', (e) => { const t = e.target.closest('[data-tip]'); if (t) show(t.dataset.tip, e.clientX, e.clientY); else if (!e.target.closest('.lplot')) hide(); });
  document.addEventListener('focusin', (e) => { const t = e.target.closest('[data-tip]'); if (t) { const r = t.getBoundingClientRect(); show(t.dataset.tip, r.left + r.width / 2, r.top); } });
  document.addEventListener('focusout', hide);
  document.querySelectorAll('.lplot').forEach((p) => {
    const pts = JSON.parse(p.dataset.points || '[]'); if (!pts.length) return;
    const [x0, x1, max] = [Number(p.dataset.x0), Number(p.dataset.x1), Number(p.dataset.max)];
    const cross = p.querySelector('.cross'), dot = p.querySelector('.pt');
    p.addEventListener('mousemove', (e) => {
      const r = p.getBoundingClientRect(); const t = x0 + ((e.clientX - r.left) / r.width) * (x1 - x0);
      let best = pts[0]; for (const q of pts) if (Math.abs(q[0] - t) < Math.abs(best[0] - t)) best = q;
      const left = ((best[0] - x0) / (x1 - x0)) * 100, bottom = (best[1] / max) * 100;
      cross.style.left = left + '%'; dot.style.left = left + '%'; dot.style.bottom = bottom + '%';
      p.classList.add('on'); show(best[2], e.clientX, e.clientY);
    });
    p.addEventListener('mouseleave', () => { p.classList.remove('on'); hide(); });
  });
})();`;

/** 1, 2 or 5 times a power of ten, at least `v` (and at least `min`). */
export function niceMax(v: number, min = 1): number {
  const x = Math.max(v, min);
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

const dayLabel = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  });
};
const weekday = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
};

function xLabels(labels: string[]): string {
  const n = labels.length;
  if (!n) return '';
  const every = Math.max(1, Math.ceil(n / 6));
  const shown = labels
    .map((l, i) => ({ l, i }))
    .filter(({ i }) => i === 0 || i === n - 1 || (i % every === 0 && n - 1 - i >= every / 2));
  return `<div class="xaxis" aria-hidden="true">${shown
    .map(
      ({ l, i }) =>
        `<span class="${i === 0 ? 'first' : i === n - 1 ? 'last' : ''}" style="left:${n === 1 ? 50 : ((i + 0.5) / n) * 100}%">${esc(l)}</span>`,
    )
    .join('')}</div>`;
}

function yAxis(max: number, fmt: (v: number) => string): string {
  return `<div class="yaxis" aria-hidden="true">${[0, 0.5, 1]
    .map(
      (f) =>
        `<span style="bottom:${f * 100}%">${esc(fmt(max * f))}</span><i class="gridline${f === 0 ? ' base' : ''}" style="bottom:${f * 100}%"></i>`,
    )
    .join('')}</div>`;
}

const legend = (items: Array<{ label: string; color: string }>) =>
  items.length > 1
    ? `<div class="legend">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`).join('')}</div>`
    : '';

interface Series {
  label: string;
  color: string;
  values: number[];
}

/** Stacked columns, one per day: series bottom-up in the order given. */
export function stackedBars(opts: {
  title: string;
  note?: string;
  days: string[];
  series: Series[];
  fmt: (v: number) => string;
  height?: number;
}): string {
  const totals = opts.days.map((_, i) => opts.series.reduce((t, s) => t + (s.values[i] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals), opts.fmt(1).startsWith('$') ? 0.01 : 1);
  const cols = opts.days
    .map((day, i) => {
      const total = totals[i] ?? 0;
      const parts = opts.series.filter((s) => (s.values[i] ?? 0) > 0);
      const tip = [
        `${weekday(day)}: ${opts.fmt(total)}`,
        ...opts.series
          .filter((s) => (s.values[i] ?? 0) > 0)
          .map((s) => `${s.label}: ${opts.fmt(s.values[i] ?? 0)}`),
      ].join('\n');
      return `<div class="col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ', '))}"><div class="stack" style="height:${
        (total / max) * 100
      }%">${parts.map((s) => `<i style="flex:${s.values[i]};background:${s.color}"></i>`).join('')}</div></div>`;
    })
    .join('');
  const table = `<details><summary>Table</summary><table><thead><tr><th>Day</th>${opts.series
    .map((s) => `<th>${esc(s.label)}</th>`)
    .join('')}<th>Total</th></tr></thead><tbody>${opts.days
    .map(
      (d, i) =>
        `<tr><td>${esc(weekday(d))}</td>${opts.series.map((s) => `<td>${esc(opts.fmt(s.values[i] ?? 0))}</td>`).join('')}<td>${esc(
          opts.fmt(totals[i] ?? 0),
        )}</td></tr>`,
    )
    .reverse()
    .join('')}</tbody></table></details>`;
  return `<figure class="viz"><div class="viz-head"><h3>${esc(opts.title)}</h3>${opts.note ? `<span class="note">${esc(opts.note)}</span>` : ''}${legend(
    opts.series,
  )}</div><div class="plot" style="--h:${opts.height ?? 150}px">${yAxis(max, opts.fmt)}<div class="bars">${cols}</div></div>${xLabels(
    opts.days.map(dayLabel),
  )}${table}</figure>`;
}

/** One series over time, with an optional dashed reference line; gaps over `gapMs` break the line. */
export function lineChart(opts: {
  title: string;
  note?: string;
  points: Array<{ at: number; v: number }>;
  from: number;
  to: number;
  max?: number;
  fmt: (v: number) => string;
  tipTime: (ms: number) => string;
  ref?: { v: number; label: string };
  gapMs: number;
  empty: string;
  height?: number;
  xTicks: Array<{ at: number; label: string }>;
}): string {
  const head = `<div class="viz-head"><h3>${esc(opts.title)}</h3>${opts.note ? `<span class="note">${esc(opts.note)}</span>` : ''}</div>`;
  if (!opts.points.length)
    return `<figure class="viz">${head}<div class="empty">${esc(opts.empty)}</div></figure>`;
  const max = opts.max ?? niceMax(Math.max(...opts.points.map((p) => p.v)), 0.0001);
  const span = Math.max(1, opts.to - opts.from);
  const x = (t: number) => ((t - opts.from) / span) * 1000;
  const y = (v: number) => 100 - (Math.min(v, max) / max) * 100;
  const lines: string[][] = [];
  let prev: number | undefined;
  for (const p of opts.points) {
    if (prev === undefined || p.at - prev > opts.gapMs) lines.push([]);
    lines.at(-1)?.push(`${x(p.at).toFixed(1)},${y(p.v).toFixed(2)}`);
    prev = p.at;
  }
  const svg = `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">${
    opts.ref ? `<line class="ref" x1="0" x2="1000" y1="${y(opts.ref.v)}" y2="${y(opts.ref.v)}"/>` : ''
  }${lines
    .map((l) =>
      l.length === 1
        ? `<circle cx="${l[0]?.split(',')[0]}" cy="${l[0]?.split(',')[1]}" r="3" fill="${SERIES_1}" vector-effect="non-scaling-stroke"/>`
        : `<polyline stroke="${SERIES_1}" points="${l.join(' ')}"/>`,
    )
    .join('')}</svg>`;
  const pts = JSON.stringify(
    opts.points.map((p) => [p.at, Math.min(p.v, max), `${opts.tipTime(p.at)}: ${opts.fmt(p.v)}`]),
  );
  const refLabel = opts.ref
    ? `<span class="reflabel" style="bottom:${(opts.ref.v / max) * 100}%">${esc(opts.ref.label)}</span>`
    : '';
  const ticks = `<div class="xaxis" aria-hidden="true">${opts.xTicks
    .map(
      (t, i, all) =>
        `<span class="${i === 0 ? 'first' : i === all.length - 1 ? 'last' : ''}" style="left:${((t.at - opts.from) / span) * 100}%">${esc(t.label)}</span>`,
    )
    .join('')}</div>`;
  const last = opts.points.at(-1) as { at: number; v: number };
  const peak = opts.points.reduce((a, b) => (b.v > a.v ? b : a));
  const table = `<details><summary>Table</summary><table><thead><tr><th>Time</th><th>${esc(opts.title)}</th></tr></thead><tbody>${opts.points
    .slice(-48)
    .reverse()
    .map((p) => `<tr><td>${esc(opts.tipTime(p.at))}</td><td>${esc(opts.fmt(p.v))}</td></tr>`)
    .join('')}</tbody></table></details>`;
  return `<figure class="viz">${head}<div class="plot lplot" style="--h:${opts.height ?? 120}px" data-x0="${opts.from}" data-x1="${opts.to}" data-max="${max}" data-points="${esc(
    pts,
  )}" role="img" aria-label="${esc(`${opts.title}: now ${opts.fmt(last.v)}, peak ${opts.fmt(peak.v)} at ${opts.tipTime(peak.at)}`)}">${yAxis(
    max,
    opts.fmt,
  )}${svg}${refLabel}<span class="cross"></span><span class="pt" style="background:${SERIES_1}"></span></div>${ticks}${table}</figure>`;
}

export interface TrendsData {
  days: number;
  dayKeys: string[];
  from: number;
  now: number;
  current: Totals;
  previous: Totals;
  runs: DayRuns[];
  cost: Array<{ day: string; byProject: Record<string, number> }>;
  projects: Array<{ name: string; title: string }>;
  usage: Array<{ at: number; share: number }>;
  jobs: Array<JobTrend & { name: string }>;
  uptimes: Array<Uptime & { label: string }>;
  /** Checks that were fine for the whole window. */
  steady: number;
  host: HostSample[];
  /** Health uptime across all checks, 0–1 (time not red over check-time). */
  overallUptime?: number;
}

const money = (v: number) =>
  v >= 100 ? `$${Math.round(v)}` : v >= 1 ? `$${v.toFixed(1)}` : v > 0 ? `$${v.toFixed(2)}` : '$0';
const count = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const pct = (v: number) => (v > 0 && v < 0.01 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`);
/** Longer by half again and by at least a minute: a 1s job taking 15s is no news. */
const slowing = (j: JobTrend) => (j.slower ?? 0) >= 1.5 && (j.recentMs ?? 0) - (j.beforeMs ?? 0) >= 60_000;
const minutes = (ms: number | undefined) =>
  ms === undefined
    ? '–'
    : ms < 60_000
      ? `${Math.max(1, Math.round(ms / 1000))}s`
      : ms < 3_600_000
        ? `${Math.round(ms / 60_000)}m`
        : `${(ms / 3_600_000).toFixed(1)}h`;

function kpi(
  label: string,
  value: string,
  now?: number,
  before?: number,
  goodWhen: 'up' | 'down' = 'up',
  unit = '%',
): string {
  let delta = '';
  if (now !== undefined && before !== undefined && before > 0) {
    const change = (now - before) / before;
    if (Math.abs(change) >= 0.05) {
      const up = change > 0;
      const tone = (up && goodWhen === 'up') || (!up && goodWhen === 'down') ? 'good' : 'bad';
      delta = `<small class="${up ? 'up' : 'down'}-${tone}">${up ? '▲' : '▼'} ${Math.round(Math.abs(change) * 100)}${unit} vs the period before</small>`;
    } else delta = '<small>about the same as the period before</small>';
  }
  return `<div class="kpi"><b>${esc(value)}</b><span>${esc(label)}</span>${delta}</div>`;
}

export function trendsPage(ctx: DashboardContext, d: TrendsData): string {
  const rangeChips = `<div class="chips">${[7, 14, 30]
    .map(
      (n) =>
        `<a class="chip${n === d.days ? ' on' : ''}" href="/health/trends?days=${n}"${n === d.days ? ' aria-current="true"' : ''}>${n} days</a>`,
    )
    .join('')}</div>`;
  const c = d.current;
  const p = d.previous;
  const kpis = `<div class="kpis">${kpi('Runs (chats and jobs)', String(c.runs), c.runs, p.runs, 'up')}${kpi(
    'Job runs that failed',
    c.failRate === undefined ? '–' : pct(c.failRate),
    c.failRate,
    p.failRate,
    'down',
  )}${kpi('Typical job length', minutes(c.medianJobMs), c.medianJobMs, p.medianJobMs, 'down')}${kpi(
    'API-equivalent cost',
    money(c.cost),
    c.cost,
    p.cost,
    'down',
  )}${d.overallUptime === undefined ? '' : kpi('Checks up', `${(d.overallUptime * 100).toFixed(d.overallUptime > 0.999 ? 2 : 1)}%`)}</div>`;

  const runsChart = stackedBars({
    title: 'Runs per day',
    note: 'chats and jobs',
    days: d.dayKeys,
    series: (['worked', 'quiet', 'failed', 'stopped'] as const).map((k) => ({
      label: RESULT_LABEL[k],
      color: RESULT_COLOR[k],
      values: d.runs.map((r) => r[k]),
    })),
    fmt: count,
  });

  // Up to three projects get their own colour; more fold into "Other".
  const shown = d.projects.slice(0, PROJECT_COLORS.length);
  const rest = d.projects.slice(PROJECT_COLORS.length);
  const costSeries: Series[] = [
    ...shown.map((pr, i) => ({
      label: pr.title,
      color: PROJECT_COLORS[i] as string,
      values: d.cost.map((x) => x.byProject[pr.name] ?? 0),
    })),
    ...(rest.length
      ? [
          {
            label: 'Other',
            color: OTHER_COLOR,
            values: d.cost.map((x) => rest.reduce((t, r) => t + (x.byProject[r.name] ?? 0), 0)),
          },
        ]
      : []),
  ];
  const costChart = stackedBars({
    title: 'Cost per day',
    note: 'what the runs would cost on the API; a subscription is not billed this',
    days: d.dayKeys,
    series: costSeries,
    fmt: money,
  });

  const dayTicks = (from: number, to: number) => {
    const ticks: Array<{ at: number; label: string }> = [];
    const step = Math.max(1, Math.ceil(d.days / 6)) * 86_400_000;
    for (let t = from; t <= to; t += step)
      ticks.push({
        at: t,
        label: new Date(t).toLocaleDateString('en-GB', {
          timeZone: ctx.timeZone,
          day: 'numeric',
          month: 'short',
        }),
      });
    return ticks;
  };
  const tipTime = (ms: number) =>
    new Date(ms).toLocaleString('en-GB', {
      timeZone: ctx.timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  const usageChart = lineChart({
    title: 'Claude usage window',
    note: 'highest share any run reported, per hour',
    points: d.usage.map((u) => ({ at: u.at, v: u.share })),
    from: d.from,
    to: d.now,
    max: 1,
    fmt: pct,
    tipTime,
    ref: { v: 0.9, label: '90%' },
    gapMs: 3 * 3_600_000,
    empty: 'No run reported its usage in this period.',
    xTicks: dayTicks(d.from, d.now),
  });

  // Jobs that need a look first: failing most, then growing longest.
  const ranked = [...d.jobs].sort(
    (a, b) => b.failRate - a.failRate || (b.slower ?? 0) - (a.slower ?? 0) || b.runs - a.runs,
  );
  const flagged = ranked.filter((j) => j.failed || slowing(j));
  const jobRow = (j: JobTrend & { name: string }) => {
    const proj = d.projects.find((x) => x.name === j.project)?.title ?? j.project;
    const trend =
      j.slower === undefined
        ? '–'
        : slowing(j)
          ? `<span style="color:var(--amber)">▲ ${Math.round((j.slower - 1) * 100)}% longer</span>`
          : j.slower <= 0.67
            ? `▼ ${Math.round((1 - j.slower) * 100)}% shorter`
            : 'steady';
    return `<tr><td class="name"><a href="/jobs#job-${esc(j.project)}-${esc(j.jobId)}">${esc(j.name)}</a><small>${esc(proj)}${
      j.lastError ? ` · last failure: ${esc(j.lastError.slice(0, 140))}` : ''
    }</small></td><td>${j.runs}</td><td>${j.failed ? `<span style="color:var(--red)">${j.failed} (${pct(j.failRate)})</span>` : '0'}</td><td>${
      j.quiet
    }</td><td>${minutes(j.p50)}</td><td>${minutes(j.p95)}</td><td>${trend}</td><td>${money(j.cost)}</td></tr>`;
  };
  const head =
    '<thead><tr><th>Job</th><th>Runs</th><th>Failed</th><th>Nothing to do</th><th>Typical</th><th>Slowest 5%</th><th>Last 3 days</th><th>Cost</th></tr></thead>';
  const others = ranked.filter((j) => !flagged.includes(j));
  const jobsPart = d.jobs.length
    ? `${
        flagged.length
          ? `<div class="tbl-wrap"><table class="tbl">${head}<tbody>${flagged.map(jobRow).join('')}</tbody></table></div>`
          : '<div class="empty">No job failed or grew slower in this period.</div>'
      }${
        others.length
          ? `<details class="more" style="margin-top:8px"><summary>${others.length} other ${others.length === 1 ? 'job' : 'jobs'}, all fine</summary><div class="tbl-wrap"><table class="tbl">${head}<tbody>${others
              .map(jobRow)
              .join('')}</tbody></table></div></details>`
          : ''
      }`
    : '<div class="empty">No job ran in this period.</div>';

  const strips = d.uptimes.length
    ? `<div class="viz"><div class="strips">${d.uptimes
        .map((u) => {
          const span = Math.max(1, d.now - d.from);
          const segs = u.segments
            .filter((s) => s.status !== 'ok')
            .map(
              (s) =>
                `<i tabindex="0" style="left:${((s.from - d.from) / span) * 100}%;width:max(3px,${((s.to - s.from) / span) * 100}%);background:${STATUS_COLOR[s.status]}" data-tip="${esc(
                  `${u.label}: ${STATUS_WORD[s.status]}\n${tipTime(s.from)} → ${s.to >= d.now - 60_000 ? 'now' : tipTime(s.to)}`,
                )}"></i>`,
            )
            .join('');
          return `<div class="strip-row"><span class="nm" title="${esc(u.label)}">${esc(u.label)}</span><div class="strip" role="img" aria-label="${esc(
            `${u.label}: up ${pct(u.uptime)}, ${u.outages} outages`,
          )}">${segs}</div><span class="pc">${(u.uptime * 100).toFixed(u.uptime > 0.999 ? 2 : 1)}%</span></div>`;
        })
        .join(
          '',
        )}</div><div class="legend" style="margin:10px 0 0"><span><i style="background:${STATUS_COLOR.warn}"></i>Needs a look</span><span><i style="background:${
        STATUS_COLOR.bad
      }"></i>Broken</span><span><i style="background:#1c2638"></i>Fine</span></div></div>${
        d.steady
          ? `<p class="dim" style="margin:8px 0 0;font-size:13px">${d.steady} other checks were fine the whole time.</p>`
          : ''
      }`
    : `<div class="empty">Every check was fine the whole time${d.steady ? ` (${d.steady} checks)` : ''}.</div>`;

  // Sampling may have started inside the window: the charts start with it rather than sit empty.
  const hostFrom = Math.max(d.from, (d.host[0]?.at ?? d.now) - 5 * 60_000);
  const hostNote = hostFrom > d.from + 86_400_000 ? `since ${tipTime(hostFrom)}` : 'every 5 minutes';
  const edgeTicks = [hostFrom, d.now].map((at) => ({
    at,
    label: new Date(at).toLocaleString('en-GB', {
      timeZone: ctx.timeZone,
      ...(d.now - hostFrom > 2 * 86_400_000
        ? { day: 'numeric', month: 'short' }
        : { hour: '2-digit', minute: '2-digit' }),
    }),
  }));
  const hostChart = (
    title: string,
    pick: (h: HostSample) => number | undefined,
    fmt: (v: number) => string,
    max?: number,
    ref?: { v: number; label: string },
  ) =>
    lineChart({
      title,
      note: hostNote,
      points: d.host.flatMap((h) => {
        const v = pick(h);
        return v === undefined ? [] : [{ at: h.at, v }];
      }),
      from: hostFrom,
      to: d.now,
      max,
      fmt,
      tipTime,
      ref,
      gapMs: 20 * 60_000,
      empty: 'No samples yet: tara-agent records the machine every 5 minutes from now on.',
      height: 90,
      xTicks: edgeTicks,
    });
  const host = `<div class="grid3">${hostChart(
    'Load (1 min)',
    (h) => h.load,
    (v) => v.toFixed(1),
  )}${hostChart('Memory used', (h) => h.memUsed, pct, 1, {
    v: 0.9,
    label: '90%',
  })}${hostChart('Disk used', (h) => h.diskUsed, pct, 1, { v: 0.85, label: '85%' })}</div>`;

  const body = `${VIZ_STYLE}${pageHead('Health', `How things went over the last ${d.days} days, against the ${d.days} days before.`)}${healthTabs(
    'trends',
  )}<div class="toolbar" style="margin-top:-6px">${rangeChips}</div>${kpis}${section(
    'Runs and cost',
    `<div class="grid2">${runsChart}${costChart}</div>`,
  )}${section('Usage', usageChart, { sub: 'every run stops when the window is used up' })}${section(
    'Jobs',
    jobsPart,
    {
      sub: 'failing or slowing down first',
    },
  )}${section('Uptime', strips, { sub: 'checks that had trouble' })}${section('Machine', host)}`;
  return layout(ctx, 'Health trends', 'Health', body, { script: VIZ_SCRIPT });
}

export interface LogsData {
  hours: number;
  now: number;
  from: number;
  /** Groups per source, in page order: tara-agent first, then each service. */
  sources: Array<{ title: string; groups: LogGroup[]; error?: string; lines: number }>;
  /** Warnings and errors per hour across every source, oldest first. */
  hourly: Array<{ at: number; warn: number; error: number }>;
  units: string[];
}

export function logsPage(ctx: DashboardContext, d: LogsData): string {
  const ranges: Array<[number, string]> = [
    [1, '1 hour'],
    [24, '24 hours'],
    [168, '7 days'],
  ];
  const rangeChips = `<div class="chips">${ranges
    .map(
      ([n, label]) =>
        `<a class="chip${n === d.hours ? ' on' : ''}" href="/health/logs?hours=${n}"${n === d.hours ? ' aria-current="true"' : ''}>${label}</a>`,
    )
    .join('')}</div>`;
  const tipTime = (ms: number) =>
    new Date(ms).toLocaleString('en-GB', {
      timeZone: ctx.timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  const totalErrors = d.hourly.reduce((t, h) => t + h.error, 0);
  const totalWarn = d.hourly.reduce((t, h) => t + h.warn, 0);
  const max = niceMax(Math.max(0, ...d.hourly.map((h) => h.warn + h.error)));
  const cols = d.hourly
    .map((h) => {
      const total = h.warn + h.error;
      const tip = `${tipTime(h.at)}\nErrors: ${h.error}\nWarnings: ${h.warn}`;
      return `<div class="col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ', '))}"><div class="stack" style="height:${
        (total / max) * 100
      }%">${h.error ? `<i style="flex:${h.error};background:#d03b3b"></i>` : ''}${h.warn ? `<i style="flex:${h.warn};background:#fab219"></i>` : ''}</div></div>`;
    })
    .join('');
  const ticks = d.hourly.length
    ? (() => {
        const n = d.hourly.length;
        const every = Math.max(1, Math.ceil(n / 6));
        return `<div class="xaxis" aria-hidden="true">${d.hourly
          .map((h, i) => ({ h, i }))
          .filter(({ i }) => i === 0 || i === n - 1 || (i % every === 0 && n - 1 - i >= every / 2))
          .map(({ h, i }) => {
            const label = new Date(h.at).toLocaleString('en-GB', {
              timeZone: ctx.timeZone,
              ...(d.hours > 24 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' }),
            });
            return `<span class="${i === 0 ? 'first' : i === n - 1 ? 'last' : ''}" style="left:${((i + 0.5) / n) * 100}%">${esc(label)}</span>`;
          })
          .join('')}</div>`;
      })()
    : '';
  const chart = `<figure class="viz"><div class="viz-head"><h3>Warnings and errors per ${d.hours > 24 ? '6 hours' : 'hour'}</h3><span class="note">${totalErrors} errors, ${totalWarn} warnings</span>${legend(
    [
      { label: 'Errors', color: '#d03b3b' },
      { label: 'Warnings', color: '#fab219' },
    ],
  )}</div><div class="plot" style="--h:110px">${yAxis(max, count)}<div class="bars">${cols}</div></div>${ticks}</figure>`;

  const groupRow = (g: LogGroup) =>
    `<details class="logrow"><summary><span class="dot ${g.level === 'error' ? 'bad' : 'warn'}" role="img" aria-label="${
      g.level === 'error' ? 'Error' : 'Warning'
    }"></span><code title="${esc(`Grouped as: ${g.pattern}`)}">${esc((g.example.split('\n')[0] ?? '').slice(0, 400))}</code><span class="cnt">${g.count}× · ${esc(relative(g.last, d.now))}</span></summary><pre>${esc(
      g.example.slice(0, 4_000),
    )}</pre><div class="meta"><span>first ${esc(tipTime(g.first))}</span><span>last ${esc(tipTime(g.last))}</span></div></details>`;
  const sources = d.sources
    .map((s) => {
      const errors = s.groups.filter((g) => g.level === 'error').reduce((t, g) => t + g.count, 0);
      const body = s.error
        ? `<div class="alert">${esc(s.error)}</div>`
        : s.groups.length
          ? `<div class="loggroups">${s.groups.slice(0, 60).map(groupRow).join('')}</div>${
              s.groups.length > 60 ? `<p class="dim">${s.groups.length - 60} more kinds not shown.</p>` : ''
            }`
          : '<div class="empty">Nothing went wrong.</div>';
      return section(s.title, body, {
        sub: s.error
          ? "couldn't be read"
          : s.lines
            ? `${s.lines} lines, ${errors} errors, ${s.groups.length} kinds`
            : 'quiet',
      });
    })
    .join('');
  const body = `${VIZ_STYLE}${pageHead(
    'Health',
    `Warnings and errors from the last ${ranges.find(([n]) => n === d.hours)?.[1] ?? `${d.hours} hours`}, grouped: the same message with other numbers or ids counts once.`,
  )}${healthTabs('logs')}<div class="toolbar" style="margin-top:-6px">${rangeChips}</div>${chart}<div style="height:24px"></div>${sources}${
    d.units.length
      ? ''
      : '<p class="dim" style="font-size:13px">Other services\' logs show here once listed in host <code>health.logUnits</code>.</p>'
  }`;
  return layout(ctx, 'Health logs', 'Health', body, { script: VIZ_SCRIPT, refresh: d.hours <= 24 });
}
