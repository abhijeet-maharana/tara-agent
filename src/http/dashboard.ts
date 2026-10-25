import { closeSync, openSync, readSync } from 'node:fs';
import type { Project } from '../config/schema.js';
import type { JobInfo } from '../scheduler/scheduler.js';
import { formatDuration } from '../slack/format.js';
import type { SessionOverview, StoredRun } from '../store/store.js';
import { cronText } from './cron-text.js';
import { firstPrompt, parseTranscript, type TranscriptEntry, transcriptPath } from './transcript.js';

/**
 * Server-rendered pages for people (the same paths answer JSON for tools): a home page with what
 * needs attention, jobs with Run now / Pause / Resume, single runs, and sessions with their
 * transcripts. Plain HTML, inline CSS and a small script; phone-friendly, dark by default.
 */

export interface DashboardContext {
  projects: Project[];
  timeZone: string;
  /** Shown in the header and page titles (host `agentName`). */
  agentName: string;
  /** Slack workspace URL (https://acme.slack.com/), for thread links. */
  slackUrl?: string;
}

/** A job with its project and latest runs (newest first), as the home and jobs pages show it. */
export interface JobView extends JobInfo {
  project: string;
  recent: StoredRun[];
}

export interface HomeData {
  jobs: JobView[];
  /** Latest job runs across projects, newest first. */
  latest: StoredRun[];
  /** Job runs in the last 24 hours. */
  runsToday: number;
  uptimeSeconds: number;
  now: number;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Just enough Markdown for Claude's replies: code blocks, inline code, bold, links, line breaks. */
export function md(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith('```')) return `<pre>${esc(part.replace(/^```\w*\n?|```$/g, ''))}</pre>`;
      return esc(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\n/g, '<br>');
    })
    .join('');
}

/** "Sun 25 Oct, 6:00 pm" in the host timezone. */
function when(ms: number | string | Date | undefined, timeZone: string): string {
  if (ms === undefined) return '';
  return new Date(ms).toLocaleString('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

const clock = (ms: number | Date, timeZone: string) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true });

/** "in 3h 5m" or "2h ago". */
function relative(ms: number | Date | undefined, now: number): string {
  if (ms === undefined) return 'never';
  const mins = Math.round((new Date(ms).getTime() - now) / 60_000);
  const span = (m: number) =>
    m >= 1440
      ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
      : m >= 60
        ? `${Math.floor(m / 60)}h ${m % 60}m`
        : `${m}m`;
  if (mins > 0) return `in ${span(mins)}`;
  if (mins === 0) return 'just now';
  const ago = -mins;
  return ago < 60
    ? `${ago}m ago`
    : ago < 1440
      ? `${Math.round(ago / 60)}h ago`
      : `${Math.round(ago / 1440)}d ago`;
}

/** Run statuses that count as a failure. `silent` means the pre-run script found nothing to do. */
const FAILED = ['failed', 'error', 'timeout', 'limit'];
const RUN_LABEL: Record<string, string> = {
  ok: 'did work',
  silent: 'nothing to do',
  failed: 'failed',
  error: 'error',
  timeout: 'timed out',
  limit: 'usage limit',
  aborted: 'stopped',
};
const runTone = (status: string) => (FAILED.includes(status) ? 'bad' : status === 'ok' ? 'ok' : 'dim');
const runTag = (status?: string) =>
  status ? `<span class="tag ${runTone(status)}">${esc(RUN_LABEL[status] ?? status)}</span>` : '';

type JobState = 'running' | 'failing' | 'paused' | 'ok' | 'new';
function jobState(j: JobInfo): JobState {
  if (j.running) return 'running';
  if (!j.enabled) return 'paused';
  if (j.lastStatus && FAILED.includes(j.lastStatus)) return 'failing';
  return j.lastStatus ? 'ok' : 'new';
}
const STATE: Record<JobState, { label: string; tone: string; card: string }> = {
  running: { label: 'running now', tone: '', card: 'accent' },
  failing: { label: 'failing', tone: 'bad', card: 'bad' },
  paused: { label: 'paused', tone: 'warn', card: 'warn' },
  ok: { label: 'healthy', tone: 'ok', card: '' },
  new: { label: 'not run yet', tone: 'dim', card: '' },
};

/** Consecutive failed runs, newest first. */
const failureStreak = (runs: StoredRun[]) => {
  const i = runs.findIndex((r) => !FAILED.includes(r.status));
  return i === -1 ? runs.length : i;
};

const anchor = (j: { project: string; id: string }) => `job-${j.project}-${j.id}`;

function actionButton(j: JobView, action: 'run' | 'pause' | 'resume', label: string, kind = ''): string {
  return `<button type="button" class="btn ${kind}" data-action="${action}" data-job="${esc(j.project)}/${esc(j.id)}" data-name="${esc(j.name)}"${
    action === 'run' && j.running ? ' disabled' : ''
  }>${label}</button>`;
}

/** Recent runs as small squares, oldest on the left. */
function runStrip(runs: StoredRun[], timeZone: string): string {
  if (!runs.length) return '';
  const cells = [...runs]
    .reverse()
    .map(
      (r) =>
        `<i class="${runTone(r.status)}" title="${esc(`${when(r.startedAt, timeZone)}: ${RUN_LABEL[r.status] ?? r.status}`)}"></i>`,
    )
    .join('');
  return `<span class="strip" aria-label="Recent runs">${cells}</span>`;
}

function threadLink(ctx: DashboardContext, threadKey: string): string {
  const [channel, ts] = threadKey.split(':');
  if (!ctx.slackUrl || !channel || !ts) return '';
  return `<a href="${esc(ctx.slackUrl)}archives/${esc(channel)}/p${esc(ts.replace('.', ''))}">Slack thread ↗</a>`;
}

/** The first prompt of a session, read from the start of its transcript only (they can be large). */
function promptPreview(cwd: string, sessionId: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath(cwd, sessionId), 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    return firstPrompt(parseTranscript(text.slice(0, text.lastIndexOf('\n'))));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const CSS = `
:root{--bg:#090d16;--panel:#0d1320;--card:#111827;--card-hover:#162032;--line:#1f293d;--line-2:#2e3e5c;--fg:#cbd5e1;--dim:#94a3b8;--head:#f8fafc;
--accent:#38bdf8;--accent-bg:rgba(56,189,248,.12);--green:#10b981;--green-bg:rgba(16,185,129,.15);--amber:#f59e0b;--amber-bg:rgba(245,158,11,.12);
--red:#f43f5e;--red-bg:rgba(244,63,94,.12);--on-accent:#04121c;--radius:10px;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--panel:#fff;--card:#fff;--card-hover:#f1f5f9;--line:#e2e8f0;--line-2:#cbd5e1;--fg:#334155;--dim:#64748b;--head:#0f172a;
--accent:#0284c7;--accent-bg:rgba(2,132,199,.1);--green:#059669;--green-bg:rgba(5,150,105,.1);--amber:#b45309;--amber-bg:rgba(180,83,9,.1);--red:#e11d48;--red-bg:rgba(225,29,72,.08);--on-accent:#fff;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
a{color:var(--accent)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px;overflow-wrap:anywhere}
pre{margin:6px 0 0;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow-y:auto}
.shell{display:flex;min-height:100vh}
.sidebar{width:220px;flex:none;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;padding:18px 16px 14px;font-weight:700;color:var(--head);font-size:16px}
.logo{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:var(--accent-bg);color:var(--accent);font-size:14px}
.menu-btn{display:none;margin-left:auto;background:none;border:1px solid var(--line-2);color:var(--fg);border-radius:8px;padding:2px 10px;font-size:18px;cursor:pointer}
nav{display:flex;flex-direction:column;gap:2px;padding:4px 8px}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--fg);text-decoration:none;font-size:14px}
.nav-item:hover{background:var(--card)}.nav-item.on{background:var(--accent-bg);color:var(--accent);font-weight:600}
.nav-item span:nth-child(2){flex:1}.badge{min-width:22px;padding:0 7px;border-radius:999px;background:var(--red);color:#fff;font-size:12px;font-weight:600;text-align:center}
.side-foot{margin-top:auto;padding:12px 16px 16px;border-top:1px solid var(--line);font-size:12px}
.side-foot a{color:var(--dim);text-decoration:none}.side-foot a:hover{color:var(--accent)}
.main{flex:1;min-width:0;padding:28px 32px 80px}.main>*{max-width:980px}
.page-head{margin-bottom:18px}.page-head h1{margin:0;font-size:24px;color:var(--head);letter-spacing:-.01em;overflow-wrap:anywhere}
.sub{margin:4px 0 0;color:var(--dim);font-size:14px}
.section{margin:0 0 28px}.sec-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.sec-head h2{margin:0;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--head)}.sec-head span{color:var(--dim);font-size:12px}
.sec-head .more{margin-left:auto;font-size:13px}
.nowbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--dim);border-radius:var(--radius);padding:10px 14px;margin-bottom:22px}
.nowbar.live{border-left-color:var(--green)}.nowbar b{color:var(--head)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:24px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px}
.stat b{display:block;font-size:22px;color:var(--head);font-variant-numeric:tabular-nums}.stat span{font-size:12px;color:var(--dim)}
.stat.bad b{color:var(--red)}.stat.ok b{color:var(--green)}.stat.warn b{color:var(--amber)}
.todo{display:grid;gap:6px}
.row{display:flex;align-items:center;gap:12px;padding:11px 14px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);color:var(--fg);text-decoration:none}
a.row:hover{border-color:var(--line-2);background:var(--card-hover)}.row .grow{flex:1;min-width:0}
.dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--accent)}.dot.bad{background:var(--red)}.dot.warn{background:var(--amber)}.dot.ok{background:var(--green)}.dot.dim{background:var(--line-2)}
.clear{color:var(--green);background:var(--green-bg);border-radius:var(--radius);padding:11px 14px}
.timeline{list-style:none;margin:0;padding:0;font-size:14px}
.timeline li{display:grid;grid-template-columns:190px 1fr auto;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}
.timeline .when{color:var(--head);font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--rc,var(--line-2));border-radius:var(--radius);padding:13px 15px;margin-bottom:10px}
.grid .card{margin:0}.card.bad{--rc:var(--red)}.card.warn{--rc:var(--amber)}.card.ok{--rc:var(--green)}.card.accent{--rc:var(--accent)}
.card-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.card-head .grow{flex:1;min-width:220px}
.title{color:var(--head);font-weight:600;overflow-wrap:anywhere}a.title{text-decoration:none}a.title:hover{color:var(--accent)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:3px;font-size:12.5px;color:var(--dim)}.meta b{color:var(--head);font-weight:600}
.meta.error{color:var(--red)}
.tag{display:inline-block;padding:0 8px;border-radius:999px;background:var(--accent-bg);color:var(--accent);font-size:12px;line-height:20px;white-space:nowrap}
.tag.bad{background:var(--red-bg);color:var(--red)}.tag.ok{background:var(--green-bg);color:var(--green)}.tag.warn{background:var(--amber-bg);color:var(--amber)}.tag.dim{background:var(--line);color:var(--dim)}
.strip{display:inline-flex;gap:2px;vertical-align:middle}.strip i{width:9px;height:12px;border-radius:2px;background:var(--line-2)}
.strip i.ok{background:var(--green)}.strip i.bad{background:var(--red)}
details{margin-top:8px;font-size:13.5px}summary{cursor:pointer;color:var(--dim)}summary:hover{color:var(--fg)}
.facts{display:grid;grid-template-columns:110px 1fr;gap:4px 12px;margin:10px 0;font-size:13px}.facts dt{color:var(--dim)}.facts dd{margin:0;overflow-wrap:anywhere}
.runs{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.runs a{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;color:var(--fg);text-decoration:none;font-size:13px}.runs a:hover{background:var(--card-hover)}
.actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.actions.end{justify-content:flex-end}
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:var(--on-accent);border:1px solid transparent;border-radius:8px;padding:5px 12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;min-height:32px;white-space:nowrap}
.btn:hover{filter:brightness(1.1)}.btn.ghost{background:transparent;color:var(--fg);border-color:var(--line-2)}.btn.ghost:hover{background:var(--card-hover);filter:none}
.btn.quiet{background:transparent;color:var(--dim)}.btn.quiet:hover{color:var(--fg);filter:none}
.btn.green{background:var(--green-bg);color:var(--green);border-color:var(--green)}.btn.danger{background:var(--red);color:#fff}
.btn:disabled{opacity:.5;cursor:not-allowed;filter:none}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{background:transparent;color:var(--dim);border:1px solid var(--line-2);border-radius:999px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none}
.chip:hover{color:var(--fg)}.chip.on{background:var(--accent-bg);color:var(--accent);border-color:var(--accent)}.chip small{opacity:.75;margin-left:4px}
.input{background:var(--bg);color:var(--fg);border:1px solid var(--line-2);border-radius:8px;padding:6px 10px;font:inherit;font-size:14px;min-width:220px}
.input:focus{border-color:var(--accent);outline:none}
.empty{color:var(--dim);padding:10px 0}.dim{color:var(--dim)}.actions.below{margin-top:10px}.card.spaced{margin-top:16px}
.msg{margin:10px 0;padding:10px 12px;border-radius:var(--radius);background:var(--card);border:1px solid var(--line);overflow-wrap:anywhere;font-size:14px}
.msg.user{border-left:3px solid var(--accent)}.msg .who{font-size:12px;color:var(--dim);margin-bottom:4px}
.tool{margin:6px 0;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card)}.tool.err summary{color:var(--red)}
.toasts{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:grid;gap:8px;z-index:30;max-width:calc(100% - 32px)}
.toast{background:var(--card);border:1px solid var(--line-2);border-radius:var(--radius);padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.overlay{position:fixed;inset:0;background:rgba(3,6,12,.6);display:grid;place-items:center;padding:16px;z-index:40}
.dialog{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line-2);border-radius:14px;padding:20px;display:grid;gap:12px;box-shadow:0 20px 50px rgba(0,0,0,.4)}
.dialog h2{margin:0;font-size:17px;color:var(--head)}.dialog p{margin:0;color:var(--dim);font-size:14px}
@media (max-width:760px){.shell{display:block}
.sidebar{position:sticky;top:0;z-index:20;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line)}
.brand{padding:12px 16px}.menu-btn{display:block}.sidebar nav,.sidebar .side-foot{display:none}.sidebar.open nav{display:flex;padding-bottom:8px}.sidebar.open .side-foot{display:block}
.main{padding:18px 16px 80px}.page-head h1{font-size:21px}.timeline li{grid-template-columns:1fr auto}.timeline .when{grid-column:1/-1}
.input{min-width:0;width:100%}.row{flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

/** Confirm dialogs, toasts, Run now / Pause / Resume, the phone menu, and the auto-refresh. */
const SCRIPT = `
const toast = (text) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; document.getElementById('toasts').append(t); setTimeout(() => t.remove(), 4500); };
const ask = (title, body, ok, danger) => new Promise((resolve) => {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = '<form class="dialog" role="dialog" aria-modal="true"><h2></h2><p></p><div class="actions end"><button type="button" class="btn ghost">Cancel</button><button type="submit" class="btn"></button></div></form>';
  o.querySelector('h2').textContent = title;
  o.querySelector('p').textContent = body;
  const submit = o.querySelector('[type=submit]');
  submit.textContent = ok;
  if (danger) submit.classList.add('danger');
  const close = (v) => { o.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
  const onKey = (e) => e.key === 'Escape' && close(false);
  document.addEventListener('keydown', onKey);
  o.addEventListener('mousedown', (e) => e.target === o && close(false));
  o.querySelector('.ghost').addEventListener('click', () => close(false));
  o.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); close(true); });
  document.body.append(o);
  submit.focus();
});
const TEXT = {
  run: ['Run "%" now?', 'It starts within a few seconds. A pre-run script still decides whether there is anything to do.', 'Run now'],
  pause: ['Pause "%"?', 'It stops running on its schedule until you resume it. This sets "enabled": false in the project\\'s .tara/jobs.json.', 'Pause'],
  resume: ['Resume "%"?', 'It runs on its schedule again.', 'Resume'],
};
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  const { action, job, name } = b.dataset;
  const [title, body, ok] = TEXT[action];
  if (!(await ask(title.replace('%', name), body, ok, action === 'pause'))) return;
  b.disabled = true;
  try {
    const r = await fetch('/jobs/' + job + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"by":"dashboard"}' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    toast(action === 'run' ? (j.result === 'running' ? name + ' is already running' : name + ' started') : name + (j.enabled ? ' resumed' : ' paused'));
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    toast('⚠️ ' + err.message);
    b.disabled = false;
  }
});
document.querySelector('.menu-btn')?.addEventListener('click', (e) => {
  const open = document.querySelector('.sidebar').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
});
if (document.body.dataset.refresh) setInterval(() => {
  if (!document.hidden && !document.querySelector('.overlay, details[open], .input:focus')) location.reload();
}, 60000);
`;

/** Filters on the jobs page: project, state and search, kept in the URL so a refresh keeps them. */
const JOBS_SCRIPT = `
const params = new URLSearchParams(location.search);
const filter = { project: params.get('project') || '', state: params.get('state') || '', q: params.get('q') || '' };
const cards = [...document.querySelectorAll('[data-card]')];
const search = document.getElementById('q');
search.value = filter.q;
const apply = () => {
  let shown = 0;
  for (const c of cards) {
    const ok = (!filter.project || c.dataset.project === filter.project) && (!filter.state || c.dataset.state === filter.state) && (!filter.q || c.dataset.q.includes(filter.q.toLowerCase()));
    c.hidden = !ok;
    if (ok) shown++;
  }
  document.querySelectorAll('.chip[data-filter]').forEach((b) => b.classList.toggle('on', filter[b.dataset.filter] === b.dataset.value));
  document.getElementById('none').hidden = shown > 0;
  const p = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
  history.replaceState(null, '', location.pathname + (p.size ? '?' + p : '') + location.hash);
};
document.querySelectorAll('.chip[data-filter]').forEach((b) => b.addEventListener('click', () => { filter[b.dataset.filter] = b.dataset.value; apply(); }));
search.addEventListener('input', () => { filter.q = search.value.trim(); apply(); });
apply();
const target = location.hash && document.getElementById(location.hash.slice(1));
if (target) { target.hidden = false; target.querySelector('details')?.setAttribute('open', ''); target.scrollIntoView({ block: 'center' }); }
`;

type Page = 'Home' | 'Jobs' | 'Sessions';

function layout(
  ctx: DashboardContext,
  title: string,
  active: Page,
  body: string,
  opts: { failing?: number; refresh?: boolean; script?: string } = {},
): string {
  const nav = (
    [
      ['/', 'Home', '🏠', 0],
      ['/jobs', 'Jobs', '⏱️', opts.failing ?? 0],
      ['/sessions', 'Sessions', '💬', 0],
    ] as const
  )
    .map(
      ([href, label, icon, badge]) =>
        `<a href="${href}" class="nav-item${label === active ? ' on' : ''}"><span aria-hidden="true">${icon}</span><span>${label}</span>${
          badge ? `<span class="badge" title="failing jobs">${badge}</span>` : ''
        }</a>`,
    )
    .join('');
  const updated = clock(Date.now(), ctx.timeZone);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#090d16">
<title>${esc(title)} · ${esc(ctx.agentName)}</title>
<style>${CSS}</style></head><body${opts.refresh ? ' data-refresh="1"' : ''}><div class="shell">
<aside class="sidebar"><div class="brand"><span class="logo" aria-hidden="true">${esc(ctx.agentName.slice(0, 1).toUpperCase())}</span><span>${esc(ctx.agentName)}</span>
<button type="button" class="menu-btn" aria-label="Menu" aria-expanded="false">☰</button></div>
<nav>${nav}</nav><div class="side-foot"><a href="" title="Refresh now">Updated ${esc(updated)} ↻</a></div></aside>
<main class="main">${body}</main></div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script>${SCRIPT}${opts.script ?? ''}</script></body></html>`;
}

const pageHead = (title: string, sub?: string) =>
  `<header class="page-head"><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</header>`;

const section = (title: string, body: string, opts: { sub?: string; more?: string } = {}) =>
  `<section class="section"><div class="sec-head"><h2>${esc(title)}</h2>${opts.sub ? `<span>${esc(opts.sub)}</span>` : ''}${
    opts.more ?? ''
  }</div>${body}</section>`;

const stat = (label: string, value: string | number, tone = '', hint = '') =>
  `<div class="stat ${tone}"${hint ? ` title="${esc(hint)}"` : ''}><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

export function homePage(ctx: DashboardContext, data: HomeData): string {
  const { jobs, now } = data;
  const tz = ctx.timeZone;
  const failing = jobs.filter((j) => jobState(j) === 'failing');
  const paused = jobs.filter((j) => !j.enabled);
  const running = jobs.filter((j) => j.running);
  const upcoming = jobs
    .filter((j) => j.enabled && j.nextRun)
    .sort((a, b) => (a.nextRun?.getTime() ?? 0) - (b.nextRun?.getTime() ?? 0))
    .slice(0, 8);
  const names = new Map(jobs.map((j) => [`${j.project}:${j.id}`, j.name]));
  const hours = Math.floor(data.uptimeSeconds / 3600);
  const uptime =
    hours >= 24
      ? `${Math.floor(hours / 24)}d ${hours % 24}h`
      : `${hours}h ${Math.floor((data.uptimeSeconds % 3600) / 60)}m`;

  const nowbar = `<div class="nowbar${running.length ? ' live' : ''}"><b>${
    running.length ? `● Running now: ${esc(running.map((j) => j.name).join(', '))}` : '○ Idle'
  }</b><span class="dim">· up ${uptime} · ${jobs.length - paused.length} of ${jobs.length} jobs on</span></div>`;

  const stats = `<div class="stats">${stat('Failing jobs', failing.length, failing.length ? 'bad' : 'ok')}${stat(
    'Paused jobs',
    paused.length,
    paused.length ? 'warn' : '',
  )}${stat('Runs, last 24h', data.runsToday, '', 'Job runs, including ones with nothing to do')}${stat(
    'Next run',
    upcoming[0]?.nextRun ? relative(upcoming[0].nextRun, now).replace(/^in /, '') : '—',
    '',
    upcoming[0]?.name ?? '',
  )}</div>`;

  const attention = [
    ...failing.map(
      (
        j,
      ) => `<div class="row"><span class="dot bad"></span><span class="grow"><b class="title">${esc(j.name)}</b> failed ${esc(
        relative(j.lastRunAt, now),
      )}<span class="meta"><span class="tag dim">${esc(j.project)}</span>${
        failureStreak(j.recent) > 1 ? `<span class="tag bad">${failureStreak(j.recent)} in a row</span>` : ''
      }${j.lastError ? `<span>${esc(j.lastError.slice(0, 160))}</span>` : ''}</span></span>
<span class="actions">${actionButton(j, 'run', 'Run again', 'ghost')}<a class="btn quiet" href="/jobs#${anchor(j)}">Details</a></span></div>`,
    ),
    ...paused.map(
      (j) =>
        `<div class="row"><span class="dot warn"></span><span class="grow"><b class="title">${esc(j.name)}</b> is paused<span class="meta"><span class="tag dim">${esc(
          j.project,
        )}</span></span></span><span class="actions">${actionButton(j, 'resume', 'Resume', 'green')}</span></div>`,
    ),
  ].join('');

  const coming = upcoming.length
    ? `<ul class="timeline">${upcoming
        .map(
          (j) =>
            `<li><span class="when">${esc(clock(j.nextRun as Date, tz))} <span class="dim">· ${esc(
              relative(j.nextRun, now),
            )}</span></span><a href="/jobs#${anchor(j)}">${esc(j.name)}</a><span class="tag dim">${esc(j.project)}</span></li>`,
        )
        .join('')}</ul>`
    : '<div class="empty">Nothing scheduled.</div>';

  const ran = data.latest.length
    ? `<ul class="timeline">${data.latest
        .map(
          (r) =>
            `<li><span class="when">${esc(relative(r.startedAt, now))}</span><a href="/runs/${r.id}">${esc(
              names.get(`${r.project}:${r.jobId}`) ?? r.jobId,
            )}</a>${runTag(r.status)}</li>`,
        )
        .join('')}</ul>`
    : '<div class="empty">No runs yet.</div>';

  const projects = ctx.projects
    .map((p) => {
      const name = p.config.name;
      const own = jobs.filter((j) => j.project === name);
      const bad = own.filter((j) => jobState(j) === 'failing').length;
      const off = own.filter((j) => !j.enabled).length;
      const tone = bad ? 'bad' : off ? 'warn' : own.length ? 'ok' : '';
      const health = bad
        ? `${bad} failing`
        : off
          ? `${off} paused`
          : own.length
            ? 'all healthy'
            : 'no scheduled jobs';
      return `<article class="card ${tone}"><div class="title">${esc(name)}</div>
<div class="meta"><span>${own.length} ${own.length === 1 ? 'job' : 'jobs'}</span><span class="tag ${tone || 'dim'}">${health}</span></div>
<div class="actions below">${
        p.config.dashboardUrl
          ? `<a class="btn" href="${esc(p.config.dashboardUrl)}" target="_blank" rel="noopener noreferrer">Open dashboard ↗</a>`
          : ''
      }<a class="btn ghost" href="/jobs?project=${esc(name)}">Jobs</a><a class="btn quiet" href="/sessions?project=${esc(name)}">Sessions</a></div></article>`;
    })
    .join('');

  return layout(
    ctx,
    'Home',
    'Home',
    `${pageHead(ctx.agentName, `${esc(when(now, tz))} · times in ${esc(tz)}`)}${nowbar}${stats}
${section(
  'Needs attention',
  attention ? `<div class="todo">${attention}</div>` : '<div class="clear">✓ Nothing needs attention.</div>',
  {
    sub: failing.length + paused.length ? `${failing.length + paused.length} jobs` : undefined,
  },
)}
${section('Coming up', coming, { sub: 'next scheduled runs', more: '<a class="more" href="/jobs">All jobs →</a>' })}
${section('Just ran', ran, { sub: 'latest runs' })}
${section('Projects', `<div class="grid">${projects}</div>`)}`,
    { failing: failing.length, refresh: true },
  );
}

const STATE_ORDER: Record<JobState, number> = { failing: 0, running: 1, ok: 2, new: 2, paused: 3 };

export function jobsPage(ctx: DashboardContext, jobs: JobView[], now = Date.now()): string {
  const tz = ctx.timeZone;
  const sorted = [...jobs].sort(
    (a, b) =>
      STATE_ORDER[jobState(a)] - STATE_ORDER[jobState(b)] ||
      (a.nextRun?.getTime() ?? Infinity) - (b.nextRun?.getTime() ?? Infinity),
  );
  const count = (pred: (j: JobView) => boolean) => jobs.filter(pred).length;
  const chip = (key: string, value: string, label: string, n: number) =>
    `<button type="button" class="chip" data-filter="${key}" data-value="${esc(value)}">${esc(label)}<small>${n}</small></button>`;
  const projectChips = [
    chip('project', '', 'All projects', jobs.length),
    ...ctx.projects.map((p) =>
      chip(
        'project',
        p.config.name,
        p.config.name,
        count((j) => j.project === p.config.name),
      ),
    ),
  ].join('');
  const stateChips = [
    chip('state', '', 'Any state', jobs.length),
    chip(
      'state',
      'failing',
      'Failing',
      count((j) => jobState(j) === 'failing'),
    ),
    chip(
      'state',
      'paused',
      'Paused',
      count((j) => jobState(j) === 'paused'),
    ),
    chip(
      'state',
      'running',
      'Running',
      count((j) => jobState(j) === 'running'),
    ),
  ].join('');

  const cards = sorted
    .map((j) => {
      const state = jobState(j);
      const streak = failureStreak(j.recent);
      const next =
        j.enabled && j.nextRun
          ? `<span>Next <b>${esc(when(j.nextRun, tz))}</b> (${esc(relative(j.nextRun, now))})</span>`
          : '';
      const history = j.recent.length
        ? `<ul class="runs">${j.recent
            .map(
              (r) =>
                `<li><a href="/runs/${r.id}"><span class="dot ${runTone(r.status)}"></span>${esc(when(r.startedAt, tz))}<span class="dim">· ${esc(
                  RUN_LABEL[r.status] ?? r.status,
                )} · ${formatDuration(r.endedAt - r.startedAt)}</span></a></li>`,
            )
            .join('')}</ul>`
        : '<div class="empty">No runs yet.</div>';
      return `<article class="card ${STATE[state].card}" id="${anchor(j)}" data-card data-project="${esc(j.project)}" data-state="${state}" data-q="${esc(
        `${j.name} ${j.id} ${j.skills.join(' ')}`.toLowerCase(),
      )}">
<div class="card-head"><div class="grow"><div class="title">${esc(j.name)}</div>
<div class="meta"><span class="tag ${STATE[state].tone}">${STATE[state].label}</span><span class="tag dim">${esc(j.project)}</span><span title="${esc(
        `${j.cron} (${j.tz})`,
      )}">${esc(cronText(j.cron, j.tz, tz))}</span></div></div>
<div class="actions">${actionButton(j, 'run', 'Run now', 'ghost')}${
        j.enabled ? actionButton(j, 'pause', 'Pause', 'quiet') : actionButton(j, 'resume', 'Resume', 'green')
      }</div></div>
<div class="meta">${next}<span>Last run ${esc(relative(j.lastRunAt, now))}</span>${runStrip(j.recent, tz)}${
        streak > 1 ? `<span class="tag bad">${streak} failures in a row</span>` : ''
      }</div>
${state === 'failing' && j.lastError ? `<div class="meta error">Last error: ${esc(j.lastError)}</div>` : ''}
<details><summary>Details and run history</summary><dl class="facts">
<dt>Skills</dt><dd>${j.skills.length ? esc(j.skills.join(', ')) : '—'}</dd>
<dt>Pre-run script</dt><dd>${j.preScript ? `<code>${esc(j.preScript)}</code>` : 'None: the model starts straight away'}</dd>
<dt>Model</dt><dd>${esc(j.model)}</dd>
${j.durationMinutes ? `<dt>Usual length</dt><dd>${j.durationMinutes} min</dd>` : ''}
<dt>Schedule</dt><dd><code>${esc(j.cron)}</code> ${esc(j.tz)}</dd>
<dt>Job id</dt><dd><code>${esc(j.id)}</code></dd></dl>${history}</details></article>`;
    })
    .join('');

  return layout(
    ctx,
    'Jobs',
    'Jobs',
    `${pageHead('Jobs', `Every scheduled job, across ${ctx.projects.length} ${ctx.projects.length === 1 ? 'project' : 'projects'}. Times in ${esc(tz)}.`)}
<div class="toolbar"><div class="chips">${projectChips}</div></div>
<div class="toolbar"><div class="chips">${stateChips}</div><input id="q" class="input" type="search" placeholder="Search jobs" aria-label="Search jobs"></div>
${cards}<div id="none" class="empty" hidden>${jobs.length ? 'No jobs match.' : 'No scheduled jobs.'}</div>
<p class="sub">Run now posts in the job's Slack channel and streams live to the project owner. Pause and Resume edit <code>enabled</code> in the project's <code>.tara/jobs.json</code>.</p>`,
    { failing: count((j) => jobState(j) === 'failing'), refresh: true, script: JOBS_SCRIPT },
  );
}

export function runPage(
  ctx: DashboardContext,
  run: StoredRun | undefined,
  jobNames?: Map<string, string>,
): string {
  if (!run) return layout(ctx, 'Run', 'Jobs', `${pageHead('Run')}<div class="empty">No such run.</div>`);
  const name = run.jobId ? (jobNames?.get(`${run.project}:${run.jobId}`) ?? run.jobId) : 'Chat turn';
  const links = [
    run.jobId ? `<a href="/jobs#${anchor({ project: run.project, id: run.jobId })}">Job</a>` : '',
    run.sessionId ? `<a href="/sessions/${esc(run.sessionId)}">Transcript</a>` : '',
    run.threadKey ? threadLink(ctx, run.threadKey) : '',
  ]
    .filter(Boolean)
    .join('');
  return layout(
    ctx,
    name,
    run.kind === 'job' ? 'Jobs' : 'Sessions',
    `${pageHead(name)}<div class="meta">${runTag(run.status)}<span class="tag dim">${esc(run.project)}</span>
<span>${esc(when(run.startedAt, ctx.timeZone))}</span><span>${formatDuration(run.endedAt - run.startedAt)}</span>${
      run.toolCalls ? `<span>${run.toolCalls} tool calls</span>` : ''
    }${links}</div>
${run.error ? `<article class="card bad spaced"><div class="title">Error</div><pre>${esc(run.error)}</pre></article>` : ''}
${section(
  'Reply',
  run.output
    ? `<div class="msg">${md(run.output)}</div>`
    : `<div class="empty">${run.status === 'silent' ? 'The pre-run script found nothing to do, so the model did not run.' : 'No reply recorded.'}</div>`,
)}
${run.scriptOutput ? section('Script output', `<pre>${esc(run.scriptOutput)}</pre>`) : ''}`,
  );
}

export function sessionsPage(
  ctx: DashboardContext,
  sessions: SessionOverview[],
  jobNames: Map<string, string>,
  filter: { project?: string; kind?: string },
): string {
  const chips = (key: 'project' | 'kind', values: [string, string][]) =>
    values
      .map(([v, label]) => {
        const params = new URLSearchParams({ ...filter, [key]: v } as Record<string, string>);
        for (const [k, val] of [...params]) if (!val) params.delete(k);
        const on = (filter[key] ?? '') === v;
        return `<a class="chip${on ? ' on' : ''}" href="/sessions${params.size ? `?${params}` : ''}">${esc(label)}</a>`;
      })
      .join('');
  const dirs = new Map(ctx.projects.map((p) => [p.config.name, p.dir]));
  const rows = sessions
    .filter((s) => !filter.kind || (s.lastRun?.kind ?? 'chat') === filter.kind)
    .map((s) => {
      const run = s.lastRun;
      const kind = run?.kind ?? 'chat';
      const jobName = run?.jobId ? (jobNames.get(`${s.project}:${run.jobId}`) ?? run.jobId) : undefined;
      const title =
        kind === 'job'
          ? jobName
          : (promptPreview(dirs.get(s.project) ?? '', s.sessionId) ?? '(no prompt yet)');
      const tokens = run ? (run.inputTokens ?? 0) + (run.outputTokens ?? 0) : 0;
      return `<a class="row" href="/sessions/${esc(s.sessionId)}"><span class="dot ${run ? runTone(run.status) : 'dim'}"></span><span class="grow">
<span class="title">${kind === 'job' ? '⏱ ' : '💬 '}${esc((title ?? '').slice(0, 160))}</span>
<span class="meta"><span class="tag dim">${esc(s.project)}</span>${runTag(run?.status)}<span>${esc(s.model)}</span>
<span>${s.turns} ${s.turns === 1 ? 'run' : 'runs'}</span><span>${esc(when(run?.startedAt ?? s.updatedAt, ctx.timeZone))}</span>
${run ? `<span>${formatDuration(run.endedAt - run.startedAt)}</span>` : ''}${tokens ? `<span>${(tokens / 1000).toFixed(1)}k tok</span>` : ''}</span></span></a>`;
    })
    .join('');
  return layout(
    ctx,
    'Sessions',
    'Sessions',
    `${pageHead('Sessions', 'Slack threads and job runs on this host, newest first.')}
<div class="toolbar"><div class="chips">${chips('project', [['', 'All projects'], ...ctx.projects.map((p): [string, string] => [p.config.name, p.config.name])])}</div></div>
<div class="toolbar"><div class="chips">${chips('kind', [
      ['', 'Chats and jobs'],
      ['chat', 'Chats'],
      ['job', 'Jobs'],
    ])}</div></div>
<div class="todo">${rows || '<div class="empty">No sessions yet.</div>'}</div>
<p class="sub">Claude Code sessions of other users on this machine are not listed.</p>`,
  );
}

function entryHtml(e: TranscriptEntry, timeZone: string): string {
  const time = e.time ? ` · ${esc(when(e.time, timeZone))}` : '';
  if (e.kind === 'user') {
    // Job prompts start with the pre-script's data block: fold it so the prompt stays readable.
    const script = /^## Script (Output|Error)\n[^\n]*\n\n```\n([\s\S]*?)\n```\n\n/.exec(e.text);
    let rest = script ? e.text.slice(script[0].length) : e.text;
    // Chat prompts start with the sender's Slack mention; show it as the author instead.
    const sender = /^<@([A-Z0-9]+)>:\s*/.exec(rest);
    if (sender) rest = rest.slice(sender[0].length);
    const who = sender ? `From <code>${esc(sender[1])}</code>` : 'Prompt';
    return `<div class="msg user"><div class="who">${who}${time}</div>${
      script
        ? `<details><summary>Script ${esc(script[1]?.toLowerCase())}</summary><pre>${esc(script[2])}</pre></details>`
        : ''
    }${md(rest)}</div>`;
  }
  if (e.kind === 'assistant')
    return `<div class="msg"><div class="who">Claude${time}</div>${md(e.text)}</div>`;
  return `<details class="tool${e.isError ? ' err' : ''}"><summary>${e.isError ? '❌' : '🔧'} ${esc(e.summary)}${time}</summary>
<pre>${esc(e.input)}</pre>${e.result !== undefined ? `<div class="sub">Result</div><pre>${esc(e.result)}</pre>` : ''}</details>`;
}

export function sessionPage(
  ctx: DashboardContext,
  session: SessionOverview | undefined,
  sessionId: string,
  entries: TranscriptEntry[] | undefined,
): string {
  const head = session
    ? `<div class="meta"><span class="tag dim">${esc(session.project)}</span>${runTag(session.lastRun?.status)}<span>${esc(session.model)}</span>
<span>${session.turns} runs</span><span><code>${esc(sessionId)}</code></span>${threadLink(ctx, session.threadKey)}</div>`
    : `<div class="meta"><code>${esc(sessionId)}</code></div>`;
  const body = entries?.length
    ? entries.map((e) => entryHtml(e, ctx.timeZone)).join('')
    : '<div class="empty">No transcript for this session on this host.</div>';
  return layout(ctx, 'Session', 'Sessions', `${pageHead('Session')}${head}${body}`);
}
