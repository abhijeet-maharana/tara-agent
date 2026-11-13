import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { HostConfig, Project } from '../config/schema.js';
import { transcriptPath } from './transcript.js';

/**
 * What the Browsers page shows: which Chrome each project drives, and the sites its runs opened
 * there, read from the Claude Code transcripts (browser tool calls with a `url`). Meant for deciding
 * which Chrome profile (signed-in identity) each project needs.
 */

const run = promisify(execFile);

/** Browser MCP tools: `mcp__chrome__navigate_page`, `mcp__plugin_playwright_playwright__browser_navigate`, … */
const BROWSER_TOOL = /^mcp__.*(chrome|browser|playwright|puppeteer)/i;
const LOOPBACK = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0$)/;

/** Host → last visit (ms) in one transcript. */
export type Sites = Map<string, number>;

/** The sites a transcript's browser tool calls opened (http(s), not this machine). */
export function sitesIn(jsonl: string): Sites {
  const sites: Sites = new Map();
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"tool_use"') || !line.includes('mcp__')) continue;
    let e: { timestamp?: unknown; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0;
    for (const c of content as { type?: unknown; name?: unknown; input?: { url?: unknown } }[]) {
      if (c?.type !== 'tool_use' || typeof c.name !== 'string' || !BROWSER_TOOL.test(c.name)) continue;
      const host = hostOf(c.input?.url);
      if (host) sites.set(host, Math.max(sites.get(host) ?? 0, at));
    }
  }
  return sites;
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.hostname && !LOOPBACK.test(u.hostname) ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Where a browser MCP server connects to an existing Chrome, from its arguments. */
export function browserUrlOf(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  const list = args.filter((a): a is string => typeof a === 'string');
  for (let i = 0; i < list.length; i++) {
    const m = /^--(browserUrl|browser-url|cdp-endpoint|cdpEndpoint|wsEndpoint|ws-endpoint)(?:=(.+))?$/.exec(
      list[i] as string,
    );
    const short = list[i] === '-u';
    if (!m && !short) continue;
    const value = m?.[2] ?? list[i + 1];
    if (value) return value.replace(/\/$/, '');
  }
  return undefined;
}

/** How a project's chat sessions (its `.mcp.json`) reach a browser. */
export interface ProjectBrowser {
  /** The shared Chrome it connects to. */
  cdpUrl?: string;
  /** A browser MCP server that starts its own Chrome (no address given). */
  ownBrowser?: boolean;
  /** The `.mcp.json` server names that drive a browser. */
  servers: string[];
}

const BROWSER_SERVER = /chrome-devtools-mcp|playwright|puppeteer|browser/i;

export function projectBrowser(dir: string): ProjectBrowser {
  let servers: Record<string, { command?: unknown; args?: unknown }> = {};
  try {
    servers = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers ?? {};
  } catch {}
  const out: ProjectBrowser = { servers: [] };
  for (const [name, s] of Object.entries(servers)) {
    const words = [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((w) => typeof w === 'string');
    const url = browserUrlOf(s.args);
    if (!url && !words.some((w) => BROWSER_SERVER.test(w as string)) && !BROWSER_SERVER.test(name)) continue;
    out.servers.push(name);
    if (url) out.cdpUrl ??= url.replace(/^ws:/, 'http:');
    else out.ownBrowser = true;
  }
  return out;
}

/** A configured browser, checked now. */
export interface BrowserStatus {
  lock: string;
  cdpUrl: string;
  up: boolean;
  /** e.g. "Chrome/142.0.7444.59". */
  version?: string;
  tabs?: number;
}

export async function probeBrowser(b: HostConfig['browsers'][number]): Promise<BrowserStatus> {
  const get = async (p: string) =>
    (await fetch(`${b.cdpUrl}${p}`, { signal: AbortSignal.timeout(2_000) })).json() as Promise<unknown>;
  try {
    const [version, list] = await Promise.all([get('/json/version'), get('/json/list')]);
    return {
      lock: b.lock,
      cdpUrl: b.cdpUrl,
      up: true,
      version: (version as { Browser?: string }).Browser,
      tabs: Array.isArray(list)
        ? list.filter((t) => (t as { type?: string }).type === 'page').length
        : undefined,
    };
  } catch {
    return { lock: b.lock, cdpUrl: b.cdpUrl, up: false };
  }
}

interface Cached {
  mtimeMs: number;
  size: number;
  sites: Sites;
}

/**
 * Reads the projects' transcripts for browser sites, keeping each file's result until it changes.
 * Files the run user owns are read through sudo (`readAs`), as the Sessions page does.
 */
export class SiteScanner {
  private files = new Map<string, Cached>();
  private running?: Promise<void>;
  private lastScan = 0;

  constructor(
    private readonly opts: {
      readAs?: string;
      configDir?: string;
      /** Only transcripts written in this many days. */
      days?: number;
      now?: () => number;
      /** Seconds between rescans. */
      everySeconds?: number;
    } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** The folder Claude Code keeps a project's transcripts in. */
  folder(dir: string) {
    return path.dirname(transcriptPath(dir, 'x', this.opts.configDir));
  }

  /** Starts a scan unless one is running or one finished lately; resolves when it is done. */
  scan(dirs: string[]): Promise<void> {
    if (this.running) return this.running;
    if (this.now() - this.lastScan < (this.opts.everySeconds ?? 60) * 1000) return Promise.resolve();
    this.running = this.scanAll(dirs).finally(() => {
      this.lastScan = this.now();
      this.running = undefined;
    });
    return this.running;
  }

  get scanning() {
    return Boolean(this.running);
  }

  /** Session id → its sites, for one project's transcripts read so far. */
  sessions(dir: string): Map<string, Sites> {
    const folder = this.folder(dir) + path.sep;
    const since = this.now() - (this.opts.days ?? 30) * 86_400_000;
    const out = new Map<string, Sites>();
    for (const [file, c] of this.files)
      if (file.startsWith(folder) && c.mtimeMs >= since && c.sites.size)
        out.set(path.basename(file, '.jsonl'), c.sites);
    return out;
  }

  private async scanAll(dirs: string[]) {
    const since = this.now() - (this.opts.days ?? 30) * 86_400_000;
    for (const dir of dirs) {
      const folder = this.folder(dir);
      let names: string[];
      try {
        names = (await readdir(folder)).filter((n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(folder, name);
        try {
          const st = await stat(file);
          if (st.mtimeMs < since) continue;
          const known = this.files.get(file);
          if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) continue;
          this.files.set(file, { mtimeMs: st.mtimeMs, size: st.size, sites: sitesIn(await this.read(file)) });
        } catch {}
      }
    }
  }

  private async read(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EACCES' || !this.opts.readAs) throw err;
      const { stdout } = await run('sudo', ['-n', '-u', this.opts.readAs, '/bin/cat', '--', file], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
      });
      return stdout;
    }
  }
}

/** One login a project's browser needs, as written down in its `.tara/logins.json`. */
export const loginSchema = z.object({
  /** e.g. "Google", "Flipkart Seller Hub". */
  service: z.string().min(1),
  /** The account to sign in with, e.g. an email or a handle. */
  account: z.string().optional(),
  /** How it signs in or what it is for, e.g. "authuser=1; OTP mailed to business@…". */
  note: z.string().optional(),
  /** Hosts it covers; `*.example.com` covers example.com and its subdomains. */
  sites: z.array(z.string().min(1)).min(1),
});
export type Login = z.infer<typeof loginSchema>;

export const loginsFileSchema = z.object({
  logins: z.array(loginSchema).default([]),
  /** Hosts the runs open that need no login (so they aren't flagged as missing one). */
  public: z.array(z.string().min(1)).default([]),
});
export type LoginsFile = z.infer<typeof loginsFileSchema>;

export const LOGINS_FILE = '.tara/logins.json';

/** A project's logins file; undefined when it has none, `error` when it doesn't parse. */
export function loadLogins(
  dir: string,
): (LoginsFile & { error?: undefined }) | { error: string } | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(dir, LOGINS_FILE), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = loginsFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    return { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export const siteMatches = (pattern: string, host: string) => {
  const p = pattern.toLowerCase();
  return p.startsWith('*.') ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p;
};

/** Who opened a site or a login's sites. */
interface Use {
  /** Sessions that opened it. */
  sessions: number;
  /** Job id → sessions. */
  jobs: Map<string, number>;
  /** Chat sessions (no job). */
  chats: number;
  last: number;
}

/** One site a project's runs opened, with who opened it. */
export interface SiteUse extends Use {
  host: string;
  /** Other projects whose runs opened it too. */
  alsoIn: string[];
}

/** A written-down login, with who used its sites. */
export interface LoginUse extends Use, Login {
  /** Other projects that list the same service and account. */
  alsoIn: string[];
}

/** What one project needs from a browser. */
export interface ProjectNeeds {
  project: string;
  browser: ProjectBrowser;
  /** Its jobs by the browser they use (its `.mcp.json` Chrome, or a lock in an older jobs file), by browser lock name. */
  lockJobs: Map<string, { id: string; name: string }[]>;
  /** Sessions that opened any site. */
  sessions: number;
  sites: SiteUse[];
  /** From `.tara/logins.json`; undefined when the project has none. */
  logins?: LoginUse[];
  /** Why `.tara/logins.json` was not read. */
  loginsError?: string;
  /** Sites opened that no login and no `public` entry covers. */
  unlisted: SiteUse[];
}

const newUse = (): Use => ({ sessions: 0, jobs: new Map(), chats: 0, last: 0 });
const count = (use: Use, job: string | undefined, at: number) => {
  use.sessions++;
  if (job) use.jobs.set(job, (use.jobs.get(job) ?? 0) + 1);
  else use.chats++;
  use.last = Math.max(use.last, at);
};
const loginKey = (l: Login) => `${l.service.toLowerCase()}|${(l.account ?? '').toLowerCase()}`;

/**
 * Per project: each site its sessions opened, split by job and chat, and its written-down logins
 * with who used them. `jobOf` maps a session id to the job it ran (undefined: a chat or a session
 * tara-agent doesn't know).
 */
export function projectNeeds(
  projects: Project[],
  sessions: (p: Project) => Map<string, Sites>,
  jobOf: (sessionId: string) => string | undefined,
  jobs: (project: string) => { id: string; name: string; locks?: string[] }[],
  logins: (p: Project) => ReturnType<typeof loadLogins> = (p) => loadLogins(p.dir),
  browsers: { lock: string; cdpUrl: string }[] = [],
): ProjectNeeds[] {
  const sameUrl = (a: string, b: string) => {
    const norm = (u: string) =>
      u.replace(/^ws:/, 'http:').replace(/\/$/, '').replace('localhost', '127.0.0.1');
    return norm(a) === norm(b);
  };
  const out = projects.map((p): ProjectNeeds => {
    const file = logins(p);
    const listed = file && !('error' in file && file.error) ? (file as LoginsFile) : undefined;
    const loginUses: LoginUse[] | undefined = listed?.logins.map((l) => ({ ...l, ...newUse(), alsoIn: [] }));
    const bySite = new Map<string, SiteUse>();
    const all = sessions(p);
    for (const [sid, sites] of all) {
      const job = jobOf(sid);
      const used = new Map<LoginUse, number>();
      for (const [host, at] of sites) {
        const use = bySite.get(host) ?? { host, ...newUse(), alsoIn: [] };
        count(use, job, at);
        bySite.set(host, use);
        for (const l of loginUses ?? [])
          if (l.sites.some((pattern) => siteMatches(pattern, host)))
            used.set(l, Math.max(used.get(l) ?? 0, at));
      }
      for (const [l, at] of used) count(l, job, at);
    }
    const lockJobs = new Map<string, { id: string; name: string }[]>();
    const cdpUrl = projectBrowser(p.dir).cdpUrl;
    const own = cdpUrl ? browsers.find((b) => sameUrl(b.cdpUrl, cdpUrl))?.lock : undefined;
    for (const j of jobs(p.config.name))
      for (const lock of new Set([...(j.locks ?? []), ...(own ? [own] : [])]))
        lockJobs.set(lock, [...(lockJobs.get(lock) ?? []), j]);
    const sites = [...bySite.values()].sort((a, b) => b.sessions - a.sessions || b.last - a.last);
    const covered = [...(listed?.logins.flatMap((l) => l.sites) ?? []), ...(listed?.public ?? [])];
    return {
      project: p.config.name,
      browser: projectBrowser(p.dir),
      lockJobs,
      sessions: all.size,
      sites,
      logins: loginUses,
      loginsError: file && 'error' in file ? file.error : undefined,
      unlisted: sites.filter((s) => !covered.some((pattern) => siteMatches(pattern, s.host))),
    };
  });
  for (const n of out) {
    for (const s of n.sites)
      s.alsoIn = out.filter((o) => o !== n && o.sites.some((x) => x.host === s.host)).map((o) => o.project);
    // Only a written-down account can be the same login: two "Meta" logins with no account may differ.
    for (const l of (n.logins ?? []).filter((x) => x.account))
      l.alsoIn = out
        .filter((o) => o !== n && o.logins?.some((x) => loginKey(x) === loginKey(l)))
        .map((o) => o.project);
  }
  return out;
}
