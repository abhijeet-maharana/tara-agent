import type { Task, TaskLevel } from '../store/store.js';
import { type DashboardContext, esc, layout, pageHead, section, taskRow } from './dashboard.js';

/**
 * The inbox: what only a person can do, left by job runs and chats (the `add_task` tool) or added
 * by hand, most urgent first. Done tasks stay for a day under "Done today", with Reopen.
 */

const LEVELS: Array<{ level: TaskLevel; title: string; sub: string; empty: string }> = [
  { level: 'urgent', title: 'Urgent', sub: 'do these today', empty: 'Nothing urgent.' },
  { level: 'decide', title: 'Decide', sub: 'approvals and drafts to review', empty: 'No decisions waiting.' },
  { level: 'later', title: 'Later', sub: 'this week or someday', empty: 'Nothing for later.' },
];

const ADD_SCRIPT = `
document.getElementById('add')?.addEventListener('click', () => {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = document.getElementById('add-form').innerHTML;
  const form = o.querySelector('form');
  const close = () => { o.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  o.addEventListener('mousedown', (e) => e.target === o && close());
  o.querySelector('.ghost').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try { await post('/inbox', { ...data, source: 'manual' }); close(); toast('Added'); reload(); }
    catch (err) { toast(err.message, { error: true }); }
  });
  document.body.append(o);
  o.querySelector('[name=title]').focus();
});
`;

export function inboxPage(
  ctx: DashboardContext,
  open: Task[],
  doneToday: Task[],
  opts: { project?: string; now: number },
): string {
  const showProject = !opts.project && ctx.projects.length > 1;
  const chip = (name: string, label: string, n: number) =>
    `<a class="chip${(opts.project ?? '') === name ? ' on' : ''}" href="/inbox${name ? `?project=${esc(name)}` : ''}">${esc(label)}<small>${n}</small></a>`;
  const counts = new Map<string, number>();
  for (const t of open) counts.set(t.project, (counts.get(t.project) ?? 0) + 1);
  const chips =
    ctx.projects.length > 1
      ? [
          chip('', 'All', open.length),
          ...ctx.projects.map((p) =>
            chip(p.config.name, p.config.title ?? p.config.name, counts.get(p.config.name) ?? 0),
          ),
        ].join('')
      : '';
  const shown = opts.project ? open.filter((t) => t.project === opts.project) : open;
  const done = opts.project ? doneToday.filter((t) => t.project === opts.project) : doneToday;

  const sections = LEVELS.map(({ level, title, sub, empty }) => {
    const tasks = shown.filter((t) => t.level === level);
    if (!tasks.length && level === 'later') return '';
    return section(
      title,
      tasks.length
        ? `<div class="todo">${tasks.map((t) => taskRow(ctx, t, opts.now, { showProject })).join('')}</div>`
        : `<div class="${level === 'urgent' ? 'clear' : 'empty'}">${level === 'urgent' ? '✓ ' : ''}${empty}</div>`,
      { sub: tasks.length ? `${tasks.length} · ${sub}` : sub },
    );
  }).join('');

  const projectOptions = ctx.projects
    .map(
      (p) =>
        `<option value="${esc(p.config.name)}"${p.config.name === opts.project ? ' selected' : ''}>${esc(p.config.title ?? p.config.name)}</option>`,
    )
    .join('');
  const form = `<template id="add-form"><form class="dialog" role="dialog" aria-modal="true" aria-labelledby="add-title"><h2 id="add-title">Add a task</h2>
<label class="field">What needs doing<input class="input" name="title" required maxlength="160"></label>
<div class="fields"><label class="field">Project<select class="input" name="project">${projectOptions}</select></label>
<label class="field">When<select class="input" name="level"><option value="urgent">Urgent</option><option value="decide" selected>Decide</option><option value="later">Later</option></select></label></div>
<label class="field">Details (optional)<textarea class="input" name="details" maxlength="4000"></textarea></label>
<div class="actions end"><button type="button" class="btn ghost">Cancel</button><button type="submit" class="btn">Add</button></div></form></template>`;

  return layout(
    ctx,
    'Inbox',
    'Inbox',
    `${pageHead('Inbox', 'What only you can do, left by jobs and chats. Most urgent first.')}
<div class="toolbar"><div class="chips">${chips}</div><button type="button" class="btn ghost" id="add">+ Add task</button></div>
${sections}
${
  done.length
    ? `<details><summary>Done today (${done.length})</summary><div class="todo" style="margin-top:8px">${done
        .map((t) => taskRow(ctx, t, opts.now, { showProject }))
        .join('')}</div></details>`
    : ''
}${form}`,
    { refresh: true, script: ADD_SCRIPT },
  );
}
