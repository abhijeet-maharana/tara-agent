import type { QueueConfig } from '../config/schema.js';
import { nextRun } from '../scheduler/queues.js';
import type { Item } from '../store/store.js';
import { goesOut, kindLabel } from './approvals.js';
import { type DashboardContext, esc, layout, pageHead, projectTag, relative, when } from './dashboard.js';

/**
 * The Queue page: approved drafts waiting to run, one section per queue (per kind in a queue that
 * alternates kinds, since kinds take turns), in the order the queue runs them. In a queue with
 * `reorder`, a person drags a row (or uses Top / ↑ / ↓ / Bottom) to choose what goes out first;
 * those queues show even when empty. Other queues sit read-only under "Other queues".
 */

export interface QueueData {
  project?: string;
  /** Approved items, in queue order (already filtered by project). */
  approved: Item[];
  running: Item[];
  /** Items waiting for approval, counted per queue. */
  pending: Item[];
  /** Queue config per project. */
  queues: (project: string) => Record<string, QueueConfig>;
  /** This browser holds the decision cookie. */
  canDecide: boolean;
  now: number;
}

const SCRIPT = `
const moveTo = async (id, to) => {
  try { await post('/items/' + id + '/move', { to }); reload(); } catch (err) { toast(err.message, { error: true }); reload(); }
};
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.move) { b.disabled = true; return moveTo(b.dataset.move, b.dataset.to); }
  if (b.dataset.cancel) {
    if (!(await ask('Cancel "' + b.dataset.title + '"?', 'It will not run. Jarvis can propose it again.', 'Cancel it', true))) return;
    try { await post('/items/' + b.dataset.cancel + '/cancel'); toast('Cancelled'); reload(); } catch (err) { toast(err.message, { error: true }); }
  }
});
// Drag a row by its handle (mouse or touch) to a new place in its list.
let drag;
const rowsOf = (list) => [...list.querySelectorAll(':scope > [data-qitem]')];
const renumber = (list) => rowsOf(list).forEach((r, n) => (r.querySelector('.pos').textContent = n + 1));
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('[data-handle]');
  if (!h || e.button > 0) return;
  const row = h.closest('[data-qitem]');
  drag = { row, list: row.parentElement, from: rowsOf(row.parentElement).indexOf(row) };
  row.classList.add('dragging');
  h.setPointerCapture(e.pointerId);
  e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (e.clientY < 60) scrollBy(0, -14); else if (e.clientY > innerHeight - 60) scrollBy(0, 14);
  const next = rowsOf(drag.list).find((r) => r !== drag.row && e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
  if (next !== drag.row.nextElementSibling) drag.list.insertBefore(drag.row, next || null);
  renumber(drag.list);
});
const drop = () => {
  if (!drag) return;
  const { row, list, from } = drag;
  drag = undefined;
  row.classList.remove('dragging');
  const to = rowsOf(list).indexOf(row);
  if (to !== from) { toast('Moved to #' + (to + 1)); moveTo(row.dataset.qitem, to); }
};
document.addEventListener('pointerup', drop);
document.addEventListener('pointercancel', drop);
`;

const CSS = `<style>
.qlist{display:grid;gap:6px}
.qlist .row{gap:10px}.qlist .row.dragging{border-color:var(--accent);box-shadow:0 6px 24px rgba(0,0,0,.35);position:relative;z-index:2}
.pos{min-width:24px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-dim);font-size:13px;font-weight:600}
.handle{cursor:grab;touch-action:none;user-select:none;color:var(--text-dim);font-size:18px;line-height:1;padding:4px 2px}.dragging .handle{cursor:grabbing}
.sub-kind{font-size:13px;color:var(--text-dim);margin:12px 0 6px}
.others{margin-top:28px}.others>summary{cursor:pointer;color:var(--text-dim);font-size:14px;margin-bottom:12px}
.result{font-size:13px;color:var(--text-dim);margin-top:4px;overflow-wrap:anywhere}
.lock{color:var(--amber);background:var(--amber-dim);border-radius:var(--radius);padding:11px 14px;margin-bottom:14px}
</style>`;

const queueTitle = (name: string) => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/-/g, ' ');

/** How the queue runs, for the section head: "next slot Tue 14:40 · 2 per run · 3 a day". */
function howItRuns(ctx: DashboardContext, cfg: QueueConfig | undefined, now: number): string {
  if (!cfg) return 'not in .tara/queues.json';
  const parts: string[] = [];
  if ('external' in cfg.executor) parts.push('run by the project');
  else {
    const at = nextRun({ runNow: false }, cfg, ctx.timeZone, now);
    const what = cfg.slots ? 'next slot' : cfg.windows ? 'next window' : 'next';
    parts.push(at ? `${what} ${at <= now + 60_000 ? 'now' : when(at, ctx.timeZone)}` : 'no window coming up');
  }
  if (cfg.batch > 1) parts.push(`${cfg.batch} per run`);
  if (cfg.caps.perDay) parts.push(`${cfg.caps.perDay} a day`);
  if (cfg.caps.perWeek) parts.push(`${cfg.caps.perWeek} a week`);
  if (cfg.gapMinutes) parts.push(`${cfg.gapMinutes} min apart`);
  return parts.join(' · ');
}

function moveButtons(id: string, first: boolean, last: boolean): string {
  const btn = (to: string, label: string, title: string, off: boolean) =>
    `<button type="button" class="btn quiet" data-move="${esc(id)}" data-to="${to}" title="${title}" aria-label="${title}"${off ? ' disabled' : ''}>${label}</button>`;
  return (
    btn('top', 'Top', 'Run first in its queue', first) +
    btn('up', '↑', 'Move up', first) +
    btn('down', '↓', 'Move down', last) +
    btn('bottom', 'Bottom', 'Run last in its queue', last)
  );
}

function row(
  ctx: DashboardContext,
  item: Item,
  data: QueueData,
  opts: { pos?: number; count?: number; kinds: boolean; reorder?: boolean },
): string {
  const running = item.status === 'running';
  const movable = !running && opts.reorder && data.canDecide && (opts.count ?? 0) > 1;
  const first = opts.pos === 0;
  const last = opts.pos === (opts.count ?? 0) - 1;
  // Only the head of the line (the first batch), or an item with its own timing, has a "goes out".
  const batch = data.queues(item.project)[item.queue ?? '']?.batch ?? 1;
  const timing = (opts.pos ?? 0) < batch || item.window || item.runNow || (item.runAfter ?? 0) > data.now;
  return `<div class="row"${running ? '' : ` data-qitem="${esc(item.id)}"`}>${
    movable ? '<span class="handle" data-handle title="Drag to reorder" aria-hidden="true">⋮⋮</span>' : ''
  }${running ? '<span class="dot"></span>' : `<span class="pos">${(opts.pos ?? 0) + 1}</span>`}<span class="grow"><span class="title">${esc(item.title)}</span>
<span class="meta">${opts.kinds ? `<span class="tag">${esc(kindLabel(item.kind))}</span>` : ''}${
    running
      ? '<span class="tag">running now</span>'
      : timing
        ? goesOut(ctx, item, data.queues, data.now, false)
        : ''
  }${item.runNow && !running ? '<span class="tag">run now</span>' : ''}<span>approved ${esc(relative(item.decidedAt, data.now))}</span></span>${
    // Why an executor put it back ("daily cap reached").
    !running && item.result ? `<div class="result">Waiting: ${esc(item.result.slice(0, 300))}</div>` : ''
  }</span>${
    !running && data.canDecide
      ? `<span class="actions">${movable ? moveButtons(item.id, first, last) : ''}<button type="button" class="btn quiet" data-cancel="${esc(item.id)}" data-title="${esc(item.title)}">Cancel</button></span>`
      : ''
  }</div>`;
}

export function queuePage(ctx: DashboardContext, data: QueueData): string {
  const multi = !data.project && ctx.projects.length > 1;
  const projectChips =
    ctx.projects.length > 1
      ? [
          `<a class="chip${data.project ? '' : ' on'}" href="/queue">All</a>`,
          ...ctx.projects.map(
            (p) =>
              `<a class="chip${data.project === p.config.name ? ' on' : ''}" href="/queue?project=${encodeURIComponent(p.config.name)}">${esc(
                p.config.title ?? p.config.name,
              )}</a>`,
          ),
        ].join('')
      : '';

  // One section per project and queue: every queue a person orders, then the others that have
  // something in them, in the order they first appear (running first).
  const queues = new Map<string, { project: string; queue: string }>();
  const add = (project: string, queue: string) =>
    queues.set(JSON.stringify([project, queue]), { project, queue });
  for (const p of ctx.projects)
    if (!data.project || p.config.name === data.project)
      for (const [name, cfg] of Object.entries(data.queues(p.config.name)))
        if (cfg.reorder) add(p.config.name, name);
  for (const i of [...data.running, ...data.approved]) if (i.queue) add(i.project, i.queue);

  const section = ({ project, queue }: { project: string; queue: string }) => {
    const cfg = data.queues(project)[queue];
    const reorder = Boolean(cfg?.reorder);
    const mine = (list: Item[]) => list.filter((i) => i.project === project && i.queue === queue);
    const approved = mine(data.approved);
    const running = mine(data.running);
    const pending = mine(data.pending).length;
    const kinds = new Set([...approved, ...running].map((i) => i.kind)).size > 1;
    const list = (items: Item[]) =>
      `<div class="qlist">${items.map((i, n) => row(ctx, i, data, { pos: n, count: items.length, kinds, reorder })).join('')}</div>`;
    // A queue that alternates kinds takes turns by kind: each kind is its own line.
    const alternate = cfg?.alternate ?? [];
    const groups = alternate.length
      ? [...new Set([...alternate, ...approved.map((i) => i.kind)])]
          .map((k) => [k, approved.filter((i) => i.kind === k)] as const)
          .filter(([, items]) => items.length)
          .map(
            ([k, items]) =>
              `<div class="sub-kind">${esc(kindLabel(k))} · ${items.length}</div>${list(items)}`,
          )
          .join('')
      : list(approved);
    const approvals = `/approvals?project=${encodeURIComponent(project)}`;
    const head = `<div class="sec-head"><h2>${esc(queueTitle(queue))}</h2>${multi ? projectTag(ctx, project) : ''}<span>${approved.length} in line · ${esc(
      howItRuns(ctx, cfg, data.now),
    )}</span>${pending ? `<a class="more" href="${approvals}">${pending} to approve →</a>` : ''}</div>`;
    return `<section class="section">${head}${
      running.length
        ? `<div class="qlist">${running.map((i) => row(ctx, i, data, { kinds })).join('')}</div>`
        : ''
    }${approved.length ? groups : running.length ? '' : `<div class="empty">Nothing approved yet.${pending ? ` <a href="${approvals}">Approve ${pending === 1 ? 'the waiting card' : `the ${pending} waiting cards`}</a> to line ${pending === 1 ? 'it' : 'them'} up here.` : ''}</div>`}</section>`;
  };
  const all = [...queues.values()];
  const ordered = all.filter((q) => data.queues(q.project)[q.queue]?.reorder).map(section);
  const others = all.filter((q) => !data.queues(q.project)[q.queue]?.reorder);
  const othersCount = others.reduce(
    (n, q) => n + data.approved.filter((i) => i.project === q.project && i.queue === q.queue).length,
    0,
  );

  return layout(
    ctx,
    'Queue',
    'Queue',
    `${CSS}${pageHead('Queue', 'Approved drafts, in the order each queue runs them. Drag a row or use the arrows to choose what goes out first.')}
${data.canDecide ? '' : '<div class="lock">This browser can look but not reorder. <a href="/unlock">Unlock it</a> once with the approvals key (only from your own phone or computer, never from Jarvis).</div>'}
${projectChips ? `<div class="toolbar"><div class="chips">${projectChips}</div></div>` : ''}
${ordered.join('') || '<div class="empty">No queue is set to be reordered. Add <code>"reorder": true</code> to a queue in its project\'s <code>.tara/queues.json</code>.</div>'}
${others.length ? `<details class="others"><summary>Other queues · ${othersCount} approved, run in approval order</summary>${others.map(section).join('')}</details>` : ''}`,
    { refresh: true, script: SCRIPT },
  );
}
