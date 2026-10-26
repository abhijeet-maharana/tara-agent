import type { Change, CodeRepo, DiffView, FileView, RepoStatus, SearchResult } from '../code/repo.js';
import { MAX_DIFF_LINES, MAX_FILE_BYTES } from '../code/repo.js';
import { type DashboardContext, esc, layout, pageHead, relative, section } from './dashboard.js';

/**
 * The Code page: each repo's uncommitted changes, their diffs, a file browser and search (file
 * names and text). Read-only; the "Ask" box on a diff or file starts a conversation about it in the
 * project's Slack channel.
 */

const CSS = `<style>
.crumbs{display:flex;flex-wrap:wrap;gap:4px;font-size:13px;color:var(--text-dim);margin:-8px 0 14px;overflow-wrap:anywhere}
.crumbs a{text-decoration:none}
.st{display:inline-grid;place-items:center;min-width:22px;height:20px;padding:0 5px;border-radius:5px;font-size:11.5px;font-weight:700;flex:none}
.st.modified{background:var(--amber-dim);color:var(--amber)}.st.added,.st.untracked{background:var(--green-dim);color:var(--green)}
.st.deleted,.st.conflict{background:var(--red-dim);color:var(--red)}
.path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;overflow-wrap:anywhere}.path .dir{color:var(--text-dim)}
.plus{color:var(--green)}.minus{color:var(--red)}.num{font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.diff,.src{margin:0;background:var(--bg);border:1px solid var(--border);border-radius:8px;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}
.diff>div,.src>div{display:grid;grid-template-columns:44px 1fr}
.diff i,.src i{font-style:normal;text-align:right;padding:0 8px 0 4px;color:var(--text-dim);opacity:.6;user-select:none;border-right:1px solid var(--border)}
.diff code,.src code{background:none;border:0;border-radius:0;padding:0 8px;font-size:inherit;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.diff .add{background:rgba(16,185,129,.12)}.diff .add code{color:#a7f3d0}
.diff .del{background:rgba(244,63,94,.12)}.diff .del code{color:#fecdd3}
.diff .hunk{background:var(--accent-dim);color:var(--accent)}.diff .hunk code{color:var(--accent)}
.ask{display:grid;gap:8px;margin-top:18px}.ask textarea{min-height:70px}
.repo-grid{display:grid;gap:8px}
.search{display:flex;gap:8px;margin:0 0 18px}.search .input{flex:1;min-width:0}
.src>div{scroll-margin-top:90px}.src>div:target{background:var(--amber-dim)}
.hits{display:grid;gap:2px;margin:0 0 12px}
.hit{display:grid;grid-template-columns:44px 1fr;padding:3px 0;border-radius:6px;color:var(--text);text-decoration:none;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.hit:hover{background:var(--card-hover)}.hit i{font-style:normal;text-align:right;padding-right:8px;color:var(--text-dim)}.hit code{background:none;border:0;padding:0;font-size:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.hit-file{display:block;margin:10px 0 2px;text-decoration:none}
mark{background:var(--amber-dim);color:var(--amber);border-radius:3px;padding:0 1px}
</style>`;

const SCRIPT = `
document.querySelectorAll('form[data-ask]').forEach((f) => f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = f.querySelector('button');
  b.disabled = true;
  try {
    const j = await post(f.dataset.ask, { path: f.dataset.path, question: f.question.value });
    f.question.value = '';
    const t = document.createElement('div');
    t.className = 'clear';
    t.innerHTML = 'Asked. The answer comes in Slack' + (j.url ? ': <a href="' + j.url + '">open the thread ↗</a>' : '.');
    f.replaceWith(t);
  } catch (err) { toast(err.message, { error: true }); b.disabled = false; }
}));
`;

const STATE_LETTER: Record<Change['state'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'N',
  conflict: '!',
};
const STATE_LABEL: Record<Change['state'], string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  untracked: 'new, not added to git',
  conflict: 'merge conflict',
};

const q = (p: string) => encodeURIComponent(p);
const repoUrl = (r: CodeRepo, page = '', file?: string) =>
  `/code/${q(r.name)}${page ? `/${page}` : ''}${file !== undefined ? `?path=${q(file)}` : ''}`;

/** "apps/api/src/x.ts" with the folder dimmed. */
const pathHtml = (p: string) => {
  const i = p.lastIndexOf('/');
  return `<span class="path">${i === -1 ? '' : `<span class="dir">${esc(p.slice(0, i + 1))}</span>`}${esc(p.slice(i + 1))}</span>`;
};

const counts = (c: { added: number; removed: number; binary?: boolean }) =>
  c.binary
    ? '<span class="num dim">binary</span>'
    : `<span class="num"><span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span></span>`;

const stateBadge = (c: Change) =>
  `<span class="st ${c.state}" title="${esc(STATE_LABEL[c.state])}${c.staged ? ', staged' : ''}">${STATE_LETTER[c.state]}</span>`;

/** Repo › folder › file links. */
function crumbs(repo: CodeRepo, file: string, last: 'dir' | 'file'): string {
  const parts = file ? file.split('/') : [];
  const links = [`<a href="${repoUrl(repo, 'files', '')}">${esc(repo.title)}</a>`];
  parts.forEach((part, i) => {
    const sub = parts.slice(0, i + 1).join('/');
    const isLast = i === parts.length - 1;
    links.push(
      isLast && last === 'file'
        ? `<span>${esc(part)}</span>`
        : `<a href="${repoUrl(repo, 'files', sub)}">${esc(part)}</a>`,
    );
  });
  return `<div class="crumbs" role="navigation" aria-label="Path">${links.join('<span aria-hidden="true">/</span>')}</div>`;
}

const searchBox = (action: string, value: string, placeholder: string) =>
  `<form class="search" method="get" action="${esc(action)}" role="search"><input class="input" type="search" name="q" value="${esc(value)}" placeholder="${esc(placeholder)}" minlength="2" required aria-label="${esc(placeholder)}"><button type="submit" class="btn">Search</button></form>`;

/** `text` with every case-insensitive occurrence of `query` marked. */
const highlight = (text: string, query: string) =>
  text
    .split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join('');

/** Totals of a repo's changes. */
const totals = (s: RepoStatus) => ({
  added: s.changes.reduce((n, c) => n + c.added, 0),
  removed: s.changes.reduce((n, c) => n + c.removed, 0),
});

export function codeHomePage(
  ctx: DashboardContext,
  repos: Array<{ repo: CodeRepo; status: RepoStatus }>,
  now: number,
): string {
  const cards = repos
    .map(({ repo, status }) => {
      const n = status.changes.length;
      const tone = status.error ? 'bad' : n ? 'warn' : 'ok';
      const head = status.head;
      return `<a class="row" href="${repoUrl(repo)}"><span class="dot ${tone}"></span><span class="grow"><span class="title">${esc(repo.title)}</span>
<span class="meta">${status.branch ? `<span class="tag dim">${esc(status.branch)}</span>` : ''}${
        status.error
          ? `<span class="error">${esc(status.error)}</span>`
          : `<span>${n ? `<b>${n}</b> changed file${n === 1 ? '' : 's'}` : 'no uncommitted changes'}</span>`
      }${head ? `<span>last commit ${esc(relative(head.at, now))}</span>` : ''}</span></span>${
        n ? counts(totals(status)) : ''
      }</a>`;
    })
    .join('');
  return layout(
    ctx,
    'Code',
    'Code',
    `${CSS}${pageHead('Code', 'Uncommitted changes and files of each repo, read-only.')}${searchBox(
      '/code',
      '',
      'Search every repo: file names and text',
    )}<div class="repo-grid">${cards || '<p class="empty">No repos.</p>'}</div>`,
    { refresh: true },
  );
}

export function codeRepoPage(ctx: DashboardContext, repo: CodeRepo, status: RepoStatus, now: number): string {
  const head = status.head;
  const sub = [
    status.branch && `on <b>${esc(status.branch)}</b>`,
    head && `last commit “${esc(head.subject)}” ${esc(relative(head.at, now))}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const list = status.changes
    .map(
      (c) =>
        `<a class="row" href="${repoUrl(repo, 'diff', c.path)}">${stateBadge(c)}<span class="grow">${pathHtml(c.path)}</span>${counts(c)}</a>`,
    )
    .join('');
  const body = status.error
    ? `<div class="alert">${esc(status.error)}</div>`
    : list
      ? `<div class="todo">${list}</div>`
      : '<div class="clear">No uncommitted changes.</div>';
  const n = status.changes.length;
  return layout(
    ctx,
    repo.title,
    'Code',
    `${CSS}${pageHead(repo.title, sub)}${searchBox(repoUrl(repo), '', `Search ${repo.title}: file names and text`)}${section(
      'Uncommitted changes',
      body,
      {
        sub: n ? `${n} file${n === 1 ? '' : 's'}` : undefined,
        more: `<a class="more" href="${repoUrl(repo, 'files', '')}">Browse files →</a>`,
      },
    )}`,
    { refresh: true },
  );
}

/** Unified diff lines with the new (or, for removed lines, old) line number. */
function diffHtml(text: string): string {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push(`<div class="hunk"><i>⋯</i><code>${esc(line)}</code></div>`);
      continue;
    }
    if (!inHunk) continue; // diff --git, index, ---, +++
    if (line.startsWith('+'))
      rows.push(`<div class="add"><i>${newLine++}</i><code>${esc(line)}</code></div>`);
    else if (line.startsWith('-'))
      rows.push(`<div class="del"><i>${oldLine++}</i><code>${esc(line)}</code></div>`);
    else if (line.startsWith('\\')) rows.push(`<div><i></i><code class="dim">${esc(line)}</code></div>`);
    else if (line) {
      rows.push(`<div><i>${newLine}</i><code>${esc(line)}</code></div>`);
      oldLine++;
      newLine++;
    }
  }
  return `<div class="diff">${rows.join('')}</div>`;
}

function askBox(repo: CodeRepo, file: string, canAsk: boolean, about: string): string {
  if (!repo.askIn) return '';
  if (!canAsk)
    return `<p class="dim" style="margin-top:18px;font-size:13px"><a href="/unlock">Unlock this browser</a> to ask ${esc(about)}.</p>`;
  return `<form class="ask card" data-ask="${repoUrl(repo, 'ask')}" data-path="${esc(file)}">
<label class="field">Ask about ${esc(about)}<textarea class="input" name="question" required placeholder="What does this change do? Is it safe to commit?"></textarea></label>
<div class="actions"><button type="submit" class="btn">Ask in Slack</button><span class="dim" style="font-size:12.5px">Starts a thread in the project's channel.</span></div></form>`;
}

export function codeDiffPage(
  ctx: DashboardContext,
  repo: CodeRepo,
  change: Change,
  diff: DiffView,
  canAsk: boolean,
): string {
  const body = diff.binary
    ? '<p class="empty">Binary file: no text diff.</p>'
    : diff.text.trim()
      ? diffHtml(diff.text)
      : '<p class="empty">No text changes (mode or whitespace only).</p>';
  const fileLink =
    change.state === 'deleted' ? '' : ` · <a href="${repoUrl(repo, 'file', change.path)}">View file</a>`;
  return layout(
    ctx,
    change.path.split('/').pop() ?? change.path,
    'Code',
    `${CSS}${pageHead(change.path.split('/').pop() ?? change.path, `${stateBadge(change)} ${esc(STATE_LABEL[change.state])}${change.staged ? ' (staged)' : ''} · ${counts(change)}${fileLink}`)}
${crumbs(repo, change.path, 'file')}${body}${
  diff.truncated
    ? `<p class="alert" style="margin-top:10px">Showing the first ${MAX_DIFF_LINES} lines.</p>`
    : ''
}${askBox(repo, change.path, canAsk, 'this change')}`,
    { script: SCRIPT },
  );
}

export function codeTreePage(
  ctx: DashboardContext,
  repo: CodeRepo,
  dir: string,
  tree: { dirs: string[]; files: string[] },
  changes: Change[],
): string {
  const prefix = dir ? `${dir}/` : '';
  const changed = new Map(changes.map((c) => [c.path, c]));
  const changedDirs = new Set(
    changes.flatMap((c) =>
      c.path
        .split('/')
        .slice(0, -1)
        .map((_, i, a) => a.slice(0, i + 1).join('/')),
    ),
  );
  const rows = [
    ...tree.dirs.map(
      (d) =>
        `<a class="row" href="${repoUrl(repo, 'files', prefix + d)}"><span aria-hidden="true">📁</span><span class="grow path">${esc(d)}</span>${
          changedDirs.has(prefix + d) ? '<span class="dot warn" title="Has changes"></span>' : ''
        }</a>`,
    ),
    ...tree.files.map((f) => {
      const c = changed.get(prefix + f);
      const href = c ? repoUrl(repo, 'diff', prefix + f) : repoUrl(repo, 'file', prefix + f);
      return `<a class="row" href="${href}">${c ? stateBadge(c) : '<span aria-hidden="true">📄</span>'}<span class="grow path">${esc(f)}</span>${
        c ? counts(c) : ''
      }</a>`;
    }),
  ].join('');
  return layout(
    ctx,
    dir || repo.title,
    'Code',
    `${CSS}${pageHead(dir ? (dir.split('/').pop() as string) : repo.title, `<a href="${repoUrl(repo)}">Uncommitted changes</a>`)}${searchBox(
      repoUrl(repo),
      '',
      `Search ${repo.title}`,
    )}${crumbs(repo, dir, 'dir')}<div class="todo">${rows || '<p class="empty">Empty folder.</p>'}</div>`,
  );
}

export function codeFilePage(
  ctx: DashboardContext,
  repo: CodeRepo,
  file: string,
  view: FileView,
  change: Change | undefined,
  canAsk: boolean,
): string {
  const size = view.size < 1024 ? `${view.size} B` : `${Math.round(view.size / 1024)} KB`;
  const body = view.tooBig
    ? `<p class="empty">Too big to show here (${size}, the limit is ${MAX_FILE_BYTES / 1024} KB).</p>`
    : view.binary
      ? `<p class="empty">Binary file (${size}).</p>`
      : `<div class="src">${(view.text ?? '')
          .replace(/\n$/, '')
          .split('\n')
          .map((l, i) => `<div id="L${i + 1}"><i>${i + 1}</i><code>${esc(l) || ' '}</code></div>`)
          .join('')}</div>`;
  const name = file.split('/').pop() ?? file;
  return layout(
    ctx,
    name,
    'Code',
    `${CSS}${pageHead(name, `${size}${change ? ` · ${stateBadge(change)} <a href="${repoUrl(repo, 'diff', file)}">See the change</a>` : ''}`)}${crumbs(
      repo,
      file,
      'file',
    )}${body}${askBox(repo, file, canAsk, 'this file')}`,
    { script: SCRIPT },
  );
}

/** Search results of one repo, or of every repo (from `/code`). */
export function codeSearchPage(
  ctx: DashboardContext,
  query: string,
  results: Array<{ repo: CodeRepo; result?: SearchResult; error?: string }>,
  scope?: CodeRepo,
): string {
  const one = ({ repo, result, error }: (typeof results)[number]) => {
    if (error) return `<div class="alert">${esc(error)}</div>`;
    if (!result || (!result.files.length && !result.matches.length))
      return '<p class="empty">No matches.</p>';
    const files = result.files
      .map(
        (f) =>
          `<a class="row" href="${repoUrl(repo, 'file', f)}"><span aria-hidden="true">📄</span><span class="grow path">${highlight(f, query)}</span></a>`,
      )
      .join('');
    const byFile = new Map<string, SearchResult['matches']>();
    for (const m of result.matches) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m]);
    const lines = [...byFile]
      .map(
        ([file, hits]) =>
          `<a class="hit-file" href="${repoUrl(repo, 'file', file)}">${pathHtml(file)}</a><div class="hits">${hits
            .map(
              (h) =>
                `<a class="hit" href="${repoUrl(repo, 'file', file)}#L${h.line}"><i>${h.line}</i><code>${highlight(h.text, query)}</code></a>`,
            )
            .join('')}</div>`,
      )
      .join('');
    return `${files ? `<div class="todo" style="margin-bottom:14px">${files}</div>` : ''}${lines}${
      result.more
        ? '<p class="dim" style="font-size:13px">More matches than shown: search for something longer.</p>'
        : ''
    }`;
  };
  const count = (r: SearchResult | undefined) => (r ? r.files.length + r.matches.length : 0);
  const body = scope
    ? one(results[0] ?? { repo: scope })
    : results
        .map((r) =>
          section(r.repo.title, one(r), {
            sub: r.result ? `${count(r.result)} match${count(r.result) === 1 ? '' : 'es'}` : undefined,
          }),
        )
        .join('');
  const title = scope ? `Search ${scope.title}` : 'Search';
  return layout(
    ctx,
    `${query} · ${title}`,
    'Code',
    `${CSS}${pageHead(title, scope ? `<a href="${repoUrl(scope)}">Uncommitted changes</a> · <a href="/code">All repos</a>` : '<a href="/code">All repos</a>')}${searchBox(
      scope ? repoUrl(scope) : '/code',
      query,
      'File names and text',
    )}${body}`,
  );
}
