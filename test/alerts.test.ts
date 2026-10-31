import { describe, expect, it } from 'vitest';
import { type Alert, Alerts, alertText } from '../src/live/alerts.js';
import type { AttentionItem } from '../src/live/attention.js';

const failing = (job: string, streak: number, tier: AttentionItem['tier'] = 'urgent'): AttentionItem => ({
  key: `job-failing:${job}:${streak}`,
  tier,
  kind: 'job-failing',
  project: job.split('/')[0],
  title: `${job} failed ${streak} times in a row`,
  url: '/jobs',
});

function setup(opts: { gapMinutes?: number; alwaysInterrupt?: string[] } = {}) {
  let items: AttentionItem[] = [];
  let now = 1_000_000;
  const state = { focusUntil: 0 };
  const alerts = new Alerts({
    attention: async () => ({ items, notes: [] }),
    state,
    gapMinutes: opts.gapMinutes ?? 30,
    alwaysInterrupt: opts.alwaysInterrupt ?? [],
    now: () => now,
  });
  const raised: Alert[] = [];
  alerts.subscribe((a) => raised.push(a));
  return {
    alerts,
    raised,
    state,
    set: (next: AttentionItem[]) => {
      items = next;
    },
    later: (minutes: number) => {
      now += minutes * 60_000;
    },
    now: () => now,
  };
}

describe('Alerts', () => {
  it('leaves what was urgent at start alone, then says what becomes urgent', async () => {
    const t = setup();
    t.set([failing('shop/digest', 3)]);
    await t.alerts.check();
    expect(t.raised).toEqual([]);
    t.set([failing('shop/digest', 3), failing('shop/sync', 3), failing('site/build', 1, 'waiting')]);
    await t.alerts.check();
    expect(t.raised).toEqual([
      {
        id: 'alert-1',
        kind: 'urgent',
        items: [{ title: 'shop/sync failed 3 times in a row', project: 'shop', url: '/jobs' }],
        text: 'Heads up: shop/sync failed 3 times in a row.',
        at: t.now(),
        quiet: false,
      },
    ]);
    // Nothing new: nothing said.
    await t.alerts.check();
    expect(t.raised).toHaveLength(1);
  });

  it('shows but does not say a second alert within the gap', async () => {
    const t = setup({ gapMinutes: 30 });
    await t.alerts.check();
    t.set([failing('shop/a', 3)]);
    await t.alerts.check();
    t.later(10);
    t.set([failing('shop/a', 3), failing('shop/b', 3)]);
    await t.alerts.check();
    t.later(30);
    t.set([failing('shop/a', 3), failing('shop/b', 3), failing('shop/c', 3)]);
    await t.alerts.check();
    expect(t.raised.map((a) => [a.items[0]?.title, a.quiet])).toEqual([
      ['shop/a failed 3 times in a row', false],
      ['shop/b failed 3 times in a row', true],
      ['shop/c failed 3 times in a row', false],
    ]);
  });

  it('holds alerts in focus mode and says them in one line when it ends, except alwaysInterrupt jobs', async () => {
    const t = setup({ alwaysInterrupt: ['shop/payments'] });
    await t.alerts.check();
    t.state.focusUntil = t.now() + 45 * 60_000;
    t.set([failing('shop/digest', 3), failing('site/build', 3)]);
    await t.alerts.check();
    expect(t.raised).toEqual([]);
    t.set([failing('shop/digest', 3), failing('site/build', 3), failing('shop/payments', 3)]);
    await t.alerts.check();
    expect(t.raised.map((a) => [a.kind, a.text, a.quiet])).toEqual([
      ['urgent', 'Heads up: shop/payments failed 3 times in a row.', false],
    ]);
    // site/build recovers during focus: not mentioned afterwards.
    t.set([failing('shop/digest', 3), failing('shop/payments', 3)]);
    t.later(46);
    await t.alerts.check();
    expect(t.raised[1]).toMatchObject({
      kind: 'focus-over',
      text: 'Focus time is over. While you were away: shop/digest failed 3 times in a row.',
      quiet: false,
    });
    await t.alerts.check();
    expect(t.raised).toHaveLength(2);
  });

  it('says an item again when it comes back, and ignores attention it could not read', async () => {
    const t = setup({ gapMinutes: 0 });
    await t.alerts.check();
    t.set([failing('shop/a', 3)]);
    await t.alerts.check();
    t.set([]);
    await t.alerts.check();
    t.set([failing('shop/a', 3)]);
    await t.alerts.check();
    expect(t.raised).toHaveLength(2);

    const broken = new Alerts({
      attention: async () => {
        throw new Error('gh down');
      },
      state: { focusUntil: 0 },
      gapMinutes: 0,
      alwaysInterrupt: [],
    });
    await expect(broken.check()).resolves.toBeUndefined();
  });

  it('does no work while no tab listens', async () => {
    let reads = 0;
    const alerts = new Alerts({
      attention: async () => {
        reads++;
        return { items: [], notes: [] };
      },
      state: { focusUntil: 0 },
      gapMinutes: 0,
      alwaysInterrupt: [],
    });
    await alerts.check();
    expect(reads).toBe(0);
    const stop = alerts.subscribe(() => {});
    await alerts.check();
    expect(reads).toBe(1);
    stop();
    await alerts.check();
    expect(reads).toBe(1);
  });

  it('reads several items as one line', () => {
    const items = [{ title: 'A failed' }, { title: 'B failed' }, { title: 'C failed' }];
    expect(alertText('urgent', items)).toBe('Heads up: 3 urgent items. A failed, and 2 more.');
    expect(alertText('focus-over', items.slice(0, 1))).toBe(
      'Focus time is over. While you were away: A failed.',
    );
  });
});
