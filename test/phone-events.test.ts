import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Attention, AttentionItem } from '../src/http/attention.js';
import {
  alertText,
  type GlanceState,
  inQuietHours,
  type PhoneAlert,
  PhoneHub,
  type PhoneHubOptions,
} from '../src/http/phone-events.js';
import { phoneScreen } from '../src/http/phone-screen.js';
import type { ActivityEvent, Task } from '../src/runner/activity.js';
import type { Item } from '../src/store/store.js';

/** 2026-11-17 12:00 UTC. */
const NOON = Date.UTC(2026, 10, 17, 12, 0);
const MIN = 60_000;

/** A response that records the event stream. */
class FakeRes {
  chunks: string[] = [];
  private onClose?: () => void;
  writeHead() {
    return this;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  on(event: string, fn: () => void) {
    if (event === 'close') this.onClose = fn;
    return this;
  }
  end() {
    this.onClose?.();
  }
  events(name: string): unknown[] {
    return this.chunks
      .filter((c) => c.startsWith(`event: ${name}\n`))
      .map((c) => JSON.parse(c.slice(c.indexOf('data: ') + 6)));
  }
}

const failing = (job: string, streak = 1): AttentionItem => ({
  key: `job-failing:abtara/${job}:${streak}`,
  tier: 'urgent',
  kind: 'job-failing',
  project: 'abtara',
  title: `${job} failed`,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  project: 'abtara',
  kind: 'job',
  title: 'Blog post',
  startedAt: NOON - 5 * MIN,
  status: 'running',
  steps: [{ id: 's1', text: 'Reading src/blog.ts', state: 'running', depth: 0, at: NOON }],
  stepCount: 1,
  text: '',
  ...over,
});

let hub: PhoneHub | undefined;
afterEach(() => hub?.close());

function setup(over: Partial<PhoneHubOptions> = {}) {
  const clock = { now: NOON };
  const attention: Attention = { items: [], notes: [] };
  let listener: ((e: ActivityEvent) => void) | undefined;
  const tasks: Task[] = [];
  hub = new PhoneHub({
    attention: async () => attention,
    pending: () => [],
    activity: {
      tasks: () => tasks,
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    next: () => [],
    usage: () => undefined,
    projectTitle: (name) => (name === 'abtara' ? 'Abtara' : name),
    timeZone: 'UTC',
    build: 'b1',
    now: () => clock.now,
    ...over,
  });
  const res = new FakeRes();
  hub.connect(res as unknown as ServerResponse);
  return { hub, res, clock, attention, tasks, emit: (e: ActivityEvent) => listener?.(e) };
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

describe('PhoneHub alerts', () => {
  it("doesn't announce what was urgent before, then says one line per gap", async () => {
    const { hub, res, clock, attention } = setup();
    attention.items = [failing('old-job')];
    await hub.check();
    expect(res.events('alert')).toEqual([]);

    attention.items.push(failing('payments'));
    await hub.check();
    const [first] = res.events('alert') as PhoneAlert[];
    expect(first).toMatchObject({ kind: 'urgent', wake: true, speak: true, held: false });
    expect(first?.text).toBe('Heads up: payments failed.');

    // Ten minutes later: shown and woken, not said.
    clock.now += 10 * MIN;
    attention.items.push(failing('blog'));
    await hub.check();
    expect(res.events('alert').at(-1)).toMatchObject({ speak: false, wake: true });

    // Failing again (a longer streak) is new; 30 minutes after the last spoken one, it is said.
    clock.now += 21 * MIN;
    attention.items = [failing('payments', 2)];
    await hub.check();
    expect(res.events('alert').at(-1)).toMatchObject({ speak: true, text: 'Heads up: payments failed.' });
  });

  it('holds alerts in quiet hours and sums them up after', async () => {
    const night = Date.UTC(2026, 10, 17, 23, 30);
    const { hub, res, clock, attention } = setup();
    clock.now = night;
    await hub.check();
    attention.items = [failing('payments'), failing('blog')];
    await hub.check();
    const held = res.events('alert').at(-1) as PhoneAlert;
    expect(held).toMatchObject({ held: true, wake: false, speak: false });
    expect(hub.state().held).toBe(2);
    expect(hub.state().quiet.now).toBe(true);

    // 07:05: one spoken summary of both, even though the items are gone by now.
    clock.now = Date.UTC(2026, 10, 18, 7, 5);
    attention.items = [];
    await hub.check();
    const summary = res.events('alert').at(-1) as PhoneAlert;
    expect(summary).toMatchObject({ kind: 'summary', speak: true, wake: true });
    expect(summary.text).toBe('Overnight: payments failed, and 1 more.');
    expect(hub.state().held).toBe(0);
  });
});

describe('PhoneHub glance', () => {
  it('builds needs, approvals per project, running and recent', async () => {
    const items = [
      { id: 'a', project: 'abtara', title: 'Post A', createdAt: NOON - 3 * 3_600_000 },
      { id: 'b', project: 'abtara', title: 'Post B', createdAt: NOON - MIN },
      { id: 'c', project: 'personal', title: 'Reply', createdAt: NOON - 10 * MIN },
    ] as Item[];
    const { hub, attention, tasks } = setup({ pending: () => items });
    attention.items = [
      {
        key: 'approval:a',
        tier: 'waiting',
        kind: 'approval',
        project: 'abtara',
        title: 'Approval waiting: Post A',
      },
      { key: 'h', tier: 'waiting', kind: 'health', title: 'Disk has a problem' },
      { key: 'p', tier: 'later', kind: 'job-paused', title: 'X is paused' },
      failing('payments'),
    ];
    tasks.push(task(), task({ id: 't0', status: 'ok', endedAt: NOON - MIN, title: 'Quote' }));
    await hub.check();
    const s: GlanceState = hub.state();
    expect(s.ready).toBe(true);
    expect(s.needs).toMatchObject({ urgent: 1, waiting: 1 });
    expect(s.needs.top.map((i) => i.title)).toEqual(['Disk has a problem', 'payments failed']);
    expect(s.approvals.total).toBe(3);
    expect(s.approvals.projects).toEqual([
      { project: 'Abtara', count: 2, oldestAt: NOON - 3 * 3_600_000, title: 'Post A' },
      { project: 'personal', count: 1, oldestAt: NOON - 10 * MIN, title: 'Reply' },
    ]);
    expect(s.running).toEqual([
      expect.objectContaining({ id: 't1', project: 'Abtara', step: 'Reading src/blog.ts', stepCount: 1 }),
    ]);
    expect(s.recent.map((t) => t.title)).toEqual(['Quote']);
    expect(hub.task('t1')?.steps).toHaveLength(1);
  });

  it('sends the glance on connect and on change, and runs as they start and end', async () => {
    const { hub, res, emit, tasks } = setup();
    expect(res.events('state')).toHaveLength(1);
    await hub.check();
    // Nothing changed but `ready`: one more state, then none for an unchanged refresh.
    const sent = res.events('state').length;
    hub.refresh();
    expect(res.events('state')).toHaveLength(sent);

    const t = task();
    tasks.push(t);
    emit({ type: 'task', task: t });
    emit({ type: 'task', task: { ...t, stepCount: 2 } });
    emit({ type: 'task', task: { ...t, status: 'error', endedAt: NOON, error: 'boom' } });
    expect(res.events('run')).toEqual([
      { phase: 'started', task: expect.objectContaining({ id: 't1', status: 'running' }) },
      { phase: 'ended', task: expect.objectContaining({ id: 't1', status: 'error', error: 'boom' }) },
    ]);
    tasks.length = 0;
    hub.refresh();
    expect((res.events('state').at(-1) as GlanceState).running).toEqual([]);
  });

  it('says alerts in one line', () => {
    expect(alertText('urgent', [{ title: 'A failed' }, { title: 'B failed' }])).toBe(
      'Heads up: 2 urgent items. A failed, and 1 more.',
    );
  });
});

describe('PhoneHub without spoken alerts', () => {
  it('still wakes the screen but never speaks', async () => {
    const { hub, res, attention } = setup({ speakAlerts: false });
    await hub.check();
    attention.items = [failing('payments')];
    await hub.check();
    expect(res.events('alert').at(-1)).toMatchObject({ wake: true, speak: false });
  });
});

describe('PhoneHub limits', () => {
  it('refuses event streams beyond the cap', () => {
    const { hub } = setup();
    // setup() opened one already.
    for (let i = 1; i < 16; i++) expect(hub.connect(new FakeRes() as unknown as ServerResponse)).toBe(true);
    const extra = new FakeRes();
    expect(hub.connect(extra as unknown as ServerResponse)).toBe(false);
    expect(extra.chunks).toEqual([]);
  });

  it('keeps config text from closing the page script', () => {
    const html = phoneScreen({
      agentName: 'Jarvis',
      timeZone: '</script><script>alert(1)</script>',
      build: '1',
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });
});
