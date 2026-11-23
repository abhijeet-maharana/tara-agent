/**
 * The VM host: the machine tara-agent's VM runs on (e.g. a Mac running it in UTM). tara-agent only
 * sees inside the VM, so the host reports its own numbers (`POST /vmhost/metrics`, every 5 minutes
 * from examples/macos-desk-widget/lib/post-metrics.sh). They show on the Health page (checks and
 * trends).
 */
import { ago, type Check, type HealthStatus } from './monitor.js';

export const THERMAL = ['nominal', 'fair', 'serious', 'critical'] as const;
export const PRESSURE = ['normal', 'warn', 'critical'] as const;
export type Thermal = (typeof THERMAL)[number];
export type Pressure = (typeof PRESSURE)[number];

export interface VmHostSample {
  at: number;
  /** What the host calls itself, e.g. "MacBook Air". */
  name?: string;
  /** CPU temperature, °C. */
  cpuTemp?: number;
  /** The OS's thermal state: serious and critical mean it is slowing the CPU down. */
  thermal?: Thermal;
  /** Share of the host's CPU in use, 0–1. */
  cpu?: number;
  /** Share of the host's RAM in use, 0–1. */
  memUsed?: number;
  swapBytes?: number;
  /** The OS's memory pressure. */
  pressure?: Pressure;
  /** The VM's share of the host's CPU, 0–1. */
  vmCpu?: number;
  vmMemBytes?: number;
  /** Power drawn, watts. */
  powerW?: number;
  /** Seconds since the host's keyboard or mouse was last used: small means someone is at it. */
  idleSec?: number;
}

/** The host reports every 5 minutes: silent this long is a warning, then an alert. */
export const VMHOST_WARN_MS = 15 * 60_000;
export const VMHOST_BAD_MS = 60 * 60_000;
/** Swap this large on the host means the VM and the host's own apps don't fit in its RAM. */
const SWAP_WARN_BYTES = 4 * 1024 ** 3;
/** The most history `GET /vmhost/metrics` returns; samples are kept for host `retentionDays`. */
export const VMHOST_MAX_QUERY_DAYS = 366;

export class VmHostError extends Error {}

const num = (v: unknown, name: string, min: number, max: number): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new VmHostError(`"${name}" must be a number from ${min} to ${max}`);
  return v;
};
const oneOf = <T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T))
    throw new VmHostError(`"${name}" must be one of ${allowed.join(', ')}`);
  return v as T;
};

/** A report from the host, checked field by field; every field is optional, unknown ones are ignored. */
export function parseVmHostSample(body: Record<string, unknown>, at: number): VmHostSample {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : undefined;
  const s: VmHostSample = {
    at,
    ...(name && { name }),
    cpuTemp: num(body.cpuTemp, 'cpuTemp', -20, 150),
    thermal: oneOf(body.thermal, 'thermal', THERMAL),
    cpu: num(body.cpu, 'cpu', 0, 1),
    memUsed: num(body.memUsed, 'memUsed', 0, 1),
    swapBytes: num(body.swapBytes, 'swapBytes', 0, 2 ** 50),
    pressure: oneOf(body.pressure, 'pressure', PRESSURE),
    vmCpu: num(body.vmCpu, 'vmCpu', 0, 1),
    vmMemBytes: num(body.vmMemBytes, 'vmMemBytes', 0, 2 ** 50),
    powerW: num(body.powerW, 'powerW', 0, 10_000),
    idleSec: num(body.idleSec, 'idleSec', 0, 10 ** 9),
  };
  for (const k of Object.keys(s) as Array<keyof VmHostSample>) if (s[k] === undefined) delete s[k];
  if (!Object.keys(s).some((k) => k !== 'at' && k !== 'name'))
    throw new VmHostError('No figures in the report');
  return s;
}

const pct = (n: number) => `${Math.round(n * 100)} %`;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** One line of figures, e.g. "58 °C · CPU 23 % · RAM 92 % · swap 0.8 GB · VM 31 % CPU, 5.9 GB · 6.1 W". */
export function vmHostLine(s: VmHostSample): string {
  const vm = [s.vmCpu !== undefined && `${pct(s.vmCpu)} CPU`, s.vmMemBytes !== undefined && gb(s.vmMemBytes)]
    .filter(Boolean)
    .join(', ');
  return [
    s.cpuTemp !== undefined && `${Math.round(s.cpuTemp)} °C`,
    s.cpu !== undefined && `CPU ${pct(s.cpu)}`,
    s.memUsed !== undefined && `RAM ${pct(s.memUsed)}`,
    s.swapBytes !== undefined && s.swapBytes > 0 && `swap ${gb(s.swapBytes)}`,
    vm && `VM ${vm}`,
    s.powerW !== undefined && `${s.powerW.toFixed(1)} W`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The VM host's rows on the Health page: whether it still reports, its heat (the OS slowing the CPU
 * down) and its memory (pressure, swap). No rows when it never reported.
 */
export function vmHostChecks(last: VmHostSample | undefined, at: number): Check[] {
  if (!last) return [];
  const group = 'VM host';
  const who = last.name ?? 'Host';
  const quiet = at - last.at;
  const out: Check[] = [
    {
      key: 'tara:vmhost:link',
      group,
      name: `${who}: reports`,
      status: quiet >= VMHOST_BAD_MS ? 'bad' : quiet >= VMHOST_WARN_MS ? 'warn' : 'ok',
      detail:
        quiet >= VMHOST_WARN_MS
          ? `Not heard from for ${ago(quiet)}: its reporting job stopped, or it can't reach tara-agent`
          : `Reported ${ago(quiet)} ago · ${vmHostLine(last) || 'no figures'}`,
    },
  ];
  // Stale figures say nothing about now: only the link row then.
  if (quiet >= VMHOST_WARN_MS) return out;
  if (last.thermal || last.cpuTemp !== undefined) {
    const status: HealthStatus =
      last.thermal === 'critical' ? 'bad' : last.thermal === 'serious' ? 'warn' : 'ok';
    const temp = last.cpuTemp !== undefined ? `${Math.round(last.cpuTemp)} °C` : '';
    out.push({
      key: 'tara:vmhost:heat',
      group,
      name: `${who}: heat`,
      status,
      detail:
        status === 'ok'
          ? [temp, last.thermal && `thermal ${last.thermal}`].filter(Boolean).join(' · ')
          : `Thermal ${last.thermal}: the host is slowing its CPU down${temp ? ` (${temp})` : ''}; runs get slower`,
    });
  }
  if (last.pressure || last.memUsed !== undefined || last.swapBytes !== undefined) {
    const swap = last.swapBytes ?? 0;
    const status: HealthStatus =
      last.pressure === 'critical'
        ? 'bad'
        : last.pressure === 'warn' || swap >= SWAP_WARN_BYTES
          ? 'warn'
          : 'ok';
    const figures = [
      last.memUsed !== undefined && `RAM ${pct(last.memUsed)}`,
      swap > 0 && `swap ${gb(swap)}`,
      last.vmMemBytes !== undefined && `VM ${gb(last.vmMemBytes)}`,
      last.pressure && `pressure ${last.pressure}`,
    ]
      .filter(Boolean)
      .join(' · ');
    out.push({
      key: 'tara:vmhost:memory',
      group,
      name: `${who}: memory`,
      status,
      detail:
        status === 'ok'
          ? figures
          : `${last.pressure === 'normal' || !last.pressure ? 'Swapping' : `Memory pressure ${last.pressure}`}: the VM and the host's own apps don't fit in its RAM (${figures})`,
    });
  }
  return out;
}
