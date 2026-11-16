import type { Reminder } from '../store/store.js';
import { cronText } from './cron-text.js';
import {
  type DashboardContext,
  esc,
  layout,
  pageHead,
  projectTitle,
  relative,
  section,
  when,
} from './dashboard.js';

/**
 * The Reminders page: every project's reminders and scheduled tasks still to come, soonest first, each
 * with Cancel. They are set by asking in Slack (`set_reminder`, `schedule_task`); a reminder starts no run,
 * a task starts one run in a fresh thread at its time.
 */

const STYLE = `<style>
.rem-list{display:grid;gap:8px}
.rem .when{font-variant-numeric:tabular-nums}
.rem .note{white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.rem details{margin-top:6px;font-size:12.5px;color:var(--text-dim)}.rem details summary{cursor:pointer}
.rem details code{overflow-wrap:anywhere}
</style>`;

const SCRIPT = `
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-cancel]');
  if (!b) return;
  if (!(await ask('Cancel this?', b.dataset.text, 'Cancel it', true))) return;
  b.disabled = true;
  try {
    await post('/reminders/' + b.dataset.cancel + '/cancel', {});
    toast('Cancelled');
    reload();
  } catch (err) { toast(err.message, { error: true }); b.disabled = false; }
});
`;

/**
 * How often, as a sentence: "Every month on the 19th at 9:30 AM", "Every day at 10:00 AM",
 * "Every Mon at 9:00 AM". The jobs pages keep cronText's shorter labels.
 */
export function repeatText(cron: string, timeZone: string): string {
  const t = cronText(cron, timeZone, timeZone);
  if (t === cron) return 'Repeats on a custom schedule (see Details)';
  const daily = /^Daily (.+)$/.exec(t);
  if (daily) return `Every day at ${daily[1]}`;
  const monthly = /^(.+) of the month, (.+)$/.exec(t);
  if (monthly) return `Every month on the ${monthly[1]} at ${monthly[2]}`;
  const weekly = /^(?:Every )?(.+?) (\d{1,2}:\d{2} [AP]M.*)$/.exec(t);
  if (weekly) return `Every ${weekly[1]} at ${weekly[2]}`;
  return t;
}

function row(ctx: DashboardContext, r: Reminder, now: number, hookName: string | undefined): string {
  const repeat = r.cron ? `🔁 ${repeatText(r.cron, ctx.timeZone)}` : 'Once only';
  const also = r.notify ? `<span class="tag">+ ${esc(hookName ?? 'hook')}</span>` : '';
  const kind = r.task ? '<span class="tag">▶️ Task: starts a run</span>' : '';
  const title = r.task
    ? `<span class="title">${esc(r.title ?? 'Scheduled Task')}</span><span class="meta note">${esc(r.text)}</span>`
    : `<span class="title">${esc(r.text)}</span>`;
  return `<div class="row rem"><span class="dot ${r.cron ? '' : 'dim'}"></span><span class="grow">
${title}
<span class="meta"><b>${esc(repeat)}</b>${kind}${also}</span>
<span class="meta">${r.cron ? 'Next' : 'On'}: <span class="when">${esc(when(r.nextAt, ctx.timeZone))}</span><span>(${esc(relative(r.nextAt, now))})</span></span>
<details><summary>Details</summary>${r.cron ? `cron <code>${esc(r.cron)}</code> · ` : ''}id <code>${esc(r.id)}</code> · set by ${esc(
    r.createdBy ?? 'unknown',
  )} ${esc(relative(r.createdAt, now))}${r.lastAt ? ` · last posted ${esc(relative(r.lastAt, now))}` : ''}</details>
</span><button type="button" class="btn ghost" data-cancel="${esc(r.project)}/${esc(r.id)}" data-text="${esc(r.text)}">Cancel</button></div>`;
}

export function remindersPage(
  ctx: DashboardContext,
  data: { reminders: (project: string) => Reminder[]; now: number },
): string {
  const sections = ctx.projects.map((p) => {
    const name = p.config.name;
    const list = data.reminders(name);
    const hookName = p.config.reminders?.hookUrl ? (p.config.reminders.label ?? 'hook') : undefined;
    const body = list.length
      ? `<div class="rem-list">${list.map((r) => row(ctx, r, data.now, hookName)).join('')}</div>`
      : `<p class="empty">Nothing scheduled. Ask in its Slack channel, e.g. "remind me every Monday at 9 to check stock" or "check the PR's CI at 5pm".</p>`;
    return section(projectTitle(ctx, name), body, {
      sub: list.length ? `${list.length} to come` : undefined,
    });
  });
  const body = `${STYLE}${pageHead(
    'Reminders',
    'Reminders are posted in the project\'s Slack channel at their time, with no Claude run. Tasks (▶️) start one run in a fresh thread at their time, then are gone. To add either, ask in Slack: "remind me on the 19th of every month to file GSTR-3B", "tomorrow at 9, post the weekly summary".',
  )}${sections.join('')}`;
  return layout(ctx, 'Reminders', 'Reminders', body, { refresh: true, script: SCRIPT });
}
