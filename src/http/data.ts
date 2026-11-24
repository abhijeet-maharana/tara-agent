import type { Project } from '../config/schema.js';
import { type DashboardContext, esc, layout, pageHead } from './dashboard.js';

/**
 * The Data tab: each project's own database, read through the project's data API (`dataUrl` in
 * `.tara/config.json`, the kit's `DataApi`), never the file. Tables with their row counts, the newest
 * rows of one, and a read-only SQL box (the project's API runs it on a read-only connection).
 *
 * Editing: rows of tables agents may write (`agentWritable`) can be changed or added by a person whose
 * browser is unlocked (the approvals cookie). Only the fields that changed are sent, as the API's
 * PATCH; the `data` JSON column as a merge patch, so a key removed in the form is removed in the row.
 * Tables the project's service computes itself stay read-only here, as they are for agents.
 */

export interface DataTable {
  name: string;
  about: string;
  agentWritable: boolean;
  rows: number;
  columns: Array<{ name: string; type: string; key: boolean; required?: boolean }>;
}

export interface DataPageView {
  project: string;
  /** Projects that have a data API, for the switcher. */
  projects: Array<{ name: string; title: string }>;
  tables: DataTable[];
  table?: string;
  rows?: Array<Record<string, unknown>>;
  offset: number;
  pageSize: number;
  sql?: string;
  result?: { rows: Array<Record<string, unknown>>; truncated: boolean };
  error?: string;
  /** This browser may edit (unlocked, from another device). */
  canEdit?: boolean;
  /** A row was just saved (its key), for the notice. */
  saved?: string;
}

/** Projects with a data API, in config order. */
export const withData = (projects: Project[]) => projects.filter((p) => p.config.dataUrl);

/** GET or POST on a project's data API; the board wraps answers as `{ok, result}`, the kit doesn't. */
export async function dataCall(
  base: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetcher(`${base.replace(/\/+$/, '')}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json && typeof json === 'object' && 'result' in json ? json.result : json;
}

const MAX_CELL = 140;

function cell(v: unknown): string {
  if (v === null || v === undefined) return '<span class="nil">–</span>';
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const short = text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
  return text.length > MAX_CELL
    ? `<span title="${esc(text.slice(0, 2000))}">${esc(short)}</span>`
    : esc(short);
}

/** A row's key for the data API: its key columns' values, joined with '|'. */
export const rowKey = (table: DataTable, row: Record<string, unknown>) =>
  table.columns
    .filter((c) => c.key)
    .map((c) => String(row[c.name] ?? ''))
    .join('|');

function grid(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
  editHref?: (row: Record<string, unknown>) => string,
): string {
  if (!rows.length) return '<div class="empty">No rows.</div>';
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return `<div class="grid-wrap"><table class="grid"><thead><tr>${editHref ? '<th></th>' : ''}${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr>${editHref ? `<td><a href="${esc(editHref(r))}">Edit</a></td>` : ''}${cols.map((c) => `<td>${cell(r[c])}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

// ---------- editing ----------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** RFC 7396 merge patch from `before` to `after`: removed keys become null, nested objects recurse. */
export function mergePatch(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(before)) if (!(k in after)) out[k] = null;
  for (const [k, v] of Object.entries(after)) {
    const was = before[k];
    if (isObject(was) && isObject(v)) {
      const inner = mergePatch(was, v);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (JSON.stringify(was) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}

/** Columns the form never sends: kept by the API itself. */
const AUTO = new Set(['created_at', 'updated_at']);

/** A form value as the column's value: empty is null, numbers for numeric columns, JSON for `data`-like ones. */
export function parseField(col: DataTable['columns'][number], raw: string): unknown {
  const text = raw.replace(/\r\n/g, '\n');
  if (text.trim() === '') {
    if (col.required) throw new Error(`${col.name} is required`);
    return null;
  }
  const type = col.type.toUpperCase();
  if (/INT/.test(type) && /^-?\d+$/.test(text.trim())) return Number(text.trim());
  if (/REAL|FLOA|DOUB|NUM/.test(type) && Number.isFinite(Number(text.trim()))) return Number(text.trim());
  if (col.name === 'data' || col.name === 'value' || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      if (col.name === 'data' || col.name === 'value') throw new Error(`${col.name} is not valid JSON`);
    }
  }
  return text;
}

/**
 * What to send for a form: for an existing row, the fields that changed (a PATCH body, `data` as a merge
 * patch), or undefined when nothing did; for a new row, every filled field (a POST body).
 */
export function editBody(
  table: DataTable,
  form: Record<string, string>,
  current?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const col of table.columns) {
    if (AUTO.has(col.name) || !(col.name in form)) continue;
    if (current && col.key) continue;
    const value = parseField(col, form[col.name] ?? '');
    if (!current) {
      if (value !== null) out[col.name] = value;
      continue;
    }
    const was = current[col.name];
    if (isObject(was) && isObject(value)) {
      const patch = mergePatch(was, value);
      if (Object.keys(patch).length) out[col.name] = patch;
    } else if (JSON.stringify(was ?? null) !== JSON.stringify(value)) out[col.name] = value;
  }
  if (current && !Object.keys(out).length) return undefined;
  return out;
}

/** A value as the form shows it: JSON pretty-printed, null as empty. */
const formValue = (v: unknown) =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);

export interface EditView {
  project: string;
  table: DataTable;
  /** The row's key, or undefined for a new row. */
  key?: string;
  values: Record<string, unknown>;
  canEdit: boolean;
  error?: string;
}

export function editPage(ctx: DashboardContext, v: EditView): string {
  const back = `/data/${encodeURIComponent(v.project)}?table=${encodeURIComponent(v.table.name)}`;
  const title = v.key ? `Edit ${v.table.name} ${v.key}` : `Add a row to ${v.table.name}`;
  const field = (c: DataTable['columns'][number]) => {
    const fixed = AUTO.has(c.name) || (v.key !== undefined && c.key);
    const value = formValue(v.values[c.name]);
    const label = `${esc(c.name)} <small>${esc(c.type || 'any')}${c.key ? ' · key' : ''}${c.required ? ' · required' : ''}${fixed ? ' · fixed' : ''}</small>`;
    if (fixed) return `<div class="field">${label}<div class="fixed">${esc(value) || '–'}</div></div>`;
    const big = c.name === 'data' || c.name === 'value' || value.length > 80 || value.includes('\n');
    return big
      ? `<label class="field">${label}<textarea name="${esc(c.name)}" spellcheck="false" rows="${Math.min(20, Math.max(4, value.split('\n').length + 1))}">${esc(value)}</textarea></label>`
      : `<label class="field">${label}<input class="input" name="${esc(c.name)}" value="${esc(value)}"></label>`;
  };
  const body = !v.table.agentWritable
    ? `<div class="alert">${esc(v.table.name)} is written by the project's own service only, so it can't be edited here.</div>`
    : !v.canEdit
      ? '<div class="lock">This browser can look but not edit. <a href="/unlock">Unlock it</a> once with the approvals key (only from your own phone or computer).</div>'
      : `<form method="post" action="/data/${esc(encodeURIComponent(v.project))}/edit" class="card edit-form">
<input type="hidden" name="_table" value="${esc(v.table.name)}">
${v.key !== undefined ? `<input type="hidden" name="_key" value="${esc(v.key)}">` : ''}
${v.table.columns.map(field).join('\n')}
<div class="actions"><button type="submit" class="btn">${v.key ? 'Save changes' : 'Add the row'}</button><a class="btn ghost" href="${esc(back)}">Cancel</a></div></form>`;
  return layout(
    ctx,
    `Data · ${v.table.name}`,
    'Data',
    `${CSS}${pageHead(title, v.key ? 'Only the fields you change are saved. Agents see the change at once.' : 'Leave a field empty for no value.')}
<p><a href="${esc(back)}">← ${esc(v.table.name)}</a></p>
${v.error ? `<div class="alert">${esc(v.error)}</div>` : ''}${body}`,
  );
}

const CSS = `<style>
.data-layout{display:grid;grid-template-columns:minmax(200px,260px) 1fr;gap:16px;align-items:start}
@media (max-width:820px){.data-layout{grid-template-columns:1fr}}
.tables{display:grid;gap:6px}
.tables a{display:block;padding:8px 10px;border:1px solid var(--border);border-radius:8px;color:inherit;text-decoration:none}
.tables a.on{border-color:var(--accent);background:var(--surface-2,transparent)}
.tables small{display:block;color:var(--muted);margin-top:2px}
.grid-wrap{overflow:auto;max-height:70vh;border:1px solid var(--border);border-radius:8px}
table.grid{border-collapse:collapse;font-size:13px;width:max-content;min-width:100%}
table.grid th,table.grid td{padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}
table.grid th{position:sticky;top:0;background:var(--bg);z-index:1}
.nil{color:var(--muted)}
.sqlbox{display:grid;gap:8px;margin-top:16px}
.sqlbox textarea{font:13px/1.4 ui-monospace,monospace;min-height:70px;width:100%;box-sizing:border-box}
.pager{display:flex;gap:8px;align-items:center;margin:8px 0}
.edit-form{display:grid;gap:12px;max-width:760px}
.edit-form textarea{font:13px/1.4 ui-monospace,monospace;width:100%;box-sizing:border-box}
.edit-form small{color:var(--muted);font-weight:400}
.fixed{padding:6px 0;color:var(--muted);font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}
.notice{padding:8px 12px;border-radius:8px;border:1px solid var(--green,#3a3);margin:8px 0}
</style>`;

export function dataPage(ctx: DashboardContext, v: DataPageView): string {
  const q = (p: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams(
      Object.entries(p)
        .filter(([, x]) => x !== undefined && x !== '')
        .map(([k, x]): [string, string] => [k, String(x)]),
    );
    return `/data/${encodeURIComponent(v.project)}${s.size ? `?${s}` : ''}`;
  };
  const switcher =
    v.projects.length > 1
      ? `<div class="toolbar"><div class="chips">${v.projects
          .map(
            (p) =>
              `<a class="chip${p.name === v.project ? ' on' : ''}" href="/data/${encodeURIComponent(p.name)}">${esc(p.title)}</a>`,
          )
          .join('')}</div></div>`
      : '';
  const list = v.tables
    .map(
      (t) =>
        `<a href="${q({ table: t.name })}" class="${t.name === v.table ? 'on' : ''}"><b>${esc(t.name)}</b> <span class="tag dim">${t.rows.toLocaleString('en')}</span>${
          t.agentWritable ? ' <span class="tag">agents write</span>' : ''
        }<small>${esc(t.about)}</small></a>`,
    )
    .join('');
  const current = v.tables.find((t) => t.name === v.table);
  const rowsHtml =
    current && v.rows
      ? `<div class="sec-head"><h2>${esc(current.name)}</h2><span>${current.rows.toLocaleString('en')} rows · newest first</span></div>
<div class="pager">${v.offset > 0 ? `<a class="btn ghost" href="${q({ table: current.name, offset: Math.max(0, v.offset - v.pageSize) })}">← Newer</a>` : ''}<span>${
          v.offset + 1
        }–${v.offset + v.rows.length}</span>${
          v.offset + v.rows.length < current.rows
            ? `<a class="btn ghost" href="${q({ table: current.name, offset: v.offset + v.pageSize })}">Older →</a>`
            : ''
        }${
          v.canEdit && current.agentWritable
            ? `<a class="btn ghost" href="/data/${esc(encodeURIComponent(v.project))}/edit?table=${esc(encodeURIComponent(current.name))}">Add a row</a>`
            : ''
        }</div>${grid(
          v.rows,
          current.columns.map((c) => c.name),
          v.canEdit && current.agentWritable
            ? (row) =>
                `/data/${encodeURIComponent(v.project)}/edit?table=${encodeURIComponent(current.name)}&key=${encodeURIComponent(rowKey(current, row))}`
            : undefined,
        )}`
      : '<div class="empty">Pick a table.</div>';
  const sqlHtml = `<form class="sqlbox" method="get" action="/data/${esc(encodeURIComponent(v.project))}">
${v.table ? `<input type="hidden" name="table" value="${esc(v.table)}">` : ''}
<label class="field">Read-only SQL (SELECT or WITH, one statement, up to 1,000 rows)<textarea name="sql" spellcheck="false" placeholder="select status, count(*) from fulltime_leads group by status">${esc(v.sql ?? '')}</textarea></label>
<div class="actions"><button type="submit" class="btn">Run</button></div></form>
${v.error ? `<div class="alert">${esc(v.error)}</div>` : ''}
${v.result ? `<div class="sec-head"><h2>Result</h2><span>${v.result.rows.length}${v.result.truncated ? '+ (first 1,000)' : ''} rows</span></div>${grid(v.result.rows)}` : ''}`;
  return layout(
    ctx,
    'Data',
    'Data',
    `${CSS}${pageHead('Data', "Each project's own database, read through its data API. Agents and scripts use the same API.")}
${switcher}
${v.saved ? `<div class="notice">Saved ${esc(v.saved)}.</div>` : ''}
<div class="data-layout"><div class="tables">${list || '<div class="empty">No tables.</div>'}</div><div>${sqlHtml}${v.result ? '' : rowsHtml}</div></div>`,
  );
}

export type SaveResult =
  | { ok: true; key: string; changed: boolean }
  | { ok: false; error: string; table?: DataTable; key?: string; values: Record<string, unknown> };

/**
 * Saves the edit form (`_table`, `_key` for an existing row, a field per column) through the project's
 * data API: a PATCH with what changed, or a POST for a new row. The API enforces its own table rules.
 */
export async function saveEdit(
  base: string,
  form: URLSearchParams,
  fetcher: typeof fetch = fetch,
): Promise<SaveResult> {
  const name = form.get('_table') ?? '';
  const key = form.get('_key') ?? undefined;
  const fields: Record<string, string> = {};
  for (const [k, v] of form) if (!k.startsWith('_')) fields[k] = v;
  let table: DataTable | undefined;
  try {
    table = ((await dataCall(base, '/tables', {}, fetcher)) as DataTable[]).find((t) => t.name === name);
    if (!table) return { ok: false, error: `No table "${name}"`, values: fields };
    if (!table.agentWritable)
      return {
        ok: false,
        error: `${name} is written by the project's own service only`,
        table,
        key,
        values: fields,
      };
    const path = `/${encodeURIComponent(name)}`;
    if (key !== undefined) {
      const current = (await dataCall(base, `${path}/${encodeURIComponent(key)}`, {}, fetcher)) as Record<
        string,
        unknown
      >;
      const body = editBody(table, fields, current);
      if (!body) return { ok: true, key, changed: false };
      await dataCall(base, `${path}/${encodeURIComponent(key)}`, { method: 'PATCH', body }, fetcher);
      return { ok: true, key, changed: true };
    }
    const row = (await dataCall(
      base,
      path,
      { method: 'POST', body: editBody(table, fields) },
      fetcher,
    )) as Record<string, unknown>;
    return { ok: true, key: rowKey(table, row), changed: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message, table, key, values: fields };
  }
}
