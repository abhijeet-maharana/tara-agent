import { describe, expect, it } from 'vitest';
import type { JobInfo } from '../src/scheduler/scheduler.js';
import { matchJob } from '../src/sessions/job-match.js';
import { SessionManager } from '../src/sessions/manager.js';
import { Store } from '../src/store/store.js';
import { FakeChat, testHost } from './fakes.js';

const job = (id: string, name: string, enabled = true): JobInfo => ({
  id,
  name,
  enabled,
  running: false,
  cron: '0 * * * *',
  tz: 'UTC',
  skills: [],
  model: 'haiku',
});
const jobs = [
  job('weekly-production-redis-health-audit', 'Weekly Production Redis Health Audit'),
  job('flipkart-order-sla-report', 'Flipkart Order SLA Report'),
  job('amazon-order-sla-report', 'Amazon Order SLA Report'),
  job('marketplace-pickup-sla-check', 'Marketplace Pickup SLA Check'),
  job('weekly-marketplace-and-web-p-and-l-pulse', 'Weekly Marketplace & Web P&L Pulse'),
];

describe('matchJob', () => {
  it.each([
    ['Run Weekly Production Redis Health Audit', 'weekly-production-redis-health-audit'],
    ['run the redis audit', 'weekly-production-redis-health-audit'],
    ['please start amazon sla report now', 'amazon-order-sla-report'],
    ['trigger flipkart sla.', 'flipkart-order-sla-report'],
    ['run marketplace-pickup-sla-check', 'marketplace-pickup-sla-check'],
    ['run weekly p&l pulse', 'weekly-marketplace-and-web-p-and-l-pulse'],
  ])('%j → %s', (text, id) => {
    expect(matchJob(text, jobs)).toEqual({ job: expect.objectContaining({ id }) });
  });

  it('offers choices when several jobs fit', () => {
    const m = matchJob('run sla', jobs);
    expect(m && 'choices' in m && m.choices.map((j) => j.id)).toEqual([
      'flipkart-order-sla-report',
      'amazon-order-sla-report',
      'marketplace-pickup-sla-check',
    ]);
  });

  it.each([
    'run the tests',
    'can you run the redis audit and compare with last week?',
    'what does the redis audit do?',
    'run',
  ])('leaves %j to Claude', (text) => {
    expect(matchJob(text, jobs)).toBeNull();
  });
});

describe('"run <job name>" in chat', () => {
  function setup() {
    const chat = new FakeChat('bot.');
    const triggered: unknown[][] = [];
    const runs: unknown[] = [];
    const manager = new SessionManager({
      projects: [
        {
          dir: '/repo',
          config: {
            name: 'shop',
            slackChannel: 'C1',
            permissionMode: 'bypassPermissions',
            chatModel: 'sonnet',
            allowedTools: [],
            allowedUsers: [],
            billing: 'subscription',
            selfImprove: true,
          },
        },
      ],
      host: testHost(),
      store: new Store(':memory:'),
      chat,
      env: {},
      log: { info() {}, warn() {}, error() {} },
      run: async (o) => {
        runs.push(o);
        return { status: 'ok', text: 'hi', durationMs: 1, toolCalls: 0, permissionDenials: [] };
      },
      jobs: {
        list: () => [...jobs, job('paused-job', 'Paused Job', false)],
        trigger: (...args: unknown[]) => {
          triggered.push(args);
          return 'started';
        },
      },
    });
    return { chat, manager, triggered, runs };
  }
  const msg = (text: string, threadTs = '100.1') => ({
    channel: 'C1',
    threadTs,
    ts: '100.1',
    user: 'U1',
    text,
  });

  it("starts the job in the requester's own thread, without a model turn", async () => {
    const { chat, manager, triggered, runs } = setup();
    await manager.handle(msg('Run Weekly Production Redis Health Audit'));
    expect(triggered).toEqual([
      ['shop', 'weekly-production-redis-health-audit', 'U1', { channel: 'C1', ts: '100.1' }],
    ]);
    expect(runs).toHaveLength(0);
    expect(chat.posts).toHaveLength(0); // the job itself reports in this thread
  });

  it('inside an existing conversation, runs it in its own message and says so', async () => {
    const { chat, manager, triggered } = setup();
    await manager.handle({ ...msg('run redis audit', '50.1'), ts: '100.2' });
    expect(triggered[0]?.[3]).toBeUndefined();
    expect(chat.texts()).toEqual([
      '▶️ Started *Weekly Production Redis Health Audit*. It posts its own message in this channel.',
    ]);
  });

  it('asks which one with buttons, and a tap starts it', async () => {
    const { chat, manager, triggered } = setup();
    await manager.handle(msg('run sla'));
    const post = chat.blockPosts[0] as { blocks: unknown[] };
    const buttons = (post.blocks[1] as { elements: Array<{ value: string }> }).elements;
    expect(buttons.map((b) => b.value)).toEqual([
      'flipkart-order-sla-report|1',
      'amazon-order-sla-report|1',
      'marketplace-pickup-sla-check|1',
    ]);
    await manager.runButton({
      actionId: 'tara:runjob:1',
      value: 'amazon-order-sla-report|1',
      user: 'U2',
      channel: 'C1',
      messageTs: 'bot.1',
      threadTs: '100.1',
    });
    expect(chat.updates[0]?.text).toBe('▶️ Amazon Order SLA Report');
    expect(triggered).toEqual([['shop', 'amazon-order-sla-report', 'U2', { channel: 'C1', ts: '100.1' }]]);
  });

  it('refuses paused jobs and hands everything else to Claude', async () => {
    const { chat, manager, triggered, runs } = setup();
    await manager.handle(msg('run paused job'));
    expect(chat.texts()[0]).toMatch(/^⏸ \*Paused Job\* is paused/);
    await manager.handle(msg('run the tests please', '200.1'));
    expect(triggered).toHaveLength(0);
    expect(runs).toHaveLength(1);
  });
});
