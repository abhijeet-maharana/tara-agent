import {
  type BrowserStatus,
  LOGINS_FILE,
  type LoginUse,
  type ProjectNeeds,
  type SiteUse,
} from './browser-usage.js';
import {
  type DashboardContext,
  esc,
  layout,
  pageHead,
  projectTitle,
  relative,
  section,
} from './dashboard.js';

/**
 * The Browsers page: each shared Chrome (host `browsers`) and, per project, the logins its browser
 * needs (its `.tara/logins.json`, with the jobs that use each), so you can decide which Chrome profile
 * each project gets and what to sign in to there.
 */

export interface BrowsersData {
  browsers: BrowserStatus[];
  needs: ProjectNeeds[];
  /** `project:jobId` → job name. */
  jobNames: Map<string, string>;
  /** Transcripts are still being read: the lists may be short. */
  scanning: boolean;
  days: number;
  now: number;
}

/** Sites opened in this many sessions or more are listed; the rest are folded. */
const OFTEN = 2;

const STYLE = `<style>
.sites{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px}
.sites th{text-align:left;font-weight:600;color:var(--text-dim);font-size:12px;padding:4px 8px;border-bottom:1px solid var(--border)}
.sites td{padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
.sites td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.sites td.host{overflow-wrap:anywhere;color:var(--text-heading)}
.sites td.host small{display:block;color:var(--text-dim);font-weight:400;font-size:12px;margin-top:2px}
.sites td.acct{overflow-wrap:anywhere}
.sites .who{display:flex;flex-wrap:wrap;gap:4px}
details.more{margin-top:8px}details.more summary{cursor:pointer;color:var(--text-dim);font-size:13px}
@media (max-width:640px){.sites .last,.sites th.last{display:none}}
</style>`;

const short = (url: string) => url.replace(/^https?:\/\/(127\.0\.0\.1|localhost)/, '');

function browserLabel(b: BrowserStatus) {
  return `<code>${esc(b.lock)}</code> <span class="dim">${esc(short(b.cdpUrl))}</span>`;
}

/** The jobs (and chats) that used a site or login, most sessions first. */
function users(n: ProjectNeeds, use: SiteUse | LoginUse, data: BrowsersData): string {
  const jobs = [...use.jobs]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([id, count]) =>
        `<span class="tag" title="${count} session${count === 1 ? '' : 's'}">${esc(data.jobNames.get(`${n.project}:${id}`) ?? id)}${
          count > 1 ? ` ×${count}` : ''
        }</span>`,
    );
  if (use.chats) jobs.push(`<span class="tag dim">chat${use.chats > 1 ? ` ×${use.chats}` : ''}</span>`);
  return jobs.length
    ? `<div class="who">${jobs.join('')}</div>`
    : `<span class="dim">not used in ${data.days} days</span>`;
}

function loginRows(ctx: DashboardContext, n: ProjectNeeds, logins: LoginUse[], data: BrowsersData): string {
  const row = (l: LoginUse) => {
    const also = l.alsoIn
      .map((p) => `<span class="tag warn">also ${esc(projectTitle(ctx, p))}</span>`)
      .join(' ');
    return `<tr><td class="host">${esc(l.service)}<small>${esc(l.sites.join(', '))}</small></td><td class="acct">${
      l.account ? `<b>${esc(l.account)}</b>` : '<span class="tag warn">account not written down</span>'
    }${l.note ? `<div class="dim" style="font-size:12.5px">${esc(l.note)}</div>` : ''}${also ? `<div class="who" style="margin-top:3px">${also}</div>` : ''}</td><td>${users(
      n,
      l,
      data,
    )}</td><td class="n last">${l.last ? esc(relative(l.last, data.now)) : ''}</td></tr>`;
  };
  const sorted = [...logins].sort((a, b) => b.sessions - a.sessions);
  return `<table class="sites"><thead><tr><th>Login</th><th>Account</th><th>Used by</th><th class="last">Last</th></tr></thead><tbody>${sorted
    .map(row)
    .join('')}</tbody></table>`;
}

function siteRows(ctx: DashboardContext, n: ProjectNeeds, sites: SiteUse[], data: BrowsersData): string {
  const row = (s: SiteUse) => {
    const also = s.alsoIn
      .map((p) => `<span class="tag warn">also ${esc(projectTitle(ctx, p))}</span>`)
      .join(' ');
    return `<tr><td class="host">${esc(s.host)}${also ? `<div class="who" style="margin-top:3px">${also}</div>` : ''}</td><td class="n">${s.sessions}</td><td>${users(n, s, data)}</td><td class="n last">${
      s.last ? esc(relative(s.last, data.now)) : ''
    }</td></tr>`;
  };
  return `<table class="sites"><thead><tr><th>Site</th><th>Sessions</th><th>Opened by</th><th class="last">Last</th></tr></thead><tbody>${sites
    .map(row)
    .join('')}</tbody></table>`;
}

function projectCard(ctx: DashboardContext, n: ProjectNeeds, data: BrowsersData): string {
  const byUrl = n.browser.cdpUrl
    ? data.browsers.find((b) => b.cdpUrl.replace(/\/$/, '') === n.browser.cdpUrl)
    : undefined;
  const chats = n.browser.cdpUrl
    ? `Chats use ${byUrl ? browserLabel(byUrl) : `<code>${esc(n.browser.cdpUrl)}</code> <span class="tag warn">not in host browsers</span>`}`
    : n.browser.ownBrowser
      ? 'Chats: its browser MCP server starts its own Chrome'
      : 'Chats: no browser MCP server in <code>.mcp.json</code>';
  const locks = data.browsers
    .filter((b) => n.lockJobs.has(b.lock))
    .map((b) => {
      const jobs = n.lockJobs.get(b.lock) ?? [];
      const mismatch = byUrl && byUrl.lock !== b.lock;
      return `<span title="${esc(jobs.map((j) => j.name).join(', '))}">${jobs.length} job${jobs.length === 1 ? '' : 's'} hold ${browserLabel(b)}${
        mismatch ? ' <span class="tag warn">chats use another Chrome</span>' : ''
      }</span>`;
    });
  const loginsPart = n.loginsError
    ? `<div class="alert">Can't read <code>${LOGINS_FILE}</code>: ${esc(n.loginsError)}</div>`
    : n.logins?.length
      ? loginRows(ctx, n, n.logins, data)
      : `<div class="empty">No logins written down: list them in <code>${LOGINS_FILE}</code>.</div>`;
  // Sites runs opened in more than one session that no login (or `public`) covers: maybe a login is missing.
  const missing = n.unlisted.filter((s) => s.sessions >= OFTEN);
  const missingPart =
    n.logins && missing.length
      ? `<details class="more" open><summary>${missing.length} site${missing.length === 1 ? '' : 's'} opened often with no login listed: add each to a login, or to <code>public</code> if it needs none</summary>${siteRows(ctx, n, missing, data)}</details>`
      : '';
  const sitesPart = n.sites.length
    ? `<details class="more"><summary>All ${n.sites.length} sites opened in ${n.sessions} sessions (last ${data.days} days)</summary>${siteRows(ctx, n, n.sites, data)}</details>`
    : `<div class="empty">No browser use in the last ${data.days} days.</div>`;
  const body = `${loginsPart}${missingPart}${sitesPart}`;
  return `<article class="card" id="project-${esc(n.project)}"><div class="card-head"><div class="grow">
<div class="meta"><span>${chats}</span>${locks.map((l) => `<span>${l}</span>`).join('')}</div>
${
  n.logins
    ? `<div class="meta"><span><b>${n.logins.length}</b> login${n.logins.length === 1 ? '' : 's'}</span></div>`
    : ''
}</div></div>${body}</article>`;
}

function browserCard(ctx: DashboardContext, b: BrowserStatus, data: BrowsersData): string {
  const chatProjects = data.needs.filter((n) => n.browser.cdpUrl === b.cdpUrl.replace(/\/$/, ''));
  const jobProjects = data.needs.filter((n) => n.lockJobs.has(b.lock));
  const status = b.up
    ? `<span class="dot ok"></span><span>Up${b.version ? ` · ${esc(b.version)}` : ''}${b.tabs !== undefined ? ` · ${b.tabs} tab${b.tabs === 1 ? '' : 's'}` : ''}</span>`
    : '<span class="dot bad"></span><span>Not answering</span>';
  const used = [
    ...chatProjects.map((n) => `${esc(projectTitle(ctx, n.project))} chats`),
    ...jobProjects.map((n) => {
      const k = n.lockJobs.get(b.lock)?.length ?? 0;
      return `${esc(projectTitle(ctx, n.project))} · ${k} job${k === 1 ? '' : 's'}`;
    }),
  ];
  return `<article class="card"><div class="card-head"><div class="grow"><div class="title">${browserLabel(b)}</div>
<div class="meta">${status}</div>
<div class="meta">${used.length ? `<span>Used by: ${used.join(', ')}</span>` : '<span>No project uses it</span>'}</div></div></div></article>`;
}

/** Logins (same service and account) more than one project needs: each Chrome they get needs them. */
function sharedCard(ctx: DashboardContext, data: BrowsersData): string {
  const seen = new Map<string, { login: LoginUse; projects: string[] }>();
  for (const n of data.needs)
    for (const l of n.logins ?? []) {
      if (!l.alsoIn.length) continue;
      const key = `${l.service}|${l.account ?? ''}`.toLowerCase();
      const entry = seen.get(key) ?? { login: l, projects: [] };
      entry.projects.push(n.project);
      seen.set(key, entry);
    }
  if (!seen.size) return '<div class="empty">No login is listed by more than one project.</div>';
  const rows = [...seen.values()]
    .map(
      ({ login, projects }) =>
        `<tr><td class="host">${esc(login.service)}</td><td class="acct">${esc(login.account ?? '')}</td><td><div class="who">${projects
          .map((p) => `<span class="tag">${esc(projectTitle(ctx, p))}</span>`)
          .join('')}</div></td></tr>`,
    )
    .join('');
  return `<div class="card"><table class="sites"><thead><tr><th>Login</th><th>Account</th><th>Projects</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function browsersPage(ctx: DashboardContext, data: BrowsersData): string {
  const projects = data.needs.filter((n) => n.sites.length || n.browser.servers.length || n.lockJobs.size);
  const body = `${STYLE}${pageHead(
    'Browsers',
    `Each shared Chrome, and the logins every project's browser needs (from its <code>${LOGINS_FILE}</code>), with the jobs that used each over the last ${data.days} days. Use it to decide which Chrome profile each project gets and what to sign in to there.`,
  )}${data.scanning ? '<div class="alert">Still reading transcripts: the lists may be short. Refresh in a minute.</div>' : ''}${section(
    'Chromes',
    data.browsers.map((b) => browserCard(ctx, b, data)).join('') ||
      '<div class="empty">No browsers configured (host <code>browsers</code>).</div>',
    { sub: 'host browsers' },
  )}${projects.map((n) => section(`Logins ${projectTitle(ctx, n.project)} needs`, projectCard(ctx, n, data))).join('')}${section(
    'Logins more than one project needs',
    sharedCard(ctx, data),
    { sub: 'sign in to these in every Chrome those projects get' },
  )}`;
  return layout(ctx, 'Browsers', 'Browsers', body);
}
