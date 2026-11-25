import type { Bridge, DataOp } from '../../bridge/bridge.js';
import { HttpError, readJson, str } from '../io.js';
import { type Route, type RouteRequest, route } from '../router.js';
import { ITEM_BODY_LIMIT, itemInput } from './items.js';

/** A Write or Edit's input holds the whole file: a small cap would silently deny every large write. */
const PERMISSION_BODY_LIMIT = 5_000_000;

const required = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${name}" is required`);
  return v;
};

/**
 * For tara's own MCP server (src/mcp/server.ts), authenticated by the header `x-tara-run: <run token>`
 * (the bridge checks it), not by the HTTP token:
 *   POST /internal/approval            {title, details, options?, kind?, handoff?}
 *   POST /internal/file                {path, comment?}
 *   POST /internal/privileged          {action, args?, reason} | {command, reason} → {ran, ok, result} | {id}
 *   POST /internal/permission          {tool_name, input}  → {id}
 *   GET  /internal/permission/<id>?wait=45                 → {decision | null}
 *   GET  /internal/jobs, POST /internal/run-job {id}        (chat turns only)
 *   POST /internal/item, GET /internal/items?status=&kind=, POST /internal/item-done {id, status, result?, retryAt?}
 *   POST /internal/pr-start {branch}, /internal/pr-open {branch, title, body?}, /internal/ci-job {job}
 *   POST /internal/withdraw            {id, reason?}  closes a waiting card of the run's project
 *   POST /internal/reminder            {text, cron? | at?, notify?, task?, title?}; GET /internal/reminders;
 *   POST /internal/reminder-cancel     {id}
 *   POST /internal/data                {action: tables|sql|rows|get|upsert|patch, table?, key?, sql?, params?, row?, fields?, limit?, offset?}
 *   GET  /internal/vault-logins        the project's saved logins (no secrets)
 *   POST /internal/vault-sign-in       {login, url?} → {status, message, url?, title?}
 */
export function internalRoutes(bridge: Bridge): Route<unknown>[] {
  const token = ({ req }: RouteRequest) => req.headers['x-tara-run'] as string | undefined;
  /** A POST taking a JSON body (of at most `limit` characters). */
  const post = (
    path: string,
    run: (body: Record<string, unknown>, token: string | undefined) => unknown,
    limit?: number,
  ) => route(`POST /internal/${path}`, async (r) => run(await readJson(r.req, limit), token(r)));

  return [
    // Long details are split into several Slack messages, so they may be long here too.
    post(
      'approval',
      (body, t) =>
        bridge.requestApproval(t, {
          title: required(body.title, 'title'),
          details: required(body.details, 'details'),
          options: Array.isArray(body.options)
            ? body.options.filter((o) => typeof o === 'string')
            : undefined,
          kind: str(body.kind)?.slice(0, 40),
          handoff: str(body.handoff)?.slice(0, 20_000),
        }),
      ITEM_BODY_LIMIT,
    ),
    post('privileged', (body, t) =>
      bridge.requestPrivileged(t, {
        action: str(body.action),
        args:
          body.args && typeof body.args === 'object' && !Array.isArray(body.args)
            ? Object.fromEntries(Object.entries(body.args).map(([k, v]) => [k, String(v)]))
            : undefined,
        command: str(body.command),
        reason: required(body.reason, 'reason'),
        title: str(body.title)?.slice(0, 150),
      }),
    ),
    post('file', (body, t) =>
      bridge.sendFile(t, {
        path: required(body.path, 'path'),
        comment: typeof body.comment === 'string' ? body.comment : undefined,
      }),
    ),
    post(
      'permission',
      (body, t) =>
        bridge.askPermission(t, {
          tool_name: required(body.tool_name, 'tool_name'),
          input:
            typeof body.input === 'object' && body.input !== null
              ? (body.input as Record<string, unknown>)
              : {},
        }),
      PERMISSION_BODY_LIMIT,
    ),
    route('GET /internal/permission/:id', async (r) => {
      const waitMs = Math.min(55, Math.max(0, Number(r.url.searchParams.get('wait')) || 0)) * 1000;
      return { decision: (await bridge.waitPermission(token(r), r.params.id ?? '', waitMs)) ?? null };
    }),
    route('GET /internal/jobs', (r) => ({ jobs: bridge.listJobs(token(r)) })),
    post('run-job', (body, t) => bridge.runJob(t, required(body.id, 'id'))),
    // A run may ask too; the host `autoApprove` rule and the project's server still decide.
    post(
      'item',
      (body, t) => bridge.proposeItem(t, { ...itemInput(body), autoApprove: body.autoApprove === true }),
      ITEM_BODY_LIMIT,
    ),
    route('GET /internal/items', (r) => ({
      items: bridge.listItems(token(r), {
        status: r.url.searchParams.get('status') ?? undefined,
        kind: r.url.searchParams.get('kind') ?? undefined,
      }),
    })),
    post('item-done', (body, t) => {
      const status =
        body.status === 'done' || body.status === 'failed' || body.status === 'later'
          ? body.status
          : undefined;
      if (!status) throw new HttpError(400, '"status" must be done, failed or later');
      const retryAt =
        typeof body.retryAt === 'number'
          ? body.retryAt
          : typeof body.retryAt === 'string'
            ? Date.parse(body.retryAt)
            : undefined;
      return bridge.finishItem(t, {
        id: required(body.id, 'id'),
        status,
        result: typeof body.result === 'string' ? body.result : undefined,
        ...(retryAt !== undefined && Number.isFinite(retryAt) && { retryAt }),
      });
    }),
    post('pr-start', (body, t) => bridge.startPullRequest(t, { branch: required(body.branch, 'branch') })),
    post('ci-job', (body, t) => bridge.readCiJob(t, { job: required(body.job, 'job') })),
    post(
      'pr-open',
      (body, t) =>
        bridge.openPullRequest(t, {
          branch: required(body.branch, 'branch'),
          title: required(body.title, 'title'),
          body: typeof body.body === 'string' ? body.body.slice(0, 60_000) : undefined,
        }),
      70_000,
    ),
    post('withdraw', (body, t) =>
      bridge.withdrawCard(t, { id: required(body.id, 'id'), reason: str(body.reason) }),
    ),
    post('reminder', (body, t) =>
      bridge.setReminder(t, {
        text: str(body.text) ?? '',
        cron: str(body.cron),
        at: typeof body.at === 'number' ? body.at : str(body.at),
        notify: body.notify === true,
        task: body.task === true,
        title: str(body.title),
      }),
    ),
    route('GET /internal/reminders', (r) => ({ reminders: bridge.listReminders(token(r)) })),
    route('GET /internal/vault-logins', (r) => bridge.vaultLogins(token(r))),
    post('vault-sign-in', (body, t) =>
      bridge.vaultSignIn(t, { login: required(body.login, 'login'), url: str(body.url) }),
    ),
    post('reminder-cancel', (body, t) => bridge.cancelReminder(t, required(body.id, 'id'))),
    post(
      'data',
      async (body, t) => ({
        result: await bridge.data(t, {
          action: body.action as DataOp['action'],
          table: body.table,
          key: body.key,
          sql: body.sql,
          params: body.params,
          row: body.row,
          fields: body.fields,
          limit: typeof body.limit === 'number' ? Math.min(Math.max(1, body.limit), 1000) : undefined,
          offset: typeof body.offset === 'number' ? Math.max(0, body.offset) : undefined,
        }),
      }),
      ITEM_BODY_LIMIT,
    ),
  ];
}
