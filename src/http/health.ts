import { ago, type CheckView, type HealthSnapshot, type HealthStatus } from '../health/monitor.js';
import type { HealthEvent } from '../store/store.js';
import { type DashboardContext, esc, layout, pageHead, section } from './dashboard.js';
import { healthTabs } from './observe.js';

export interface HealthPageData {
  snapshot?: HealthSnapshot;
  /** Status changes over the last 7 days, newest first. */
  history: HealthEvent[];
  /** A check's name for the history (also for checks no longer listed). */
  label: (key: string) => string;
  uptimeSeconds: number;
  now: number;
}

const STYLE = `<style>
.health-rows{display:flex;flex-direction:column;gap:6px}
.health-rows .row{align-items:flex-start}
.health-rows .row .dot{margin-top:6px}
.health-rows .row.ok{padding:8px 14px}
.health-rows .row.ok .title{font-weight:500}
.hgroup{margin:14px 0 6px;font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em}
.hgroup:first-child{margin-top:0}
.hdetail{color:var(--text);font-size:13.5px;margin-top:2px;overflow-wrap:anywhere}
.row.ok .hdetail{color:var(--text-dim)}
.head-actions{display:flex;gap:8px;align-items:center;margin:-6px 0 18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px}
.tile{display:flex;gap:9px;align-items:flex-start;min-width:0;padding:8px 12px;background:var(--card-bg);border:1px solid var(--border);border-left:3px solid var(--rc,var(--border));border-radius:var(--radius);color:var(--text);text-decoration:none}
a.tile:hover{background:var(--card-hover)}
.tile .dot{margin-top:5px}
.tile b{display:block;font-weight:600;font-size:13.5px;color:var(--text-heading);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile small{display:block;font-size:12.5px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile>span:last-child{min-width:0;flex:1}
.tile.warn{--rc:var(--amber)}.tile.bad{--rc:var(--red)}
.hist{display:flex;flex-direction:column;gap:2px}
.hist .row{padding:7px 14px;font-size:13.5px}
.hist time{color:var(--text-dim);min-width:92px;font-variant-numeric:tabular-nums}
</style>`;

const DOT: Record<HealthStatus, string> = { ok: 'ok', warn: 'warn', bad: 'bad' };
const WORD: Record<HealthStatus, string> = { ok: 'Fine', warn: 'Needs a look soon', bad: 'Problem' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function when(ms: number, ctx: DashboardContext): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ctx.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

function row(c: CheckView, now: number, opts: { source?: string } = {}): string {
  const status = c.unconfirmed ? 'warn' : c.status;
  const name = c.link
    ? `<a class="title" href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.name)}</a>`
    : `<span class="title">${esc(c.name)}</span>`;
  const meta = [
    opts.source ? esc(opts.source) : '',
    c.status !== 'ok' && !c.unconfirmed ? `${WORD[c.status].toLowerCase()} for ${ago(now - c.since)}` : '',
    c.unconfirmed ? 'just failed once: checking again before it counts' : '',
    c.outages ? `${plural(c.outages, 'outage')} in 7 days` : '',
  ].filter(Boolean);
  return `<div class="row ${c.status === 'ok' ? 'ok' : ''}" data-key="${esc(c.key)}"><span class="dot ${DOT[status]}" role="img" aria-label="${
    WORD[status]
  }"></span><span class="grow">${name}${c.detail ? `<div class="hdetail">${esc(c.detail)}</div>` : ''}${
    meta.length ? `<div class="meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>` : ''
  }</span></div>`;
}

/** A check in one compact line (the source sections): name, and its detail cut to one line. */
function tile(c: CheckView): string {
  const status = c.unconfirmed ? 'warn' : c.status;
  const tag = c.link ? 'a' : 'div';
  const href = c.link ? ` href="${esc(c.link)}" target="_blank" rel="noopener"` : '';
  return `<${tag} class="tile ${status === 'ok' ? '' : status}"${href} title="${esc(`${c.name}: ${c.detail}`)}" data-key="${esc(
    c.key,
  )}"><span class="dot ${DOT[status]}" role="img" aria-label="${WORD[status]}"></span><span><b>${esc(c.name)}</b>${
    c.detail ? `<small>${esc(c.detail)}</small>` : ''
  }</span></${tag}>`;
}

function sourceSection(title: string, checks: CheckView[], error?: string): string {
  const bad = checks.filter((c) => c.status === 'bad' && !c.unconfirmed).length;
  const warn = checks.filter((c) => c.status === 'warn' || c.unconfirmed).length;
  const sub = error
    ? "couldn't be checked"
    : bad
      ? plural(bad, 'problem')
      : warn
        ? `${warn} to watch`
        : 'all good';
  const groups = [...new Set(checks.map((c) => c.group))];
  const body = groups
    .map((g) => {
      const tiles = checks.filter((c) => c.group === g).map(tile);
      const heading = groups.length > 1 && g !== title ? `<div class="hgroup">${esc(g)}</div>` : '';
      return `${heading}<div class="tiles">${tiles.join('')}</div>`;
    })
    .join('');
  return section(title, body || '<div class="empty">Nothing to check.</div>', { sub });
}

export function healthPage(ctx: DashboardContext, data: HealthPageData): string {
  const s = data.snapshot;
  const up = `${ctx.agentName} up ${ago(data.uptimeSeconds * 1000)}`;
  if (!s) {
    const body = `${STYLE}${pageHead('Health', `Checking everything for the first time… · ${esc(up)}`)}${healthTabs('now')}<div class="empty">The first checks are still running. This page refreshes by itself.</div>`;
    return layout(ctx, 'Health', 'Health', body, { refresh: true });
  }
  const bad = s.checks.filter((c) => c.status === 'bad' && !c.unconfirmed);
  const watch = s.checks.filter((c) => c.status === 'warn' || c.unconfirmed);
  const summary = bad.length
    ? `❌ ${plural(bad.length, 'problem')}${watch.length ? `, ${watch.length} to watch` : ''}`
    : watch.length
      ? `⚠️ ${watch.length} to watch, nothing broken`
      : '✅ Everything is fine';
  const sub = `${summary} · checked ${ago(data.now - s.checkedAt)} ago · ${esc(up)}`;
  const titles = new Map(s.sources.map((x) => [x.id, x.title]));
  const sourceOf = (c: CheckView) =>
    titles.get(s.sources.find((x) => c.key.startsWith(`${x.id}:`))?.id ?? '') ?? '';

  const problems = [...bad, ...watch];
  const problemsPart = problems.length
    ? section(
        'Needs you',
        `<div class="health-rows">${problems.map((c) => row(c, data.now, { source: `${sourceOf(c)}${c.group && c.group !== sourceOf(c) ? ` · ${c.group}` : ''}` })).join('')}</div>`,
        { sub: 'red ones are posted in Slack once, and again when fixed' },
      )
    : '';

  const sources = s.sources
    .map((src) => {
      const checks = s.checks.filter((c) => c.key.startsWith(`${src.id}:`));
      return sourceSection(src.title, checks, src.error);
    })
    .join('');

  const history = data.history.slice(0, 40);
  const historyPart = section(
    'Last 7 days',
    history.length
      ? `<div class="hist">${history
          .map(
            (e) =>
              `<div class="row"><time>${esc(when(e.at, ctx))}</time><span class="dot ${DOT[e.status]}" role="img" aria-label="${WORD[e.status]}"></span><span class="grow"><b>${esc(
                data.label(e.key),
              )}</b> ${e.status === 'ok' ? 'fine again' : e.status === 'warn' ? 'needs a look' : 'broke'}${
                e.detail && e.status !== 'ok' ? `<div class="meta"><span>${esc(e.detail)}</span></div>` : ''
              }</span></div>`,
          )
          .join('')}</div>`
      : '<div class="empty">No changes in the last 7 days.</div>',
    { sub: 'every change of state' },
  );

  const body = `${STYLE}${pageHead('Health', sub)}${healthTabs('now')}<div class="head-actions"><button type="button" class="btn ghost" id="recheck">Check again</button></div>${problemsPart}${sources}${historyPart}`;
  const script = `
document.getElementById('recheck')?.addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
  try { await post('/health/check'); location.reload(); }
  catch (err) { toast('Could not check: ' + err.message, { error: true }); b.disabled = false; b.textContent = 'Check again'; }
});`;
  return layout(ctx, 'Health', 'Health', body, { refresh: true, script });
}
