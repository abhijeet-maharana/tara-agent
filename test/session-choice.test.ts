import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Approvals } from '../src/approvals/approvals.js';
import { CONTEXT_LARGE, IDLE_LONG_MS, sessionChoice, TURNS_MANY } from '../src/approvals/session-choice.js';
import type { Project } from '../src/config/schema.js';
import type { IncomingMessage } from '../src/sessions/manager.js';
import { type Item, Store } from '../src/store/store.js';
import { FakeChat } from './fakes.js';

const makeProject = (): Project => ({
  dir: mkdtempSync(path.join(tmpdir(), 'tara-choice-')),
  config: {
    name: 'shop',
    slackChannel: 'C1',
    permissionMode: 'bypassPermissions',
    chatModel: 'opus',
    allowedTools: [],
    allowedUsers: [],
    billing: 'subscription',
    selfImprove: 'off',
    owner: 'U1',
  },
});

const NOW = 1_800_000_000_000;
const card = (over: Partial<Item> = {}) => ({
  mode: 'resume' as const,
  kind: 'decision',
  handoff: 'Campaign 123: set bids to 0.40',
  threadTs: '90.1',
  ...over,
});
const started = { started: true };
const state = (over: { turns?: number; contextTokens?: number; lastAt?: number } = {}) => ({
  turns: 2,
  lastAt: NOW - 60_000,
  contextTokens: 30_000,
  ...over,
});

describe('sessionChoice: where a decision is acted on', () => {
  it('continues a small, recent session and offers a new one instead', () => {
    expect(sessionChoice(card(), started, state(), NOW)).toEqual({
      mode: 'continue',
      alternative: 'new',
      why: 'follow-up in a small session (30k tokens, 2 turns)',
    });
  });

  it.each([
    ['a large context', state({ contextTokens: CONTEXT_LARGE }), /^large context \(100k tokens\)$/],
    ['a long thread', state({ turns: TURNS_MANY }), /^long thread \(8 turns\)$/],
    ['an idle session', state({ lastAt: NOW - IDLE_LONG_MS }), /^session idle for 3 days$/],
  ])('advises a new session for %s, and still offers to continue', (_, s, why) => {
    const choice = sessionChoice(card(), started, s, NOW);
    expect(choice).toMatchObject({ mode: 'new', alternative: 'continue' });
    expect(choice?.why).toMatch(why);
  });

  it('has one way only when the other is impossible', () => {
    // No handoff notes: only the run that asked knows what to do.
    expect(sessionChoice(card({ handoff: undefined }), started, state(), NOW)).toEqual({
      mode: 'continue',
      why: 'no handoff notes, so only the run that asked knows what to do',
    });
    // A root action reports back to the run that asked.
    expect(sessionChoice(card(), started, state(), NOW, { rootAction: true })?.mode).toBe('continue');
    // No session (never started, or no thread): only a new one.
    expect(sessionChoice(card(), undefined, undefined, NOW)).toEqual({
      mode: 'new',
      why: 'the run that asked has no session to continue',
    });
    expect(sessionChoice(card(), { started: false }, undefined, NOW)?.alternative).toBeUndefined();
  });

  it('gives no advice for drafts, notices, or cards with nowhere to act', () => {
    expect(sessionChoice(card({ mode: 'queue' }), started, state(), NOW)).toBeUndefined();
    expect(sessionChoice(card({ kind: 'notice' }), started, state(), NOW)).toBeUndefined();
    expect(sessionChoice(card({ handoff: undefined, threadTs: undefined }), undefined, undefined, NOW)).toBe(
      undefined,
    );
  });
});

describe('cards show the advice, refresh it after each run, and use it (or the override)', () => {
  function setup() {
    const project = makeProject();
    let now = NOW;
    const store = new Store(':memory:', () => now);
    const chat = new FakeChat('ts');
    const approvals = new Approvals({
      store,
      chat,
      log: { info() {}, warn() {}, error() {} },
      projects: [project],
      timeZone: 'UTC',
      now: () => now,
    });
    const chats: IncomingMessage[] = [];
    const resumed: string[] = [];
    const fresh: string[] = [];
    approvals.onChat = async (m) => void chats.push(m);
    approvals.onJob = async (_p, _j, r) => void resumed.push(r.text);
    approvals.onJobDecision = async (_p, _j, r) => void fresh.push(r.text);
    store.saveSession({
      threadKey: 'C1:90.1',
      project: 'shop',
      sessionId: 's1',
      model: 'opus',
      started: true,
    });
    const run = (contextTokens: number) =>
      store.recordRun({
        kind: 'job',
        project: 'shop',
        jobId: 'ads',
        threadKey: 'C1:90.1',
        sessionId: 's1',
        startedAt: now - 1_000,
        endedAt: now,
        status: 'ok',
        contextTokens,
      });
    const ask = () =>
      approvals.requestDecision(
        { project, channel: 'C1', threadTs: '90.1', jobId: 'ads' },
        { title: 'Cut bids', details: 'Saves ₹1,240/week', handoff: 'Campaign 123: set bids to 0.40' },
      );
    return {
      store,
      chat,
      approvals,
      chats,
      resumed,
      fresh,
      run,
      ask,
      tick: (ms: number) => {
        now += ms;
      },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 5));
  const buttons = (blocks: unknown) =>
    (
      (
        blocks as Array<{ type: string; elements?: Array<{ action_id: string; text: { text: string } }> }>
      ).find((b) => b.type === 'actions')?.elements ?? []
    ).map((e) => [e.action_id, e.text.text]);

  it('puts the advice on the card with a button for the other session', async () => {
    const { chat, store, ask, run } = setup();
    run(20_000);
    const { id } = await ask();
    const blocks = chat.blockPosts[0]?.blocks;
    expect(buttons(blocks)).toEqual([
      ['tara:approval:0:continue', 'Approve'],
      ['tara:approval:0:new', 'Approve · new session'],
      ['tara:approval:1:continue', 'Reject'],
    ]);
    expect(JSON.stringify(blocks)).toContain('Upon approval, this will continue in the existing session');
    expect(store.getItem(id)?.session).toBe('continue');
  });

  it('refreshes the card once a run in its thread ends with a large context', async () => {
    const { chat, store, ask, run } = setup();
    run(20_000);
    const { id } = await ask();
    run(150_000);
    await flush();
    expect(store.getItem(id)?.session).toBe('new');
    const update = chat.updates.at(-1);
    expect(update?.ts).toBe(store.getItem(id)?.messageTs);
    expect(JSON.stringify(update?.blocks)).toContain(
      'a new session will be created · large context (150k tokens)',
    );
    expect(buttons(update?.blocks)[1]).toEqual(['tara:approval:0:continue', 'Approve · same session']);
    // Nothing changed: the card is left alone.
    const edits = chat.updates.length;
    run(160_000);
    await flush();
    expect(chat.updates).toHaveLength(edits);
  });

  it('acts as advised by default, and as picked when overridden', async () => {
    const { approvals, store, ask, run, resumed, fresh } = setup();
    run(20_000);
    const a = await ask();
    await approvals.decide(a.id, { option: 'Approve', by: 'U1', via: 'slack' });
    await approvals.settled();
    expect(resumed).toHaveLength(1);
    expect(fresh).toHaveLength(0);

    const b = await ask();
    await approvals.decide(b.id, { option: 'Approve', by: 'U1', via: 'slack', session: 'new' });
    await approvals.settled();
    expect(fresh).toHaveLength(1);
    expect(store.getItem(b.id)?.session).toBe('new');
  });

  it('keeps to the advice the person saw, even if it would differ by now', async () => {
    const { approvals, store, ask, run, tick, resumed } = setup();
    run(20_000);
    const { id } = await ask();
    tick(IDLE_LONG_MS + 1); // the session went cold since the card was shown
    await approvals.decide(id, { option: 'Approve', by: 'U1', via: 'dashboard' });
    await approvals.settled();
    expect(store.getItem(id)?.session).toBe('continue');
    expect(resumed).toHaveLength(1);
  });

  it('brings the card in line when the advice changed with time alone (the page asks)', async () => {
    const { approvals, store, chat, ask, run, tick } = setup();
    run(20_000);
    const { id } = await ask();
    tick(IDLE_LONG_MS + 1);
    const { choice, done } = approvals.syncAdvice(store.getItem(id) as Item);
    await done;
    expect(choice?.mode).toBe('new');
    expect(store.getItem(id)?.session).toBe('new');
    expect(JSON.stringify(chat.updates.at(-1)?.blocks)).toContain('session idle for 3 days');
  });

  it('ignores an override the card cannot use', async () => {
    const { approvals, store, chats, resumed } = setup();
    const project = makeProject();
    // No handoff notes: a new session would not know what to do, so it continues.
    const { id } = await approvals.requestDecision(
      { project, channel: 'C1', threadTs: '90.1', jobId: 'ads' },
      { title: 'Enter the OTP', details: 'Sent to your phone' },
    );
    await approvals.decide(id, { option: 'Approve', by: 'U1', via: 'slack', session: 'new' });
    await approvals.settled();
    expect(store.getItem(id)?.session).toBe('continue');
    expect(resumed).toHaveLength(1);
    expect(chats).toHaveLength(0);
  });
});
