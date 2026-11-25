import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Attention, AttentionItem } from '../src/http/attention.js';
import { Glance, type GlanceOptions, type GlanceState, inQuietHours } from '../src/http/glance.js';
import { startHttpServer } from '../src/http/server.js';
import type { Task } from '../src/runner/activity.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import type { Item } from '../src/store/store.js';
import { Store } from '../src/store/store.js';

/** 2026-11-17 12:00 UTC. */
const NOON = Date.UTC(2026, 10, 17, 12, 0);
const MIN = 60_000;

const failing = (job: string): AttentionItem => ({
  key: `job-failing:shop/${job}:1`,
  tier: 'urgent',
  kind: 'job-failing',
  project: 'shop',
  title: `${job} failed`,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  project: 'shop',
  kind: 'job',
  title: 'Blog post',
  startedAt: NOON - 5 * MIN,
  status: 'running',
  steps: [{ id: 's1', text: 'Reading src/blog.ts', state: 'running', depth: 0, at: NOON }],
  stepCount: 1,
  text: '',
  ...over,
});

function setup(over: Partial<GlanceOptions> = {}) {
  const clock = { now: NOON };
  const attention: Attention = { items: [], notes: [] };
  const tasks: Task[] = [];
  let reads = 0;
  const glance = new Glance({
    attention: async () => {
      reads++;
      return attention;
    },
    pending: () => [],
    tasks: () => tasks,
    next: () => [],
    usage: () => undefined,
    projectTitle: (name) => (name === 'shop' ? 'Shop' : name),
    timeZone: 'UTC',
    now: () => clock.now,
    ...over,
  });
  return { glance, clock, attention, tasks, reads: () => reads };
}

describe('quiet hours', () => {
  const q = { from: '23:00', to: '07:00' };
  it('wraps past midnight in the host timezone', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 17, h, m);
    expect(inQuietHours(at(23, 30), 'UTC', q)).toBe(true);
    expect(inQuietHours(at(6, 59), 'UTC', q)).toBe(true);
    expect(inQuietHours(at(7), 'UTC', q)).toBe(false);
    expect(inQuietHours(at(12), 'UTC', q)).toBe(false);
    // 18:00 UTC is 23:30 in India.
    expect(inQuietHours(at(18), 'Asia/Kolkata', q)).toBe(true);
    expect(inQuietHours(at(12), 'UTC', { from: '09:00', to: '17:00' })).toBe(true);
  });
});

describe('Glance', () => {
  it('builds needs, approvals per project, running and recent', async () => {
    const items = [
      { id: 'a', project: 'shop', title: 'Post A', createdAt: NOON - 3 * 3_600_000 },
      { id: 'b', project: 'shop', title: 'Post B', createdAt: NOON - MIN },
      { id: 'c', project: 'personal', title: 'Reply', createdAt: NOON - 10 * MIN },
    ] as Item[];
    const { glance, attention, tasks } = setup({ pending: () => items });
    attention.items = [
      {
        key: 'approval:a',
        tier: 'waiting',
        kind: 'approval',
        project: 'shop',
        title: 'Approval waiting: Post A',
      },
      { key: 'h', tier: 'waiting', kind: 'health', title: 'Disk has a problem' },
      { key: 'p', tier: 'later', kind: 'job-paused', title: 'X is paused' },
      failing('payments'),
    ];
    tasks.push(task(), task({ id: 't0', status: 'ok', endedAt: NOON - MIN, title: 'Quote' }));
    const s = await glance.read();
    expect(s.ready).toBe(true);
    expect(s.quiet).toEqual({ from: '23:00', to: '07:00', now: false });
    expect(s.needs).toMatchObject({ urgent: 1, waiting: 1 });
    expect(s.needs.top.map((i) => i.title)).toEqual(['Disk has a problem', 'payments failed']);
    expect(s.approvals.total).toBe(3);
    expect(s.approvals.projects).toEqual([
      { project: 'Shop', count: 2, oldestAt: NOON - 3 * 3_600_000, title: 'Post A' },
      { project: 'personal', count: 1, oldestAt: NOON - 10 * MIN, title: 'Reply' },
    ]);
    expect(s.running).toEqual([
      expect.objectContaining({ id: 't1', project: 'Shop', step: 'Reading src/blog.ts', stepCount: 1 }),
    ]);
    expect(s.recent.map((t) => t.title)).toEqual(['Quote']);
  });

  it('reads /attention at most once a minute, and keeps the last read when one fails', async () => {
    let fail = false;
    const { glance, clock, attention, reads } = setup();
    const g = new Glance({
      attention: async () => {
        if (fail) throw new Error('gh down');
        return { ...attention, items: [...attention.items] };
      },
      pending: () => [],
      next: () => [],
      usage: () => undefined,
      projectTitle: (n) => n,
      timeZone: 'UTC',
      now: () => clock.now,
    });
    await glance.read();
    clock.now += 30_000;
    await glance.read();
    expect(reads()).toBe(1);
    clock.now += 31_000;
    await glance.read();
    expect(reads()).toBe(2);

    attention.items = [failing('payments')];
    expect((await g.read()).needs.urgent).toBe(1);
    fail = true;
    attention.items = [];
    clock.now += 2 * MIN;
    const s = await g.read();
    expect(s.ready).toBe(true);
    expect(s.needs.urgent).toBe(1);
  });

  it("passes Claude's weekly window along with the 5-hour one", async () => {
    const week = { share: 0.12, resetsAt: NOON + 3 * 86_400_000 };
    const { glance } = setup({ usage: () => ({ share: 0.87, resetsAt: NOON + 3_600_000, week }) });
    expect((await glance.read()).usage).toEqual({ share: 0.87, resetsAt: NOON + 3_600_000, week });
  });

  it('says when it is quiet hours', async () => {
    const { glance, clock } = setup({ quietHours: { from: '11:00', to: '13:00' } });
    expect((await glance.read()).quiet.now).toBe(true);
    clock.now += 2 * 3_600_000;
    expect(glance.state().quiet.now).toBe(false);
  });
});

describe('GET /glance', () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  const start = (token?: string) =>
    startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      token,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store: new Store(':memory:'),
      projects: [],
      attention: async () => ({ items: [failing('payments')], notes: [] }),
      quietHours: { from: '00:00', to: '23:59' },
      log: silent,
    });

  it('serves the glance as JSON, behind the token when one is set', async () => {
    const server = await start('secret');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/glance`)).status).toBe(401);
      const res = await fetch(`${base}/glance`, { headers: { authorization: 'Bearer secret' } });
      expect(res.status).toBe(200);
      const s = (await res.json()) as GlanceState;
      expect(s).toMatchObject({ ready: true, needs: { urgent: 1 }, approvals: { total: 0 }, running: [] });
      expect(s.quiet).toMatchObject({ from: '00:00', to: '23:59' });
      const gone = await fetch(`${base}/phone/state`, { headers: { authorization: 'Bearer secret' } });
      expect(gone.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
