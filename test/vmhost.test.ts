import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseVmHostSample, type VmHostSample, vmHostChecks, vmHostLine } from '../src/health/vmhost.js';
import { startHttpServer } from '../src/http/server.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';

const silent = { info() {}, warn() {}, error() {} };
const AT = Date.parse('2026-11-21T17:00:00Z');
const MIN = 60_000;
const GB = 1024 ** 3;

const mac: VmHostSample = {
  at: AT,
  name: 'MacBook Air',
  cpuTemp: 58.4,
  thermal: 'nominal',
  cpu: 0.23,
  memUsed: 0.92,
  swapBytes: 0.8 * GB,
  pressure: 'normal',
  vmCpu: 0.31,
  vmMemBytes: 5.9 * GB,
  powerW: 6.1,
  idleSec: 12,
};

describe('parseVmHostSample', () => {
  it('keeps known figures, trims the name and ignores unknown fields', () => {
    const { at: _, ...body } = mac;
    expect(parseVmHostSample({ ...body, name: '  MacBook Air  ', extra: 1 }, AT)).toEqual(mac);
  });

  it('takes a report with only some figures', () => {
    expect(parseVmHostSample({ cpuTemp: 61 }, AT)).toEqual({ at: AT, cpuTemp: 61 });
  });

  it('refuses figures out of range, unknown states and empty reports', () => {
    expect(() => parseVmHostSample({ cpu: 23 }, AT)).toThrow('"cpu" must be a number from 0 to 1');
    expect(() => parseVmHostSample({ thermal: 'hot' }, AT)).toThrow('"thermal" must be one of');
    expect(() => parseVmHostSample({ cpuTemp: '58' }, AT)).toThrow('"cpuTemp" must be a number');
    expect(() => parseVmHostSample({ idleSec: -1 }, AT)).toThrow('"idleSec" must be a number');
    expect(() => parseVmHostSample({ name: 'Mac' }, AT)).toThrow('No figures in the report');
  });
});

describe('vmHostLine', () => {
  it('reads as one line of figures', () => {
    expect(vmHostLine(mac)).toBe('58 °C · CPU 23 % · RAM 92 % · swap 0.8 GB · VM 31 % CPU, 5.9 GB · 6.1 W');
    expect(vmHostLine({ at: AT, cpuTemp: 50, swapBytes: 0 })).toBe('50 °C');
  });
});

describe('vmHostChecks', () => {
  const status = (s: VmHostSample, at = AT + MIN) =>
    Object.fromEntries(vmHostChecks(s, at).map((c) => [c.key.split(':').at(-1), c.status]));

  it('has no rows when the host never reported', () => {
    expect(vmHostChecks(undefined, AT)).toEqual([]);
  });

  it('shows the link, heat and memory of a fresh report', () => {
    const rows = vmHostChecks(mac, AT + 2 * MIN);
    expect(rows.map((c) => [c.group, c.name, c.status])).toEqual([
      ['VM host', 'MacBook Air: reports', 'ok'],
      ['VM host', 'MacBook Air: heat', 'ok'],
      ['VM host', 'MacBook Air: memory', 'ok'],
    ]);
    expect(rows[0]?.detail).toBe(`Reported 2m ago · ${vmHostLine(mac)}`);
  });

  it('warns while the host slows its CPU down or swaps hard, and alerts when critical', () => {
    expect(status({ ...mac, thermal: 'serious' }).heat).toBe('warn');
    expect(status({ ...mac, thermal: 'critical' }).heat).toBe('bad');
    expect(status({ ...mac, pressure: 'warn' }).memory).toBe('warn');
    expect(status({ ...mac, swapBytes: 6 * GB }).memory).toBe('warn');
    expect(status({ ...mac, pressure: 'critical' }).memory).toBe('bad');
    expect(vmHostChecks({ ...mac, thermal: 'serious' }, AT)[1]?.detail).toBe(
      'Thermal serious: the host is slowing its CPU down (58 °C); runs get slower',
    );
  });

  it('shows only the link once reports stop, warning then alerting', () => {
    expect(status(mac, AT + 20 * MIN)).toEqual({ link: 'warn' });
    expect(status(mac, AT + 61 * MIN)).toEqual({ link: 'bad' });
    expect(vmHostChecks(mac, AT + 20 * MIN)[0]?.detail).toContain('Not heard from for 20m');
  });
});

describe('VM host store', () => {
  it('keeps reports, returns the latest and forgets them after the retention days', () => {
    let now = AT;
    const store = new Store(':memory:', () => now);
    expect(store.lastVmHostSample()).toBeUndefined();
    store.addVmHostSample({ at: AT - 100 * 86_400_000, cpuTemp: 40 });
    store.addVmHostSample({ at: AT - 40 * 86_400_000, cpuTemp: 41 });
    store.addVmHostSample({ ...mac, at: AT - 5 * MIN, thermal: 'fair' });
    store.addVmHostSample(mac);
    expect(store.lastVmHostSample()).toEqual(mac);
    expect(store.vmHostSamples(AT - 10 * MIN).map((s) => s.thermal)).toEqual(['fair', 'nominal']);
    now = AT + MIN;
    // Kept as long as runs (host retentionDays, 90 here), not just a month.
    store.prune(AT - 90 * 86_400_000);
    expect(store.vmHostSamples(0).map((s) => s.cpuTemp)).toEqual([41, 58.4, 58.4]);
  });
});

describe('Machine samples', () => {
  it('keep swap when known, and are listed by GET /host/metrics', async () => {
    const store = new Store(':memory:');
    const now = Date.now();
    store.addHostSample({ at: now - 10 * MIN, load: 0.5, memUsed: 0.4, diskUsed: 0.3 });
    store.addHostSample({ at: now - 5 * MIN, load: 1.2, memUsed: 0.7, diskUsed: 0.3, swapUsed: 0.25 });
    expect(store.hostSamples(0)).toEqual([
      { at: now - 10 * MIN, load: 0.5, memUsed: 0.4, diskUsed: 0.3 },
      { at: now - 5 * MIN, load: 1.2, memUsed: 0.7, diskUsed: 0.3, swapUsed: 0.25 },
    ]);
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store,
      projects: [],
      log: silent,
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const listed = (await fetch(`${base}/host/metrics?hours=1`).then((r) => r.json())) as {
        samples: Array<{ swapUsed?: number }>;
      };
      expect(listed.samples.map((s) => s.swapUsed)).toEqual([undefined, 0.25]);
    } finally {
      server.close();
    }
  });
});

describe('VM host API', () => {
  it('stores a POSTed report, lists it and refuses bad ones', async () => {
    const store = new Store(':memory:');
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store,
      projects: [],
      log: silent,
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: object) =>
      fetch(`${base}/vmhost/metrics`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({
        status: r.status,
        json: await r.json(),
      }));
    try {
      const { at: _, ...body } = mac;
      expect(await post(body)).toEqual({ status: 200, json: { ok: true } });
      expect(await post({ cpu: 2 })).toEqual({
        status: 400,
        json: { error: '"cpu" must be a number from 0 to 1' },
      });
      const listed = (await fetch(`${base}/vmhost/metrics?hours=2`).then((r) => r.json())) as {
        samples: VmHostSample[];
      };
      expect(listed.samples.map((s) => s.name)).toEqual(['MacBook Air']);
    } finally {
      server.close();
    }
  });
});
