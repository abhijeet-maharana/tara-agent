import type { GithubRepo } from '../config/schema.js';
import type { Logger } from '../sessions/manager.js';

/**
 * Reading a GitHub Actions job (host `github`), so a run can see why CI failed without the token.
 * Read-only: only GETs on the project's own repo (job details and its log), never reruns or
 * cancels. The token goes to api.github.com only; the log's signed download URL gets no
 * Authorization header. See docs/security.md "CI jobs".
 */

export class CiJobError extends Error {}

export interface CiJobsDeps {
  repos: GithubRepo[];
  token: string;
  log: Logger;
  /** Tests. */
  fetch?: typeof fetch;
}

export interface CiJob {
  id: string;
  name: string;
  workflow: string;
  branch: string;
  sha: string;
  status: string;
  conclusion: string | null;
  url: string;
  failedSteps: Array<{ number: number; name: string; conclusion: string }>;
  /** Lines around the first `##[error]`, if any. */
  firstError?: { line: number; lines: string[] };
  /** The log's last lines (timestamps and ANSI codes removed). */
  tail: string[];
  /** Lines in the whole log. */
  logLines: number;
  /** Why there is no log (still running, expired). */
  logMissing?: string;
}

const TAIL_LINES = 300;
const ERROR_BEFORE = 30;
const ERROR_AFTER = 15;
const MAX_LINE = 1000;
const API_TIMEOUT_MS = 30_000;
const LOG_TIMEOUT_MS = 2 * 60_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/** A log line without its timestamp, ANSI codes and carriage returns, cut to MAX_LINE. */
export function cleanLine(line: string): string {
  const s = line.replace(TIMESTAMP, '').replace(ANSI, '').replaceAll('\r', '');
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)} …` : s;
}

/**
 * The repo (if a URL) and job id in `input`: a job id, a job page
 * (github.com/o/r/actions/runs/1/job/2, github.com/o/r/runs/2) or its API URL.
 */
export function parseJobRef(input: string): { repo?: string; id: string } {
  const s = input.trim();
  if (/^\d{1,20}$/.test(s)) return { id: s };
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new CiJobError(`"${s.slice(0, 200)}" is not a job id or a GitHub Actions job URL`);
  }
  const p = url.pathname.replace(/\/+$/, '');
  const patterns =
    url.protocol !== 'https:'
      ? []
      : url.hostname === 'github.com'
        ? [
            /^\/([\w.-]+\/[\w.-]+)\/actions\/runs\/\d+\/job\/(\d{1,20})$/,
            /^\/([\w.-]+\/[\w.-]+)\/runs\/(\d{1,20})$/,
          ]
        : url.hostname === 'api.github.com'
          ? [/^\/repos\/([\w.-]+\/[\w.-]+)\/actions\/jobs\/(\d{1,20})$/]
          : [];
  for (const re of patterns) {
    const m = p.match(re);
    if (m?.[1] && m[2]) return { repo: m[1], id: m[2] };
  }
  if (url.hostname === 'github.com' && /^\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(\/attempts\/\d+)?$/.test(p))
    throw new CiJobError(
      'That is a workflow run, not a job: open the failed job in it and pass that URL (…/actions/runs/<run>/job/<job>)',
    );
  throw new CiJobError(`"${s.slice(0, 200)}" is not a GitHub Actions job URL`);
}

interface ApiJob {
  id: number;
  name: string;
  workflow_name?: string | null;
  head_branch?: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  steps?: Array<{ number: number; name: string; status: string; conclusion: string | null }>;
}

export class CiJobs {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: CiJobsDeps) {
    this.fetchFn = deps.fetch ?? fetch;
  }

  has(project: string): boolean {
    return this.deps.repos.some((r) => r.project === project);
  }

  /** The job's details, failed steps and log excerpt. Only jobs of the project's own repo. */
  async read(project: string, input: string): Promise<CiJob> {
    const own = this.deps.repos.find((r) => r.project === project);
    if (!own) throw new CiJobError(`CI jobs are not set up for project "${project}"`);
    const ref = parseJobRef(input);
    if (ref.repo && ref.repo.toLowerCase() !== own.repo.toLowerCase())
      throw new CiJobError(`Refused: ${ref.repo} is not this project's repo (${own.repo})`);
    try {
      return await this.readJob(own.repo, ref.id);
    } catch (err) {
      const message = (err as Error).message.replaceAll(this.deps.token, '***');
      throw err instanceof CiJobError
        ? new CiJobError(message)
        : new CiJobError(`Reading the job failed: ${message}`);
    }
  }

  private async readJob(repo: string, id: string): Promise<CiJob> {
    const job = await this.api(`/repos/${repo}/actions/jobs/${id}`);
    const res = (await job.json()) as ApiJob;
    const out: CiJob = {
      id: String(res.id),
      name: res.name,
      workflow: res.workflow_name ?? '',
      branch: res.head_branch ?? '',
      sha: res.head_sha,
      status: res.status,
      conclusion: res.conclusion,
      url: res.html_url,
      failedSteps: (res.steps ?? [])
        .filter(
          (s) => s.conclusion === 'failure' || s.conclusion === 'timed_out' || s.conclusion === 'cancelled',
        )
        .map((s) => ({ number: s.number, name: s.name, conclusion: s.conclusion as string })),
      tail: [],
      logLines: 0,
    };

    // The API answers with a redirect to a short-lived signed URL. Follow it by hand so the token
    // never goes to that host.
    const logs = await this.api(`/repos/${repo}/actions/jobs/${id}/logs`, {
      redirect: 'manual',
      allow: [404, 410],
    });
    if (logs.status === 404 || logs.status === 410) {
      out.logMissing =
        res.status !== 'completed'
          ? `the job is ${res.status}; its log is ready when it ends`
          : 'its log has expired';
      return out;
    }
    let body: Response = logs;
    if (logs.status >= 300 && logs.status < 400) {
      const location = logs.headers.get('location');
      if (!location?.startsWith('https://'))
        throw new CiJobError(`GitHub answered ${logs.status} without a download link for the log`);
      body = await this.fetchFn(location, {
        redirect: 'follow',
        signal: AbortSignal.timeout(LOG_TIMEOUT_MS),
      });
      if (!body.ok) throw new CiJobError(`Downloading the log failed: ${body.status}`);
    }
    Object.assign(out, await excerpt(body));
    // GitHub masks the repo's secrets in logs; this token is not one of them.
    const hide = (l: string) => l.replaceAll(this.deps.token, '***');
    out.tail = out.tail.map(hide);
    if (out.firstError) out.firstError.lines = out.firstError.lines.map(hide);
    this.deps.log.info(
      `read CI job ${repo} ${id} (${out.conclusion ?? out.status}, ${out.logLines} log lines)`,
    );
    return out;
  }

  private async api(
    route: string,
    opts: { redirect?: 'follow' | 'manual'; allow?: number[] } = {},
  ): Promise<Response> {
    const res = await this.fetchFn(`https://api.github.com${route}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.deps.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tara-agent',
      },
      redirect: opts.redirect ?? 'follow',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (res.ok || (res.status >= 300 && res.status < 400) || opts.allow?.includes(res.status)) return res;
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    const hint =
      res.status === 404
        ? ' (no such job in this repo)'
        : res.status === 403 || res.status === 401
          ? ' (the token needs Actions: Read-only on this repo)'
          : '';
    throw new CiJobError(`GitHub answered ${res.status}: ${json.message ?? res.statusText}${hint}`);
  }
}

/** Streams the log once, keeping the last lines and the lines around the first `##[error]`. */
async function excerpt(res: Response): Promise<Pick<CiJob, 'tail' | 'logLines' | 'firstError'>> {
  const tail: string[] = [];
  let count = 0;
  let firstError: CiJob['firstError'];
  let after = 0;
  const take = (raw: string) => {
    const line = cleanLine(raw);
    count++;
    if (firstError && after > 0) {
      firstError.lines.push(line);
      after--;
    } else if (!firstError && line.includes('##[error]')) {
      firstError = { line: count, lines: [...tail.slice(-ERROR_BEFORE), line] };
      after = ERROR_AFTER;
    }
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  };
  const decoder = new TextDecoder();
  let rest = '';
  if (res.body) {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) take(l);
    }
  }
  rest += decoder.decode();
  if (rest) take(rest);
  return { tail, logLines: count, firstError };
}
