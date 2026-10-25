import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { planDay } from '../src/http/schedule.js';
import { startHttpServer } from '../src/http/server.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';
import { addDays, dayKey, midnight } from '../src/util/time.js';

const MIN = 60_000;

describe('schedule days', () => {
  it('finds midnight in the host timezone', () => {
    const start = midnight('2026-10-25', 'Asia/Kolkata');
    expect(new Date(start).toISOString()).toBe('2026-10-24T18:30:00.000Z');
    expect(dayKey(start, 'Asia/Kolkata')).toBe('2026-10-25');
    expect(dayKey(start - 1, 'Asia/Kolkata')).toBe('2026-10-24');
    // A 25-hour day: London leaves summer time on 25 Oct 2026.
    expect(midnight('2026-10-26', 'Europe/London') - midnight('2026-10-25', 'Europe/London')).toBe(
      25 * 60 * MIN,
    );
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('plans a day: overlaps, tight gaps, free windows, runs that happened and jobs that run often', () => {
    const start = Date.UTC(2026, 9, 25);
    const end = start + 1440 * MIN;
    const at = (h: number, m = 0) => start + (h * 60 + m) * MIN;
    const plan = planDay(
      [
        { project: 'shop', id: 'labels', name: 'Labels', durationMinutes: 30, starts: [at(9)] },
        { project: 'shop', id: 'sla', name: 'SLA', starts: [at(9, 20)] }, // overlaps Labels
        { project: 'jobs', id: 'scout', name: 'Scout', durationMinutes: 10, starts: [at(9, 40)] }, // 5 min after SLA
        { project: 'shop', id: 'poll', name: 'Poll', starts: Array.from({ length: 13 }, (_, i) => at(i)) },
      ],
      [
        {
          id: 7,
          kind: 'job',
          project: 'shop',
          jobId: 'labels',
          startedAt: at(9) + 4_000,
          endedAt: at(9, 25),
          status: 'ok',
        },
      ],
      start,
      end,
    );
    expect(plan.slots.map((s) => s.name)).toEqual(['Labels', 'SLA', 'Scout']);
    expect(plan.slots[0]?.run?.id).toBe(7);
    expect(plan.slots[1]?.minutes).toBe(15); // default length
    expect(plan.overlaps.map(({ a, b }) => `${a.name}/${b.name}`)).toEqual(['Labels/SLA']);
    expect(plan.tight.map(({ a, b, gapMinutes }) => `${a.name}/${b.name}/${gapMinutes}`)).toEqual([
      'SLA/Scout/5',
    ]);
    expect(plan.often).toEqual([{ project: 'shop', id: 'poll', name: 'Poll', runs: 13 }]);
    expect(plan.busyMinutes).toBe(30 + 5 + 10); // 9:00-9:35 and 9:40-9:50
    expect(plan.free.map((f) => [(f.start - start) / MIN, (f.end - start) / MIN])).toEqual([
      [0, 540],
      [590, 1440],
    ]);
  });
});

describe('dashboard token', () => {
  it('lets a browser in once with ?token=, then by cookie; scripts still use the bearer header', async () => {
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      token: 's3cret',
      scheduler: { list: () => [] } as unknown as Scheduler,
      store: new Store(':memory:'),
      projects: ['shop'],
      log: { info() {}, warn() {}, error() {} },
      dashboard: { projects: [], timeZone: 'UTC', agentName: 'Jarvis' },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const html = { accept: 'text/html' };
    expect((await fetch(`${base}/inbox`, { headers: html })).status).toBe(401);
    expect((await fetch(`${base}/inbox`)).status).toBe(401);

    const login = await fetch(`${base}/inbox?token=s3cret`, { headers: html, redirect: 'manual' });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/inbox');
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const page = await fetch(`${base}/inbox`, { headers: { ...html, cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<h1>Inbox</h1>');

    const api = await fetch(`${base}/inbox`, { headers: { authorization: 'Bearer s3cret' } });
    expect(await api.json()).toEqual({ tasks: [] });
    server.close();
  });
});
