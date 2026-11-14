import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  constants,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApprovalError,
  type Approvals,
  PRIVILEGED_KIND,
  type ProposeInput,
  privilegedNote,
} from '../approvals/approvals.js';
import type { PermissionMode, Project } from '../config/schema.js';
import { type CiJob, CiJobError, type CiJobs } from '../github/actions.js';
import {
  type OpenedPullRequest,
  PullRequestError,
  type PullRequests,
  type StartedPullRequest,
} from '../github/pull-requests.js';
import type { Privileged } from '../privileged/privileged.js';
import { describeTool } from '../runner/stream.js';
import type { JobControl } from '../scheduler/scheduler.js';
import type { ChatPort, IncomingMessage, Logger, SlackBlock } from '../sessions/manager.js';
import type { ButtonTap } from '../slack/app.js';
import { ITEM_STATUSES, type ItemStatus, type Store } from '../store/store.js';

/** One Claude run that may call tara's MCP tools: where its thread is and what it may ask for. */
export interface RunContext {
  project: Project;
  channel: string;
  threadTs: string;
  kind: 'chat' | 'job';
  /** Route permission prompts to Allow/Deny buttons (chat turns outside bypass mode). */
  permissionPrompts: boolean;
  /** Who is talking (chat turns): jobs Claude starts are run in their name. */
  user?: string;
  /** The job this run belongs to (its decisions continue the run as that job). */
  jobId?: string;
  /** Approved items this run was given by a queue; only these can be reported with `finish_item`. */
  items?: string[];
}

export interface RunHandle {
  /** Pass to `claude --mcp-config`. */
  mcpConfigPath: string;
  dispose(): void;
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

interface PendingPermission {
  ctx: RunContext;
  messageTs: string;
  title: string;
  input: Record<string, unknown>;
  /** When it was asked. */
  at: number;
  result?: PermissionResult;
  waiters: Array<(r: PermissionResult) => void>;
  timer: NodeJS.Timeout;
}

export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Appended for chat turns, which can also start the channel's scheduled jobs. */
/** An item reported `later` without a time is tried again after this long (as for a URL executor). */
const LATER_MS = 3_600_000;

export const JOB_TOOLS_PROMPT = `- To run one of this channel's scheduled jobs now, call \`run_job\` (\`list_jobs\` shows them). The job runs in its own message in the channel; tell the person it started, don't wait for it.`;

/** Appended to the system prompt of every run that has tara's MCP tools. */
export const BRIDGE_PROMPT = `Slack tools (tara MCP server):
- Everything that needs a person goes through \`request_approval\`: a card on the Approvals page and in this thread. The answer arrives as your next message, starting with "USER DECISION", and you continue from there. There is no other task list. Raise a card for:
  - a decision, before you act (spending money; changing prices, listings, ads, orders or data; publishing; sending messages to other people): the exact proposal and numbers. End your turn without acting.
  - a suggestion worth acting on: approving it means you do it.
  - something only a person can do (a login, an OTP, a captcha, a call, a failure you could not fix): say exactly what, with options like "Done, continue" / "Skip".
  No card for OK or FYI news: that stays in your reply.
- Drafts that should go out later (messages, emails, applications, posts) go through \`propose_item\` with the queue that sends them: one card each, approved or edited on the Approvals page, then run at the queue's time. Never send them yourself.
- Close a waiting card yourself with \`withdraw_card\` (its id from \`list_items\`, and why) whenever it no longer needs the person: they did it themselves, the role or post is gone, it is a duplicate, or a newer card replaces it. No approval is needed to close a card. Never ask them to tap a button just to clear it, and never leave a card they cannot act on.
- To share a screenshot, PDF, CSV or image, save it inside the project (e.g. .scratch/) and call \`send_file\`.`;

/** Without root actions on the host: a run can still ask a person to run a command for it. */
export const PRIVILEGED_MANUAL_PROMPT = `Root access (you have no sudo): when something needs root or fails with Permission denied outside your reach, call \`request_privileged\` with \`command\` (the exact shell command a person should run) and end your turn; you continue once they have run it.`;

/** Modes in which Claude never asks, so there is nothing to route to buttons. */
const NEVER_ASKS: PermissionMode[] = ['bypassPermissions', 'dontAsk'];
export const wantsPermissionPrompts = (mode: PermissionMode) => !NEVER_ASKS.includes(mode);

const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface BridgeDeps {
  /** tara-agent's local API, as the MCP server reaches it. */
  apiUrl: string;
  chat: ChatPort;
  store: Store;
  /** Approval items (request_approval, propose_item, finish_item). */
  approvals: Approvals;
  /** Root actions (`request_privileged`); unset = runs can only ask a person to run a command. */
  privileged?: Privileged;
  /** Pull requests (host `github`); only projects listed there get the tools. */
  pullRequests?: PullRequests;
  /** Reading CI jobs (host `github`, read-only); same projects as pull requests. */
  ciJobs?: CiJobs;
  log: Logger;
  projects: Project[];
  timeZone: string;
  permissionTimeoutMs?: number;
  /** Built MCP server entry point (dist/mcp/server.js). */
  mcpServerPath?: string;
  /** With `claude.runAs`: the run user's group, which must read the MCP config. */
  shareGid?: number;
  now?: () => number;
  newId?: () => string;
}

/**
 * Connects Claude runs to Slack beyond plain text: approval buttons (a tap resumes the thread's
 * session with the decision), Allow/Deny permission prompts, and file uploads. Claude reaches it
 * through tara's MCP server, which calls the local API with a per-run token.
 */
export class Bridge {
  /** Delivers a decision into its thread as if the person had typed it (set to SessionManager.handle). */
  onDecision?: (msg: IncomingMessage) => Promise<void>;
  /** The scheduler, for the `list_jobs` / `run_job` tools in chat turns. */
  jobs?: JobControl;

  private readonly runs = new Map<string, RunContext>();
  private readonly permissions = new Map<string, PendingPermission>();
  private configDir: string | undefined;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: BridgeDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    // Decisions on chat cards continue the thread the way a typed reply would.
    deps.approvals.onChat ??= (msg) => this.onDecision?.(msg) ?? Promise.resolve();
  }

  /** Registers a run and writes its MCP config (mode 600; the token never appears on a command line). */
  open(ctx: RunContext): RunHandle {
    if (!this.configDir) {
      this.configDir = mkdtempSync(path.join(tmpdir(), 'tara-mcp-'));
      if (this.deps.shareGid !== undefined) {
        chownSync(this.configDir, process.getuid?.() ?? -1, this.deps.shareGid);
        chmodSync(this.configDir, 0o750);
      }
    }
    const token = randomBytes(24).toString('hex');
    const file = path.join(this.configDir, `${token.slice(0, 16)}.json`);
    const server = this.deps.mcpServerPath ?? fileURLToPath(new URL('../mcp/server.js', import.meta.url));
    const config = {
      mcpServers: {
        tara: {
          command: process.execPath,
          args: [server],
          env: {
            TARA_API: this.deps.apiUrl,
            TARA_RUN_TOKEN: token,
            TARA_PERMISSION_PROMPTS: ctx.permissionPrompts ? '1' : '0',
            TARA_JOB_TOOLS: ctx.kind === 'chat' && this.jobs ? '1' : '0',
            TARA_GITHUB_TOOLS: this.deps.pullRequests?.has(ctx.project.config.name) ? '1' : '0',
          },
        },
      },
    };
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    if (this.deps.shareGid !== undefined) {
      chownSync(file, process.getuid?.() ?? -1, this.deps.shareGid);
      chmodSync(file, 0o640);
    }
    this.runs.set(token, ctx);
    return {
      mcpConfigPath: file,
      dispose: () => {
        this.runs.delete(token);
        rmSync(file, { force: true });
      },
    };
  }

  /** The system prompt part for runs with tara's MCP tools. */
  prompt(): string {
    return [BRIDGE_PROMPT, this.deps.privileged?.prompt() || PRIVILEGED_MANUAL_PROMPT].join('\n\n');
  }

  /** The run a token belongs to; throws 401 for unknown or finished runs. */
  run(token: string | undefined): RunContext {
    const ctx = token ? this.runs.get(token) : undefined;
    if (!ctx) throw new BridgeError(401, 'Unknown or finished run');
    return ctx;
  }

  async requestApproval(
    token: string | undefined,
    input: { title: string; details: string; options?: string[]; kind?: string },
  ): Promise<{ id: string; options: string[] }> {
    const ctx = this.run(token);
    return this.deps.approvals.requestDecision(ctx, input).catch(asBridgeError);
  }

  /**
   * Something only root can do. An allowlisted action either runs at once (`auto`) and returns how it
   * went, or becomes a card whose approval runs it and continues the run (a chat or a scheduled job
   * alike); a free-form `command` becomes a card asking a person to run it.
   */
  async requestPrivileged(
    token: string | undefined,
    input: {
      action?: string;
      args?: Record<string, string>;
      command?: string;
      reason: string;
      title?: string;
    },
  ): Promise<{ id?: string; ran?: boolean; ok?: boolean; result?: string; options?: string[] }> {
    const ctx = this.run(token);
    const reason = input.reason.trim();
    if (!input.action === !input.command?.trim())
      throw new BridgeError(400, 'Give either an "action" or a "command"');
    if (input.command) {
      const command = input.command.trim();
      return this.deps.approvals
        .requestDecision(ctx, {
          kind: PRIVILEGED_KIND,
          title: input.title?.trim() || `Run as root: ${command.split('\n')[0]?.slice(0, 100)}`,
          details: `${reason}\n\nPlease run this on the machine, then continue:\n\`\`\`\n${command}\n\`\`\``,
          options: ['I ran it, continue', 'Reject'],
        })
        .catch(asBridgeError);
    }
    const privileged = this.deps.privileged;
    if (!privileged) throw new BridgeError(404, 'No root actions on this host: ask for a "command" instead');
    const args = input.args ?? {};
    const plan = await privileged.plan(input.action as string, args).catch((err: Error) => {
      throw new BridgeError(400, err.message);
    });
    const card = {
      title: input.title?.trim() || `Root: ${plan.description}`,
      details: `${reason}\n\nRuns as root:\n\`\`\`\n${plan.command}\n\`\`\``,
      fields: [
        { key: 'action', label: 'Action', type: 'text' as const, value: plan.id, readOnly: true },
        ...(Object.keys(args).length
          ? [
              {
                key: 'args',
                label: 'Arguments',
                type: 'text' as const,
                value: JSON.stringify(args),
                readOnly: true,
              },
            ]
          : []),
      ],
    };
    if (plan.auto) {
      const result = await this.deps.approvals.runAutoPrivileged(ctx, card).catch(asBridgeError);
      return { ran: true, ok: result.ok, result: privilegedNote(result) };
    }
    return this.deps.approvals
      .requestDecision(ctx, { ...card, kind: PRIVILEGED_KIND, options: ['Run it', 'Reject'] })
      .catch(asBridgeError);
  }

  /** A draft for later, as an approval card of this run's project. */
  async proposeItem(
    token: string | undefined,
    input: ProposeInput,
  ): Promise<{ id: string; status: string; reply?: string; checks: unknown[] }> {
    const ctx = this.run(token);
    const item = await this.deps.approvals
      .propose(ctx.project, input, {
        channel: ctx.channel,
        threadTs: ctx.threadTs,
        jobId: ctx.jobId,
        source: ctx.jobId ?? (ctx.kind === 'chat' ? 'chat' : undefined),
      })
      .catch(asBridgeError);
    return { id: item.id, status: item.status, reply: item.reply, checks: item.checks };
  }

  /**
   * The executor's report on one item it was given: done, failed, or later (it can't go yet, e.g. a daily
   * cap: back in its queue until `retryAt`, or an hour from now), as a URL executor answers.
   */
  finishItem(
    token: string | undefined,
    input: { id: string; status: 'done' | 'failed' | 'later'; result?: string; retryAt?: number },
  ) {
    const ctx = this.run(token);
    if (!ctx.items?.includes(input.id))
      throw new BridgeError(403, `Item ${input.id} was not given to this run`);
    if (input.status === 'later') {
      const now = this.now();
      const at = input.retryAt && input.retryAt > now ? input.retryAt : now + LATER_MS;
      const item = this.deps.store.deferItem(input.id, at, input.result);
      if (!item) throw new BridgeError(409, `Item ${input.id} is not running (already reported?)`);
      return { id: item.id, status: item.status, runAfter: at };
    }
    const item = this.deps.store.finishItem(input.id, input.status, input.result);
    if (!item) throw new BridgeError(409, `Item ${input.id} is not running (already reported?)`);
    this.deps.approvals.finished(item, ctx.threadTs);
    return { id: item.id, status: item.status };
  }

  /**
   * Takes back a waiting card of this run's project (the person did it themselves, it no longer applies,
   * a duplicate). Any card of the project, so a tidy-up job can clear what other runs raised; never
   * another project's.
   */
  withdrawCard(token: string | undefined, input: { id: string; reason?: string }) {
    const ctx = this.run(token);
    const item = this.deps.store.getItem(input.id);
    if (!item || item.project !== ctx.project.config.name)
      throw new BridgeError(403, `Card ${input.id} is not a card of ${ctx.project.config.name}`);
    try {
      const withdrawn = this.deps.approvals.withdraw(item.id, input.reason, ctx.jobId ?? 'chat');
      return { id: withdrawn.id, status: withdrawn.status };
    } catch (err) {
      asBridgeError(err);
    }
  }

  /** This project's items, for checking before proposing again. */
  listItems(token: string | undefined, filter: { status?: string; kind?: string }) {
    const ctx = this.run(token);
    const statuses = filter.status
      ? filter.status
          .split(',')
          .filter((s): s is ItemStatus => (ITEM_STATUSES as readonly string[]).includes(s))
      : (['pending', 'approved', 'running'] as ItemStatus[]);
    return this.deps.store
      .items({ project: ctx.project.config.name, kind: filter.kind, statuses, limit: 200 })
      .map(({ id, kind, key, title, status, queue, window, decision, reply, result }) => ({
        id,
        kind,
        key,
        title,
        status,
        queue,
        window,
        decision,
        reply,
        result,
      }));
  }

  async sendFile(
    token: string | undefined,
    input: { path: string; comment?: string },
  ): Promise<{ name: string }> {
    const ctx = this.run(token);
    let real: string;
    try {
      real = realpathSync(path.resolve(ctx.project.dir, input.path));
    } catch {
      throw new BridgeError(404, `No such file: ${input.path}`);
    }
    // Resolved through symlinks, so a link can't point the upload outside these roots.
    const roots = [ctx.project.dir, tmpdir()].map((r) => realpathSync(r));
    const inside = (p: string) => roots.some((root) => p.startsWith(root + path.sep));
    if (!inside(real)) {
      throw new BridgeError(403, 'Only files inside the project or the temp directory can be sent');
    }
    const data = await readChecked(real, inside, input.path);
    await this.deps.chat.uploadFile(
      ctx.channel,
      ctx.threadTs,
      { name: path.basename(real), data },
      input.comment?.slice(0, 2_000),
    );
    return { name: path.basename(real) };
  }

  /** A workspace for a pull request (`start_pull_request`). */
  startPullRequest(token: string | undefined, input: { branch: string }): Promise<StartedPullRequest> {
    const ctx = this.run(token);
    return this.pullRequest(() => this.deps.pullRequests?.start(ctx.project.config.name, input.branch));
  }

  /** Commits the workspace and opens or updates the PR (`open_pull_request`). */
  openPullRequest(
    token: string | undefined,
    input: { branch: string; title: string; body?: string },
  ): Promise<OpenedPullRequest> {
    const ctx = this.run(token);
    return this.pullRequest(() => this.deps.pullRequests?.open(ctx.project.config.name, input));
  }

  /** A GitHub Actions job of the project's repo, with its failed steps and log excerpt (`read_ci_job`). */
  async readCiJob(token: string | undefined, input: { job: string }): Promise<CiJob> {
    const ctx = this.run(token);
    if (!this.deps.ciJobs?.has(ctx.project.config.name))
      throw new BridgeError(404, 'CI jobs are not set up for this project');
    try {
      return await this.deps.ciJobs.read(ctx.project.config.name, input.job);
    } catch (err) {
      if (err instanceof CiJobError) throw new BridgeError(400, err.message);
      throw err;
    }
  }

  private async pullRequest<T>(call: () => Promise<T> | undefined): Promise<T> {
    try {
      const result = await call();
      if (result === undefined) throw new BridgeError(404, 'Pull requests are not set up on this host');
      return result;
    } catch (err) {
      if (err instanceof PullRequestError) throw new BridgeError(400, err.message);
      throw err;
    }
  }

  listJobs(token: string | undefined) {
    const ctx = this.run(token);
    return (this.jobs?.list(ctx.project.config.name) ?? []).map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      running: j.running,
      nextRun: j.nextRun?.toISOString() ?? null,
      lastStatus: j.lastStatus ?? null,
    }));
  }

  runJob(token: string | undefined, id: string): { result: string; name?: string } {
    const ctx = this.run(token);
    if (ctx.kind !== 'chat' || !this.jobs)
      throw new BridgeError(403, 'Jobs can only be started from a chat turn');
    const job = this.jobs.list(ctx.project.config.name).find((j) => j.id === id);
    if (!job) throw new BridgeError(404, `No job "${id}" in this channel; call list_jobs`);
    if (!job.enabled) return { result: 'paused', name: job.name };
    return { result: this.jobs.trigger(ctx.project.config.name, id, ctx.user ?? 'Claude'), name: job.name };
  }

  /** Posts Allow/Deny buttons for a tool call and returns the request id to wait on. */
  async askPermission(
    token: string | undefined,
    input: { tool_name: string; input: Record<string, unknown> },
  ): Promise<{ id: string }> {
    const ctx = this.run(token);
    if (!ctx.permissionPrompts) throw new BridgeError(403, 'Permission prompts are off for this run');
    const id = this.newId();
    const title = describeTool(input.tool_name, input.input);
    const preview = JSON.stringify(input.input, null, 1).slice(0, 1_200);
    const blocks: SlackBlock[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*🔐 Claude wants to run:* ${title}\n\`\`\`${preview}\`\`\`` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Allow' },
            action_id: 'tara:perm:allow',
            value: id,
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            action_id: 'tara:perm:deny',
            value: id,
            style: 'danger',
          },
        ],
      },
    ];
    const messageTs = await this.deps.chat.postBlocks(
      ctx.channel,
      ctx.threadTs,
      `Permission needed: ${title}`,
      blocks,
    );
    const timeoutMs = this.deps.permissionTimeoutMs ?? 10 * 60_000;
    const timer = setTimeout(() => {
      void this.decidePermission(
        id,
        { behavior: 'deny', message: 'Nobody answered the permission prompt in time.' },
        '⌛ No answer in time; denied',
      );
    }, timeoutMs);
    timer.unref();
    this.permissions.set(id, {
      ctx,
      messageTs,
      title,
      input: input.input,
      at: this.now(),
      waiters: [],
      timer,
    });
    return { id };
  }

  /** Permission prompts nobody has answered yet. */
  pendingPermissions(): Array<{ project: string; title: string; at: number }> {
    return [...this.permissions.values()]
      .filter((p) => !p.result)
      .map((p) => ({ project: p.ctx.project.config.name, title: p.title, at: p.at }));
  }

  /** Resolves with the decision, or undefined if none arrived within `waitMs` (callers poll again). */
  waitPermission(
    token: string | undefined,
    id: string,
    waitMs: number,
  ): Promise<PermissionResult | undefined> {
    this.run(token);
    const pending = this.permissions.get(id);
    if (!pending) throw new BridgeError(404, 'No such permission request');
    if (pending.result) return Promise.resolve(pending.result);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.waiters = pending.waiters.filter((w) => w !== done);
        resolve(undefined);
      }, waitMs);
      const done = (r: PermissionResult) => {
        clearTimeout(timer);
        resolve(r);
      };
      pending.waiters.push(done);
    });
  }

  /** Handles a tap on any `tara:` button. */
  async handleButton(tap: ButtonTap): Promise<void> {
    if (tap.actionId.startsWith('tara:approval:')) return this.approvalTapped(tap);
    if (tap.actionId === 'tara:perm:allow' || tap.actionId === 'tara:perm:deny')
      return this.permissionTapped(tap);
  }

  private allowed(projectName: string, user: string): boolean {
    const project = this.deps.projects.find((p) => p.config.name === projectName);
    const users = project?.config.allowedUsers ?? [];
    return users.length === 0 || users.includes(user);
  }

  private time(): string {
    return new Date(this.now()).toLocaleTimeString('en-GB', {
      timeZone: this.deps.timeZone,
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private async approvalTapped(tap: ButtonTap): Promise<void> {
    const item = this.deps.store.getItem(tap.value);
    const option = item?.options[Number(tap.actionId.split(':')[2])];
    if (!item || !option) return;
    if (!this.allowed(item.project, tap.user)) {
      this.deps.log.warn(`[${item.project}] approval tap by ${tap.user} ignored (not in allowedUsers)`);
      return;
    }
    await this.deps.approvals.decide(item.id, { option, by: tap.user, via: 'slack' }).catch((err: Error) => {
      // Already decided (a double tap, or the dashboard first): nothing to do.
      if (!(err instanceof ApprovalError && err.status === 409)) throw err;
    });
  }

  private async permissionTapped(tap: ButtonTap): Promise<void> {
    const pending = this.permissions.get(tap.value);
    if (!pending || pending.result) return;
    if (!this.allowed(pending.ctx.project.config.name, tap.user)) return;
    const allow = tap.actionId === 'tara:perm:allow';
    await this.decidePermission(
      tap.value,
      allow
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: `Denied by the user in Slack.` },
      `${allow ? '✅ Allowed' : '❌ Denied'} by <@${tap.user}> at ${this.time()}`,
    );
  }

  private async decidePermission(id: string, result: PermissionResult, note: string): Promise<void> {
    const pending = this.permissions.get(id);
    if (!pending || pending.result) return;
    pending.result = result;
    clearTimeout(pending.timer);
    for (const waiter of pending.waiters.splice(0)) waiter(result);
    // Keep the answer around briefly for a poll that arrives just after the decision.
    setTimeout(() => this.permissions.delete(id), 120_000).unref();
    await this.deps.chat
      .update(pending.ctx.channel, pending.messageTs, `${pending.title}: ${note}`, [
        { type: 'section', text: { type: 'mrkdwn', text: `*🔐 ${pending.title}*` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: note }] },
      ])
      .catch((err: Error) => this.deps.log.warn(`could not update permission message: ${err.message}`));
  }
}

/** Approval errors keep their HTTP status on the way back to the MCP server. */
function asBridgeError(err: unknown): never {
  if (err instanceof ApprovalError) throw new BridgeError(err.status, err.message);
  throw err;
}

/**
 * Reads a file for `send_file` so that what is uploaded is what was checked. The run's user can change
 * its own folders at any moment: checking a path and reading it later would let it swap a folder for a
 * symlink in between and have tara-agent upload a file only tara-agent can read (its own environment,
 * with the Slack tokens). So the file is opened once (never following a final symlink, never blocking on
 * a FIFO), the open file is checked (Linux: the path the kernel opened, through /proc/self/fd; elsewhere:
 * the same file still at a path inside the roots), and the upload reads from that same open file.
 */
export async function readChecked(
  real: string,
  inside: (p: string) => boolean,
  shown: string,
): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM')
      throw new BridgeError(
        403,
        `tara-agent cannot read this file: run \`chmod g+r ${shown}\` and send it again`,
      );
    if (code === 'ELOOP') throw new BridgeError(403, 'The file changed into a symlink: send the file itself');
    throw new BridgeError(404, `No such file: ${shown}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BridgeError(400, 'Not a file');
    if (stat.size > MAX_FILE_BYTES) throw new BridgeError(413, 'File is larger than 100 MB');
    let opened: string | undefined;
    try {
      opened = readlinkSync(`/proc/self/fd/${handle.fd}`);
    } catch {
      // No /proc (macOS): the same file must still be there, at a path inside the roots.
      try {
        const again = realpathSync(real);
        const now = statSync(again);
        if (now.dev === stat.dev && now.ino === stat.ino) opened = again;
      } catch {}
    }
    if (!opened || !inside(opened))
      throw new BridgeError(403, 'Only files inside the project or the temp directory can be sent');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
