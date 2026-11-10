import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GithubRepo } from '../config/schema.js';
import type { RunAs } from '../runner/as-user.js';
import type { Logger } from '../sessions/manager.js';

/**
 * Pull requests from a run (host `github`). The GitHub token stays in tara-agent: a run never sees
 * it, so it can't push to the base branch itself (a private repo on GitHub Free has no branch
 * protection). A run asks for a workspace, a fresh copy of the base branch (or of its open PR's
 * branch) outside the project folder, changes files there, and asks for the PR. tara-agent then
 * commits the workspace with its own git data, pushes only to `<agent>/<name>` branches, never
 * force-pushes, never merges, and refuses secrets and CI files. See docs/security.md "Pull requests".
 */

export class PullRequestError extends Error {}

export interface PullRequestsDeps {
  repos: GithubRepo[];
  token: string;
  /** Branches are `<agent name>/<name>`, e.g. jarvis/fix-otp-retry. */
  agentName: string;
  /** Where the git data lives (one bare repo per project), unreadable by the run user. */
  stateDir: string;
  log: Logger;
  /** The run user (host `claude.runAs`), whose files in a workspace tara-agent can't delete itself. */
  runAs?: RunAs;
  /** The run user's group, which must write in the workspace. */
  shareGid?: number;
  /** Parent folder of the workspaces. Defaults to the temp directory. */
  workRoot?: string;
  /** Tests: where to fetch and push, instead of github.com. */
  remoteUrl?: (repo: string) => string;
  fetch?: typeof fetch;
  git?: string;
}

interface Workspace {
  project: string;
  branch: string;
  dir: string;
  indexFile: string;
  /** The commit the workspace was made from. */
  from: string;
  /** Made from the PR's existing branch (not the base). */
  existing: boolean;
}

export interface StartedPullRequest {
  dir: string;
  branch: string;
  base: string;
  /** True when the branch already exists (its PR is updated). */
  existing: boolean;
  commit: string;
}

export interface OpenedPullRequest {
  url: string;
  number: number;
  branch: string;
  files: string[];
  /** True when an open PR for the branch already existed and got a new commit. */
  updated: boolean;
}

/** Never committed: secrets, and CI files (a pushed branch runs its own workflows with the repo's secrets). */
const BLOCKED: Array<[RegExp, string]> = [
  [/^\.github\//, 'CI configuration (.github/)'],
  [/(^|\/)\.env($|\.)/i, 'an env file'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, 'a key file'],
  [/(^|\/)(id_rsa|id_ed25519|id_ecdsa)/i, 'an SSH key'],
  [/credentials/i, 'a credentials file'],
  [/(^|\/)\.npmrc$/i, 'an .npmrc'],
];
const MAX_FILES = 200;
const NAME = /^[a-z0-9][a-z0-9-]{1,59}$/;
const GIT_TIMEOUT_MS = 5 * 60_000;

/** The branch's own part: "fix-otp", "jarvis/fix-otp" → "fix-otp". */
export function branchName(agentName: string, input: string): string {
  const prefix = `${slug(agentName)}/`;
  const name = input
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, '');
  const own = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  if (!NAME.test(own))
    throw new PullRequestError(
      `Branch name "${input}" is not allowed: use 2-60 lowercase letters, digits and dashes, e.g. "fix-otp-retry"`,
    );
  return prefix + own;
}

/** The first rule a path breaks, if any. */
export function blockedPath(file: string): string | undefined {
  return BLOCKED.find(([re]) => re.test(file))?.[1];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';

export class PullRequests {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly git: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: PullRequestsDeps) {
    this.git = deps.git ?? 'git';
    this.fetchFn = deps.fetch ?? fetch;
  }

  /** Whether runs of this project get the pull request tools. */
  has(project: string): boolean {
    return this.deps.repos.some((r) => r.project === project);
  }

  /** A workspace for `branch`: the open PR's branch if it exists, else the base branch. */
  async start(project: string, input: string): Promise<StartedPullRequest> {
    const repo = this.repo(project);
    const branch = branchName(this.deps.agentName, input);
    const key = `${project}\0${branch}`;
    const known = this.workspaces.get(key);
    if (known && existsSync(known.dir)) {
      return {
        dir: known.dir,
        branch,
        base: repo.base,
        existing: known.existing,
        commit: known.from.slice(0, 7),
      };
    }
    const gitDir = await this.gitDir(project);
    const heads = await this.remoteHeads(gitDir, repo.repo, [repo.base, branch]);
    if (!heads.has(repo.base)) throw new PullRequestError(`${repo.repo} has no branch "${repo.base}"`);
    const existing = heads.has(branch);
    const ref = existing ? branch : repo.base;
    await this.runGit(
      gitDir,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        this.url(repo.repo),
        `+refs/heads/${ref}:refs/tara/${ref}`,
      ],
      { auth: true },
    );
    const from = (await this.runGit(gitDir, ['rev-parse', `refs/tara/${ref}`])).trim();

    const root = this.deps.workRoot ?? tmpdir();
    const dir = mkdtempSync(path.join(root, `tara-pr-${slug(project)}-`));
    if (this.deps.shareGid !== undefined) {
      chownSync(dir, process.getuid?.() ?? -1, this.deps.shareGid);
      chmodSync(dir, 0o2770);
    }
    const indexFile = path.join(gitDir, `index-${randomBytes(6).toString('hex')}`);
    try {
      await this.runGit(gitDir, ['read-tree', '--reset', '-u', from], { workTree: dir, indexFile });
    } catch (err) {
      this.remove({ project, branch, dir, indexFile, from, existing });
      throw err;
    }
    this.workspaces.set(key, { project, branch, dir, indexFile, from, existing });
    this.deps.log.info(`pull request workspace for ${project} ${branch} at ${dir}`);
    return { dir, branch, base: repo.base, existing, commit: from.slice(0, 7) };
  }

  /** Commits the workspace onto its branch, pushes it and opens (or updates) the PR. */
  async open(
    project: string,
    input: { branch: string; title: string; body?: string },
  ): Promise<OpenedPullRequest> {
    const repo = this.repo(project);
    const branch = branchName(this.deps.agentName, input.branch);
    const ws = this.workspaces.get(`${project}\0${branch}`);
    if (!ws || !existsSync(ws.dir))
      throw new PullRequestError(
        `No workspace for ${branch}: call start_pull_request first and make the change there`,
      );
    const gitDir = await this.gitDir(project);
    const inTree = { workTree: ws.dir, indexFile: ws.indexFile };

    await this.runGit(gitDir, ['add', '--all', '--', '.'], inTree);
    const files = (
      await this.runGit(gitDir, ['diff', '--cached', '--name-only', '--no-renames', '-z', ws.from], inTree)
    )
      .split('\0')
      .filter(Boolean);
    if (!files.length) throw new PullRequestError(`Nothing changed in ${ws.dir}`);
    if (files.length > MAX_FILES)
      throw new PullRequestError(`${files.length} files changed; at most ${MAX_FILES}`);
    const refused = files.flatMap((f) => {
      const why = blockedPath(f);
      return why ? [`${f} (${why})`] : [];
    });
    if (refused.length)
      throw new PullRequestError(
        `Refused, a pull request can't change: ${refused.join(', ')}. Undo those and try again.`,
      );

    const title = input.title.trim().slice(0, 200);
    const tree = (await this.runGit(gitDir, ['write-tree'], inTree)).trim();
    const commit = (
      await this.runGit(gitDir, ['commit-tree', tree, '-p', ws.from, '-m', title], { author: true })
    ).trim();
    try {
      // No "+": a branch that moved on GitHub since the workspace was made is rejected, never overwritten.
      await this.runGit(gitDir, ['push', '--quiet', this.url(repo.repo), `${commit}:refs/heads/${branch}`], {
        auth: true,
      });
    } catch (err) {
      throw new PullRequestError(
        `Push to ${branch} failed (the branch may have changed on GitHub: start again to get its latest): ${(err as Error).message}`,
      );
    }

    const [owner] = repo.repo.split('/');
    const open = await this.api<Array<{ html_url: string; number: number }>>(
      'GET',
      `/repos/${repo.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    const pr =
      open[0] ??
      (await this.api<{ html_url: string; number: number }>('POST', `/repos/${repo.repo}/pulls`, {
        title,
        head: branch,
        base: repo.base,
        body: `${input.body?.trim() ?? ''}\n\n---\nRaised by ${this.deps.agentName} (tara-agent).`.trim(),
      }));
    this.remove(ws);
    this.workspaces.delete(`${project}\0${branch}`);
    this.deps.log.info(`pull request ${pr.html_url} (${files.length} files) for ${project}`);
    return { url: pr.html_url, number: pr.number, branch, files, updated: Boolean(open[0]) };
  }

  private repo(project: string): Required<GithubRepo> {
    const repo = this.deps.repos.find((r) => r.project === project);
    if (!repo) throw new PullRequestError(`Pull requests are not set up for project "${project}"`);
    return { ...repo, base: repo.base ?? 'main' };
  }

  private url(repo: string): string {
    return this.deps.remoteUrl?.(repo) ?? `https://github.com/${repo}.git`;
  }

  private async gitDir(project: string): Promise<string> {
    const dir = path.join(this.deps.stateDir, 'github', `${slug(project)}.git`);
    if (!existsSync(path.join(dir, 'HEAD'))) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      await this.runGit(dir, ['init', '--quiet', '--bare']);
    }
    return dir;
  }

  private async remoteHeads(gitDir: string, repo: string, names: string[]): Promise<Set<string>> {
    const out = await this.runGit(
      gitDir,
      ['ls-remote', '--heads', this.url(repo), ...names.map((n) => `refs/heads/${n}`)],
      {
        auth: true,
      },
    );
    return new Set(
      out
        .split('\n')
        .map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, ''))
        .filter((n): n is string => Boolean(n)),
    );
  }

  /** Deletes a workspace; the run user's own files go through it (tara-agent may not delete them). */
  private remove(ws: Workspace): void {
    rmSync(ws.indexFile, { force: true });
    const drop = () => rmSync(ws.dir, { recursive: true, force: true });
    try {
      drop();
    } catch {
      if (!this.deps.runAs) return;
      execFile(
        'sudo',
        ['-n', '-u', this.deps.runAs.user, '/usr/bin/find', ws.dir, '-mindepth', '1', '-delete'],
        () => {
          try {
            drop();
          } catch (err) {
            this.deps.log.warn(`could not delete ${ws.dir}: ${(err as Error).message}`);
          }
        },
      );
    }
  }

  /**
   * Runs git on tara-agent's own git data, ignoring every config file and hook, so nothing a run
   * writes into a workspace can make git run code as tara-agent. The token goes in the environment
   * (never on a command line), and only for commands that talk to GitHub.
   */
  private runGit(
    gitDir: string,
    args: string[],
    opts: { workTree?: string; indexFile?: string; auth?: boolean; author?: boolean } = {},
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: gitDir,
      LC_ALL: 'C',
      GIT_DIR: gitDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '0',
    };
    const config: Array<[string, string]> = [
      ['core.hooksPath', '/dev/null'],
      ['core.fsmonitor', 'false'],
    ];
    if (opts.auth) {
      const basic = Buffer.from(`x-access-token:${this.deps.token}`).toString('base64');
      config.push(['http.https://github.com/.extraHeader', `AUTHORIZATION: basic ${basic}`]);
    }
    config.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
    env.GIT_CONFIG_COUNT = String(config.length);
    if (opts.workTree) env.GIT_WORK_TREE = opts.workTree;
    if (opts.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
    if (opts.author) {
      const email = `${slug(this.deps.agentName)}@tara-agent.local`;
      Object.assign(env, {
        GIT_AUTHOR_NAME: this.deps.agentName,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: this.deps.agentName,
        GIT_COMMITTER_EMAIL: email,
      });
    }
    return new Promise((resolve, reject) => {
      execFile(
        this.git,
        args,
        { env, cwd: opts.workTree ?? gitDir, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          const detail = (stderr || err.message)
            .replaceAll(this.deps.token, '***')
            .trim()
            .split('\n')
            .slice(-3);
          reject(new PullRequestError(`git ${args[0]} failed: ${detail.join(' ')}`));
        },
      );
    });
  }

  private async api<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`https://api.github.com${route}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.deps.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tara-agent',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok)
      throw new PullRequestError(`GitHub answered ${res.status}: ${json.message ?? res.statusText}`);
    return json;
  }
}
