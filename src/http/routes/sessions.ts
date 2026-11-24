import { isWebChannel } from '../../web/chat.js';
import { slackSummaryOf } from '../../web/summary.js';
import type { ServerContext } from '../context.js';
import { HttpError, numParam, readJson, str } from '../io.js';
import { type Route, route } from '../router.js';

/**
 *   GET  /sessions?project=<name>&limit=30   latest sessions with their last run
 *   GET  /sessions/<id>/transcript     the conversation as JSON (prompts, replies, tool calls and results)
 *   GET  /sessions/<id>/live           {running, task}: the run working in its thread now
 *   POST /sessions/<id>/stop           the session page's Stop (unlocked browser)
 *   POST /sessions/<id>/message        {text} continues that session's thread as its owner; needs the
 *                                      header `x-tara-admin: <TARA_ADMIN_TOKEN>` (for a person's own Claude
 *                                      fixing a run, never for runs)
 *   POST /sessions/<id>/say            {text} the session page's reply box (unlocked browser)
 */
export function sessionRoutes(c: ServerContext): Route<unknown>[] {
  const { options } = c;
  const { store } = options;
  /** The session's thread, or 404. */
  const threadOf = (sessionId: string) => {
    const session = store.sessionsOverview({ sessionId, limit: 1 })[0];
    const at = session?.threadKey.indexOf(':') ?? -1;
    if (!session || at < 1) throw new HttpError(404, 'No thread for this session');
    const channel = session.threadKey.slice(0, at);
    const threadTs = session.threadKey.slice(at + 1);
    if (!threadTs) throw new HttpError(404, 'No thread for this session');
    return { session, channel, threadTs, project: c.project(session.project) };
  };
  const continueThread = () => {
    if (!options.continueThread) throw new HttpError(404, 'Chat is not running');
    return options.continueThread;
  };

  return [
    route('GET /sessions', ({ url }) => ({
      sessions: store.sessionsOverview({
        project: c.optionalProject(url),
        limit: numParam(url, 'limit', 30, 1, 200),
      }),
    })),
    route('GET /sessions/:id/transcript', ({ params }) => {
      const entries = c.transcript(params.id ?? '');
      if (!entries) throw new HttpError(404, 'No transcript for this session on this host');
      return { sessionId: params.id, entries };
    }),
    route('GET /sessions/:id/live', ({ params }) => {
      const task = c.liveTask(params.id ?? '');
      return { running: task?.status === 'running', task: task ?? null };
    }),
    // The session page's Stop: ends the run as "stop" in its Slack thread would.
    route('POST /sessions/:id/stop', ({ req, params }) => {
      c.human(req);
      const task = c.liveTask(params.id ?? '');
      if (task?.status !== 'running' || !options.activity?.stop(task.id))
        throw new HttpError(409, 'Nothing is running in this session');
      return { ok: true };
    }),
    route('POST /sessions/:id/message', async ({ req, params }) => {
      c.adminHeader(req);
      const send = continueThread();
      const text = str((await readJson(req)).text);
      if (!text) throw new HttpError(400, '"text" is required');
      const { session, channel, threadTs, project } = threadOf(params.id ?? '');
      void send({ channel, threadTs, ts: threadTs, user: project?.config.owner ?? 'admin', text });
      return { ok: true, threadKey: session.threadKey };
    }),
    // The session page's reply box: as the project's owner, from an unlocked browser. A session Slack
    // shows (a Slack thread, or a dashboard run with a Slack summary) gets the message there too, as the
    // owner, and the answer there (`Approvals.sayFromDashboard`); a dashboard-only one answers here.
    route('POST /sessions/:id/say', async ({ req, params }) => {
      c.human(req);
      const send = continueThread();
      const text = str((await readJson(req)).text)?.slice(0, 20_000);
      if (!text) throw new HttpError(400, '"text" is required');
      const { session, channel, threadTs, project } = threadOf(params.id ?? '');
      const user = project?.config.owner ?? 'dashboard';
      const onDashboard = isWebChannel(channel);
      const ts =
        onDashboard && options.web ? await options.web.post(channel, threadTs, text, user) : threadTs;
      // Slack shows this session too (its own thread, or a dashboard run's summary thread): your
      // message goes there, as you, and Jarvis answers it there, so Slack never has only the answer.
      const slackChannel = project?.config.slackChannel;
      const summaryTs =
        onDashboard && slackChannel ? slackSummaryOf(store, slackChannel, channel, threadTs) : undefined;
      const inSlack = !onDashboard
        ? { channel, threadTs }
        : slackChannel && summaryTs
          ? { channel: slackChannel, threadTs: summaryTs }
          : undefined;
      const said =
        inSlack && options.approvals
          ? options.approvals.sayFromDashboard(inSlack, text, user)
          : send({ channel, threadTs, ts, user, text });
      void said.catch((err: Error) => options.log.warn(`reply in ${session.threadKey}: ${err.message}`));
      return { ok: true, threadKey: session.threadKey };
    }),
  ];
}
