import { readFileSync } from 'node:fs';
import type { StatementSync } from 'node:sqlite';
import type { ProjectDb } from './db.js';

/**
 * The data API of a project's database, the same for every project, without a web framework: the
 * service routes `<base>/*` (e.g. `/api/db`) to `DataApi.handle` and sends back what it returns. The
 * Data tab on tara-agent's dashboard, agents and scripts (`jdb`) all use it.
 *
 *   GET   <base>/tables                      tables with columns and row counts
 *   POST  <base>/sql      {sql, params?}     read-only SELECT/WITH (read-only connection)
 *   GET   <base>/<table>?limit=&offset=      rows, newest first when the table has updated_at
 *   GET   <base>/<table>/<key>               one row by primary key (a composite key joined with '|')
 *   POST  <base>/<table>  {row}              insert or update by primary key   (agent-writable tables only)
 *   PATCH <base>/<table>/<key> {fields}      update some fields; a `data` object is merged (agent-writable only)
 *
 * Only tables in the rules are exposed (`<repo>/.tara/db/tables.json`). `agentWritable: false`: only the
 * service's own code writes it. The service decides who may call the API at all (e.g. tailnet only).
 */

export interface TableRule {
  agentWritable: boolean;
  about: string;
}

export interface DataRequest {
  method: string;
  /** The path after the API's base, e.g. `/tables` or `/leads/123`. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface DataResponse {
  status: number;
  body: unknown;
}

export class DataError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `{ "<table>": { "agentWritable": bool, "about": "…" } }` from a tables.json file. */
export function loadTables(file: string): Record<string, TableRule> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<TableRule>>;
  const out: Record<string, TableRule> = {};
  for (const [name, r] of Object.entries(raw)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`${file}: "${name}" is not a plain table name`);
    out[name] = { agentWritable: r.agentWritable === true, about: String(r.about ?? '') };
  }
  return out;
}

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

const MAX_ROWS = 1000;
const SQL_MAX_LENGTH = 10_000;
/** Words that could reach outside the database file or change settings, even on a read-only connection. */
const SQL_BLOCKED = /\b(attach|detach|pragma|load_extension|vacuum)\b/i;
const nowIso = () => new Date().toISOString();

/** A row for JSON: `data`/`value` JSON text is parsed, so callers get objects back; bigints become numbers. */
function outRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && (k === 'data' || k === 'value') && /^[[{"]/.test(v)) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {}
    }
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

function inValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

export class DataApi {
  constructor(
    private readonly store: ProjectDb,
    private readonly tables: Record<string, TableRule>,
  ) {}

  /** Never throws: errors come back as `{status, body: {error}}`. */
  handle(req: DataRequest): DataResponse {
    try {
      return { status: 200, body: this.route(req) };
    } catch (err) {
      if (err instanceof DataError) return { status: err.status, body: { error: err.message } };
      return { status: 500, body: { error: (err as Error).message } };
    }
  }

  private route({ method, path, query = {}, body }: DataRequest): unknown {
    const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodeURIComponent);
    const m = method.toUpperCase();
    if (parts.length === 1 && parts[0] === 'tables' && m === 'GET') return this.listTables();
    if (parts.length === 1 && parts[0] === 'sql' && m === 'POST') {
      const b = (body ?? {}) as { sql?: unknown; params?: unknown };
      return this.sql(b.sql, b.params ?? []);
    }
    if (parts.length === 1 && m === 'GET') return this.rows(parts[0] as string, query);
    if (parts.length === 1 && m === 'POST') return this.upsert(parts[0] as string, body);
    if (parts.length === 2 && m === 'GET') return this.one(parts[0] as string, parts[1] as string);
    if (parts.length === 2 && m === 'PATCH') return this.patch(parts[0] as string, parts[1] as string, body);
    throw new DataError(404, `No ${m} ${path}`);
  }

  listTables() {
    const db = this.store.db();
    return Object.entries(this.tables).map(([name, rule]) => ({
      name,
      about: rule.about,
      agentWritable: rule.agentWritable,
      rows: Number((db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n),
      columns: this.columns(name).map((c) => ({
        name: c.name,
        type: c.type,
        key: c.pk > 0,
        required: Boolean(c.notnull),
      })),
    }));
  }

  /** One read-only query: SELECT or WITH, one statement, at most 1000 rows. */
  sql(sql: unknown, params: unknown = []) {
    const text = String(sql ?? '')
      .trim()
      .replace(/;\s*$/, '');
    if (!text) throw new DataError(400, 'sql is required');
    if (text.length > SQL_MAX_LENGTH) throw new DataError(400, `sql is longer than ${SQL_MAX_LENGTH} characters`);
    if (!/^(select|with)\b/i.test(text))
      throw new DataError(400, 'Only SELECT or WITH queries (the API is read-only; use the table endpoints to write)');
    if (text.includes(';')) throw new DataError(400, 'One statement only');
    if (SQL_BLOCKED.test(text)) throw new DataError(400, 'ATTACH, PRAGMA, VACUUM and load_extension are not allowed');
    if (!Array.isArray(params)) throw new DataError(400, 'params must be an array');
    let stmt: StatementSync;
    try {
      stmt = this.store.readOnly().prepare(text);
    } catch (err) {
      throw new DataError(400, (err as Error).message);
    }
    const rows: Record<string, unknown>[] = [];
    try {
      for (const row of stmt.iterate(...params.map(inValue))) {
        if (rows.length >= MAX_ROWS) break;
        rows.push(outRow(row as Record<string, unknown>));
      }
    } catch (err) {
      throw new DataError(400, (err as Error).message);
    }
    return { rows, truncated: rows.length >= MAX_ROWS };
  }

  private table(name: string): { rule: TableRule; columns: Column[] } {
    const rule = this.tables[name];
    if (!rule) throw new DataError(404, `Unknown table "${name}". GET tables lists them.`);
    return { rule, columns: this.columns(name) };
  }

  private columns(name: string): Column[] {
    return this.store.db().prepare(`PRAGMA table_info(${name})`).all() as unknown as Column[];
  }

  private keyWhere(columns: Column[], key: string): { sql: string; values: string[] } {
    const keys = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const parts = keys.length > 1 ? key.split('|') : [key];
    if (!keys.length || parts.length !== keys.length)
      throw new DataError(400, `Key must be ${keys.map((k) => k.name).join('|') || 'the rowid'}`);
    return { sql: keys.map((k) => `${k.name} = ?`).join(' AND '), values: parts };
  }

  private fields(columns: Column[], body: unknown): Record<string, string | number | null> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new DataError(400, 'Body must be a JSON object of column: value');
    const known = new Set(columns.map((c) => c.name));
    const out: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!known.has(k)) throw new DataError(400, `Unknown column "${k}"`);
      if (k === 'created_at' || k === 'updated_at') continue;
      out[k] = inValue(v);
    }
    return out;
  }

  private writable(name: string, rule: TableRule): void {
    if (!rule.agentWritable) throw new DataError(403, `${name} is written by the project's service only`);
  }

  rows(name: string, query: Record<string, string | undefined>) {
    const { columns } = this.table(name);
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? '100', 10) || 100, 1), MAX_ROWS);
    const offset = Math.max(Number.parseInt(query.offset ?? '0', 10) || 0, 0);
    const order = columns.some((c) => c.name === 'updated_at')
      ? 'ORDER BY updated_at DESC, rowid DESC'
      : 'ORDER BY rowid DESC';
    const rows = this.store.db().prepare(`SELECT * FROM ${name} ${order} LIMIT ? OFFSET ?`).all(limit, offset);
    return { rows: (rows as Record<string, unknown>[]).map(outRow), limit, offset };
  }

  one(name: string, key: string) {
    const { columns } = this.table(name);
    const where = this.keyWhere(columns, key);
    const row = this.store.db().prepare(`SELECT * FROM ${name} WHERE ${where.sql}`).get(...where.values);
    if (!row) throw new DataError(404, `No ${name} row ${key}`);
    return outRow(row as Record<string, unknown>);
  }

  upsert(name: string, body: unknown) {
    const { rule, columns } = this.table(name);
    this.writable(name, rule);
    const fields = this.fields(columns, body);
    const has = (c: string) => columns.some((col) => col.name === c);
    const at = nowIso();
    if (has('updated_at')) fields.updated_at = at;
    if (has('created_at')) fields.created_at = at;
    const keys = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((k) => k.name);
    if (!keys.length || !keys.every((k) => fields[k] !== undefined && fields[k] !== null))
      throw new DataError(400, `Row needs its key: ${keys.join(', ')}`);
    const cols = Object.keys(fields);
    const updates = cols.filter((c) => !keys.includes(c) && c !== 'created_at').map((c) => `${c} = excluded.${c}`);
    const sql = `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
      ON CONFLICT(${keys.join(', ')}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`;
    this.store
      .db()
      .prepare(sql)
      .run(...cols.map((c) => fields[c] ?? null));
    return this.one(name, keys.map((k) => String(fields[k])).join('|'));
  }

  patch(name: string, key: string, body: unknown) {
    const { rule, columns } = this.table(name);
    this.writable(name, rule);
    const fields = this.fields(columns, body);
    for (const c of columns) if (c.pk > 0) delete fields[c.name];
    if (columns.some((c) => c.name === 'updated_at')) fields.updated_at = nowIso();
    const cols = Object.keys(fields);
    if (!cols.length) throw new DataError(400, 'Nothing to change');
    const where = this.keyWhere(columns, key);
    // A JSON object for `data` is merged into the stored one (RFC 7396: a null value removes that field).
    const data = (body as Record<string, unknown>).data;
    const mergeData = cols.includes('data') && data && typeof data === 'object' && !Array.isArray(data);
    const set = cols.map((c) => (c === 'data' && mergeData ? `data = json_patch(coalesce(data, '{}'), ?)` : `${c} = ?`));
    const res = this.store
      .db()
      .prepare(`UPDATE ${name} SET ${set.join(', ')} WHERE ${where.sql}`)
      .run(...cols.map((c) => fields[c] ?? null), ...where.values);
    if (!res.changes) throw new DataError(404, `No ${name} row ${key}`);
    return this.one(name, key);
  }
}
