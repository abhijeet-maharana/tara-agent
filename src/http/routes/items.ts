import type { Approvals, ProposeInput } from '../../approvals/approvals.js';
import { ITEM_STATUSES, type ItemStatus } from '../../store/store.js';
import { safeMediaUrl, sessionLink } from '../approvals.js';
import type { ServerContext } from '../context.js';
import { arr, HttpError, readJson, str } from '../io.js';
import { type Route, route } from '../router.js';

/** Approval items carry drafts (emails, posts), so they may be bigger than other requests. */
export const ITEM_BODY_LIMIT = 200_000;
/** Enough for a job application form: the note, every question and the resume. */
const MAX_FIELDS = 40;

/** Checks a proposed item from the API or a run; returns the input or throws 400. */
export function itemInput(body: Record<string, unknown>): ProposeInput {
  const need = (v: unknown, name: string) => {
    const s = str(v);
    if (!s) throw new HttpError(400, `"${name}" is required`);
    return s;
  };
  const runAfter =
    typeof body.runAfter === 'number'
      ? body.runAfter
      : str(body.runAfter)
        ? Date.parse(body.runAfter as string)
        : undefined;
  if (Number.isNaN(runAfter)) throw new HttpError(400, '"runAfter" must be a time');
  if (body.priority !== undefined && body.priority !== null && !Number.isFinite(body.priority))
    throw new HttpError(400, '"priority" must be a number');
  return {
    kind: need(body.kind, 'kind').slice(0, 40),
    key: str(body.key)?.slice(0, 120),
    title: need(body.title, 'title'),
    body: str(body.body)?.slice(0, 8_000),
    queue: need(body.queue, 'queue'),
    window: str(body.window),
    runAfter,
    priority: typeof body.priority === 'number' ? body.priority : undefined,
    options: arr(body.options).filter((o): o is string => typeof o === 'string'),
    fields: arr(body.fields)
      .slice(0, MAX_FIELDS)
      .map((f: Record<string, unknown>) => ({
        key: need(f?.key, 'fields[].key'),
        label: str(f?.label) ?? String(f?.key),
        type: f?.type === 'text' || f?.type === 'list' ? f.type : 'textarea',
        value: Array.isArray(f?.value) ? (f.value as unknown[]).map(String) : String(f?.value ?? ''),
        maxLength: typeof f?.maxLength === 'number' ? f.maxLength : undefined,
        required: f?.required === true || undefined,
        readOnly: f?.readOnly === true || undefined,
      })),
    checks: arr(body.checks)
      .slice(0, 20)
      .map((c: Record<string, unknown>) => ({ text: String(c?.text ?? ''), blocking: c?.blocking === true })),
    media: arr(body.media)
      .slice(0, 20)
      .map((m: Record<string, unknown>) => {
        const url = need(m?.url, 'media[].url');
        const poster = str(m?.poster);
        if (!safeMediaUrl(url) || (poster && !safeMediaUrl(poster)))
          throw new HttpError(400, 'media[].url and poster must be http(s) URLs or paths starting with /');
        return {
          type: m?.type === 'video' || m?.type === 'file' ? (m.type as 'video' | 'file') : ('image' as const),
          url,
          caption: str(m?.caption),
          poster,
        };
      }),
  };
}

/**
 * Approval items (cards), for project servers and the Approvals page:
 *   GET  /items?project=&kind=&status=a,b&since=&limit=200
 *   POST /items                        {project, kind, title, queue, …} propose (see itemInput); `thread` puts
 *                                      the card in that run's thread
 *   POST /items/ask                    {project, title, details?, options?} ask a person outside any run
 *   POST /items/bulk                   {ids, option, seen?} decide many (unlocked browser)
 *   GET  /items/<id>
 *   POST /items/<id>/decide            {option, fields?, reply?, runNow?, seen?, session?} (unlocked browser)
 *   POST /items/<id>/note              {text} a note to Jarvis in the card's thread (unlocked browser)
 *   POST /items/<id>/withdraw          {reason?}
 *   POST /items/<id>/report            {status: done|failed|waiting, result?} for `external` queues
 *   POST /items/<id>/cancel, /move     {to: up|down|top|bottom|<place>} (unlocked browser)
 */
export function itemRoutes(c: ServerContext, approvals: Approvals): Route<unknown>[] {
  const { store } = c.options;
  /** Who a decision is recorded as: the item's project owner, else the browser. */
  const decider = (req: Parameters<typeof c.human>[0], id: string) => {
    const by = c.human(req);
    return c.owner(id) ?? by;
  };
  return [
    route('GET /items', ({ url }) => {
      const statuses = (url.searchParams.get('status') ?? '')
        .split(',')
        .filter((x): x is ItemStatus => (ITEM_STATUSES as readonly string[]).includes(x));
      return {
        items: store.items({
          project: c.optionalProject(url),
          kind: url.searchParams.get('kind') ?? undefined,
          statuses: statuses.length ? statuses : undefined,
          since: Number(url.searchParams.get('since')) || undefined,
          limit: Math.min(500, Number(url.searchParams.get('limit')) || 200),
        }),
      };
    }),
    // A project server proposing a draft (e.g. the next follow-up). Proposing is harmless: it still
    // needs a person to approve it, unless the host's `autoApprove` lets the project's own server say no
    // person is needed (approvals.ts askAutoApprove).
    route('POST /items', async ({ req }) => {
      const body = await readJson(req, ITEM_BODY_LIMIT);
      const project = approvals.project(c.knownProject(str(body.project) ?? null));
      const input = { ...itemInput(body), autoApprove: body.autoApprove === true };
      // `thread`: the TARA_THREAD of the run the server works for; the card goes in that run's thread.
      const thread = approvals.runThread(project, str(body.thread));
      return {
        item: await approvals.propose(project, input, {
          source: str(body.source),
          channel: thread?.channel,
          threadTs: thread?.threadTs,
        }),
      };
    }),
    // A project server asking a person outside any run (a login expired, a send bounced). It only asks:
    // whatever the person picks goes to the agent in the card's thread.
    route('POST /items/ask', async ({ req }) => {
      const body = await readJson(req);
      const project = approvals.project(c.knownProject(str(body.project) ?? null));
      const title = str(body.title);
      if (!title) throw new HttpError(400, '"title" is required');
      return {
        item: await approvals.ask(
          project,
          {
            title,
            details: str(body.details) ?? '',
            options: arr(body.options).filter((o): o is string => typeof o === 'string'),
            kind: str(body.kind)?.slice(0, 40),
            key: str(body.key)?.slice(0, 120),
          },
          approvals.runThread(project, str(body.thread)),
        ),
      };
    }),
    route('POST /items/bulk', async ({ req }) => {
      const by = c.human(req);
      const body = await readJson(req);
      const ids = arr(body.ids)
        .filter((i): i is string => typeof i === 'string')
        .slice(0, 200);
      const option = str(body.option);
      if (!option) throw new HttpError(400, '"option" is required');
      const seen = body.seen && typeof body.seen === 'object' ? (body.seen as Record<string, unknown>) : {};
      const decided: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const id of ids) {
        try {
          await approvals.decide(id, {
            option,
            by: c.owner(id) ?? by,
            via: 'dashboard',
            seen: typeof seen[id] === 'number' ? seen[id] : undefined,
          });
          decided.push(id);
        } catch (err) {
          failed.push({ id, error: (err as Error).message });
        }
      }
      return { decided, failed };
    }),
    route('GET /items/:id', ({ params }) => {
      const item = store.getItem(params.id ?? '');
      if (!item) throw new HttpError(404, 'No such item');
      return { item };
    }),
    route('POST /items/:id/decide', async ({ req, params }) => {
      const id = params.id ?? '';
      const by = decider(req, id);
      const body = await readJson(req, ITEM_BODY_LIMIT);
      const fields =
        body.fields && typeof body.fields === 'object'
          ? (body.fields as Record<string, string | string[]>)
          : undefined;
      return {
        item: await approvals.decide(id, {
          option: str(body.option) ?? '',
          by,
          via: 'dashboard',
          fields,
          reply: str(body.reply),
          runNow: body.runNow === true,
          seen: typeof body.seen === 'number' ? body.seen : undefined,
          session: body.session === 'new' || body.session === 'continue' ? body.session : undefined,
        }),
      };
    }),
    // A note about a waiting card without deciding it: to Jarvis in the card's thread, whose session page
    // (`session`) shows the answer live.
    route('POST /items/:id/note', async ({ req, params }) => {
      const id = params.id ?? '';
      const by = decider(req, id);
      const text = str((await readJson(req)).text)?.slice(0, 4_000);
      if (!text) throw new HttpError(400, '"text" is required');
      const item = await approvals.note(id, text, by);
      return { ok: true, version: item.updatedAt, session: sessionLink(item) };
    }),
    route('POST /items/:id/withdraw', async ({ req, params }) => {
      const body = await readJson(req);
      return { item: approvals.withdraw(params.id ?? '', str(body.reason)) };
    }),
    // A project server reporting an item it runs itself (an `external` queue). Not a decision: the item
    // was approved by a person already, and the project acts on its own records.
    route('POST /items/:id/report', async ({ req, params }) => {
      const body = await readJson(req);
      const status = body.status;
      if (status !== 'done' && status !== 'failed' && status !== 'waiting')
        throw new HttpError(400, '"status" must be done, failed or waiting');
      return { item: approvals.report(params.id ?? '', status, str(body.result)) };
    }),
    route('POST /items/:id/cancel', ({ req, params }) => ({
      item: approvals.cancel(params.id ?? '', decider(req, params.id ?? '')),
    })),
    route('POST /items/:id/move', async ({ req, params }) => {
      c.human(req);
      const to = (await readJson(req)).to;
      if (
        !(typeof to === 'number' && Number.isInteger(to) && to >= 0) &&
        to !== 'up' &&
        to !== 'down' &&
        to !== 'top' &&
        to !== 'bottom'
      )
        throw new HttpError(400, '"to" must be up, down, top, bottom or a place (0 is first)');
      return { item: approvals.move(params.id ?? '', to) };
    }),
  ];
}
