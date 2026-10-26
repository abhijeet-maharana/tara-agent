import { execFile } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HostConfig, Project } from '../config/schema.js';

/**
 * Read-only view of a repo for the Code page: its uncommitted changes, file list, diffs and files.
 *
 * Git never writes to the repo or its git data: it runs with GIT_OPTIONAL_LOCKS=0 and a private copy
 * of the index (in tara-agent's state folder), which it is free to refresh. That also lets the git
 * data be a one-way copy from another machine (`gitDir`): the copied index carries that machine's
 * file timestamps, so refreshing the private copy once keeps later checks fast.
 *
 * Only files git lists (tracked, or untracked and not ignored) can be shown, so ignored secrets
 * (sessions, keys, `.env`) never are; `exclude` hides tracked ones too.
 */

const exec = promisify(execFile);

export interface CodeRepo {
  /** In URLs: the project name, else the folder name. */
  name: string;
  title: string;
  dir: string;
  gitDir: string;
  /** Project whose Slack channel "Ask" posts to. */
  askIn?: string;
}

export type ChangeState = 'modified' | 'added' | 'deleted' | 'untracked' | 'conflict';

export interface Change {
  path: string;
  state: ChangeState;
  /** Part of the change is staged. */
  staged: boolean;
  added: number;
  removed: number;
  binary?: boolean;
}

export interface RepoStatus {
  branch?: string;
  head?: { sha: string; subject: string; at: number };
  changes: Change[];
  /** Why the repo can't be read (no git data, git failed). */
  error?: string;
}

export interface FileView {
  text?: string;
  binary?: boolean;
  /** Over MAX_FILE_BYTES: not shown. */
  tooBig?: boolean;
  size: number;
}

export interface DiffView {
  /** Unified diff text (a new file is shown as all added lines). */
  text: string;
  truncated: boolean;
  binary: boolean;
}

export interface SearchResult {
  /** Files whose path contains the text. */
  files: string[];
  /** Lines that contain it, a few per file. */
  matches: Array<{ path: string; line: number; text: string }>;
  /** More matched than is shown. */
  more: boolean;
}

export class CodeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_DIFF_LINES = 2_000;
/** Untracked files whose lines are counted for the +N badge. */
const MAX_COUNTED = 300;
const CACHE_MS = 15_000;
export const MIN_QUERY = 2;
const MAX_NAME_HITS = 50;
const MAX_LINE_HITS = 200;
const LINES_PER_FILE = 5;
/** Characters of a matching line shown around the match. */
const SNIPPET = 160;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A file's first 8 KB has a NUL byte. */
const looksBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0);

/** Lines in a text, the way a diff counts them. */
const lineCount = (text: string) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

/** `git grep -n --null` → path, line number and text per match. */
export function parseGrep(out: string): Array<{ path: string; line: number; text: string }> {
  return out.split('\n').flatMap((entry) => {
    const [p, n, ...rest] = entry.split('\0');
    return p && n && /^\d+$/.test(n) ? [{ path: p, line: Number(n), text: rest.join('\0') }] : [];
  });
}

/** A long line cut down to the part around `query`. */
export function snippet(text: string, query: string): string {
  const line = text.trim();
  if (line.length <= SNIPPET) return line;
  const at = Math.max(0, line.toLowerCase().indexOf(query.toLowerCase()) - SNIPPET / 3);
  return `${at ? '…' : ''}${line.slice(at, at + SNIPPET)}${at + SNIPPET < line.length ? '…' : ''}`;
}

function stateOf(xy: string): ChangeState {
  const [x = ' ', y = ' '] = xy;
  if (xy === '??') return 'untracked';
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'conflict';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  return 'modified';
}

/** `git status --porcelain -z --no-renames` → path and XY code per entry. */
export function parseStatus(out: string): Array<{ path: string; xy: string }> {
  return out
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => ({ xy: e.slice(0, 2), path: e.slice(3) }));
}

/** `git diff --numstat -z --no-renames` → lines added and removed per path (`-` for binary). */
export function parseNumstat(out: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const map = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const entry of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (!m) continue;
    const binary = m[1] === '-';
    map.set(m[3] as string, { added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

/** A path from a request: relative, inside the repo, never into `.git`. */
export function cleanPath(input: string): string {
  const p = path.posix.normalize(input.replace(/\\/g, '/')).replace(/\/$/, '');
  if (!p || p === '.') return '';
  if (input.includes('\0') || p.startsWith('/') || p === '..' || p.startsWith('../'))
    throw new CodeError(400, 'Not a path inside the repo');
  if (p.split('/').includes('.git')) throw new CodeError(400, 'Not a path inside the repo');
  return p;
}

/** A result reused for CACHE_MS; a failed load isn't kept. */
class Cached<T> {
  private hit?: { at: number; value: Promise<T> };

  get(now: number, load: () => Promise<T>): Promise<T> {
    if (this.hit && now - this.hit.at < CACHE_MS) return this.hit.value;
    const hit = { at: now, value: load() };
    this.hit = hit;
    hit.value.catch(() => {
      if (this.hit === hit) this.hit = undefined;
    });
    return hit.value;
  }

  clear(): void {
    this.hit = undefined;
  }
}

export class RepoReader {
  private readonly indexFile: string;
  private indexKey = '';
  /** One git index refresh at a time (it takes a lock on the private index). */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly statusCache = new Cached<RepoStatus>();
  private readonly filesCache = new Cached<string[]>();

  constructor(
    readonly repo: CodeRepo,
    private readonly opts: { exclude: string[]; stateDir: string; now?: () => number },
  ) {
    this.indexFile = path.join(opts.stateDir, 'code', `${repo.name}.index`);
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private get pathspec(): string[] {
    return ['--', '.', ...this.opts.exclude.map((g) => `:(exclude,glob)${g}`)];
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await exec(
      'git',
      [
        '-c',
        'safe.directory=*',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.quotePath=false',
        '--git-dir',
        this.repo.gitDir,
        '--work-tree',
        this.repo.dir,
        ...args,
      ],
      {
        cwd: this.repo.dir,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_INDEX_FILE: this.indexFile, LC_ALL: 'C' },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    return stdout;
  }

  /** Copies the repo's index when it changed (a commit, a stage) and refreshes the copy. */
  private refreshIndex(): Promise<void> {
    const run = this.chain.then(async () => {
      const source = path.join(this.repo.gitDir, 'index');
      let key = 'none';
      try {
        const st = statSync(source);
        key = `${st.size}:${st.mtimeMs}`;
      } catch {}
      if (key !== this.indexKey) {
        mkdirSync(path.dirname(this.indexFile), { recursive: true });
        if (key !== 'none') copyFileSync(source, this.indexFile);
        this.indexKey = key;
      }
      // Exits non-zero when files changed; that's what status reports next.
      await this.git(['update-index', '-q', '--refresh']).catch(() => {});
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Forget cached results (tests, or after the repo is known to have changed). */
  reset(): void {
    this.statusCache.clear();
    this.filesCache.clear();
  }

  private branch(): string | undefined {
    try {
      const head = readFileSync(path.join(this.repo.gitDir, 'HEAD'), 'utf8').trim();
      return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
    } catch {
      return undefined;
    }
  }

  status(): Promise<RepoStatus> {
    return this.statusCache.get(this.now(), async () => {
      try {
        statSync(path.join(this.repo.gitDir, 'HEAD'));
      } catch {
        return { changes: [], error: `No git data at ${this.repo.gitDir}` };
      }
      try {
        await this.refreshIndex();
        const log = await this.git(['log', '-1', '--format=%H%x00%s%x00%ct', 'HEAD']).catch(() => '');
        const [sha, subject, at] = log.trim().split('\0');
        const head = sha ? { sha, subject: subject ?? '', at: Number(at) * 1000 } : undefined;
        const [statusOut, numstatOut] = await Promise.all([
          this.git([
            'status',
            '--porcelain',
            '-z',
            '--no-renames',
            '--untracked-files=all',
            ...this.pathspec,
          ]),
          this.git([
            'diff',
            head ? 'HEAD' : EMPTY_TREE,
            '--numstat',
            '-z',
            '--no-renames',
            '--no-ext-diff',
            '--no-textconv',
            ...this.pathspec,
          ]),
        ]);
        const counts = parseNumstat(numstatOut);
        let counted = 0;
        const changes = parseStatus(statusOut).map(({ path: p, xy }): Change => {
          const state = stateOf(xy);
          const staged = xy[0] !== ' ' && xy[0] !== '?';
          if (state === 'untracked') {
            const file = counted++ < MAX_COUNTED ? this.peek(p) : undefined;
            return { path: p, state, staged, added: file?.lines ?? 0, removed: 0, binary: file?.binary };
          }
          const n = counts.get(p);
          return {
            path: p,
            state,
            staged,
            added: n?.added ?? 0,
            removed: n?.removed ?? 0,
            binary: n?.binary,
          };
        });
        changes.sort((a, b) => a.path.localeCompare(b.path));
        return { branch: this.branch(), head, changes };
      } catch (err) {
        return { branch: this.branch(), changes: [], error: (err as Error).message.split('\n')[0] };
      }
    });
  }

  /** Lines (or binary) of an untracked file, for its +N badge. */
  private peek(rel: string): { lines: number; binary: boolean } | undefined {
    try {
      const abs = path.join(this.repo.dir, rel);
      if (statSync(abs).size > MAX_FILE_BYTES) return undefined;
      const buf = readFileSync(abs);
      return looksBinary(buf)
        ? { lines: 0, binary: true }
        : { lines: lineCount(buf.toString('utf8')), binary: false };
    } catch {
      return undefined;
    }
  }

  /** Every file git knows here: tracked, and untracked but not ignored. */
  files(): Promise<string[]> {
    return this.filesCache.get(this.now(), async () => {
      await this.refreshIndex();
      const out = await this.git([
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        ...this.pathspec,
      ]);
      return [...new Set(out.split('\0').filter(Boolean))].sort();
    });
  }

  /** Files whose path contains `query`, and lines of text files that do (case-insensitive, literal). */
  async search(query: string): Promise<SearchResult> {
    const q = query.trim();
    if (q.length < MIN_QUERY) throw new CodeError(400, `Search for at least ${MIN_QUERY} characters`);
    const needle = q.toLowerCase();
    const named = (await this.files()).filter((f) => f.toLowerCase().includes(needle));
    const out = await this.git([
      'grep',
      '-n',
      '-I',
      '-i',
      '-F',
      '--null',
      '--untracked',
      `--max-count=${LINES_PER_FILE}`,
      '-e',
      q,
      ...this.pathspec,
    ]).catch((err: { code?: number }) => {
      if (err.code === 1) return ''; // nothing matched
      throw err;
    });
    const matches = parseGrep(out);
    return {
      files: named.slice(0, MAX_NAME_HITS),
      matches: matches.slice(0, MAX_LINE_HITS).map((m) => ({ ...m, text: snippet(m.text, q) })),
      more: named.length > MAX_NAME_HITS || matches.length > MAX_LINE_HITS,
    };
  }

  /** Folders and files directly inside `dir` ('' is the repo root). */
  async tree(dir: string): Promise<{ dirs: string[]; files: string[] }> {
    const clean = cleanPath(dir);
    const prefix = clean ? `${clean}/` : '';
    const dirs = new Set<string>();
    const files: string[] = [];
    for (const f of await this.files()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push(rest);
      else dirs.add(rest.slice(0, slash));
    }
    if (clean && !dirs.size && !files.length) throw new CodeError(404, 'No such folder');
    return { dirs: [...dirs].sort(), files };
  }

  /** A file's content, when git lists it and it really is inside the repo. */
  async read(file: string): Promise<FileView> {
    const rel = cleanPath(file);
    if (!rel || !(await this.files()).includes(rel)) throw new CodeError(404, 'No such file');
    const abs = this.inside(rel);
    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) throw new CodeError(404, 'Not a file');
      size = st.size;
    } catch (err) {
      if (err instanceof CodeError) throw err;
      throw new CodeError(404, 'This file is deleted in the working tree');
    }
    if (size > MAX_FILE_BYTES) return { size, tooBig: true };
    const buf = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    const fd = openSync(abs, 'r');
    try {
      readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    return looksBinary(buf) ? { size, binary: true } : { size, text: buf.toString('utf8') };
  }

  /** The uncommitted change of one file, against the last commit. */
  async diff(file: string): Promise<DiffView> {
    const rel = cleanPath(file);
    const change = (await this.status()).changes.find((c) => c.path === rel);
    if (!rel || !change) throw new CodeError(404, 'No uncommitted change in this file');
    if (change.state === 'untracked') {
      const view = await this.read(rel);
      if (view.binary || view.tooBig)
        return { text: '', truncated: Boolean(view.tooBig), binary: Boolean(view.binary) };
      const lines = (view.text ?? '').replace(/\n$/, '').split('\n');
      return this.cut(
        `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`,
        change.binary,
      );
    }
    const head = (await this.status()).head;
    const out = await this.git([
      'diff',
      head ? 'HEAD' : EMPTY_TREE,
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      '--',
      `:(literal)${rel}`,
    ]);
    return this.cut(out, change.binary);
  }

  private cut(text: string, binary?: boolean): DiffView {
    const lines = text.split('\n');
    const truncated = lines.length > MAX_DIFF_LINES;
    return {
      text: truncated ? lines.slice(0, MAX_DIFF_LINES).join('\n') : text,
      truncated,
      binary: Boolean(binary),
    };
  }

  /** The absolute path, refusing anything a symlink takes outside the repo. */
  private inside(rel: string): string {
    const abs = path.join(this.repo.dir, rel);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return abs; // deleted: nothing to read through it
    }
    const root = realpathSync(this.repo.dir);
    if (real !== root && !real.startsWith(`${root}${path.sep}`))
      throw new CodeError(403, 'Points outside the repo');
    return real;
  }
}

/** A reader per repo of the host's `code` block (the projects when it lists none). */
export function codeReaders(host: HostConfig, projects: Project[]): RepoReader[] {
  if (!host.code.enabled) return [];
  type RepoConfig = NonNullable<HostConfig['code']['repos']>[number];
  return (host.code.repos ?? projects.map((p): RepoConfig => ({ path: p.dir }))).map((r) => {
    const project = projects.find((p) => p.dir === r.path);
    const folder = path.basename(r.path);
    return new RepoReader(
      {
        name: project?.config.name ?? folder,
        title: r.title ?? project?.config.title ?? project?.config.name ?? folder,
        dir: r.path,
        gitDir: r.gitDir ?? path.join(r.path, '.git'),
        askIn: r.askIn ?? project?.config.name,
      },
      { exclude: host.code.exclude, stateDir: host.stateDir as string },
    );
  });
}
