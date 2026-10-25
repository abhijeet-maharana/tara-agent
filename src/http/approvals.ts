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
 * decision; drafts wait for approval (with edits) and then run at their queue's time. Tabs: Waiting,
 * Scheduled (approved, in queue order) and Done (the last 30 days).
 */

export type ApprovalsTab = 'waiting' | 'scheduled' | 'done';

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
}

const kindLabel = (kind: string) =>
  kind === 'decision' ? 'Decisions' : (kind.charAt(0).toUpperCase() + kind.slice(1)).replace(/-/g, ' ');

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
  if (option === 'Revise' && !reply) { c.querySelector('.reply').hidden = false; c.querySelector('[data-reply]').focus(); return toast('Say what to change, then press Revise again'); }
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
  if (b.dataset.toggleReply !== undefined) { const r = card(b).querySelector('.reply'); r.hidden = !r.hidden; if (!r.hidden) r.querySelector('textarea').focus(); return; }
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
    if (!(await ask('Approve ' + ids.length + (ids.length === 1 ? ' item?' : ' items?'), 'Each runs at its queue\\'s time, as it is now. Unsaved edits on these cards are not included.', 'Approve ' + ids.length))) return;
    try {
      const r = await post('/items/bulk', { ids, option: b.dataset.bulk });
      toast(r.decided.length + ' approved' + (r.failed.length ? ', ' + r.failed.length + ' not: ' + r.failed[0].error : ''), r.failed.length ? { error: true } : {});
      reload();
    } catch (err) { toast(err.message, { error: true }); }
  }
});
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
.item .body{margin-top:8px;font-size:14px;overflow-wrap:anywhere}.item .body.long{max-height:220px;overflow:auto}
.media{display:flex;gap:8px;overflow-x:auto;margin-top:10px}.media img,.media video{height:180px;border-radius:8px;border:1px solid var(--border);background:var(--bg)}
.fieldset{display:grid;gap:10px;margin-top:12px}.fieldset .field{position:relative}
.fieldset textarea{min-height:90px;width:100%;min-width:0}.fieldset input.input{width:100%;min-width:0}
.count{position:absolute;right:8px;top:0;font-size:11px;color:var(--text-dim)}.count.over{color:var(--red);font-weight:600}
.checks{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:4px;font-size:13px}
.checks li::before{content:'⚠ ';}.checks li.bad{color:var(--red)}.checks li.warn{color:var(--amber)}
.reply{margin-top:10px}.reply textarea{width:100%;min-width:0;min-height:60px}
.item .actions{margin-top:12px}.pick{width:18px;height:18px;accent-color:var(--accent)}
.revising{color:var(--amber);font-size:13px;margin-top:8px}
.result{font-size:13px;color:var(--text-dim);margin-top:4px;overflow-wrap:anywhere}
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

function mediaHtml(item: Item): string {
  if (!item.media.length) return '';
  return `<div class="media">${item.media
    .map((m) =>
      m.type === 'video'
        ? `<video src="${esc(m.url)}" controls preload="none" title="${esc(m.caption ?? '')}"></video>`
        : m.type === 'file'
          ? `<a class="chip" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">📄 ${esc(m.caption ?? 'Open file')} ↗</a>`
          : `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(m.url)}" alt="${esc(m.caption ?? '')}" loading="lazy"></a>`,
    )
    .join('')}</div>`;
}

function goesOut(ctx: DashboardContext, item: Item, data: ApprovalsData): string {
  if (item.mode !== 'queue') return '';
  const at = nextRun(item, data.queues(item.project)[item.queue ?? ''], ctx.timeZone, data.now);
  const where = [item.queue, item.window].filter(Boolean).join(' · ');
  return `<span>${at ? `goes out ${esc(at <= data.now + 60_000 ? 'now' : when(at, ctx.timeZone))}` : 'no window coming up'}${where ? ` · ${esc(where)}` : ''}</span>`;
}

function waitingCard(ctx: DashboardContext, item: Item, data: ApprovalsData, multi: boolean): string {
  const blocking = item.checks.some((c) => c.blocking);
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
        `<button type="button" class="btn quiet" data-toggle-reply>${item.mode === 'queue' ? 'Revise…' : 'Add a note…'}</button>`,
      ].join('')
    : '';
  return `<article class="card item${blocking ? ' bad' : ''}" data-item="${esc(item.id)}" data-title="${esc(item.title)}"${
    blocking ? '' : ' data-clean'
  }>
<div class="card-head"><div class="grow"><div class="title">${esc(item.title)}</div>
<div class="meta">${multi ? projectTag(ctx, item.project) : ''}${item.source ? `<span>${esc(item.source)}</span>` : ''}<span>${esc(
    relative(item.createdAt, data.now),
  )}</span>${goesOut(ctx, item, data)}</div></div>${
    data.canDecide && item.mode === 'queue' && !blocking
      ? `<input type="checkbox" class="pick" data-pick="${esc(item.id)}" aria-label="Select">`
      : ''
  }</div>
${item.body ? `<div class="body${long ? ' long' : ''}">${md(item.body)}</div>` : ''}
${mediaHtml(item)}
${item.fields.length ? `<div class="fieldset">${item.fields.map((f) => fieldHtml(f, data.canDecide)).join('')}</div>` : ''}
${item.checks.length ? `<ul class="checks">${item.checks.map((c) => `<li class="${c.blocking ? 'bad' : 'warn'}">${esc(c.text)}</li>`).join('')}</ul>` : ''}
${item.reply ? `<div class="revising">✏️ Revision asked: ${esc(item.reply)}</div>` : ''}
${
  data.canDecide
    ? `<div class="reply" hidden><textarea class="input" data-reply placeholder="${
        item.mode === 'queue'
          ? 'What should change? Jarvis makes a new version of this card.'
          : 'A note for Jarvis with your decision'
      }"></textarea>${item.mode === 'queue' ? '<div class="actions"><button type="button" class="btn ghost" data-decide="Revise">Revise</button></div>' : ''}</div>`
    : ''
}
${buttons ? `<div class="actions">${buttons}</div>` : ''}</article>`;
}

function scheduledRow(ctx: DashboardContext, item: Item, data: ApprovalsData, multi: boolean): string {
  const running = item.status === 'running';
  return `<div class="row"><span class="dot${running ? '' : ' ok'}"></span><span class="grow"><span class="title">${esc(item.title)}</span>
<span class="meta">${multi ? projectTag(ctx, item.project) : ''}<span class="tag">${esc(kindLabel(item.kind))}</span>${
    running ? '<span class="tag">running now</span>' : goesOut(ctx, item, data)
  }<span>approved ${esc(relative(item.decidedAt, data.now))}</span></span>${
    // Why an executor put it back ("daily cap reached").
    !running && item.result ? `<div class="result">Waiting: ${esc(item.result.slice(0, 300))}</div>` : ''
  }</span>${
    !running && data.canDecide
      ? `<span class="actions"><button type="button" class="btn quiet" data-cancel="${esc(item.id)}" data-title="${esc(item.title)}">Cancel</button></span>`
      : ''
  }</div>`;
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
  const tabs = (['waiting', 'scheduled', 'done'] as const)
    .map(
      (t) =>
        `<a class="chip${data.tab === t ? ' on' : ''}" href="${link({ tab: t === 'waiting' ? '' : t, kind: '' })}">${
          { waiting: 'Waiting', scheduled: 'Scheduled', done: 'Done' }[t]
        }<small>${data.counts[t]}</small></a>`,
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
  const kinds = [...new Set(data.items.map((i) => i.kind))];
  const kindChips =
    kinds.length > 1
      ? [
          `<a class="chip${data.kind ? '' : ' on'}" href="${link({ kind: '' })}">Every kind</a>`,
          ...kinds.map(
            (k) =>
              `<a class="chip${data.kind === k ? ' on' : ''}" href="${link({ kind: k })}">${esc(kindLabel(k))}<small>${
                data.items.filter((i) => i.kind === k).length
              }</small></a>`,
          ),
        ].join('')
      : '';
  const shown = data.kind ? data.items.filter((i) => i.kind === data.kind) : data.items;

  let body: string;
  if (data.tab === 'waiting') {
    body = kinds
      .filter((k) => !data.kind || k === data.kind)
      .map((k) => {
        const group = shown.filter((i) => i.kind === k);
        const clean = group.filter((i) => i.mode === 'queue' && !i.checks.some((c) => c.blocking));
        const label = `Approve all ${clean.length}`;
        const bulk =
          data.canDecide && clean.length > 1 && group[0]?.options[0]
            ? `<button type="button" class="btn ghost more" data-bulk="${esc(group[0].options[0])}" data-label="${esc(label)}">${esc(label)}</button>`
            : '';
        return `<div data-group>${section(
          kindLabel(k),
          group.map((i) => waitingCard(ctx, i, data, multi)).join(''),
          {
            sub: `${group.length}`,
            more: bulk,
          },
        )}</div>`;
      })
      .join('');
    if (!body) body = '<div class="clear">✓ Nothing waiting for you.</div>';
  } else if (data.tab === 'scheduled') {
    body = shown.length
      ? `<div class="todo">${shown.map((i) => scheduledRow(ctx, i, data, multi)).join('')}</div>`
      : '<div class="empty">Nothing approved is waiting to run.</div>';
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
<div class="toolbar"><div class="chips">${tabs}</div></div>
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
