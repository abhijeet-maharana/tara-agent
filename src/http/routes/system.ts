import { readFileSync } from 'node:fs';
import { parseVmHostSample, VMHOST_MAX_QUERY_DAYS, VmHostError } from '../../health/vmhost.js';
import type { ServerContext } from '../context.js';
import { HttpError, numParam, readJson } from '../io.js';
import { type Route, route } from '../router.js';

/**
 *   GET  /health                       ok, build, idle (safe to restart), job counts, usage-limit holds
 *   POST /drain                        {on?} stop starting scheduled and queue runs (x-tara-admin)
 *   GET  /health/checks, POST /health/check
 *   GET  /attention                    what needs the owner
 *   POST /vmhost/metrics               {name?, cpuTemp?, thermal?, cpu?, memUsed?, swapBytes?, pressure?, vmCpu?,
 *                                      vmMemBytes?, powerW?} the VM host's own figures (src/health/vmhost.ts)
 *   GET  /vmhost/metrics?hours=1       its reports over the last hours
 *   GET  /host/metrics?hours=1         this machine's own samples (load, memory, disk, swap; every 5 minutes)
 */
export function systemRoutes(c: ServerContext): Route<unknown>[] {
  const { options, now } = c;
  const { drain, health, attention } = options;
  let build: object | undefined;
  const hours = (url: URL) => numParam(url, 'hours', 1, 1, 24 * VMHOST_MAX_QUERY_DAYS);
  return [
    route('GET /health', () => {
      // Which code is running: dist/build.json from `npm run build` (src hash and time).
      build ??= (() => {
        try {
          return JSON.parse(readFileSync(new URL('../../build.json', import.meta.url), 'utf8')) as object;
        } catch {
          return {};
        }
      })();
      const jobs = options.projects.flatMap((p) => options.scheduler.list(p));
      const counts = options.health?.snapshot()?.counts;
      const drain = options.drain?.state();
      const busyJobs = jobs.filter((j) => j.running).length;
      return {
        ok: true,
        ...(Object.keys(build).length && { build }),
        // Safe to restart: no CLI process, no job running or waiting, no queue batch (see POST /drain).
        ...(drain && {
          idle: drain.liveRuns === 0 && busyJobs === 0 && drain.queueBatches === 0,
          draining: drain.draining,
          liveRuns: drain.liveRuns,
        }),
        ...(counts && { checks: counts }),
        uptimeSeconds: Math.floor((now() - c.started) / 1000),
        projects: options.projects,
        jobs: {
          total: jobs.length,
          enabled: jobs.filter((j) => j.enabled).length,
          running: jobs.filter((j) => j.running && !j.waitingFor).length,
          waiting: jobs.filter((j) => j.waitingFor).length,
        },
        // CLIs at their usage limit, and when scheduled runs on them start again.
        limits: Object.fromEntries(
          Object.entries(options.scheduler.holds?.active() ?? {}).map(([h, t]) => [
            h,
            new Date(t).toISOString(),
          ]),
        ),
      };
    }),
    // Before a restart: stop starting scheduled and queue runs, let running work finish, then restart
    // once `/health` says `idle`. Needs x-tara-admin (the deploy reads it as root, like jarvis-doctor).
    ...(drain
      ? [
          route('POST /drain', async ({ req }) => {
            c.adminHeader(req);
            const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
            drain.set(body.on !== false);
            return drain.state();
          }),
        ]
      : []),
    ...(health
      ? [
          route('GET /health/checks', async () => health.snapshot() ?? (await health.check())),
          route('POST /health/check', async () => {
            const { counts, checkedAt } = await health.check();
            return { counts, checkedAt };
          }),
        ]
      : []),
    ...(attention ? [route('GET /attention', () => attention())] : []),
    route('POST /vmhost/metrics', async ({ req }) => {
      try {
        options.store.addVmHostSample(parseVmHostSample(await readJson(req, 4_000), now()));
      } catch (err) {
        if (err instanceof VmHostError) throw new HttpError(400, err.message);
        throw err;
      }
      return { ok: true };
    }),
    route('GET /vmhost/metrics', ({ url }) => ({
      samples: options.store.vmHostSamples(now() - hours(url) * 3_600_000),
    })),
    route('GET /host/metrics', ({ url }) => ({
      samples: options.store.hostSamples(now() - hours(url) * 3_600_000),
    })),
  ];
}
