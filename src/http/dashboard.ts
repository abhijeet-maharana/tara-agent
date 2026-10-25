import { closeSync, openSync, readSync } from 'node:fs';
import type { Project } from '../config/schema.js';
import type { JobInfo } from '../scheduler/scheduler.js';
import { formatDuration } from '../slack/format.js';
import type { SessionOverview, StoredRun } from '../store/store.js';
import { firstPrompt, parseTranscript, type TranscriptEntry, transcriptPath } from './transcript.js';

/**
 * Server-rendered pages for people (the same paths answer JSON for tools): sessions with their
 * transcripts, jobs with "Run now", and single runs. Plain HTML + a little CSS, phone-friendly.
 */

export interface DashboardContext {
  projects: Project[];
  timeZone: string;
  /** Slack workspace URL (https://acme.slack.com/), for thread links. */
  slackUrl?: string;
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

function when(ms: number | string | undefined, timeZone: string): string {
  if (ms === undefined) return '';
  return new Date(ms).toLocaleString('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_ICON: Record<string, string> = {
  ok: '✅',
  silent: '🔇',
  failed: '❌',
  error: '❌',
  timeout: '⌛',
  limit: '⏸',
  aborted: '⏹',
};
const statusBadge = (status?: string) =>
  status ? `<span class="badge s-${esc(status)}">${STATUS_ICON[status] ?? ''} ${esc(status)}</span>` : '';

function threadLink(ctx: DashboardContext, threadKey: string): string {
  const [channel, ts] = threadKey.split(':');
  if (!ctx.slackUrl || !channel || !ts) return '';
  return `<a class="slack" href="${esc(ctx.slackUrl)}archives/${esc(channel)}/p${esc(ts.replace('.', ''))}">Slack thread ↗</a>`;
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

function layout(title: string, active: string, body: string): string {
  const nav = [
    ['/', 'Sessions'],
    ['/jobs', 'Jobs'],
  ]
    .map(([href, label]) => `<a href="${href}"${label === active ? ' class="on"' : ''}>${label}</a>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · tara</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#2563eb;--code:#f5f5f4;--ok:#15803d;--bad:#b91c1c;--warn:#a16207}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--code:#292524;--ok:#4ade80;--bad:#f87171;--warn:#facc15}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:1}
header b{font-size:17px}header nav{display:flex;gap:4px}header nav a{padding:4px 10px;border-radius:8px;color:var(--muted);text-decoration:none}
header nav a.on{background:var(--code);color:var(--fg)}main{max-width:960px;margin:0 auto;padding:16px}
a{color:var(--accent)}h1{font-size:20px;margin:4px 0 12px}h2{font-size:16px;margin:24px 0 8px}
.muted{color:var(--muted)}.row{display:block;padding:12px;margin:8px 0;background:var(--card);border:1px solid var(--line);border-radius:12px;text-decoration:none;color:inherit}
.row:hover{border-color:var(--accent)}.meta{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:13px;color:var(--muted);margin-top:4px}
.title{font-weight:600;overflow-wrap:anywhere}.badge{font-size:12px;padding:1px 8px;border-radius:999px;background:var(--code);white-space:nowrap}
.s-ok{color:var(--ok)}.s-failed,.s-error{color:var(--bad)}.s-limit,.s-timeout{color:var(--warn)}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.filters a{font-size:13px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--fg)}
.filters a.on{background:var(--fg);color:var(--bg)}
.msg{margin:10px 0;padding:10px 12px;border-radius:12px;background:var(--card);border:1px solid var(--line);overflow-wrap:anywhere}
.msg.user{border-left:3px solid var(--accent)}.msg .who{font-size:12px;color:var(--muted);margin-bottom:4px}
details{margin:6px 0;padding:6px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
summary{cursor:pointer;font-size:14px}details.err summary{color:var(--bad)}
pre{background:var(--code);padding:8px;border-radius:8px;overflow-x:auto;font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere}
code{background:var(--code);padding:0 4px;border-radius:4px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
button{font:inherit;font-size:13px;padding:4px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button:disabled{opacity:.5}.slack{font-size:13px}
@media (max-width:640px){td.hide,th.hide{display:none}}
</style></head><body><header><b>tara</b><nav>${nav}</nav></header><main>${body}</main></body></html>`;
}

export function sessionsPage(
  ctx: DashboardContext,
  sessions: SessionOverview[],
  jobNames: Map<string, string>,
  filter: { project?: string; kind?: string },
): string {
  const chips = (key: 'project' | 'kind', values: string[]) =>
    ['', ...values]
      .map((v) => {
        const params = new URLSearchParams({ ...filter, [key]: v } as Record<string, string>);
        for (const [k, val] of [...params]) if (!val) params.delete(k);
        const on = (filter[key] ?? '') === v;
        return `<a href="/?${params}"${on ? ' class="on"' : ''}>${esc(v || 'all')}</a>`;
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
      return `<a class="row" href="/sessions/${esc(s.sessionId)}">
<div class="title">${kind === 'job' ? '⏱ ' : '💬 '}${esc((title ?? '').slice(0, 160))}</div>
<div class="meta"><span>${esc(s.project)}</span><span>${esc(s.model)}</span>${statusBadge(run?.status)}
<span>${s.turns} ${s.turns === 1 ? 'run' : 'runs'}</span><span>${esc(when(run?.startedAt ?? s.updatedAt, ctx.timeZone))}</span>
${run ? `<span>${formatDuration(run.endedAt - run.startedAt)}</span>` : ''}${tokens ? `<span>${(tokens / 1000).toFixed(1)}k tok</span>` : ''}</div></a>`;
    })
    .join('');
  return layout(
    'Sessions',
    'Sessions',
    `<h1>Sessions</h1><div class="filters">${chips(
      'project',
      ctx.projects.map((p) => p.config.name),
    )}</div>
<div class="filters">${chips('kind', ['chat', 'job'])}</div>
${rows || '<p class="muted">No sessions yet.</p>'}
<p class="muted">Sessions tara-agent ran on this host (Slack threads and job runs). Claude Code sessions of other users on this machine are not listed.</p>`,
  );
}

function entryHtml(e: TranscriptEntry, timeZone: string): string {
  const time = e.time ? `<span class="muted"> · ${esc(when(e.time, timeZone))}</span>` : '';
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
  return `<details${e.isError ? ' class="err"' : ''}><summary>${e.isError ? '❌' : '🔧'} ${esc(e.summary)}${time}</summary>
<pre>${esc(e.input)}</pre>${e.result !== undefined ? `<div class="muted">Result</div><pre>${esc(e.result)}</pre>` : ''}</details>`;
}

export function sessionPage(
  ctx: DashboardContext,
  session: SessionOverview | undefined,
  sessionId: string,
  entries: TranscriptEntry[] | undefined,
): string {
  const head = session
    ? `<div class="meta"><span>${esc(session.project)}</span><span>${esc(session.model)}</span>${statusBadge(session.lastRun?.status)}
<span>${session.turns} runs</span><span><code>${esc(sessionId)}</code></span>${threadLink(ctx, session.threadKey)}</div>`
    : `<p class="muted"><code>${esc(sessionId)}</code></p>`;
  const body = entries?.length
    ? entries.map((e) => entryHtml(e, ctx.timeZone)).join('')
    : '<p class="muted">No transcript for this session on this host.</p>';
  return layout('Session', 'Sessions', `<h1>Session</h1>${head}${body}`);
}

export function jobsPage(ctx: DashboardContext, jobs: Map<string, JobInfo[]>): string {
  const sections = ctx.projects
    .map((p) => {
      const list = jobs.get(p.config.name) ?? [];
      if (list.length === 0) return '';
      const rows = list
        .map(
          (j) => `<tr><td><div class="title">${esc(j.name)}</div><div class="meta"><code>${esc(j.id)}</code>
<span>${esc(j.cron)} (${esc(j.tz)})</span>${j.enabled ? '' : '<span class="badge">paused</span>'}</div></td>
<td class="hide">${esc(when(j.nextRun?.getTime(), ctx.timeZone)) || '—'}</td>
<td>${j.running ? '<span class="badge">🔄 running</span>' : statusBadge(j.lastStatus)}<div class="meta">${esc(when(j.lastRunAt?.getTime(), ctx.timeZone))}</div></td>
<td><button data-run="${esc(p.config.name)}/${esc(j.id)}"${j.enabled && !j.running ? '' : ' disabled'}>Run now</button></td></tr>`,
        )
        .join('');
      return `<h2>${esc(p.config.name)}</h2><table><tr><th>Job</th><th class="hide">Next run</th><th>Last</th><th></th></tr>${rows}</table>`;
    })
    .join('');
  const script = `<script>
document.querySelectorAll('button[data-run]').forEach((b) => b.addEventListener('click', async () => {
  b.disabled = true; b.textContent = 'Starting…';
  const r = await fetch('/jobs/' + b.dataset.run + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"by":"dashboard"}' });
  const j = await r.json().catch(() => ({}));
  b.textContent = r.ok ? (j.result === 'running' ? 'Already running' : 'Started ✓') : (j.error || 'Failed');
}));
</script>`;
  return layout(
    'Jobs',
    'Jobs',
    `<h1>Jobs</h1>${sections || '<p class="muted">No scheduled jobs.</p>'}<p class="muted">"Run now" posts in the job's Slack channel and streams live to the project owner.</p>${script}`,
  );
}

export function runPage(ctx: DashboardContext, run: StoredRun | undefined): string {
  if (!run) return layout('Run', 'Jobs', '<h1>Run</h1><p class="muted">No such run.</p>');
  return layout(
    'Run',
    'Jobs',
    `<h1>${esc(run.jobId ?? 'Chat turn')}</h1><div class="meta"><span>${esc(run.project)}</span>${statusBadge(run.status)}
<span>${esc(when(run.startedAt, ctx.timeZone))}</span><span>${formatDuration(run.endedAt - run.startedAt)}</span>
${run.sessionId ? `<a href="/sessions/${esc(run.sessionId)}">Transcript</a>` : ''}${run.threadKey ? threadLink(ctx, run.threadKey) : ''}</div>
${run.error ? `<h2>Error</h2><pre>${esc(run.error)}</pre>` : ''}${run.scriptOutput ? `<h2>Script output</h2><pre>${esc(run.scriptOutput)}</pre>` : ''}
${run.output ? `<h2>Reply</h2><div class="msg">${md(run.output)}</div>` : ''}`,
  );
}
