import { Cron } from 'croner';
import { addDays, dayKey } from '../../util/time.js';
import type { ServerContext } from '../context.js';
import { HttpError, iso, numParam, readJson, str } from '../io.js';
import { type Route, type RouteRequest, route } from '../router.js';
import { isDayKey } from '../schedule.js';

/** Most start times `GET /jobs?upcoming=` returns per job. */
const MAX_UPCOMING = 60;

/**
 *   GET  /jobs?project=<name>[&upcoming=<days>]   with `upcoming`, each job's start times over the next days
 *   POST /jobs/<project>/<id>/run      {"by": "who asked"}
 *   POST /jobs/<project>/<id>/pause    flips `enabled` off in the repo's .tara/jobs.json → {ok, enabled}
 *   POST /jobs/<project>/<id>/resume   flips it back on, effective at once
 *   POST /jobs/<project>/<id>/duration {"minutes": 20} sets `durationMinutes` in the jobs file
 *   GET  /jobs/<project>/<id>/runs?limit=15
 *   GET  /runs?limit=30                latest job runs of every project (no outputs)
 *   GET  /runs/<id>
 *   POST /reload                       re-read every .tara/jobs.json now
 *   GET  /queues?project=<name>&upcoming=10   a project's queues: next slot times and the kind that went last
 *   GET  /schedule?day=YYYY-MM-DD&project=<name>   one day's planned runs, overlaps and free windows
 *   GET  /schedule/conflicts?days=7    overlapping and back-to-back jobs over the next days
 */
export function jobRoutes(c: ServerContext): Route<unknown>[] {
  const { options, now, timeZone } = c;
  const { scheduler, store } = options;
  const unknownJob = (project: string, id: string) => new HttpError(404, `No job "${id}" in ${project}`);
  /** A job's runs without their outputs (just whether there is one). */
  const runList = (runs: ReturnType<typeof store.recentJobRuns>) =>
    runs.map(({ output, scriptOutput, ...run }) => ({ ...run, hasOutput: Boolean(output || scriptOutput) }));
  const pauseOrResume =
    (enabled: boolean) =>
    ({ params }: RouteRequest) => {
      const project = c.knownProject(params.project ?? '');
      if (scheduler.setEnabled(project, params.id ?? '', enabled) === 'unknown')
        throw unknownJob(project, params.id ?? '');
      return { ok: true, enabled };
    };

  return [
    route('GET /jobs', ({ url }) => {
      const project = c.knownProject(url.searchParams.get('project'));
      // `upcoming=<days>` adds each job's start times over the next days (for planning views).
      const days = numParam(url, 'upcoming', 0, 0, 31);
      const upcoming = days
        ? new Map(
            scheduler
              .plannedRuns(project, now(), now() + days * 86_400_000, MAX_UPCOMING)
              .map(({ id, starts }) => [
                id,
                starts.slice(0, MAX_UPCOMING).map((t) => new Date(t).toISOString()),
              ]),
          )
        : undefined;
      return {
        jobs: scheduler.list(project).map((j) => ({
          ...j,
          nextRun: iso(j.nextRun),
          lastRunAt: iso(j.lastRunAt),
          ...(upcoming && { upcoming: upcoming.get(j.id) ?? [] }),
        })),
      };
    }),
    route('POST /reload', () => {
      scheduler.reloadAll();
      return { ok: true };
    }),
    route('POST /jobs/:project/:id/run', async ({ req, params }) => {
      const project = c.knownProject(params.project ?? '');
      const by = str((await readJson(req)).by)?.slice(0, 60) ?? 'api';
      const result = scheduler.trigger(project, params.id ?? '', by);
      if (result === 'unknown') throw unknownJob(project, params.id ?? '');
      return { result };
    }),
    route('POST /jobs/:project/:id/pause', pauseOrResume(false)),
    route('POST /jobs/:project/:id/resume', pauseOrResume(true)),
    route('POST /jobs/:project/:id/duration', async ({ req, params }) => {
      const project = c.knownProject(params.project ?? '');
      const minutes = Number((await readJson(req)).minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600)
        throw new HttpError(400, '"minutes" must be a whole number from 1 to 600');
      if (scheduler.setDuration(project, params.id ?? '', minutes) === 'unknown')
        throw unknownJob(project, params.id ?? '');
      return { ok: true, minutes };
    }),
    route('GET /jobs/:project/:id/runs', ({ url, params }) => {
      const project = c.knownProject(params.project ?? '');
      return { runs: runList(store.jobRuns(project, params.id ?? '', numParam(url, 'limit', 15, 1, 100))) };
    }),
    route('GET /runs', ({ url }) => ({
      runs: runList(store.recentJobRuns(numParam(url, 'limit', 30, 1, 200))),
    })),
    route('GET /runs/:id', ({ params }) => {
      const run = store.getRun(Number(params.id));
      if (!run) throw new HttpError(404, 'No such run');
      return { run };
    }),
    // A project's queues for its own pages (a content calendar): the next slot times and the kind that
    // went last (slot queues take turns between kinds).
    route('GET /queues', ({ url }) => {
      const name = c.knownProject(url.searchParams.get('project'));
      const project = c.project(name);
      if (!project) throw new HttpError(404, 'No such project');
      const upcoming = Math.min(30, Number(url.searchParams.get('upcoming')) || 10);
      return {
        queues: Object.entries(c.queuesOf(project)).map(([queue, q]) => ({
          name: queue,
          executor: 'job' in q.executor ? 'job' : 'url' in q.executor ? 'url' : 'external',
          slots: q.slots,
          alternate: q.alternate,
          fills: q.fills,
          windows: q.windows,
          nextSlots: q.slots
            ? new Cron(q.slots, { timezone: q.tz ?? timeZone, paused: true })
                .nextRuns(upcoming)
                .map((d) => d.getTime())
            : [],
          lastKind: store.lastQueueStart(name, queue)?.kind ?? null,
        })),
      };
    }),
    route('GET /schedule', ({ url }) => {
      const day = url.searchParams.get('day');
      return c.dayPlan(isDayKey(day) ? day : dayKey(now(), timeZone), c.optionalProject(url));
    }),
    route('GET /schedule/conflicts', ({ url }) => {
      const days = numParam(url, 'days', 7, 1, 31);
      const today = dayKey(now(), timeZone);
      return {
        days: Array.from({ length: days }, (_, i) => {
          const day = addDays(today, i);
          const plan = c.dayPlan(day);
          const slot = ({ project, id, name, start, minutes }: (typeof plan.slots)[number]) => ({
            project,
            id,
            name,
            start: new Date(start).toISOString(),
            minutes,
          });
          return {
            day,
            runs: plan.slots.length,
            overlaps: plan.overlaps.map(({ a, b }) => ({ a: slot(a), b: slot(b) })),
            tight: plan.tight.map(({ a, b, gapMinutes }) => ({ a: slot(a), b: slot(b), gapMinutes })),
            free: plan.free.map((f) => ({
              start: new Date(f.start).toISOString(),
              end: new Date(f.end).toISOString(),
            })),
          };
        }),
      };
    }),
  ];
}
