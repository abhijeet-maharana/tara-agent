import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionMode, Project } from '../config/schema.js';
import { describeTool } from '../runner/stream.js';
import type { JobControl } from '../scheduler/scheduler.js';
import type { ChatPort, IncomingMessage, Logger, SlackBlock } from '../sessions/manager.js';
import type { ButtonTap } from '../slack/app.js';
import { splitMessage, toSlackMrkdwn } from '../slack/format.js';
import type { Store } from '../store/store.js';

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
export const JOB_TOOLS_PROMPT = `- To run one of this channel's scheduled jobs now, call \`run_job\` (\`list_jobs\` shows them). The job runs in its own message in the channel; tell the person it started, don't wait for it.`;

/** Appended to the system prompt of every run that has tara's MCP tools. */
export const BRIDGE_PROMPT = `Slack tools (tara MCP server):
- Before anything that needs a human decision (spending money; changing prices, listings, ads, orders or data; publishing; sending messages to other people), call \`request_approval\` with the exact proposal and numbers, then end your turn without acting. The answer arrives as your next message, starting with "USER DECISION", or as a normal reply.
- To share a screenshot, PDF, CSV or image, save it inside the project (e.g. .scratch/) and call \`send_file\`.`;

/** Modes in which Claude never asks, so there is nothing to route to buttons. */
const NEVER_ASKS: PermissionMode[] = ['bypassPermissions', 'dontAsk'];
export const wantsPermissionPrompts = (mode: PermissionMode) => !NEVER_ASKS.includes(mode);

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const SECTION_MAX = 2_800;
const DEFAULT_OPTIONS = ['Approve', 'Reject'];
const NEGATIVE = /^(reject|deny|no|cancel|stop|decline)/i;

export interface BridgeDeps {
  /** tara-agent's local API, as the MCP server reaches it. */
  apiUrl: string;
  chat: ChatPort;
  store: Store;
  log: Logger;
  projects: Project[];
  timeZone: string;
  permissionTimeoutMs?: number;
  /** Built MCP server entry point (dist/mcp/server.js). */
  mcpServerPath?: string;
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
  }

  /** Registers a run and writes its MCP config (mode 600; the token never appears on a command line). */
  open(ctx: RunContext): RunHandle {
    this.configDir ??= mkdtempSync(path.join(tmpdir(), 'tara-mcp-'));
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
          },
        },
      },
    };
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    this.runs.set(token, ctx);
    return {
      mcpConfigPath: file,
      dispose: () => {
        this.runs.delete(token);
        rmSync(file, { force: true });
      },
    };
  }

  /** The run a token belongs to; throws 401 for unknown or finished runs. */
  run(token: string | undefined): RunContext {
    const ctx = token ? this.runs.get(token) : undefined;
    if (!ctx) throw new BridgeError(401, 'Unknown or finished run');
    return ctx;
  }

  async requestApproval(
    token: string | undefined,
    input: { title: string; details: string; options?: string[] },
  ): Promise<{ id: string; options: string[] }> {
    const ctx = this.run(token);
    const title = input.title.trim().slice(0, 150);
    const options = (input.options?.length ? input.options : DEFAULT_OPTIONS)
      .map((o) => o.trim().slice(0, 75))
      .filter(Boolean)
      .slice(0, 5);
    if (!title || options.length < 2) throw new BridgeError(400, 'Need a title and at least 2 options');

    let details = toSlackMrkdwn(input.details.trim());
    if (details.length > SECTION_MAX) {
      // Too long for one block: post it in full first, then the buttons under it.
      for (const chunk of splitMessage(details)) await this.deps.chat.post(ctx.channel, ctx.threadTs, chunk);
      details = '_Full proposal above._';
    }
    const id = this.newId();
    this.deps.store.createApproval({
      id,
      project: ctx.project.config.name,
      channel: ctx.channel,
      threadTs: ctx.threadTs,
      title,
      options,
    });
    const blocks: SlackBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `*🟡 Approval needed: ${title}*\n${details}` } },
      {
        type: 'actions',
        elements: options.map((option, i) => ({
          type: 'button',
          text: { type: 'plain_text', text: option },
          action_id: `tara:approval:${i}`,
          value: id,
          ...(i === 0 ? { style: 'primary' } : NEGATIVE.test(option) ? { style: 'danger' } : {}),
        })),
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Or reply in this thread with changes.' }] },
    ];
    const ts = await this.deps.chat.postBlocks(
      ctx.channel,
      ctx.threadTs,
      `Approval needed: ${title}`,
      blocks,
    );
    this.deps.store.setApprovalMessage(id, ts);
    return { id, options };
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
    if (!roots.some((root) => real.startsWith(root + path.sep))) {
      throw new BridgeError(403, 'Only files inside the project or the temp directory can be sent');
    }
    const stat = statSync(real);
    if (!stat.isFile()) throw new BridgeError(400, 'Not a file');
    if (stat.size > MAX_FILE_BYTES) throw new BridgeError(413, 'File is larger than 100 MB');
    await this.deps.chat.uploadFile(ctx.channel, ctx.threadTs, real, input.comment?.slice(0, 2_000));
    return { name: path.basename(real) };
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
    this.permissions.set(id, { ctx, messageTs, title, input: input.input, waiters: [], timer });
    return { id };
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
    const row = this.deps.store.getApproval(tap.value);
    const option = row?.options[Number(tap.actionId.split(':')[2])];
    if (!row || !option) return;
    if (!this.allowed(row.project, tap.user)) {
      this.deps.log.warn(`[${row.project}] approval tap by ${tap.user} ignored (not in allowedUsers)`);
      return;
    }
    if (!this.deps.store.decideApproval(row.id, option, tap.user)) return; // someone already decided
    const when = this.time();
    const icon = NEGATIVE.test(option) ? '❌' : '✅';
    await this.deps.chat
      .update(tap.channel, tap.messageTs, `${row.title}: ${option}`, [
        { type: 'section', text: { type: 'mrkdwn', text: `*${row.title}*` } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `${icon} *${option}*, chosen by <@${tap.user}> at ${when}` }],
        },
      ])
      .catch((err: Error) => this.deps.log.warn(`could not update approval message: ${err.message}`));
    await this.onDecision?.({
      channel: row.channel,
      threadTs: row.threadTs,
      ts: tap.messageTs,
      user: tap.user,
      text: `USER DECISION on "${row.title}": ${option} (tapped at ${when})`,
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
