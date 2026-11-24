import type { Reminders } from '../../reminders/reminders.js';
import type { ServerContext } from '../context.js';
import { HttpError, readJson, str } from '../io.js';
import { type Route, route } from '../router.js';

/**
 *   GET  /reminders?project=<name>     reminders still to come, soonest first
 *   POST /reminders/<project>          {text, cron? | at?, notify?, task?, title?, by?} → the reminder
 *   POST /reminders/<project>/<id>/cancel
 */
export function reminderRoutes(c: ServerContext, reminders: Reminders): Route<unknown>[] {
  return [
    route('GET /reminders', ({ url }) => ({
      reminders: reminders.list(c.knownProject(url.searchParams.get('project'))),
    })),
    route('POST /reminders/:project', async ({ req, params }) => {
      const body = await readJson(req);
      return reminders.add(c.knownProject(params.project ?? ''), {
        text: str(body.text) ?? '',
        cron: str(body.cron),
        at: typeof body.at === 'number' ? body.at : str(body.at),
        notify: body.notify === true,
        task: body.task === true,
        title: str(body.title),
        by: str(body.by)?.slice(0, 60) ?? 'api',
      });
    }),
    route('POST /reminders/:project/:id/cancel', ({ params }) => {
      if (!reminders.cancel(c.knownProject(params.project ?? ''), params.id ?? ''))
        throw new HttpError(404, `No reminder "${params.id}" to come`);
      return { ok: true };
    }),
  ];
}
