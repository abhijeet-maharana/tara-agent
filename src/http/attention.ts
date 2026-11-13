import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepoReader } from '../code/repo.js';
import type { JobInfo } from '../scheduler/scheduler.js';
import type { Item, StoredRun } from '../store/store.js';
import { FAILED } from './dashboard.js';

const exec = promisify(execFile);

/**
 * What needs the owner, in three tiers. `urgent` may interrupt (chime and one spoken line), `waiting`
 * is a count on screen, `later` is only told when asked. See docs/command.md.
 */
export type Tier = 'urgent' | 'waiting' | 'later';

export interface AttentionItem {
  /** Stable across refreshes, so a client can tell new items from ones it already announced. */
  key: string;
  tier: Tier;
  kind:
    | 'approval'
    | 'permission'
    | 'job-failing'
    | 'job-paused'
    | 'repo-changes'
    | 'pr-review'
    | 'pr-checks'
    | 'pr-changes'
    | 'pr-ready'
    | 'health';
  project?: string;
  /** One short line, fit to be read aloud. */
  title: string;
  detail?: string;
  url?: string;
  at?: number;
}

export interface Attention {
  items: AttentionItem[];
  /** Sources that couldn't be read (gh not logged in, a repo without git data). */
  notes: string[];
}

/** Makes a failing job urgent: one that failed this many times in a row, or a named job (`project/jobId`). */
export interface UrgentRule {
  consecutiveFailures?: number;
  job?: string;
}

export type AttentionJob = JobInfo & { project: string; recent: StoredRun[] };

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Someone asked you to review it; otherwise it's yours. */
  reviewRequested: boolean;
  /** Your PRs: the latest commit's checks (`SUCCESS`, `FAILURE`, `ERROR`, `PENDING`…). */
  checks?: string;
  /** Your PRs: `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`. */
  review?: string;
  draft?: boolean;
}

export interface AttentionSources {
  /** Pending approval items. */
  approvals: () => Item[];
  permissions?: () => Array<{ project: string; title: string; at: number }>;
  jobs: () => AttentionJob[];
  repos?: RepoReader[];
  pullRequests?: () => Promise<PullRequest[]>;
  urgent?: UrgentRule[];
  /** Red Health checks other than jobs (jobs come from `jobs`). */
  health?: () => Array<{ key: string; project?: string; name: string; detail: string; since: number }>;
}

const TIER_ORDER: Record<Tier, number> = { urgent: 0, waiting: 1, later: 2 };

export const failureStreak = (runs: StoredRun[]) => {
  const i = runs.findIndex((r) => !FAILED.includes(r.status));
  return i === -1 ? runs.length : i;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function isUrgent(job: AttentionJob, rules: UrgentRule[]): boolean {
  const streak = failureStreak(job.recent);
  return rules.some(
    (r) =>
      (r.job !== undefined && r.job === `${job.project}/${job.id}`) ||
      (r.consecutiveFailures !== undefined && streak >= r.consecutiveFailures),
  );
}

/** Everything that needs the owner right now, most pressing first. Sources that fail become notes. */
export async function gatherAttention(src: AttentionSources): Promise<Attention> {
  const items: AttentionItem[] = [];
  const notes: string[] = [];

  for (const a of src.approvals())
    items.push({
      key: `approval:${a.id}`,
      tier: 'waiting',
      kind: 'approval',
      project: a.project,
      title: `Approval waiting: ${a.title}`,
      url: '/approvals',
      at: a.createdAt,
    });

  for (const p of src.permissions?.() ?? [])
    items.push({
      key: `permission:${p.project}:${p.at}`,
      tier: 'waiting',
      kind: 'permission',
      project: p.project,
      title: `Permission prompt: ${p.title}`,
      at: p.at,
    });

  for (const job of src.jobs()) {
    if (!job.enabled) {
      items.push({
        key: `job-paused:${job.project}/${job.id}`,
        tier: 'later',
        kind: 'job-paused',
        project: job.project,
        title: `${job.name} is paused`,
      });
      continue;
    }
    if (job.running || !job.lastStatus || !FAILED.includes(job.lastStatus)) continue;
    const streak = failureStreak(job.recent);
    items.push({
      // The streak is in the key, so failing again counts as new.
      key: `job-failing:${job.project}/${job.id}:${streak}`,
      tier: isUrgent(job, src.urgent ?? []) ? 'urgent' : 'waiting',
      kind: 'job-failing',
      project: job.project,
      title: streak > 1 ? `${job.name} failed ${streak} times in a row` : `${job.name} failed`,
      detail: job.lastError?.slice(0, 300),
      at: job.lastRunAt?.getTime(),
    });
  }

  for (const h of src.health?.() ?? [])
    items.push({
      key: `health:${h.key}:${h.since}`,
      tier: 'waiting',
      kind: 'health',
      ...(h.project && { project: h.project }),
      title: `${h.name} has a problem`,
      detail: h.detail.slice(0, 300),
      url: '/health',
      at: h.since,
    });

  const statuses = await Promise.all(
    (src.repos ?? []).map(async (r) => ({
      repo: r.repo,
      status: await r.status().catch((e: Error) => ({ changes: [], error: e.message })),
    })),
  );
  for (const { repo, status } of statuses) {
    if (status.error) notes.push(`${repo.name}: ${status.error}`);
    if (!status.changes.length) continue;
    items.push({
      key: `repo-changes:${repo.name}:${status.changes.length}`,
      tier: 'later',
      kind: 'repo-changes',
      project: repo.name,
      title: `${plural(status.changes.length, 'uncommitted file')} in ${repo.title}`,
      url: `/code/${encodeURIComponent(repo.name)}`,
    });
  }

  if (src.pullRequests) {
    try {
      for (const pr of await src.pullRequests()) {
        const item = prItem(pr);
        if (item) items.push(item);
      }
    } catch (err) {
      notes.push(`GitHub: ${(err as Error).message}`);
    }
  }

  items.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || (b.at ?? 0) - (a.at ?? 0));
  return { items, notes };
}

function prItem(pr: PullRequest): AttentionItem | undefined {
  const base = { project: pr.repo, url: pr.url };
  const name = `${pr.repo.split('/').pop()} #${pr.number}`;
  if (pr.reviewRequested)
    return {
      ...base,
      key: `pr-review:${pr.url}`,
      tier: 'waiting',
      kind: 'pr-review',
      title: `Review requested on ${name}: ${pr.title}`,
    };
  if (pr.draft) return undefined;
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR')
    return {
      ...base,
      key: `pr-checks:${pr.url}`,
      tier: 'waiting',
      kind: 'pr-checks',
      title: `Checks failing on ${name}: ${pr.title}`,
    };
  if (pr.review === 'CHANGES_REQUESTED')
    return {
      ...base,
      key: `pr-changes:${pr.url}`,
      tier: 'waiting',
      kind: 'pr-changes',
      title: `Changes requested on ${name}: ${pr.title}`,
    };
  if (pr.review === 'APPROVED' && pr.checks === 'SUCCESS')
    return {
      ...base,
      key: `pr-ready:${pr.url}`,
      tier: 'later',
      kind: 'pr-ready',
      title: `${name} is approved and green: ${pr.title}`,
    };
  return undefined;
}

const PR_FIELDS = 'number title url isDraft repository { nameWithOwner }';
const PR_QUERY = `query {
  viewer { pullRequests(states: OPEN, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes { ${PR_FIELDS} reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
  } }
  search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 30) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

interface GqlPr {
  number: number;
  title: string;
  url: string;
  isDraft?: boolean;
  repository: { nameWithOwner: string };
  reviewDecision?: string | null;
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
}

/** `gh api graphql` output → your open PRs and the ones waiting for your review. */
export function parsePullRequests(json: string): PullRequest[] {
  const data = (
    JSON.parse(json) as {
      data?: { viewer?: { pullRequests?: { nodes?: GqlPr[] } }; search?: { nodes?: GqlPr[] } };
    }
  ).data;
  const pr = (n: GqlPr, reviewRequested: boolean): PullRequest => ({
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    reviewRequested,
    draft: n.isDraft,
    review: n.reviewDecision ?? undefined,
    checks: n.commits?.nodes[0]?.commit.statusCheckRollup?.state,
  });
  return [
    // Search results that aren't PRs come back as empty objects.
    ...(data?.search?.nodes ?? []).filter((n) => n.url).map((n) => pr(n, true)),
    ...(data?.viewer?.pullRequests?.nodes ?? []).map((n) => pr(n, false)),
  ];
}

/** Your PRs through the `gh` CLI (its own login), cached so a chatty client doesn't hit the API. */
export function githubPullRequests(
  opts: { cacheMs?: number; now?: () => number } = {},
): () => Promise<PullRequest[]> {
  const cacheMs = opts.cacheMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  let hit: { at: number; value: Promise<PullRequest[]> } | undefined;
  return () => {
    if (hit && now() - hit.at < cacheMs) return hit.value;
    const value = exec('gh', ['api', 'graphql', '-f', `query=${PR_QUERY}`], { timeout: 20_000 }).then(
      ({ stdout }) => parsePullRequests(stdout),
      (err: Error & { stderr?: string }) => {
        throw new Error((err.stderr || err.message).trim().split('\n')[0] ?? 'gh failed');
      },
    );
    const current = { at: now(), value };
    hit = current;
    value.catch(() => {
      if (hit === current) hit = undefined;
    });
    return value;
  };
}
