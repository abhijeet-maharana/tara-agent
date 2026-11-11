import { describe, expect, it } from 'vitest';
import type { RepoReader, RepoStatus } from '../src/code/repo.js';
import { hostConfigSchema } from '../src/config/schema.js';
import {
  type AttentionJob,
  type AttentionSources,
  gatherAttention,
  parsePullRequests,
} from '../src/http/attention.js';
import type { Item, StoredRun } from '../src/store/store.js';

const run = (status: string, startedAt = 1): StoredRun => ({
  id: startedAt,
  kind: 'job',
  project: 'shop',
  startedAt,
  endedAt: startedAt,
  status,
});

const job = (over: Partial<AttentionJob> = {}): AttentionJob => ({
  id: 'sync',
  name: 'Payments sync',
  enabled: true,
  running: false,
  tz: 'UTC',
  skills: [],
  model: 'haiku',
  project: 'shop',
  recent: [],
  ...over,
});

const repo = (name: string, status: RepoStatus) =>
  ({ repo: { name, title: name, dir: '', gitDir: '' }, status: async () => status }) as unknown as RepoReader;

const sources = (over: Partial<AttentionSources> = {}): AttentionSources => ({
  approvals: () => [],
  jobs: () => [],
  ...over,
});

describe('gatherAttention', () => {
  it('is empty when nothing needs you', async () => {
    expect(await gatherAttention(sources())).toEqual({ items: [], notes: [] });
  });

  it('puts approvals and permission prompts in waiting, paused jobs and dirty repos in later', async () => {
    const { items } = await gatherAttention(
      sources({
        approvals: () => [{ id: 'a1', project: 'shop', title: 'Send the newsletter', createdAt: 5 } as Item],
        permissions: () => [{ project: 'shop', title: 'Bash: rm -rf dist', at: 7 }],
        jobs: () => [job({ enabled: false })],
        repos: [
          repo('site', {
            changes: [{ path: 'a.ts', state: 'modified', staged: false, added: 1, removed: 0 }],
          }),
          repo('clean', { changes: [] }),
        ],
      }),
    );
    expect(items.map((i) => [i.tier, i.kind, i.title])).toEqual([
      ['waiting', 'permission', 'Permission prompt: Bash: rm -rf dist'],
      ['waiting', 'approval', 'Approval waiting: Send the newsletter'],
      ['later', 'job-paused', 'Payments sync is paused'],
      ['later', 'repo-changes', '1 uncommitted file in site'],
    ]);
  });

  it('counts a failing streak and makes it urgent only by a rule', async () => {
    const failing = job({
      lastStatus: 'failed',
      lastError: 'timeout talking to Stripe',
      recent: [run('failed', 3), run('error', 2), run('ok', 1)],
    });
    const plain = await gatherAttention(sources({ jobs: () => [failing] }));
    expect(plain.items[0]).toMatchObject({
      tier: 'waiting',
      title: 'Payments sync failed 2 times in a row',
      detail: 'timeout talking to Stripe',
      key: 'job-failing:shop/sync:2',
    });

    const byStreak = await gatherAttention(
      sources({ jobs: () => [failing], urgent: [{ consecutiveFailures: 2 }] }),
    );
    expect(byStreak.items[0]?.tier).toBe('urgent');
    const notYet = await gatherAttention(
      sources({ jobs: () => [failing], urgent: [{ consecutiveFailures: 3 }] }),
    );
    expect(notYet.items[0]?.tier).toBe('waiting');
    const byName = await gatherAttention(sources({ jobs: () => [failing], urgent: [{ job: 'shop/sync' }] }));
    expect(byName.items[0]?.tier).toBe('urgent');
  });

  it('skips running and healthy jobs', async () => {
    const { items } = await gatherAttention(
      sources({ jobs: () => [job({ running: true, lastStatus: 'failed' }), job({ lastStatus: 'ok' })] }),
    );
    expect(items).toEqual([]);
  });

  it('turns unreadable sources into notes', async () => {
    const { items, notes } = await gatherAttention(
      sources({
        repos: [repo('gone', { changes: [], error: 'No git data at /x' })],
        pullRequests: async () => {
          throw new Error('gh: not logged in');
        },
      }),
    );
    expect(items).toEqual([]);
    expect(notes).toEqual(['gone: No git data at /x', 'GitHub: gh: not logged in']);
  });

  it('keeps only PRs that need you', async () => {
    const pr = { repo: 'me/shop', title: 't', reviewRequested: false };
    const { items } = await gatherAttention(
      sources({
        pullRequests: async () => [
          { ...pr, number: 1, url: 'u1', reviewRequested: true },
          { ...pr, number: 2, url: 'u2', checks: 'FAILURE' },
          { ...pr, number: 3, url: 'u3', review: 'CHANGES_REQUESTED', checks: 'SUCCESS' },
          { ...pr, number: 4, url: 'u4', review: 'APPROVED', checks: 'SUCCESS' },
          { ...pr, number: 5, url: 'u5', checks: 'PENDING' },
          { ...pr, number: 6, url: 'u6', checks: 'FAILURE', draft: true },
        ],
      }),
    );
    expect(items.map((i) => [i.tier, i.kind, i.title])).toEqual([
      ['waiting', 'pr-review', 'Review requested on shop #1: t'],
      ['waiting', 'pr-checks', 'Checks failing on shop #2: t'],
      ['waiting', 'pr-changes', 'Changes requested on shop #3: t'],
      ['later', 'pr-ready', 'shop #4 is approved and green: t'],
    ]);
  });
});

describe('parsePullRequests', () => {
  it('reads your PRs and review requests from gh api graphql', () => {
    const out = JSON.stringify({
      data: {
        viewer: {
          pullRequests: {
            nodes: [
              {
                number: 7,
                title: 'Fix sync',
                url: 'https://github.com/me/shop/pull/7',
                isDraft: false,
                repository: { nameWithOwner: 'me/shop' },
                reviewDecision: 'APPROVED',
                commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
              },
              {
                number: 8,
                title: 'No checks',
                url: 'https://github.com/me/shop/pull/8',
                isDraft: true,
                repository: { nameWithOwner: 'me/shop' },
                reviewDecision: null,
                commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              },
            ],
          },
        },
        search: {
          nodes: [
            {},
            {
              number: 3,
              title: 'Docs',
              url: 'https://github.com/o/lib/pull/3',
              repository: { nameWithOwner: 'o/lib' },
            },
          ],
        },
      },
    });
    expect(parsePullRequests(out)).toEqual([
      expect.objectContaining({ repo: 'o/lib', number: 3, reviewRequested: true }),
      expect.objectContaining({ number: 7, reviewRequested: false, review: 'APPROVED', checks: 'SUCCESS' }),
      expect.objectContaining({ number: 8, draft: true, review: undefined, checks: undefined }),
    ]);
  });
});

describe('attention config', () => {
  it('defaults to GitHub on and nothing urgent', () => {
    expect(hostConfigSchema.parse({ projects: ['/p'] }).attention).toEqual({ github: true, urgent: [] });
  });

  it('rejects an urgent rule with nothing to match', () => {
    expect(() => hostConfigSchema.parse({ projects: ['/p'], attention: { urgent: [{}] } })).toThrow();
    expect(() =>
      hostConfigSchema.parse({ projects: ['/p'], attention: { urgent: [{ job: 'nojobid' }] } }),
    ).toThrow();
  });
});
