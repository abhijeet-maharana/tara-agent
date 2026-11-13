import type { Project } from '../config/schema.js';
import type { JobInfo } from '../scheduler/scheduler.js';
import { formatDuration } from '../slack/format.js';
import type { Item, SessionOverview, StoredRun } from '../store/store.js';
import { cronText } from './cron-text.js';
import { SWITCHER_CSS, TOKENS } from './look.js';
import { firstPrompt, type TranscriptEntry } from './transcript.js';

/**
 * Server-rendered pages for people (the same paths answer JSON for tools): a home page with what
 * needs attention, jobs with Run now / Pause / Resume, the day's schedule, single runs,
 * and sessions with their transcripts. Plain HTML, inline CSS and a small script; phone-friendly,
 * dark only, in the shared look of src/http/look.ts.
 */

export interface DashboardContext {
  projects: Project[];
  timeZone: string;
  /** Shown in the header and page titles (host `agentName`). */
  agentName: string;
  /** Slack workspace URL (https://acme.slack.com/), for thread links. */
  slackUrl?: string;
  /** This machine's host name: dashboard links that point at it follow the host the page was opened with. */
  hostName?: string;
  /** Waiting approvals and failing jobs, for the sidebar badges. */
  waiting?: number;
  failing?: number;
  /** The Code page is on. */
  code?: boolean;
  /** The Browsers page is on. */
  browsers?: boolean;
  /** Red checks on the Health page, for its sidebar badge; undefined when the page is off. */
  unhealthy?: number;
}

/** A job with its project and latest runs (newest first), as the home and jobs pages show it. */
export interface JobView extends JobInfo {
  project: string;
  recent: StoredRun[];
  /** Home page: the gap between starts, for jobs that run every half hour or more often. */
  everyMs?: number;
  /** Home page: the session a running job is working in, for a link to its live transcript. */
  liveSessionId?: string;
  /** Jobs page: the last 7 days of runs. */
  week?: JobWeek;
  /** Jobs page: the queues (`.tara/queues.json`) this job is the executor of. */
  queues?: string[];
}

/** A job's last 7 days: how many runs, their cost at API prices, and how long a run that worked takes. */
export interface JobWeek {
  runs: number;
  costUsd: number;
  /**
   * 75th percentile of the scheduled runs where the model ran (the first run in each thread, not a
   * continuation after a card), in whole minutes; set from 3 such runs.
   */
  typicalMinutes?: number;
}

/** Runs of the last 7 days per `project:jobId`. */
export function jobWeeks(runs: StoredRun[]): Map<string, JobWeek> {
  const by = new Map<string, StoredRun[]>();
  for (const r of runs)
    if (r.kind === 'job' && r.jobId)
      by.set(`${r.project}:${r.jobId}`, [...(by.get(`${r.project}:${r.jobId}`) ?? []), r]);
  const out = new Map<string, JobWeek>();
  for (const [key, list] of by) {
    // The scheduled run only: a card decision continues the job in the same thread as a later, short
    // run, which the schedule doesn't plan for. So each thread counts once, by its first run.
    const firsts = new Map<string, StoredRun>();
    for (const r of [...list].sort((a, b) => a.startedAt - b.startedAt))
      if (r.status !== 'silent') {
        const thread = r.threadKey ?? `run:${r.id}`;
        if (!firsts.has(thread)) firsts.set(thread, r);
      }
    const worked = [...firsts.values()].map((r) => (r.endedAt - r.startedAt) / 60_000).sort((a, b) => a - b);
    out.set(key, {
      runs: list.length,
      costUsd: list.reduce((t, r) => t + (r.costUsd ?? 0), 0),
      typicalMinutes:
        worked.length >= 3
          ? Math.max(1, Math.ceil(worked[Math.floor((worked.length - 1) * 0.75)] as number))
          : undefined,
    });
  }
  return out;
}

/** The planned length is far off what runs take: worth a "Use N min" button. */
export const lengthOff = (planned: number | undefined, typical: number | undefined) =>
  planned !== undefined && typical !== undefined && Math.abs(planned - typical) >= Math.max(5, planned * 0.5);

/** A repo whose uncommitted changes have waited since an old last commit. */
export interface StaleRepo {
  name: string;
  title: string;
  files: number;
  lastCommit: number;
}

/** How much of Claude's usage window is used, from the CLI's last report or the latest run. */
export interface HomeUsage {
  /** 0–1. */
  share: number;
  /** e.g. `five_hour`, when the CLI said. */
  window?: string;
  resetsAt?: number;
  /** Set when the figure is a past run's, not this process's latest report. */
  asOf?: number;
}

export interface HomeData {
  jobs: JobView[];
  /** Latest job runs that did something (not "nothing to do"), one per job, newest first. */
  latest: StoredRun[];
  /** Runs in the last 24 hours that found nothing to do. */
  quietRuns: number;
  /** Waiting approval cards. */
  pending: Item[];
  usage?: HomeUsage;
  /** Repos with uncommitted changes and an old last commit (Code page). */
  staleRepos?: StaleRepo[];
  uptimeSeconds: number;
  now: number;
  /** Which model does what (Models section); see modelUses. */
  models?: ModelUse[];
  /** Host `claude.effort`, shown next to the models. */
  effort?: string;
  /** Red Health checks other than jobs (Home lists failing jobs itself); undefined when the page is off. */
  health?: { problems: Array<{ name: string; where: string }>; watch: number };
}

/** Host-level model settings the dashboard shows: effort and voice notes (`voice`). */
export interface HostModels {
  effort?: string;
  voice?: string[];
}

/** One line of the Models section: what a model is used for, and by what. */
export interface ModelUse {
  purpose: string;
  model: string;
  used: string;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/**
 * Just enough Markdown for Claude's replies and approval cards: code blocks, inline code, bold, italic,
 * links, headings, bullet lists, quotes and line breaks. Slack-style text (`*bold*`, `• ` bullets,
 * `<url|text>` links) renders too, since older cards and Slack-minded drafts use it.
 */
export function md(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith('```')) return `<pre>${esc(part.replace(/^```\w*\n?|```$/g, ''))}</pre>`;
      return mdLines(part);
    })
    .join('');
}

/** Block level: headings, runs of bullets (one list) and runs of quote lines; other lines joined by <br>. */
function mdLines(part: string): string {
  const out: string[] = [];
  // Typed through `as`: TS would otherwise narrow it to null, not seeing the closures assign it.
  let block = null as { tag: 'ul' | 'blockquote'; items: string[] } | null;
  const flush = () => {
    if (!block) return;
    out.push(
      block.tag === 'ul'
        ? `<ul class="md">${block.items.map((i) => `<li>${i}</li>`).join('')}</ul>`
        : `<blockquote class="md">${block.items.join('<br>')}</blockquote>`,
    );
    block = null;
  };
  let text: string[] = [];
  const flushText = () => {
    if (text.length) out.push(text.join('<br>'));
    text = [];
  };
  for (const line of part.split('\n')) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    const tag = bullet ? 'ul' : quote ? 'blockquote' : null;
    if (tag) {
      flushText();
      if (block?.tag !== tag) flush();
      block ??= { tag, items: [] };
      block.items.push(inline(((bullet ?? quote) as RegExpExecArray)[1] as string));
      continue;
    }
    if (block) {
      flush();
      if (line === '') continue; // the blank line after a list is its end, not an extra break
    }
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    text.push(heading ? `<b>${inline(heading[1] as string)}</b>` : inline(line));
  }
  flush();
  flushText();
  return out.join('');
}

/** Inline: code spans and links are set aside first, so bold/italic never reach into them. */
function inline(line: string): string {
  const kept: string[] = [];
  const keep = (html: string) => `\uE000${kept.push(html) - 1}\uE000`;
  const link = (url: string, label: string) => keep(`<a href="${esc(url)}">${inline(label)}</a>`);
  const s = line
    .replace(/`([^`\n]+)`/g, (_, c: string) => keep(`<code>${esc(c)}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, l: string, u: string) => link(u, l))
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>\n]+)>/g, (_, u: string, l: string) => link(u, l));
  return esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(?<![*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![*\w])/g, '<b>$1</b>')
    .replace(/(?<![\w])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\w])/g, '<i>$1</i>')
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => kept[Number(i)] as string);
}

/** "Sun 25 Oct, 6:00 pm" in the host timezone. */
export function when(ms: number | string | Date | undefined, timeZone: string): string {
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

export const clock = (ms: number | Date, timeZone: string) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true });

/** "3h 5m", "2d 4h" or "45m". */
export const span = (m: number) =>
  m >= 1440
    ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
    : m >= 60
      ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
      : `${m}m`;

/** "in 3h 5m" or "2h ago". */
export function relative(ms: number | Date | undefined, now: number): string {
  if (ms === undefined) return 'never';
  const mins = Math.round((new Date(ms).getTime() - now) / 60_000);
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
export const FAILED = ['failed', 'error', 'timeout', 'limit'];
const RUN_LABEL: Record<string, string> = {
  ok: 'did work',
  silent: 'nothing to do',
  failed: 'failed',
  error: 'failed',
  timeout: 'timed out',
  limit: 'usage limit',
  aborted: 'stopped',
};
const runTone = (status: string) => (FAILED.includes(status) ? 'bad' : status === 'ok' ? 'ok' : 'dim');
export const runTag = (status?: string) =>
  status ? `<span class="tag ${runTone(status)}">${esc(RUN_LABEL[status] ?? status)}</span>` : '';

/** Where a run opens: its transcript when a model ran (a session), else the run's record. */
export const runHref = (r: StoredRun) => (r.sessionId ? `/sessions/${esc(r.sessionId)}` : `/runs/${r.id}`);

/** A run's first line, as plain text: the headline of its reply, or of its error when it failed. */
export function headline(r: StoredRun): string {
  const text = (FAILED.includes(r.status) && r.error) || r.output || r.error || '';
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line
    .replace(/<[^|>]+\|([^>]+)>/g, '$1') // Slack links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Markdown links
    .replace(/^\s*(#+|>|[-•*])\s+/, '')
    .replace(/[*`]/g, '')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,:;])/g, '$1$2')
    .trim()
    .slice(0, 200);
}

export type JobState = 'running' | 'failing' | 'paused' | 'ok' | 'new';
export function jobState(j: JobInfo): JobState {
  if (j.running) return 'running';
  if (!j.enabled) return 'paused';
  if (j.lastStatus && FAILED.includes(j.lastStatus)) return 'failing';
  return j.lastStatus ? 'ok' : 'new';
}
const STATE: Record<JobState, { label: string; tone: string; card: string }> = {
  running: { label: 'running', tone: '', card: 'accent' },
  failing: { label: 'failing', tone: 'bad', card: 'bad' },
  paused: { label: 'paused', tone: 'warn', card: 'warn' },
  ok: { label: 'ok', tone: 'ok', card: '' },
  new: { label: 'not run yet', tone: 'dim', card: '' },
};

/** Consecutive failed runs, newest first. */
const failureStreak = (runs: StoredRun[]) => {
  const i = runs.findIndex((r) => !FAILED.includes(r.status));
  return i === -1 ? runs.length : i;
};

export const anchor = (j: { project: string; id: string }) => `job-${j.project}-${j.id}`;

/** How the dashboard names a project. */
export const projectTitle = (ctx: DashboardContext, name: string) =>
  ctx.projects.find((p) => p.config.name === name)?.config.title ?? name;

export const projectTag = (ctx: DashboardContext, name: string) =>
  `<span class="tag dim">${esc(projectTitle(ctx, name))}</span>`;

function actionButton(
  j: { project: string; id: string; name: string; running?: boolean },
  action: 'run' | 'pause' | 'resume',
  label: string,
  kind = '',
): string {
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
  const ok = runs.filter((r) => !FAILED.includes(r.status)).length;
  return `<span class="strip" aria-label="${ok} of ${runs.length} recent runs OK">${cells}</span>`;
}

function threadLink(ctx: DashboardContext, threadKey: string): string {
  const [channel, ts] = threadKey.split(':');
  if (!ctx.slackUrl || !channel || !ts) return '';
  return `<a href="${esc(ctx.slackUrl)}archives/${esc(channel)}/p${esc(ts.replace('.', ''))}">Slack thread ↗</a>`;
}

/** The first prompt of a session, read from the start of its transcript only (they can be large). */
const CSS = `${TOKENS}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 var(--font)}
a{color:var(--accent)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code{background:var(--card-bg);border:1px solid var(--border);border-radius:6px;padding:1px 6px;font-size:13px;overflow-wrap:anywhere}
ul.md{margin:4px 0;padding-left:22px}ul.md li{margin:2px 0}
blockquote.md{margin:6px 0;padding:2px 0 2px 10px;border-left:3px solid var(--border-light);color:var(--text-dim)}
pre{margin:6px 0 0;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 11px;font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow-y:auto}
.shell{display:flex;min-height:100vh}
.sidebar{width:var(--sidebar);flex:none;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--border);overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;padding:18px 16px 14px;font-weight:700;color:var(--text-heading);font-size:16px}
.menu-btn{display:none;margin-left:auto;align-items:center;gap:6px;background:none;border:1px solid var(--border-light);color:var(--text);border-radius:8px;padding:2px 10px;font-size:18px;cursor:pointer}
nav{display:flex;flex-direction:column;gap:2px;padding:4px 8px}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--text);text-decoration:none;font-size:14px}
.nav-item:hover{background:var(--card-bg)}.nav-item.on{background:var(--accent-dim);color:var(--accent);font-weight:600}
.nav-item span:nth-child(2){flex:1}.badge{min-width:22px;padding:0 7px;border-radius:999px;background:var(--red);color:#fff;font-size:12px;font-weight:600;text-align:center}
${SWITCHER_CSS}
.nav-group{padding:14px 10px 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}
.side-foot{margin-top:auto;padding:12px 16px 16px;border-top:1px solid var(--border);font-size:12px}
.side-foot a{color:var(--text-dim);text-decoration:none}.side-foot a:hover{color:var(--accent)}
.main{flex:1;min-width:0;padding:28px 32px 80px}.main>*{max-width:980px}
.main.framed{padding:0;display:flex}.main.framed>*{max-width:none}
.app-frame{flex:1;width:100%;height:100vh;border:0;display:block;background:var(--bg)}
.page-head{margin-bottom:18px}.page-head h1{margin:0;font-size:24px;color:var(--text-heading);letter-spacing:-.01em;overflow-wrap:anywhere}
.sub{margin:4px 0 0;color:var(--text-dim);font-size:14px}
.section{margin:0 0 28px}.sec-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.sec-head h2{margin:0;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-heading)}.sec-head span{color:var(--text-dim);font-size:12px}
.sec-head .more{margin-left:auto;font-size:13px}
.nowbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:var(--card-bg);border:1px solid var(--border);border-left:3px solid var(--text-dim);border-radius:var(--radius);padding:10px 14px;margin-bottom:22px}
.nowbar.live{border-left-color:var(--green)}.nowbar b{color:var(--text-heading)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:24px}
.stat{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;color:inherit;text-decoration:none}
a.stat:hover{border-color:var(--border-light);background:var(--card-hover)}
.stat b{display:block;font-size:22px;color:var(--text-heading);font-variant-numeric:tabular-nums}.stat span{font-size:12px;color:var(--text-dim)}
.stat.bad b{color:var(--red)}.stat.ok b{color:var(--green)}.stat.warn b{color:var(--amber)}
.todo{display:grid;gap:6px}
.row{display:flex;align-items:center;gap:12px;padding:11px 14px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);text-decoration:none}
a.row:hover{border-color:var(--border-light);background:var(--card-hover)}.row .grow{flex:1;min-width:0}
.dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--accent)}.dot.bad{background:var(--red)}.dot.warn{background:var(--amber)}.dot.ok{background:var(--green)}.dot.dim{background:var(--border-light)}
.clear{color:var(--green);background:var(--green-dim);border-radius:var(--radius);padding:11px 14px}
.alert{color:var(--amber);background:var(--amber-dim);border-radius:var(--radius);padding:11px 14px;margin-bottom:12px}
.timeline{list-style:none;margin:0;padding:0;font-size:14px}
.timeline li{display:grid;grid-template-columns:190px 1fr auto;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)}
.timeline .when{color:var(--text-heading);font-variant-numeric:tabular-nums}
.timeline li.free{color:var(--text-dim);font-size:13px}.timeline li.free .when{color:var(--text-dim)}
.timeline li.clash .when{color:var(--amber)}
.sessions .day{margin:14px 0 2px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}.sessions .day:first-child{margin-top:0}
.sessions .row .line{display:block;color:var(--text-dim);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.timeline .what{min-width:0}.timeline .line{display:block;color:var(--text-dim);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nowbar a{color:var(--text-heading)}.nowbar a:hover{color:var(--accent)}
.card:target{outline:2px solid var(--accent);outline-offset:2px}
.fold-btn{all:unset;cursor:pointer;display:flex;gap:8px;align-items:baseline;min-width:0}
.fold-btn::before{content:'▸';color:var(--text-dim);flex:none;transition:transform .15s}.open>* .fold-btn::before,.open .fold-btn::before{transform:rotate(90deg)}
.fold-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.live .steps{list-style:none;margin:10px 0 0;padding:0;font-size:13px;display:grid;gap:3px;max-height:360px;overflow:auto}
.live .steps li{display:flex;gap:10px;overflow-wrap:anywhere}.live .steps li.sub{padding-left:22px}.live .steps li.error{color:var(--red)}.live .steps li.running{color:var(--accent)}
.live .steps .at{flex:none;min-width:58px;color:var(--text-dim);font-variant-numeric:tabular-nums}
.live .live-text{margin:10px 0 0;white-space:pre-wrap;font-size:13px;color:var(--text-dim);max-height:180px;overflow:auto}.card[id]{scroll-margin-top:72px}
.card{background:var(--card-bg);border:1px solid var(--border);border-left:3px solid var(--rc,var(--border-light));border-radius:var(--radius);padding:13px 15px;margin-bottom:10px}
.card.bad{--rc:var(--red)}.card.warn{--rc:var(--amber)}.card.ok{--rc:var(--green)}.card.accent{--rc:var(--accent)}
.card-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.card-head .grow{flex:1;min-width:0}
.title{color:var(--text-heading);font-weight:600;overflow-wrap:anywhere}a.title{text-decoration:none}a.title:hover{color:var(--accent)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:3px;font-size:12.5px;color:var(--text-dim)}.meta b{color:var(--text-heading);font-weight:600}
.meta.error{color:var(--red)}
.tag{display:inline-block;padding:0 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent);font-size:12px;line-height:20px;white-space:nowrap}
.tag.bad{background:var(--red-dim);color:var(--red)}.tag.ok{background:var(--green-dim);color:var(--green)}.tag.warn{background:var(--amber-dim);color:var(--amber)}.tag.dim{background:var(--border);color:var(--text-dim)}
.strip{display:inline-flex;gap:2px;vertical-align:middle}.strip i{width:9px;height:12px;border-radius:2px;background:var(--border-light)}
.strip i.ok{background:var(--green)}.strip i.bad{background:var(--red)}
details{margin-top:8px;font-size:13.5px}summary{cursor:pointer;color:var(--text-dim)}summary:hover{color:var(--text)}
.views .chip{font-weight:600}.queue-jobs{margin-top:22px}.queue-jobs>summary{cursor:pointer;color:var(--text-dim);font-size:14px;margin-bottom:12px}
.facts{display:grid;grid-template-columns:110px 1fr;gap:4px 12px;margin:10px 0;font-size:13px}.facts dt{color:var(--text-dim)}.facts dd{margin:0;overflow-wrap:anywhere}
.runs{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.runs a{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;color:var(--text);text-decoration:none;font-size:13px}.runs a:hover{background:var(--card-hover)}
.actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.actions.end{justify-content:flex-end}
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:var(--on-accent);border:1px solid transparent;border-radius:8px;padding:5px 12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;min-height:32px;white-space:nowrap}
.btn:hover{filter:brightness(1.1)}.btn.ghost{background:transparent;color:var(--text);border-color:var(--border-light)}.btn.ghost:hover{background:var(--card-hover);filter:none}
.btn.quiet{background:transparent;color:var(--text-dim)}.btn.quiet:hover{color:var(--text);filter:none}
.btn.green{background:var(--green-dim);color:var(--green);border-color:var(--green)}.btn.danger{background:var(--red);color:#fff}
.btn:disabled{opacity:.5;cursor:not-allowed;filter:none}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}.toolbar .btn{margin-left:auto}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{background:transparent;color:var(--text-dim);border:1px solid var(--border-light);border-radius:999px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none}
.chip:hover{color:var(--text)}.chip.on{background:var(--accent-dim);color:var(--accent);border-color:var(--accent)}.chip small{opacity:.75;margin-left:4px}
.input{background:var(--bg);color:var(--text);border:1px solid var(--border-light);border-radius:8px;padding:6px 10px;font:inherit;font-size:14px;min-width:220px}
.input:focus{border-color:var(--accent);outline:none}textarea.input{min-height:80px;resize:vertical}
.field{display:grid;gap:4px;font-size:13px;color:var(--text-dim)}.fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.empty{color:var(--text-dim);padding:10px 0}.dim{color:var(--text-dim)}.actions.below{margin-top:10px}.card.spaced{margin-top:16px}
.msg{margin:10px 0;padding:10px 12px;border-radius:var(--radius);background:var(--card-bg);border:1px solid var(--border);overflow-wrap:anywhere;font-size:14px}
.msg.user{border-left:3px solid var(--accent)}.msg .who{font-size:12px;color:var(--text-dim);margin-bottom:4px}
.tool{margin:6px 0;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg)}.tool.err summary{color:var(--red)}
.toasts{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:grid;gap:8px;z-index:30;max-width:calc(100% - 32px)}
.toast{display:flex;align-items:center;gap:12px;background:var(--card-bg);border:1px solid var(--border-light);border-radius:var(--radius);padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.toast.err{border-color:var(--red);color:var(--red)}.toast button{background:none;border:0;color:var(--accent);font:inherit;font-weight:600;cursor:pointer;padding:0}
.overlay{position:fixed;inset:0;background:rgba(3,6,12,.6);display:grid;place-items:center;padding:16px;z-index:40}
.dialog{width:100%;max-width:440px;background:var(--card-bg);border:1px solid var(--border-light);border-radius:14px;padding:20px;display:grid;gap:12px;box-shadow:0 20px 50px rgba(0,0,0,.4)}
.dialog h2{margin:0;font-size:17px;color:var(--text-heading)}.dialog p{margin:0;color:var(--text-dim);font-size:14px}.dialog .input{min-width:0;width:100%}
@media (max-width:760px){.shell{display:block}
.sidebar{position:sticky;top:0;z-index:20;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--border)}
.brand{padding:12px 16px}.menu-btn{display:flex}.sidebar nav,.sidebar .switcher,.sidebar .side-foot{display:none}
.sidebar.open nav,.sidebar.open .switcher{display:flex}.sidebar.open .side-foot{display:block}
.main{padding:18px 16px 80px}.main.framed{padding:0}.app-frame{height:calc(100dvh - var(--bar,53px))}.page-head h1{font-size:21px}.timeline li{grid-template-columns:1fr auto}.timeline .when{grid-column:1/-1}
.input{min-width:0;width:100%}.row{flex-wrap:wrap}.fields{grid-template-columns:1fr}
.jobs-filters .chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:0 16px;max-width:calc(100% + 32px)}.jobs-filters .chips::-webkit-scrollbar{display:none}
.jobs-filters .chips>*{flex:none}.jobs-filters .toolbar{flex-direction:column;align-items:stretch}
[data-card] .card-head>.actions{width:100%}[data-card] .card-head>.actions .btn{flex:1;justify-content:center;min-height:40px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

/** Confirm dialogs, toasts, job and task buttons, the phone menu, and the auto-refresh. */
const SCRIPT = `
const toast = (text, opts = {}) => {
  const t = document.createElement('div');
  t.className = 'toast' + (opts.error ? ' err' : '');
  t.append(text);
  if (opts.undo) { const b = document.createElement('button'); b.textContent = 'Undo'; b.onclick = () => { t.remove(); opts.undo(); }; t.append(b); }
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), opts.undo ? 6000 : 4500);
};
const ask = (title, body, ok, danger) => new Promise((resolve) => {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = '<form class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title"><h2 id="dlg-title"></h2><p></p><div class="actions end"><button type="button" class="btn ghost">Cancel</button><button type="submit" class="btn"></button></div></form>';
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
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
};
const reload = () => setTimeout(() => location.reload(), 900);
const TEXT = {
  run: ['Run "%" now?', 'It starts within a few seconds and posts in the project\\'s Slack channel.', 'Run now'],
  pause: ['Pause "%"?', 'It stops running on its schedule until you resume it.', 'Pause'],
  resume: ['Resume "%"?', 'It runs on its schedule again.', 'Resume'],
};
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (b) {
    const { action, job, name } = b.dataset;
    const [title, body, ok] = TEXT[action];
    if (!(await ask(title.replace('%', name), body, ok, action === 'pause'))) return;
    b.disabled = true;
    try {
      const j = await post('/jobs/' + job + '/' + action, { by: 'dashboard' });
      toast(action === 'run' ? (j.result === 'running' ? name + ' is already running' : name + ' started') : name + (j.enabled ? ' resumed' : ' paused'));
      reload();
    } catch (err) { toast(err.message, { error: true }); b.disabled = false; }
    return;
  }
});
// Dashboard links that point at this machine follow the host this page was opened with (LAN or tailnet IP).
document.querySelectorAll('a[data-same-host]').forEach((a) => { const u = new URL(a.href); u.hostname = location.hostname; a.href = u; });
document.querySelector('.menu-btn')?.addEventListener('click', (e) => {
  const open = document.querySelector('.sidebar').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
});
if (document.body.dataset.refresh) setInterval(() => {
  if (!document.hidden && !document.querySelector('.overlay, details[open], .input:focus, .toast, .dragging')) location.reload();
}, 60000);
`;

/** Filters on the jobs page: project, state and search, kept in the URL so a refresh keeps them. */
const JOBS_SCRIPT = `
const params = new URLSearchParams(location.search);
const view = params.get('view') || '';
const filter = { project: params.get('project') || '', state: params.get('state') || '', q: params.get('q') || '', sort: params.get('sort') || '' };
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
  // Most usage: every job in one ranked list. Otherwise the server's order (state, then next run),
  // with on-demand jobs and the jobs a queue runs back in their own groups.
  const main = document.querySelector('[data-cards]');
  const usage = filter.sort === 'usage';
  cards.sort((a, b) => usage ? Number(b.dataset.usage) - Number(a.dataset.usage) : Number(a.dataset.order) - Number(b.dataset.order));
  for (const c of cards) ((!usage && document.querySelector('[data-cards="' + c.dataset.group + '"]')) || main).append(c);
  for (const group of document.querySelectorAll('[data-group-box]')) {
    const visible = !usage && [...group.querySelectorAll('[data-card]')].some((c) => !c.hidden);
    group.hidden = !visible;
    if (visible && group.tagName === 'DETAILS' && (filter.q || filter.state)) group.open = true;
  }
  document.querySelectorAll('.chip[data-filter]').forEach((b) => { const on = filter[b.dataset.filter] === b.dataset.value; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  document.getElementById('none').hidden = shown > 0;
  const p = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
  if (view) p.set('view', view);
  document.querySelectorAll('a[data-view]').forEach((a) => {
    const u = new URL(a.href);
    if (filter.project) u.searchParams.set('project', filter.project); else u.searchParams.delete('project');
    a.href = u.pathname + u.search;
  });
  history.replaceState(null, '', location.pathname + (p.size ? '?' + p : '') + location.hash);
};
document.querySelectorAll('.chip[data-filter]').forEach((b) => b.addEventListener('click', () => { filter[b.dataset.filter] = b.dataset.value; apply(); }));
search.addEventListener('input', () => { filter.q = search.value.trim(); apply(); });
apply();
document.addEventListener('click', async (e) => {
  const c = e.target.closest('button[data-length]');
  if (c) {
    const value = prompt('Planned length of "' + c.dataset.name + '" in minutes', c.dataset.minutes);
    if (value === null) return;
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) return toast('Enter whole minutes, 1 to 600', { error: true });
    try { await post('/jobs/' + c.dataset.length + '/duration', { minutes }); toast(c.dataset.name + ': ' + minutes + ' min'); reload(); }
    catch (err) { toast(err.message, { error: true }); }
    return;
  }
  const b = e.target.closest('button[data-duration]');
  if (!b) return;
  b.disabled = true;
  try { await post('/jobs/' + b.dataset.duration + '/duration', { minutes: Number(b.dataset.minutes) }); toast('Planned length set to ' + b.dataset.minutes + ' min'); reload(); }
  catch (err) { toast(err.message, { error: true }); b.disabled = false; }
});
const target = location.hash && document.getElementById(location.hash.slice(1));
// Links to /jobs#job-… come from every page; an on-demand job's card is on the On demand tab.
if (location.hash.startsWith('#job-') && !target && !view) location.replace('/jobs?view=on-demand' + location.hash);
if (target) { target.hidden = false; target.closest('details.queue-jobs')?.setAttribute('open', ''); target.querySelector('details')?.setAttribute('open', ''); target.scrollIntoView({ block: 'center' }); }
`;

export type JobsView = 'list' | 'ondemand' | 'timeline';

/**
 * The Jobs page's three views: List (`/jobs`, scheduled and queue jobs), On demand
 * (`/jobs?view=on-demand`, jobs started only by hand) and Timeline (`/schedule`, a day of runs).
 * The project carries over; the jobs pages keep the links current as their filter changes.
 */
export const jobViewTabs = (view: JobsView, project?: string) => {
  const tab = (v: JobsView, path: string, label: string) => {
    const q = new URLSearchParams(path === '/jobs' && v === 'ondemand' ? { view: 'on-demand' } : {});
    if (project) q.set('project', project);
    const href = `${path}${q.size ? `?${q}` : ''}`;
    return `<a class="chip${view === v ? ' on' : ''}" href="${esc(href)}" data-view="${v}"${view === v ? ' aria-current="page"' : ''}>${label}</a>`;
  };
  return `<div class="toolbar"><div class="chips views">${tab('list', '/jobs', 'List')}${tab('ondemand', '/jobs', 'On demand')}${tab('timeline', '/schedule', 'Timeline')}</div></div>`;
};

export type Page = 'Home' | 'Approvals' | 'Queue' | 'Jobs' | 'Sessions' | 'Code' | 'Browsers' | 'Health' | '';

/** Projects whose app pages show here as tabs (`tabs` plus `dashboardUrl`). */
export const tabbed = (projects: Project[]) =>
  projects.filter((p) => p.config.dashboardUrl && p.config.tabs?.length);

/** The "Dashboards" switcher: this dashboard first, then each project dashboard that isn't shown as tabs. */
function switcher(ctx: DashboardContext): string {
  const own = ctx.projects.filter((p) => p.config.dashboardUrl && !p.config.tabs?.length);
  if (!own.length) return '';
  const link = (p: Project) => {
    const url = new URL(p.config.dashboardUrl as string);
    const title = p.config.title ?? p.config.name;
    const sameHost = ['localhost', '127.0.0.1', ctx.hostName].includes(url.hostname);
    return `<a class="switch" href="${esc(url.href)}"${sameHost ? ' data-same-host' : ''}><span class="mark" aria-hidden="true">${esc(
      title.slice(0, 1).toUpperCase(),
    )}</span><span>${esc(title)}</span></a>`;
  };
  return `<div class="switcher"><span class="switcher-label">Dashboards</span><a class="switch on" href="/" aria-current="true"><span class="mark" aria-hidden="true">${esc(
    ctx.agentName.slice(0, 1).toUpperCase(),
  )}</span><span>${esc(ctx.agentName)}</span></a>${own.map(link).join('')}</div>`;
}

export function layout(
  ctx: DashboardContext,
  title: string,
  active: Page,
  body: string,
  opts: { refresh?: boolean; script?: string; framed?: boolean } = {},
): string {
  const waiting = ctx.waiting ?? 0;
  const failing = ctx.failing ?? 0;
  const nav = (
    [
      ['/', 'Home', '🏠', 0, ''],
      ['/approvals', 'Approvals', '✅', waiting, 'waiting for a decision'],
      ['/queue', 'Queue', '📤', 0, ''],
      ['/jobs', 'Jobs', '⏱️', failing, 'failing jobs'],
      ['/sessions', 'Sessions', '💬', 0, ''],
      ...(ctx.code ? ([['/code', 'Code', '📝', 0, '']] as const) : []),
      ...(ctx.browsers ? ([['/browsers', 'Browsers', '🌐', 0, '']] as const) : []),
      ...(ctx.unhealthy !== undefined
        ? ([['/health', 'Health', '❤️', ctx.unhealthy, 'health problems']] as const)
        : []),
    ] as const
  )
    .map(
      ([href, label, icon, badge, hint]) =>
        `<a href="${href}" class="nav-item${label === active ? ' on' : ''}"${label === active ? ' aria-current="page"' : ''}><span aria-hidden="true">${icon}</span><span>${label}</span>${
          badge ? `<span class="badge" title="${badge} ${hint}">${badge}</span>` : ''
        }</a>`,
    )
    .join('');
  // Each project's app pages, under the project's title; the tab script marks the current one.
  const tabs = tabbed(ctx.projects)
    .map((p) => {
      const name = p.config.name;
      const items = (p.config.tabs ?? [])
        .map(
          (t) =>
            `<a href="/p/${esc(name)}${esc(t.path)}" class="nav-item" data-app="${esc(name)}" data-tab="${esc(t.path)}"><span aria-hidden="true">${esc(
              t.icon ?? '•',
            )}</span><span>${esc(t.label)}</span></a>`,
        )
        .join('');
      return `<div class="nav-group">${esc(p.config.title ?? name)}</div>${items}`;
    })
    .join('');
  const updated = clock(Date.now(), ctx.timeZone);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#090d16">
<title>${esc(title)} · ${esc(ctx.agentName)}</title>
<style>${CSS}</style></head><body${opts.refresh ? ' data-refresh="1"' : ''}><div class="shell">
<aside class="sidebar"><div class="brand"><span class="mark" aria-hidden="true">${esc(ctx.agentName.slice(0, 1).toUpperCase())}</span><span>${esc(ctx.agentName)}</span>
<button type="button" class="menu-btn" aria-label="Menu" aria-expanded="false">${
    waiting + failing ? `<span class="badge">${waiting + failing}</span>` : ''
  }☰</button></div>
<nav>${nav}${tabs}</nav>${switcher(ctx)}<div class="side-foot"><a href="" title="Refresh now">Updated ${esc(updated)} ↻</a></div></aside>
<main class="main${opts.framed ? ' framed' : ''}">${body}</main></div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script>${SCRIPT}${opts.script ?? ''}</script></body></html>`;
}

export const pageHead = (title: string, sub?: string) =>
  `<header class="page-head"><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</header>`;

export const section = (title: string, body: string, opts: { sub?: string; more?: string } = {}) =>
  `<section class="section"><div class="sec-head"><h2>${esc(title)}</h2>${opts.sub ? `<span>${esc(opts.sub)}</span>` : ''}${
    opts.more ?? ''
  }</div>${body}</section>`;

const stat = (label: string, value: string | number, tone = '', href = '') =>
  href
    ? `<a class="stat ${tone}" href="${href}"><b>${esc(value)}</b><span>${esc(label)}</span></a>`
    : `<div class="stat ${tone}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

/** "every 10m", for the frequent jobs line. */
const every = (ms: number) => `every ${span(Math.round(ms / 60_000))}`;
const plural = (n: number, kind: string) => `${n} ${kind.replace(/-/g, ' ')}${n === 1 ? '' : 's'}`;
const USAGE_WINDOW: Record<string, string> = {
  five_hour: '5h window',
  seven_day: '7-day window',
  seven_day_opus: '7-day Opus window',
};

const nameList = (names: string[], max = 4) =>
  names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max} more` : names.join(', ');
const onHarness = (harness: string | undefined, model: string) =>
  harness === 'agy' ? `agy · ${model}` : model;

/** Which model does what: chat per project, jobs (and their steps and handoffs) per model, voice notes. */
export function modelUses(projects: Project[], jobs: JobInfo[], host: HostModels = {}): ModelUse[] {
  const out: ModelUse[] = [];
  const grouped = (purpose: string, pairs: Array<[model: string, name: string]>, kind?: string) => {
    const by = new Map<string, string[]>();
    for (const [model, name] of pairs) by.set(model, [...(by.get(model) ?? []), name]);
    for (const [model, names] of [...by].sort((a, b) => b[1].length - a[1].length))
      out.push({
        purpose,
        model,
        used: `${kind ? `${plural(names.length, kind)}: ` : ''}${nameList(names)}`,
      });
  };
  grouped(
    'Chat',
    projects.map((p) => [p.config.chatModel, p.config.title ?? p.config.name]),
  );
  grouped(
    'Jobs',
    jobs.map((j) => [onHarness(j.harness, j.model), j.name]),
    'job',
  );
  grouped(
    'Job steps',
    jobs.flatMap((j) => (j.stepModels ?? []).map((m): [string, string] => [onHarness(j.harness, m), j.name])),
    'job',
  );
  grouped(
    'After approval',
    jobs.flatMap(
      (j): Array<[string, string]> =>
        j.handoff ? [[onHarness(j.handoff.harness, j.handoff.model), j.name]] : [],
    ),
    'job',
  );
  if (projects.some((p) => p.config.selfImprove !== 'off'))
    out.push({
      purpose: 'Learning',
      model: 'same as the run',
      used: 'a turn after a chat or job run, in its session',
    });
  if (host.voice?.length)
    out.push({
      purpose: 'Voice notes',
      model: host.voice.join(' → '),
      used: "speech-to-text when Slack didn't transcribe, tried in order",
    });
  return out;
}

function modelsSection(models: ModelUse[], effort?: string): string {
  if (!models.length) return '';
  const rows = models
    .map(
      (m) =>
        `<li><span class="when">${esc(m.purpose)}</span><span class="what"><span class="line" title="${esc(m.used)}">${esc(
          m.used,
        )}</span></span><code>${esc(m.model)}</code></li>`,
    )
    .join('');
  return section('Models', `<ul class="timeline models">${rows}</ul>`, {
    sub: effort ? `effort ${effort}` : "each model's default effort",
  });
}

export function homePage(ctx: DashboardContext, data: HomeData): string {
  const { jobs, now } = data;
  // Notices only tell: one line for them, kept out of the counts and the cards to start with.
  const pending = data.pending.filter((i) => i.kind !== 'notice');
  const notices = data.pending.length - pending.length;
  const runWaits = (i: Item) => i.mode === 'resume' && Boolean(i.jobId);
  const tz = ctx.timeZone;
  const failing = jobs.filter((j) => jobState(j) === 'failing');
  const paused = jobs.filter((j) => !j.enabled);
  const running = jobs.filter((j) => j.running);
  const frequent = jobs.filter((j) => j.enabled && j.everyMs !== undefined);
  const upcoming = jobs
    .filter((j) => j.enabled && j.nextRun && j.everyMs === undefined)
    .sort((a, b) => (a.nextRun?.getTime() ?? 0) - (b.nextRun?.getTime() ?? 0))
    .slice(0, 8);
  const names = new Map(jobs.map((j) => [`${j.project}:${j.id}`, j.name]));
  const uptime = span(Math.floor(data.uptimeSeconds / 60));

  // Each running job links to its live transcript when its session is known.
  const runningLinks = running
    .map(
      (j) =>
        `<a href="${j.liveSessionId ? `/sessions/${esc(j.liveSessionId)}` : `/jobs#${anchor(j)}`}">${esc(j.name)}</a>`,
    )
    .join(', ');
  const nowbar = `<div class="nowbar${running.length ? ' live' : ''}"><b>${
    running.length ? `● Running now: ${runningLinks}` : '○ Nothing running'
  }</b><span class="dim">· up ${uptime} · ${jobs.length - paused.length} of ${jobs.length} jobs on</span></div>`;

  const waiting = ctx.waiting ?? pending.length;
  const usage = data.usage;
  const usageStat = usage
    ? stat(
        `Claude usage · ${
          usage.asOf !== undefined
            ? `as of ${relative(usage.asOf, now)}`
            : usage.resetsAt
              ? `resets ${clock(usage.resetsAt, tz)}`
              : (USAGE_WINDOW[usage.window ?? ''] ?? 'current window')
        }`,
        `${Math.round(usage.share * 100)}%`,
        usage.share >= 0.9 ? 'bad' : usage.share >= 0.7 ? 'warn' : 'ok',
      )
    : '';
  const stats = `<div class="stats">${stat('Waiting approvals', waiting, waiting ? 'warn' : 'ok', '/approvals')}${stat(
    'Failing jobs',
    failing.length,
    failing.length ? 'bad' : 'ok',
    '/jobs?state=failing',
  )}${usageStat}</div>`;

  // Waiting cards per project: what kinds, and how long the oldest has waited.
  const byProject = new Map<string, Item[]>();
  for (const item of pending) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item]);
  const approvalRows = [...byProject.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([project, items]) => {
      const kinds = new Map<string, number>();
      for (const i of items) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
      const sorted = [...kinds.entries()].sort((a, b) => b[1] - a[1]);
      const shown = sorted.slice(0, 4).map(([k, n]) => plural(n, k));
      if (sorted.length > 4) shown.push(`${sorted.slice(4).reduce((t, [, n]) => t + n, 0)} more`);
      const oldest = Math.min(...items.map((i) => i.createdAt));
      return `<a class="row" href="/approvals?project=${esc(project)}"><span class="dot warn"></span><span class="grow"><b class="title">${esc(
        projectTitle(ctx, project),
      )}: ${items.length} waiting</b><span class="meta"><span>${esc(shown.join(' · '))}</span><span>oldest ${esc(
        relative(oldest, now).replace(' ago', ''),
      )}</span></span></span><span class="dim">Approvals →</span></a>`;
    });

  const health = data.health;
  const healthRows = health?.problems.length
    ? [
        `<a class="row" href="/health"><span class="dot bad"></span><span class="grow"><span class="title">${esc(
          health.problems.length === 1
            ? `${health.problems[0]?.name} has a problem`
            : `${health.problems.length} health problems`,
        )}</span><span class="meta"><span>${esc(
          health.problems
            .slice(0, 4)
            .map((p) => (health.problems.length === 1 ? p.where : `${p.name} (${p.where})`))
            .join(' · '),
        )}</span></span></span><span class="dim">Health →</span></a>`,
      ]
    : [];
  const attention = [
    ...healthRows,
    ...approvalRows,
    ...(data.staleRepos ?? []).map(
      (r) =>
        `<a class="row" href="/code/${encodeURIComponent(r.name)}"><span class="dot warn"></span><span class="grow"><span class="title">${esc(r.title)}: ${r.files} ${
          r.files === 1 ? 'file' : 'files'
        } uncommitted</span><span class="meta"><span>last commit ${esc(relative(r.lastCommit, now))}</span></span></span><span class="dim">Code →</span></a>`,
    ),
    ...(notices
      ? [
          `<a class="row" href="/approvals#fyi"><span class="dot dim"></span><span class="grow"><span class="title">${notices} ${
            notices === 1 ? 'notice' : 'notices'
          } to glance at</span><span class="meta"><span>for your information, nothing to decide</span></span></span><span class="dim">See →</span></a>`,
        ]
      : []),
    ...failing.map(
      (
        j,
      ) => `<div class="row"><span class="dot bad"></span><span class="grow"><a class="title" href="/jobs#${anchor(j)}">${esc(j.name)}</a> failed ${esc(
        relative(j.lastRunAt, now),
      )}<span class="meta">${projectTag(ctx, j.project)}${
        failureStreak(j.recent) > 1 ? `<span class="tag bad">${failureStreak(j.recent)} in a row</span>` : ''
      }${j.lastError ? `<span>${esc(j.lastError.slice(0, 160))}</span>` : ''}</span></span>
<span class="actions">${j.recent[0] ? `<a class="btn quiet" href="${runHref(j.recent[0])}">See what happened</a>` : ''}${actionButton(j, 'run', 'Run now', 'ghost')}</span></div>`,
    ),
    ...paused.map(
      (j) =>
        `<div class="row"><span class="dot warn"></span><span class="grow"><a class="title" href="/jobs#${anchor(j)}">${esc(j.name)}</a> is paused<span class="meta">${projectTag(
          ctx,
          j.project,
        )}</span></span><span class="actions">${actionButton(j, 'resume', 'Resume', 'green')}</span></div>`,
    ),
  ].join('');

  // The cards to start with: those a paused job run is waiting on, then the oldest.
  const first = [...pending]
    .sort((a, b) => Number(runWaits(b)) - Number(runWaits(a)) || a.createdAt - b.createdAt)
    .slice(0, 3)
    .map(
      (i) =>
        `<a class="row" href="/approvals?project=${esc(i.project)}#item-${esc(i.id)}"><span class="dot warn"></span><span class="grow"><span class="title">${esc(
          i.title,
        )}</span><span class="meta">${projectTag(ctx, i.project)}<span>${esc(plural(1, i.kind))}</span>${
          runWaits(i) ? '<span class="tag warn">a run is waiting</span>' : ''
        }<span>${esc(relative(i.createdAt, now))}</span></span></span></a>`,
    )
    .join('');

  const coming =
    upcoming.length || frequent.length
      ? `<ul class="timeline">${upcoming
          .map(
            (j) =>
              `<li><span class="when">${esc(clock(j.nextRun as Date, tz))} <span class="dim">· ${esc(
                relative(j.nextRun, now),
              )}</span></span><a href="/jobs#${anchor(j)}">${esc(j.name)}</a>${projectTag(ctx, j.project)}</li>`,
          )
          .join('')}${[...new Set(frequent.map((j) => j.everyMs as number))]
          .sort((a, b) => a - b)
          .map(
            (ms) =>
              `<li class="free"><span class="when">Also ${esc(every(ms))}</span><span>${frequent
                .filter((j) => j.everyMs === ms)
                .map((j) => `<a href="/jobs#${anchor(j)}">${esc(j.name)}</a>`)
                .join(', ')}</span></li>`,
          )
          .join('')}</ul>`
      : '<div class="empty">Nothing scheduled.</div>';

  const quiet = data.quietRuns
    ? `<li class="free"><span class="when"></span><span>${data.quietRuns} more ${
        data.quietRuns === 1 ? 'run' : 'runs'
      } in the last 24 hours found nothing to do</span></li>`
    : '';
  const ran =
    data.latest.length || quiet
      ? `<ul class="timeline">${data.latest
          .map((r) => {
            const line = headline(r);
            return `<li><span class="when">${esc(relative(r.startedAt, now))}</span><span class="what"><a href="${runHref(r)}">${esc(
              names.get(`${r.project}:${r.jobId}`) ?? r.jobId,
            )}</a>${line ? `<span class="line" title="${esc(line)}">${esc(line)}</span>` : ''}</span>${runTag(r.status)}</li>`;
          })
          .join('')}${quiet}</ul>`
      : '<div class="empty">No runs yet.</div>';

  return layout(
    ctx,
    'Home',
    'Home',
    `${pageHead(ctx.agentName, `${esc(when(now, tz))} · times in ${esc(tz)}`)}${nowbar}${stats}
${section(
  'Needs attention',
  attention ? `<div class="todo">${attention}</div>` : '<div class="clear">✓ Nothing needs attention.</div>',
)}
${first ? section('Start with these', `<div class="todo">${first}</div>`, { more: '<a class="more" href="/approvals">All approvals →</a>' }) : ''}
${section('Just ran', ran, { more: '<a class="more" href="/jobs">All jobs →</a>' })}
${section('Coming up', coming, { more: '<a class="more" href="/schedule">Timeline →</a>' })}
${modelsSection(data.models ?? [], data.effort)}`,
    { refresh: true },
  );
}

const STATE_ORDER: Record<JobState, number> = { failing: 0, running: 1, ok: 2, new: 2, paused: 3 };

/** Where a job sits on the jobs page: on a schedule, started by hand, or run by its queue. */
const group = (j: JobView): 'scheduled' | 'ondemand' | 'queued' =>
  j.cron ? 'scheduled' : j.queues?.length ? 'queued' : 'ondemand';

export function jobsPage(
  ctx: DashboardContext,
  allJobs: JobView[],
  now = Date.now(),
  view: 'list' | 'ondemand' = 'list',
): string {
  const tz = ctx.timeZone;
  const onDemandView = view === 'ondemand';
  // List: scheduled and queue jobs. On demand: jobs that run only when started.
  const jobs = allJobs.filter((j) => (group(j) === 'ondemand') === onDemandView);
  const sorted = [...jobs].sort(
    (a, b) =>
      STATE_ORDER[jobState(a)] - STATE_ORDER[jobState(b)] ||
      (a.nextRun?.getTime() ?? Infinity) - (b.nextRun?.getTime() ?? Infinity),
  );
  const count = (pred: (j: JobView) => boolean) => jobs.filter(pred).length;
  const chip = (key: string, value: string, label: string, n: number) =>
    `<button type="button" class="chip" data-filter="${key}" data-value="${esc(value)}" aria-pressed="false">${esc(label)}<small>${n}</small></button>`;
  const projectChips =
    new Set(jobs.map((j) => j.project)).size > 1
      ? [
          chip('project', '', 'All', jobs.length),
          // Projects with no jobs get no chip.
          ...ctx.projects
            .filter((p) => jobs.some((j) => j.project === p.config.name))
            .map((p) =>
              chip(
                'project',
                p.config.name,
                p.config.title ?? p.config.name,
                count((j) => j.project === p.config.name),
              ),
            ),
        ].join('')
      : '';
  const stateChips = [
    chip('state', '', 'Any state', jobs.length),
    ...(['failing', 'running', 'paused'] as const).map((s) =>
      chip(
        'state',
        s,
        s[0]?.toUpperCase() + s.slice(1),
        count((j) => jobState(j) === s),
      ),
    ),
  ].join('');
  const sortChips = `<span class="dim">Sort</span>${chip('sort', '', 'Next run', jobs.length).replace(/<small>.*<\/small>/, '')}${chip(
    'sort',
    'usage',
    'Most usage',
    jobs.length,
  ).replace(/<small>.*<\/small>/, '')}`;
  // Usage: the share of all job runs' cost this week (cost is at API prices; a subscription pays none of it).
  const total = allJobs.reduce((t, j) => t + (j.week?.costUsd ?? 0), 0);
  const top3 = [...allJobs]
    .sort((a, b) => (b.week?.costUsd ?? 0) - (a.week?.costUsd ?? 0))
    .slice(0, 3)
    .reduce((t, j) => t + (j.week?.costUsd ?? 0), 0);
  const order = new Map(sorted.map((j, i) => [j, i]));

  const card = (j: JobView) => {
    const state = jobState(j);
    const week = j.week;
    const share = total && week?.costUsd ? week.costUsd / total : 0;
    const usage = week?.runs
      ? `<span title="Last 7 days. Cost at API prices; on a subscription it counts against the usage limit instead.">${
          share >= 0.005 ? `≈${Math.round(share * 100)}% of job usage · ` : ''
        }${week.runs} ${week.runs === 1 ? 'run' : 'runs'}${week.costUsd >= 0.5 ? ` · $${Math.round(week.costUsd)} this week` : ''}</span>`
      : '';
    const off = lengthOff(j.durationMinutes, week?.typicalMinutes);
    const length = off
      ? `<span class="tag warn">takes ~${week?.typicalMinutes} min (planned ${j.durationMinutes})</span><button type="button" class="btn quiet" data-duration="${esc(j.project)}/${esc(j.id)}" data-minutes="${week?.typicalMinutes}" title="Set the planned length the Timeline uses">Use ${week?.typicalMinutes} min</button>`
      : '';
    const streak = failureStreak(j.recent);
    const next =
      j.enabled && j.nextRun
        ? `<span>Next <b>${esc(when(j.nextRun, tz))}</b> (${esc(relative(j.nextRun, now))})</span>`
        : '';
    const history = j.recent.length
      ? `<ul class="runs">${j.recent
          .map(
            (r) =>
              `<li><a href="${runHref(r)}"><span class="dot ${runTone(r.status)}"></span>${esc(when(r.startedAt, tz))}<span class="dim">· ${esc(
                RUN_LABEL[r.status] ?? r.status,
              )} · ${formatDuration(r.endedAt - r.startedAt)}</span></a></li>`,
          )
          .join('')}</ul>`
      : '<div class="empty">No runs yet.</div>';
    return `<article class="card ${STATE[state].card}" id="${anchor(j)}" data-card data-order="${order.get(j)}" data-group="${group(j)}" data-usage="${(week?.costUsd ?? 0).toFixed(2)}" data-project="${esc(j.project)}" data-state="${state}" data-q="${esc(
      `${j.name} ${j.id} ${j.skills.join(' ')}`.toLowerCase(),
    )}">
<div class="card-head"><div class="grow"><div class="title">${esc(j.name)}</div>
<div class="meta"><span class="tag ${STATE[state].tone}">${STATE[state].label}</span>${projectTag(ctx, j.project)}${
      onDemandView
        ? '' // the tab already says it
        : `<span>${esc(j.cron ? cronText(j.cron, j.tz, tz) : 'Runs when its queue has approved items')}</span>`
    }</div></div>
<div class="actions">${
      // An on-demand job has no schedule to pause: Run now is its one action (Resume if a person disabled it).
      onDemandView
        ? j.enabled
          ? actionButton(j, 'run', 'Run now')
          : actionButton(j, 'resume', 'Resume', 'green')
        : `${actionButton(j, 'run', 'Run now', 'ghost')}${
            j.enabled
              ? actionButton(j, 'pause', 'Pause', 'quiet')
              : actionButton(j, 'resume', 'Resume', 'green')
          }`
    }</div></div>
<div class="meta">${next}<span>Last run ${esc(relative(j.lastRunAt, now))}</span>${runStrip(j.recent, tz)}${
      streak > 1 ? `<span class="tag bad">${streak} failures in a row</span>` : ''
    }</div>
${usage || length ? `<div class="meta">${usage}${length}</div>` : ''}
${state === 'failing' && j.lastError ? `<div class="meta error">Last error: ${esc(j.lastError)}</div>` : ''}
<details><summary>Details and run history</summary><dl class="facts">
<dt>Skills</dt><dd>${j.skills.length ? esc(j.skills.join(', ')) : '—'}</dd>
<dt>Model</dt><dd>${j.harness === 'agy' ? 'agy (Antigravity CLI) · ' : ''}${esc(j.model)}${
      j.stepModels?.length ? ` · steps: ${esc(j.stepModels.join(', '))}` : ''
    }${j.handoff ? ` · after approval: ${esc(onHarness(j.handoff.harness, j.handoff.model))}` : ''}</dd>
<dt>Length</dt><dd>${j.durationMinutes ? `${j.durationMinutes} min planned` : 'not planned'}${week?.typicalMinutes ? ` · ~${week.typicalMinutes} min in the last 7 days` : ''} <button type="button" class="btn quiet" data-length="${esc(j.project)}/${esc(j.id)}" data-name="${esc(j.name)}" data-minutes="${j.durationMinutes ?? week?.typicalMinutes ?? ''}" title="The planned length the Timeline uses for overlaps and free time">Change</button></dd>
<dt>Schedule</dt><dd>${
      j.cron
        ? `<code>${esc(j.cron)}</code> ${esc(j.tz)}`
        : j.queues?.length
          ? `none (executor of the ${esc(j.queues.join(', '))} ${j.queues.length === 1 ? 'queue' : 'queues'})`
          : 'none (on demand: Run now, or ask in chat)'
    }</dd>
<dt>Job id</dt><dd><code>${esc(j.id)}</code></dd></dl>${history}</details></article>`;
  };
  // Jobs a queue runs when it has approved items are folded at the bottom of List.
  const main = sorted.filter((j) => group(j) !== 'queued');
  const queued = sorted.filter((j) => group(j) === 'queued');
  const jobsThatRun = (n: number) => `${n} ${n === 1 ? 'job that runs' : 'jobs that run'}`;
  const cards = `<div data-cards>${main.map(card).join('')}</div>${
    queued.length
      ? `<details class="queue-jobs" data-group-box><summary>Run by a queue · ${jobsThatRun(queued.length)} when ${queued.length === 1 ? 'its' : 'their'} queue has approved items</summary><div data-cards="queued">${queued.map(card).join('')}</div></details>`
      : ''
  }`;

  return layout(
    ctx,
    'Jobs',
    'Jobs',
    `${pageHead(
      'Jobs',
      onDemandView
        ? `Jobs that never run on a schedule: start one with Run now, or ask for it in Slack. It posts in the project's channel. Times in ${esc(tz)}.`
        : `Every scheduled job${ctx.projects.length > 1 ? `, across ${ctx.projects.length} projects` : ''}. Times in ${esc(tz)}.${
            total >= 1
              ? ` Last 7 days: ≈$${Math.round(total)} of usage at API prices; the top 3 jobs used ${Math.round((top3 / total) * 100)}%.`
              : ''
          }`,
    )}
${jobViewTabs(view)}
<div class="jobs-filters">
${projectChips ? `<div class="toolbar"><div class="chips">${projectChips}</div></div>` : ''}
<div class="toolbar">${onDemandView ? '' : `<div class="chips">${stateChips}</div><div class="chips">${sortChips}</div>`}<input id="q" class="input" type="search" placeholder="Search jobs" aria-label="Search jobs"></div>
</div>
${cards}<div id="none" class="empty" hidden>${
      jobs.length
        ? 'No jobs match.'
        : onDemandView
          ? 'No on-demand jobs. A job with no <code>cron</code> that no queue runs shows here.'
          : 'No scheduled jobs.'
    }</div>`,
    { refresh: true, script: JOBS_SCRIPT },
  );
}

export function runPage(ctx: DashboardContext, run: StoredRun, job?: JobInfo): string {
  const name = run.jobId ? (job?.name ?? run.jobId) : 'Chat turn';
  const links = [
    run.jobId ? `<a href="/jobs#${anchor({ project: run.project, id: run.jobId })}">Job</a>` : '',
    run.threadKey ? threadLink(ctx, run.threadKey) : '',
  ]
    .filter(Boolean)
    .join('');
  const actions = [
    run.sessionId ? `<a class="btn" href="/sessions/${esc(run.sessionId)}">Open transcript →</a>` : '',
    job ? actionButton({ ...job, project: run.project }, 'run', 'Run now', 'ghost') : '',
  ].join('');
  return layout(
    ctx,
    name,
    run.kind === 'job' ? 'Jobs' : 'Sessions',
    `${pageHead(name)}<div class="card-head"><div class="meta">${runTag(run.status)}${projectTag(ctx, run.project)}
<span>${esc(when(run.startedAt, ctx.timeZone))}</span><span>${formatDuration(run.endedAt - run.startedAt)}</span>${
      run.toolCalls ? `<span>${run.toolCalls} tool calls</span>` : ''
    }${links}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>
${run.error ? `<article class="card bad spaced"><div class="title">Error</div><pre>${esc(run.error)}</pre></article>` : ''}
${section(
  'Reply',
  run.output
    ? `<div class="msg">${md(run.output)}</div>`
    : `<div class="empty">${run.status === 'silent' ? 'The check before the run found nothing to do, so Claude did not run.' : 'No reply recorded.'}</div>`,
)}
${run.scriptOutput ? `<details><summary>What the check before the run found</summary><pre>${esc(run.scriptOutput)}</pre></details>` : ''}`,
  );
}

export function sessionsPage(
  ctx: DashboardContext,
  sessions: SessionOverview[],
  jobNames: Map<string, string>,
  filter: { project?: string; kind?: string },
  opts: {
    /** A session's first message (chats), read from its transcript. */
    preview?: (project: string, sessionId: string) => string | undefined;
    /** Slack threads with a run working in them now. */
    runningThreads?: Set<string>;
    now?: number;
  } = {},
): string {
  const chips = (key: 'project' | 'kind', values: [string, string][]) =>
    values
      .map(([v, label]) => {
        const params = new URLSearchParams({ ...filter, [key]: v } as Record<string, string>);
        for (const [k, val] of [...params]) if (!val) params.delete(k);
        const on = (filter[key] ?? '') === v;
        return `<a class="chip${on ? ' on' : ''}" href="/sessions${params.size ? `?${params}` : ''}"${on ? ' aria-current="true"' : ''}>${esc(label)}</a>`;
      })
      .join('');
  const tz = ctx.timeZone;
  const now = opts.now ?? Date.now();
  // A session belongs to a job when its runs do (a learning turn after it carries the job's id too).
  // A job prompt starts with its pre-run check's output: a session with no recorded run (stopped by
  // a restart) is still recognisable as a job's.
  const jobPrompt = (s: SessionOverview) =>
    opts.preview?.(s.project, s.sessionId)?.startsWith('## Script ') ?? false;
  const kindOf = (s: SessionOverview) => (s.jobId || s.lastRun?.jobId || jobPrompt(s) ? 'job' : 'chat');
  const dayOf = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
  const today = dayOf(now);
  const yesterday = dayOf(now - 86_400_000);
  const dayLabel = (key: string, ms: number) =>
    key === today
      ? 'Today'
      : key === yesterday
        ? 'Yesterday'
        : new Date(ms).toLocaleDateString('en-GB', {
            timeZone: tz,
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          });
  let lastDay = '';
  const rows = sessions
    .filter((s) => !filter.kind || kindOf(s) === filter.kind)
    .map((s) => {
      const run = s.lastRun;
      const kind = kindOf(s);
      const at = run?.startedAt ?? s.updatedAt;
      const jobId = s.jobId ?? run?.jobId;
      const jobName = jobId ? (jobNames.get(`${s.project}:${jobId}`) ?? jobId) : undefined;
      // A chat's title is its message's first line (tara-agent adds context below it).
      const message = opts
        .preview?.(s.project, s.sessionId)
        ?.split('\n')
        .find((l) => l.trim());
      const title =
        kind === 'job'
          ? (jobName ?? 'A job run with no record (stopped before it finished?)')
          : (message ?? '(no message yet)');
      // What happened: a job run's first line, or "replied in Slack" when the last turn was a reply.
      const line =
        kind === 'job' && run ? (run.jobId ? headline(run) : 'Last: a reply in its Slack thread') : '';
      const running = opts.runningThreads?.has(s.threadKey);
      const key = dayOf(at);
      const heading = key !== lastDay ? `<h3 class="day" data-day>${esc(dayLabel(key, at))}</h3>` : '';
      lastDay = key;
      return `${heading}<a class="row" href="/sessions/${esc(s.sessionId)}" data-q="${esc(
        `${title ?? ''} ${line} ${jobId ?? ''} ${projectTitle(ctx, s.project)}`.toLowerCase(),
      )}"><span class="dot ${running ? '' : run ? runTone(run.status) : 'dim'}"></span><span class="grow">
<span class="title">${kind === 'job' ? '⏱ ' : '💬 '}${esc((title ?? '').slice(0, 160))}</span>${
        line ? `<span class="line">${esc(line)}</span>` : ''
      }
<span class="meta">${projectTag(ctx, s.project)}${running ? '<span class="tag">● running</span>' : runTag(run?.status)}
<span>${s.turns} ${s.turns === 1 ? 'turn' : 'turns'}</span><span>${esc(clock(at, tz))}</span>
${run && !running ? `<span>${formatDuration(run.endedAt - run.startedAt)}</span>` : ''}</span></span></a>`;
    })
    .join('');
  const filtered = Boolean(filter.project || filter.kind);
  return layout(
    ctx,
    'Sessions',
    'Sessions',
    `${pageHead('Sessions', 'Slack chats and job runs, newest first. Open one to read the whole conversation.')}
<div class="toolbar"><div class="chips">${
      ctx.projects.length > 1
        ? chips('project', [
            ['', 'All'],
            ...ctx.projects.map((p): [string, string] => [p.config.name, p.config.title ?? p.config.name]),
          ])
        : ''
    }${chips('kind', [
      ['', 'Chats and jobs'],
      ['chat', 'Chats'],
      ['job', 'Jobs'],
    ])}</div><input id="sq" class="input" type="search" placeholder="Search sessions" aria-label="Search sessions"></div>
<div class="todo sessions">${rows || `<div class="empty">${filtered ? 'No sessions match.' : 'No sessions yet.'}</div>`}</div><div id="none" class="empty" hidden>No sessions match.</div>`,
    { script: SESSIONS_SCRIPT },
  );
}

/** The Sessions search: filters the rows as you type and hides day headings left empty. */
const SESSIONS_SCRIPT = `
const sq = document.getElementById('sq');
sq?.addEventListener('input', () => {
  const q = sq.value.trim().toLowerCase();
  let shown = 0, day = null, dayShown = 0;
  const close = () => { if (day) day.hidden = dayShown === 0; };
  for (const el of document.querySelectorAll('.sessions > *')) {
    if (el.matches('[data-day]')) { close(); day = el; dayShown = 0; continue; }
    const ok = !q || (el.dataset.q || '').includes(q);
    el.hidden = !ok;
    if (ok) { shown++; dayShown++; }
  }
  close();
  document.getElementById('none').hidden = shown > 0;
});
`;

function entryHtml(e: TranscriptEntry, timeZone: string): string {
  const time = e.time ? ` · ${esc(when(e.time, timeZone))}` : '';
  if (e.kind === 'user') {
    // Job prompts start with the pre-script's data block: fold it so the prompt stays readable.
    const script = /^## Script (Output|Error)\n[^\n]*\n\n```\n([\s\S]*?)\n```\n\n/.exec(e.text);
    let rest = script ? e.text.slice(script[0].length) : e.text;
    // Chat prompts start with the sender's Slack mention; show it as a message instead.
    const sender = /^<@([A-Z0-9]+)>:\s*/.exec(rest);
    if (sender) rest = rest.slice(sender[0].length);
    return `<div class="msg user"><div class="who">${sender ? 'Message' : 'Prompt'}${time}</div>${
      script
        ? `<details><summary>What the check before the run found</summary><pre>${esc(script[2])}</pre></details>`
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
  opts: {
    jobName?: string;
    /** The session's latest run: its error, and its reply when there is no transcript. */
    run?: StoredRun;
    /** A run is working in this session now: the page shows its steps as they happen. */
    running?: boolean;
    /** This browser may stop the run (unlocked, from another device). */
    canStop?: boolean;
  } = {},
): string {
  const { run, running } = opts;
  const title = opts.jobName ?? (entries ? firstPrompt(entries)?.slice(0, 80) : undefined) ?? 'Conversation';
  const project = session?.project ?? run?.project;
  const status = running
    ? '<span class="tag">● running</span>'
    : runTag(run?.status ?? session?.lastRun?.status);
  const head = project
    ? `<div class="meta">${projectTag(ctx, project)}${status}${
        session
          ? `<span>${esc(session.model)}</span>
<span>${session.turns} ${session.turns === 1 ? 'turn' : 'turns'}</span>${threadLink(ctx, session.threadKey)}`
          : ''
      }${
        run && !running ? `<a href="/runs/${run.id}">Run details</a>` : ''
      }<span class="dim" title="${esc(sessionId)}">id ${esc(sessionId.slice(0, 8))}</span></div>`
    : '';
  const error =
    !running && run?.error && FAILED.includes(run.status)
      ? `<article class="card bad spaced"><div class="title">Error</div><pre>${esc(run.error)}</pre></article>`
      : '';
  const body = entries?.length
    ? entries.map((e) => entryHtml(e, ctx.timeZone)).join('')
    : run?.output
      ? `<div class="empty">No transcript for this session on this machine (old, or run on another CLI). The run's reply:</div><div class="msg">${md(run.output)}</div>`
      : `<div class="empty">${running ? 'The transcript shows here when the run ends.' : 'No transcript for this session on this machine.'}</div>`;
  // While it runs: its steps and the end of what it is writing, polled; the page reloads when it ends.
  const live = running
    ? `<section class="card accent live" id="live" data-session="${esc(sessionId)}" aria-live="polite"><div class="card-head"><div class="grow"><div class="title">● Working <span class="dim" id="live-clock"></span></div><div class="meta" id="live-meta">Connecting…</div></div>${
        opts.canStop
          ? '<div class="actions"><button type="button" class="btn danger" id="live-stop">Stop</button></div>'
          : '<div class="actions"><a class="btn quiet" href="/unlock" title="Unlock this browser to stop runs from here">Unlock to stop</a></div>'
      }</div><ol class="steps" id="live-steps"></ol><pre class="live-text" id="live-text" hidden></pre></section>`
    : '';
  return layout(ctx, title, 'Sessions', `${pageHead(title)}${head}${error}${live}${body}`, {
    script: running ? LIVE_SCRIPT : undefined,
  });
}

/** The running session's live card: polls `/sessions/<id>/live`, Stop posts `/sessions/<id>/stop`. */
const LIVE_SCRIPT = `
(() => {
  const box = document.getElementById('live');
  if (!box) return;
  const url = '/sessions/' + encodeURIComponent(box.dataset.session);
  const $ = (id) => document.getElementById(id);
  const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };
  let started = 0, misses = 0;
  setInterval(() => { if (started) $('live-clock').textContent = fmt(Date.now() - started); }, 1000);
  async function poll() {
    try {
      const r = await fetch(url + '/live');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (!j.running) return location.reload();
      misses = 0;
      const t = j.task;
      started = t.startedAt;
      $('live-meta').textContent = t.stepCount + (t.stepCount === 1 ? ' step' : ' steps') + (t.stepCount > t.steps.length ? ' · the latest ' + t.steps.length + ' shown' : '');
      const list = $('live-steps');
      const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
      list.replaceChildren(...t.steps.map((s) => {
        const li = document.createElement('li');
        li.className = s.state + (s.depth ? ' sub' : '');
        const at = document.createElement('span');
        at.className = 'at';
        at.textContent = fmt(s.at - t.startedAt);
        li.append(at, (s.state === 'error' ? '✗ ' : s.state === 'running' ? '… ' : '') + s.text);
        return li;
      }));
      if (atEnd) list.scrollTop = list.scrollHeight;
      $('live-text').hidden = !t.text;
      $('live-text').textContent = t.text;
    } catch {
      $('live-meta').textContent = 'Lost touch with the run; retrying…';
      if (++misses > 20) return;
    }
    setTimeout(poll, document.hidden ? 10000 : 2500);
  }
  poll();
  const stop = $('live-stop');
  stop?.addEventListener('click', async () => {
    if (!(await ask('Stop this run?', 'The work so far stays, and its Slack thread says it stopped.', 'Stop', true))) return;
    stop.disabled = true;
    try { await post(url + '/stop'); toast('Stopping…'); }
    catch (err) { toast(err.message, { error: true }); stop.disabled = false; }
  });
})();
`;

/** 404 and 500 pages, inside the normal layout so the way back is always there. */
/**
 * A project's app page inside this dashboard: the sidebar plus a frame on `/app/<name><rest>`, which the
 * server proxies to the project's `dashboardUrl`. As the app moves between its pages, the script keeps
 * this page's address on `/p/<name>/…` and the matching tab marked, so links and reloads land back there.
 */
export function tabPage(ctx: DashboardContext, project: Project, rest: string): string {
  const name = project.config.name;
  const title = project.config.title ?? name;
  const app = `/app/${name}`;
  return layout(
    ctx,
    title,
    '',
    `<iframe class="app-frame" src="${esc(app + rest)}" title="${esc(title)}" data-app="${esc(name)}"></iframe>`,
    { framed: true, script: TAB_SCRIPT },
  );
}

const TAB_SCRIPT = `
(() => {
  const frame = document.querySelector('.app-frame');
  const name = frame.dataset.app, app = '/app/' + name, shell = '/p/' + name;
  const under = (path, base) => path === base || path.startsWith(base.endsWith('/') ? base : base + '/');
  const mark = (rest) => {
    const tabs = [...document.querySelectorAll('.nav-item[data-app="' + name + '"]')];
    const best = tabs.filter((a) => under(rest, a.dataset.tab)).sort((a, b) => b.dataset.tab.length - a.dataset.tab.length)[0];
    tabs.forEach((a) => { a.classList.toggle('on', a === best); if (a === best) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  };
  const sync = () => {
    let loc;
    try { loc = frame.contentWindow.location; } catch { return; }
    if (!under(loc.pathname, app)) return;
    const rest = loc.pathname.slice(app.length) || '/';
    const next = shell + rest + loc.search + loc.hash;
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, '', next);
    mark(rest);
    try { if (frame.contentDocument.title) document.title = frame.contentDocument.title; } catch {}
  };
  mark(location.pathname.slice(shell.length) || '/');
  frame.addEventListener('load', () => {
    sync();
    const w = frame.contentWindow;
    try {
      for (const m of ['pushState', 'replaceState']) {
        const orig = w.history[m];
        w.history[m] = function (...args) { const r = orig.apply(this, args); sync(); return r; };
      }
      w.addEventListener('popstate', sync);
      w.addEventListener('hashchange', sync);
    } catch {}
  });
  // On phones the sidebar is a top bar: the frame takes the rest of the screen.
  const bar = () => frame.style.setProperty('--bar', document.querySelector('.brand').offsetHeight + 1 + 'px');
  bar(); addEventListener('resize', bar);
})();
`;

export function errorPage(ctx: DashboardContext, status: 404 | 500, detail?: string): string {
  const [title, text] =
    status === 404
      ? ['Not found', 'There is no page here. It may have moved; use the menu.']
      : ['Something went wrong', 'This page could not be shown. The error is in the tara-agent log.'];
  return layout(ctx, title, '', `${pageHead(title, esc(text))}${detail ? `<pre>${esc(detail)}</pre>` : ''}`);
}
