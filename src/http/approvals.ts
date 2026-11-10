import type { QueueConfig } from '../config/schema.js';
import { nextRun } from '../scheduler/queues.js';
import type { Item } from '../store/store.js';
import {
  type DashboardContext,
  esc,
  layout,
  md,
  pageHead,
  projectTag,
  relative,
  section,
  when,
} from './dashboard.js';

/**
 * The Approvals page: every card that waits for a person, from every project. Paused runs wait for a
 * decision; drafts wait for approval (with edits) and then run at their queue's time (in the order
 * set on the Queue page). Tabs: Waiting and Done (the last 30 days).
 */

export type ApprovalsTab = 'waiting' | 'done';

export interface ApprovalsData {
  tab: ApprovalsTab;
  project?: string;
  kind?: string;
  /** Items of the tab (already filtered by project). */
  items: Item[];
  counts: Record<ApprovalsTab, number>;
  /** Queue config per project, for "goes out …". */
  queues: (project: string) => Record<string, QueueConfig>;
  /** This browser holds the decision cookie. */
  canDecide: boolean;
  now: number;
  /** Job names by `project:jobId`, so a card says which job raised it. */
  jobNames?: Map<string, string>;
}

/** Most items a tab lists (and counts). */
export const ITEMS_LIMIT = 500;
const DAY_MS = 86_400_000;
/** Kind chips shown before "More". */
const TOP_KINDS = 6;

/** Cards that only tell (their first option, e.g. "Seen", just closes them): not counted as waiting. */
export const isNotice = (item: Pick<Item, 'kind'>) => item.kind === 'notice';
/**
 * A job's run is paused until this card is decided. (Every card has a Slack thread, so the job id is
 * the sign: a script's question or a notice has none.)
 */
export const runWaits = (item: Pick<Item, 'mode' | 'jobId' | 'kind'>) =>
  item.mode === 'resume' && Boolean(item.jobId) && !isNotice(item);

const ACRONYMS = new Set([
  'ga4',
  'seo',
  'b2b',
  'b2c',
  'x',
  'gbp',
  'ci',
  'pr',
  'ui',
  'api',
  'sla',
  'rto',
  'gst',
  'pnl',
  'qr',
]);
/** "seo-code-change" → "SEO code change", "decision" → "Decisions". */
export const kindLabel = (kind: string) => {
  if (kind === 'decision') return 'Decisions';
  const words = kind
    .split(/[-_\s]+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const STATUS_TONE: Record<string, string> = {
  done: 'ok',
  approved: '',
  running: '',
  failed: 'bad',
  rejected: 'dim',
  expired: 'dim',
  cancelled: 'dim',
};

const SCRIPT = `
const card = (el) => el.closest('[data-item]');
const editedFields = (c) => {
  const out = {};
  c.querySelectorAll('[data-field]').forEach((f) => {
    const value = f.dataset.type === 'list' ? f.value.split('\\n').map((l) => l.trim()).filter(Boolean) : f.value;
    if (JSON.stringify(value) !== f.dataset.original) out[f.dataset.field] = value;
  });
  return out;
};
const decide = async (c, option, runNow) => {
  const reply = c.querySelector('[data-reply]')?.value.trim() || undefined;
  if (option === 'Revise' && !reply) { c.classList.add('open'); c.querySelector('[data-reply]').focus(); return toast('Say what to change, then press Revise again'); }
  c.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await post('/items/' + c.dataset.item + '/decide', { option, fields: editedFields(c), reply, runNow: Boolean(runNow) });
    toast(option === 'Revise' ? 'Sent back to Jarvis for a new version' : option + ': ' + c.dataset.title);
    c.remove();
    document.querySelectorAll('[data-group]').forEach((g) => { if (!g.querySelector('[data-item]')) g.remove(); });
  } catch (err) {
    toast(err.message, { error: true });
    c.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
};
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.decide) return decide(card(b), b.dataset.decide, b.dataset.now);
  if (b.dataset.fold !== undefined) { const c = card(b); const open = c.classList.toggle('open'); b.setAttribute('aria-expanded', open); return; }
  if (b.dataset.expand !== undefined) { const body = card(b).querySelector('.body'); body.classList.toggle('open'); b.textContent = body.classList.contains('open') ? 'Show less' : 'Show all'; return; }
  if (b.dataset.openNote !== undefined) { const c = card(b); c.classList.add('open'); c.querySelector('[data-fold]')?.setAttribute('aria-expanded', 'true'); c.querySelector('[data-reply]').focus(); return; }
  // A note without a decision: to Jarvis in the card's Slack thread; the card keeps waiting.
  if (b.dataset.note !== undefined) {
    const c = card(b), box = c.querySelector('[data-reply]'), text = box.value.trim();
    if (!text) { box.focus(); return toast('Write the note first'); }
    b.disabled = true;
    try {
      await post('/items/' + c.dataset.item + '/note', { text });
      box.value = '';
      const sent = document.createElement('div');
      sent.className = 'sent-note';
      sent.textContent = '📝 Sent: ' + text;
      c.querySelector('.reply').before(sent);
      toast("Sent to Jarvis. The answer comes in the card's Slack thread.");
    } catch (err) { toast(err.message, { error: true }); }
    b.disabled = false;
    return;
  }
  if (b.dataset.cancel) {
    if (!(await ask('Cancel "' + b.dataset.title + '"?', 'It will not run. Jarvis can propose it again.', 'Cancel it', true))) return;
    try { await post('/items/' + b.dataset.cancel + '/cancel'); toast('Cancelled'); reload(); } catch (err) { toast(err.message, { error: true }); }
    return;
  }
  if (b.dataset.bulk) {
    const g = b.closest('[data-group]');
    const picked = [...g.querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick);
    const ids = picked.length ? picked : [...g.querySelectorAll('[data-item][data-clean]')].map((x) => x.dataset.item);
    if (!ids.length) return toast('Nothing that can be approved as it is', { error: true });
    const seen = b.dataset.notice !== undefined;
    if (!seen && !(await ask('Approve ' + ids.length + (ids.length === 1 ? ' item?' : ' items?'), 'Each runs at its queue\\'s time, as it is now. Unsaved edits on these cards are not included.', 'Approve ' + ids.length))) return;
    try {
      const r = await post('/items/bulk', { ids, option: b.dataset.bulk });
      toast(r.decided.length + (seen ? ' marked ' + b.dataset.bulk.toLowerCase() : ' approved') + (r.failed.length ? ', ' + r.failed.length + ' not: ' + r.failed[0].error : ''), r.failed.length ? { error: true } : {});
      reload();
    } catch (err) { toast(err.message, { error: true }); }
  }
});
// A link to one card (#item-…) opens it.
const target = location.hash.startsWith('#item-') && document.getElementById(location.hash.slice(1));
if (target) { target.classList.add('open'); target.querySelector('[data-fold]')?.setAttribute('aria-expanded', 'true'); }
document.addEventListener('input', (e) => {
  const f = e.target.closest('[data-field]');
  if (!f || !f.dataset.max) return;
  const n = f.value.length;
  const count = f.parentElement.querySelector('.count');
  count.textContent = n + '/' + f.dataset.max;
  count.classList.toggle('over', n > Number(f.dataset.max));
});
document.addEventListener('change', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (!pick) return;
  const g = pick.closest('[data-group]');
  const n = g.querySelectorAll('[data-pick]:checked').length;
  const b = g.querySelector('[data-bulk]');
  if (b) b.textContent = n ? 'Approve ' + n + ' selected' : b.dataset.label;
});
`;

const CSS = `<style>
.item .body{margin-top:8px;font-size:14px;overflow-wrap:anywhere}.item .body.long:not(.open){max-height:260px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 75%,transparent);mask-image:linear-gradient(#000 75%,transparent)}
.btn.expand{margin-top:6px}
.media{display:flex;gap:8px;overflow-x:auto;margin-top:10px;align-items:flex-start}.media img,.media video{height:180px;border-radius:8px;border:1px solid var(--border);background:var(--bg)}.media video{height:min(62vh,520px);max-width:100%;aspect-ratio:9/16;background:#000;object-fit:contain}
.fieldset{display:grid;gap:10px;margin-top:12px}.fieldset .field{position:relative}
.fieldset textarea{min-height:90px;width:100%;min-width:0}.fieldset input.input{width:100%;min-width:0}
.count{position:absolute;right:8px;top:0;font-size:11px;color:var(--text-dim)}.count.over{color:var(--red);font-weight:600}
.checks{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:4px;font-size:13px}
.checks li::before{content:'⚠ ';}.checks li.bad{color:var(--red)}.checks li.warn{color:var(--amber)}
.reply{margin-top:10px}.reply textarea{width:100%;min-width:0;min-height:60px}.reply .actions{margin-top:8px;align-items:center}.reply .hint{font-size:12.5px}
.sent-note{font-size:13px;color:var(--text-dim);margin-top:8px;overflow-wrap:anywhere}
.item .actions{margin-top:12px}.pick{width:18px;height:18px;accent-color:var(--accent)}
.revising{color:var(--amber);font-size:13px;margin-top:8px}
.result{font-size:13px;color:var(--text-dim);margin-top:4px;overflow-wrap:anywhere}
.item:not(.open) .fold{display:none}.item:not(.open) .actions{margin-top:8px}.item:not(.open){padding-top:10px;padding-bottom:10px}
.kinds-more>summary{display:block;list-style:none}.kinds-more>summary::-webkit-details-marker{display:none}
.kinds-more .chips{margin-top:6px}
.sub-head{margin:14px 0 8px}.sub-head h3{margin:0;font-size:14px;color:var(--text-heading)}.sub-head .more{margin-left:auto}
.lock{color:var(--amber);background:var(--amber-dim);border-radius:var(--radius);padding:11px 14px;margin-bottom:14px}
</style>`;

function fieldHtml(f: Item['fields'][number], editable: boolean): string {
  const value = Array.isArray(f.value) ? f.value.join('\n') : f.value;
  const original = esc(JSON.stringify(f.value));
  const attrs = `data-field="${esc(f.key)}" data-type="${f.type}" data-original="${original}"${f.maxLength ? ` data-max="${f.maxLength}"` : ''}${
    editable && !f.readOnly ? '' : ' readonly'
  }`;
  const count = f.maxLength
    ? `<span class="count${value.length > f.maxLength ? ' over' : ''}">${value.length}/${f.maxLength}</span>`
    : '';
  // A one-line field whose value has line breaks (a tweet) still needs a box that keeps them.
  const input =
    f.type === 'text' && !value.includes('\n')
      ? `<input class="input" ${attrs} value="${esc(value)}">`
      : `<textarea class="input" ${attrs} rows="${Math.min(12, Math.max(3, value.split('\n').length + 1))}">${esc(value)}</textarea>`;
  return `<label class="field">${esc(f.label)}${count}${input}</label>`;
}

export function mediaHtml(item: Item): string {
  if (!item.media.length) return '';
  return `<div class="media">${item.media
    .map((m) =>
      m.type === 'video'
        ? `<video src="${esc(m.url)}"${m.poster ? ` poster="${esc(m.poster)}"` : ''} controls playsinline preload="none" title="${esc(m.caption ?? '')}"></video>`
        : m.type === 'file'
          ? `<a class="chip" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">📄 ${esc(m.caption ?? 'Open file')} ↗</a>`
          : `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(m.url)}" alt="${esc(m.caption ?? '')}" loading="lazy"></a>`,
    )
    .join('')}</div>`;
}

/** "goes out Tue 14:40 · linkedin · EU" (`withQueue` false: without the queue's name). */
export function goesOut(
  ctx: DashboardContext,
  item: Item,
  queues: ApprovalsData['queues'],
  now: number,
  withQueue = true,
): string {
  if (item.mode !== 'queue') return '';
  const all = queues(item.project);
  const cfg = all[item.queue ?? ''];
  const at = nextRun(item, cfg?.fills ? all[cfg.fills] : cfg, ctx.timeZone, now);
  const where = [withQueue && item.queue, item.window].filter(Boolean).join(' · ');
  return `<span>${at ? `goes out ${esc(at <= now + 60_000 ? 'now' : when(at, ctx.timeZone))}` : 'no window coming up'}${where ? ` · ${esc(where)}` : ''}</span>`;
}

/** "expires in 5h" when a waiting card has less than a day left (project `approvals.expireDays`, default 7). */
function expiresSoon(ctx: DashboardContext, item: Item, now: number): string {
  const days = ctx.projects.find((p) => p.config.name === item.project)?.config.approvals?.expireDays ?? 7;
  const at = item.createdAt + days * DAY_MS;
  return at - now < DAY_MS ? `<span class="tag bad">expires ${esc(relative(at, now))}</span>` : '';
}

function waitingCard(
  ctx: DashboardContext,
  item: Item,
  data: ApprovalsData,
  multi: boolean,
  open = false,
): string {
  const blocking = item.checks.some((c) => c.blocking);
  const source = item.source ? (data.jobNames?.get(`${item.project}:${item.source}`) ?? item.source) : '';
  const expiry = expiresSoon(ctx, item, data.now);
  const long = (item.body?.length ?? 0) > 700;
  const buttons = data.canDecide
    ? [
        ...item.options.map((o, i) => {
          const negative = /^(reject|deny|no|cancel|stop|decline|skip)/i.test(o);
          const kind = i === 0 ? 'green' : negative ? 'quiet' : 'ghost';
          return `<button type="button" class="btn ${kind}" data-decide="${esc(o)}"${!negative && blocking ? ' disabled title="Fix the problems first"' : ''}>${esc(o)}</button>`;
        }),
        item.mode === 'queue' && item.options[0]
          ? `<button type="button" class="btn quiet" data-decide="${esc(item.options[0])}" data-now="1"${blocking ? ' disabled' : ''} title="Skip the window and run as soon as the queue is free">${esc(item.options[0])} &amp; run now</button>`
          : '',
        `<button type="button" class="btn quiet" data-open-note>${item.mode === 'queue' ? 'Revise or note…' : 'Note…'}</button>`,
      ].join('')
    : '';
  return `<article class="card item${blocking ? ' bad' : ''}${open ? ' open' : ''}" id="item-${esc(item.id)}" data-item="${esc(item.id)}" data-title="${esc(item.title)}"${
    blocking ? '' : ' data-clean'
  }>
<div class="card-head"><div class="grow"><button type="button" class="fold-btn" data-fold aria-expanded="${open}"><span class="title">${esc(item.title)}</span></button>
<div class="meta">${multi ? projectTag(ctx, item.project) : ''}${source ? `<span>${esc(source)}</span>` : ''}${
    runWaits(item) ? '<span class="tag warn">a run is waiting</span>' : ''
  }<span>${esc(relative(item.createdAt, data.now))}</span>${expiry}${goesOut(ctx, item, data.queues, data.now)}${
    item.checks.length
      ? `<span class="tag ${blocking ? 'bad' : 'warn'}">${item.checks.length} ${item.checks.length === 1 ? 'check' : 'checks'}</span>`
      : ''
  }</div></div>${
    data.canDecide && item.mode === 'queue' && !blocking
      ? `<input type="checkbox" class="pick" data-pick="${esc(item.id)}" aria-label="Select">`
      : ''
  }</div>
<div class="fold">
${item.body ? `<div class="body${long ? ' long' : ''}">${md(item.body)}</div>${long ? '<button type="button" class="btn quiet expand" data-expand>Show all</button>' : ''}` : ''}
${mediaHtml(item)}
${item.fields.length ? `<div class="fieldset">${item.fields.map((f) => fieldHtml(f, data.canDecide)).join('')}</div>` : ''}
${item.checks.length ? `<ul class="checks">${item.checks.map((c) => `<li class="${c.blocking ? 'bad' : 'warn'}">${esc(c.text)}</li>`).join('')}</ul>` : ''}
${item.reply ? `<div class="revising">✏️ Revision asked: ${esc(item.reply)}</div>` : ''}
${
  data.canDecide
    ? `<div class="reply"><textarea class="input" data-reply rows="2" placeholder="${
        item.mode === 'queue'
          ? 'What should change (Revise: Jarvis makes a new version), or a question for Jarvis (Send)'
          : 'A note or question for Jarvis'
      }"></textarea><div class="actions"><button type="button" class="btn ghost" data-note title="Jarvis answers in the card's Slack thread; the card keeps waiting">Send</button>${
        item.mode === 'queue'
          ? '<button type="button" class="btn ghost" data-decide="Revise">Revise</button>'
          : ''
      }<span class="dim hint">Send asks Jarvis without deciding. Or pick an option: the note goes with your decision.</span></div></div>`
    : ''
}
</div>
${buttons ? `<div class="actions">${buttons}</div>` : ''}</article>`;
}

function doneRow(ctx: DashboardContext, item: Item, data: ApprovalsData, multi: boolean): string {
  return `<div class="row"><span class="dot ${STATUS_TONE[item.status] === 'ok' ? 'ok' : STATUS_TONE[item.status] === 'bad' ? 'bad' : 'dim'}"></span><span class="grow"><span class="title">${esc(item.title)}</span>
<span class="meta">${multi ? projectTag(ctx, item.project) : ''}<span class="tag ${STATUS_TONE[item.status] ?? 'dim'}">${esc(item.status)}</span><span>${esc(
    kindLabel(item.kind),
  )}</span>${item.decision ? `<span>${esc(item.decision)}</span>` : ''}<span>${esc(relative(item.finishedAt ?? item.updatedAt, data.now))}</span></span>${
    item.result ? `<div class="result">${esc(item.result.slice(0, 300))}</div>` : ''
  }</span></div>`;
}

export function approvalsPage(ctx: DashboardContext, data: ApprovalsData): string {
  const multi = !data.project && ctx.projects.length > 1;
  const link = (q: Partial<Record<'tab' | 'project' | 'kind', string | undefined>>) => {
    const p = new URLSearchParams(
      Object.entries({
        tab: data.tab === 'waiting' ? undefined : data.tab,
        project: data.project,
        kind: data.kind,
        ...q,
      }).filter((e): e is [string, string] => Boolean(e[1])),
    );
    return `/approvals${p.size ? `?${p}` : ''}`;
  };
  const tabs = (['waiting', 'done'] as const)
    .map(
      (t) =>
        `<a class="chip${data.tab === t ? ' on' : ''}" href="${link({ tab: t === 'waiting' ? '' : t, kind: '' })}">${
          { waiting: 'Waiting', done: 'Done' }[t]
        }<small>${data.counts[t] >= ITEMS_LIMIT ? `${ITEMS_LIMIT}+` : data.counts[t]}</small></a>`,
    )
    .join('');
  const projectChips =
    ctx.projects.length > 1
      ? [
          `<a class="chip${data.project ? '' : ' on'}" href="${link({ project: '' })}">All</a>`,
          ...ctx.projects.map(
            (p) =>
              `<a class="chip${data.project === p.config.name ? ' on' : ''}" href="${link({ project: p.config.name })}">${esc(
                p.config.title ?? p.config.name,
              )}</a>`,
          ),
        ].join('')
      : '';
  const count = (k: string) => data.items.filter((i) => i.kind === k).length;
  // Most cards first; the chosen kind always stays in view.
  const kinds = [...new Set(data.items.map((i) => i.kind))].sort(
    (a, b) => count(b) - count(a) || a.localeCompare(b),
  );
  const chip = (k: string) =>
    `<a class="chip${data.kind === k ? ' on' : ''}" href="${link({ kind: k })}">${esc(kindLabel(k))}<small>${count(k)}</small></a>`;
  const top = kinds.filter((k, i) => i < TOP_KINDS || k === data.kind);
  const rest = kinds.filter((k) => !top.includes(k));
  const kindChips =
    kinds.length > 1
      ? `<a class="chip${data.kind ? '' : ' on'}" href="${link({ kind: '' })}">Every kind</a>${top.map(chip).join('')}${
          rest.length
            ? `<details class="kinds-more"><summary class="chip">More<small>${rest.length}</small></summary><div class="chips">${rest.map(chip).join('')}</div></details>`
            : ''
        }`
      : '';
  const shown = data.kind ? data.items.filter((i) => i.kind === data.kind) : data.items;

  let body: string;
  if (data.tab === 'waiting') {
    const oldest = (a: Item, b: Item) => a.createdAt - b.createdAt;
    // Only a card or two on screen (a filter): open them.
    const openAll = shown.length <= 2;
    const cards = (items: Item[]) => items.map((i) => waitingCard(ctx, i, data, multi, openAll)).join('');
    // Questions: a paused run (or a script) needs an answer. The runs that wait come first, then the oldest.
    const questions = shown
      .filter((i) => i.mode !== 'queue' && !isNotice(i))
      .sort((a, b) => Number(runWaits(b)) - Number(runWaits(a)) || oldest(a, b));
    // Drafts that go out once approved, by kind (most first), each kind with its Approve all.
    const drafts = shown.filter((i) => i.mode === 'queue');
    const inKind = (k: string) => drafts.filter((i) => i.kind === k);
    const draftKinds = [...new Set(drafts.map((i) => i.kind))].sort(
      (a, b) => inKind(b).length - inKind(a).length,
    );
    const notices = shown.filter((i) => i.mode !== 'queue' && isNotice(i)).sort(oldest);
    const seen = notices[0]?.options[0];
    body = [
      questions.length
        ? `<div data-group>${section('Needs your answer', cards(questions), {
            sub: `${questions.length} · paused runs first, then the oldest`,
          })}</div>`
        : '',
      draftKinds.length
        ? `<section class="section"><div class="sec-head"><h2>Drafts to send</h2><span>${drafts.length} · go out at their queue's time once approved</span></div>${draftKinds
            .map((k) => {
              const group = inKind(k).sort(oldest);
              const clean = group.filter((i) => !i.checks.some((c) => c.blocking));
              const label = `Approve all ${clean.length}`;
              const bulk =
                data.canDecide && clean.length > 1 && group[0]?.options[0]
                  ? `<button type="button" class="btn ghost more" data-bulk="${esc(group[0].options[0])}" data-label="${esc(label)}">${esc(label)}</button>`
                  : '';
              return `<div data-group><div class="sec-head sub-head"><h3>${esc(kindLabel(k))}</h3><span>${group.length}</span>${bulk}</div>${cards(group)}</div>`;
            })
            .join('')}</section>`
        : '',
      notices.length
        ? `<div data-group id="fyi">${section('For your information', cards(notices), {
            sub: `${notices.length} · not counted as waiting`,
            more:
              data.canDecide && seen && notices.length > 1
                ? `<button type="button" class="btn ghost more" data-bulk="${esc(seen)}" data-notice data-label="Mark all ${esc(seen.toLowerCase())}">Mark all ${esc(seen.toLowerCase())}</button>`
                : '',
          })}</div>`
        : '',
    ].join('');
    if (!body) body = '<div class="clear">✓ Nothing waiting for you.</div>';
  } else {
    body = shown.length
      ? `<div class="todo">${shown.map((i) => doneRow(ctx, i, data, multi)).join('')}</div>`
      : '<div class="empty">Nothing finished in the last 30 days.</div>';
  }

  return layout(
    ctx,
    'Approvals',
    'Approvals',
    `${CSS}${pageHead('Approvals', "Decide here. Paused runs continue with your answer; approved drafts run at their queue's time, one at a time.")}
${data.canDecide ? '' : '<div class="lock">This browser can look but not decide. <a href="/unlock">Unlock it</a> once with the approvals key (only from your own phone or computer, never from Jarvis).</div>'}
<div class="toolbar"><div class="chips">${tabs}<a class="chip" href="/queue">Scheduled → Queue</a></div></div>
${projectChips ? `<div class="toolbar"><div class="chips">${projectChips}</div></div>` : ''}
${kindChips ? `<div class="toolbar"><div class="chips">${kindChips}</div></div>` : ''}
${body}`,
    { refresh: data.tab !== 'waiting', script: SCRIPT },
  );
}

/** The one-time form that gives this browser the decision cookie. */
export function unlockPage(ctx: DashboardContext, error?: string): string {
  return layout(
    ctx,
    'Unlock',
    'Approvals',
    `${pageHead('Unlock this browser', 'Enter the approvals key (TARA_ADMIN_TOKEN) once. Only a person on their own device should do this: decisions are refused from Jarvis itself.')}
${error ? `<div class="alert">${esc(error)}</div>` : ''}
<form method="post" action="/unlock" class="card" style="max-width:440px;display:grid;gap:10px">
<label class="field">Approvals key<input class="input" type="password" name="token" autocomplete="current-password" required></label>
<div class="actions"><button type="submit" class="btn">Unlock</button></div></form>`,
  );
}
