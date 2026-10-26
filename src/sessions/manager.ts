import { randomUUID } from 'node:crypto';
import { type Bridge, JOB_TOOLS_PROMPT, type RunContext, wantsPermissionPrompts } from '../bridge/bridge.js';
import type { HostConfig, Project } from '../config/schema.js';
import { buildClaudeArgs } from '../runner/args.js';
import { buildChildEnv } from '../runner/env.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import { sessionScratch } from '../runner/workspace.js';
import { foldersNote, identityPrompt } from '../scheduler/prompt.js';
import type { JobControl, JobInfo } from '../scheduler/scheduler.js';
import type { ButtonTap } from '../slack/app.js';
import { formatDuration, splitMessage } from '../slack/format.js';
import { EditReply, type StreamPort, StreamReply, type TurnReply } from '../slack/reply.js';
import type { SessionRow, Store } from '../store/store.js';
import { KeyedQueue, Semaphore } from '../util/concurrency.js';
import { matchJob } from './job-match.js';
import { learnFromRun, troubleReasons } from './learn.js';

/** The chat platform as the session manager sees it. Slack implements it; tests fake it. */
export interface ChatPort {
  /** Posts into a thread (or top-level when `threadTs` is undefined) and returns the new message's ts. */
  post(channel: string, threadTs: string | undefined, text: string): Promise<string>;
  delete(channel: string, ts: string): Promise<void>;
  update(channel: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void>;
  /** Posts a Block Kit message (text is the notification/fallback text), top-level without `threadTs`. */
  postBlocks(
    channel: string,
    threadTs: string | undefined,
    text: string,
    blocks: SlackBlock[],
  ): Promise<string>;
  /** Uploads a local file into a thread. */
  uploadFile(channel: string, threadTs: string, filePath: string, comment?: string): Promise<void>;
  /** Native message streaming, when the platform has it. */
  stream?: StreamPort;
  react(channel: string, ts: string, emoji: string): Promise<void>;
  unreact(channel: string, ts: string, emoji: string): Promise<void>;
}

/** A Slack Block Kit block, kept loose on purpose: only the bridge builds them. */
export type SlackBlock = { type: string; block_id?: string; [key: string]: unknown };

export interface IncomingMessage {
  channel: string;
  /** Thread root ts; equals `ts` for a top-level message. */
  threadTs: string;
  ts: string;
  user: string;
  text: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface ManagerDeps {
  projects: Project[];
  host: HostConfig;
  store: Store;
  chat: ChatPort;
  run: Runner;
  /** Scheduler, for `!jobs` and `!run`. */
  jobs?: JobControl;
  /** Approval buttons, permission prompts and file uploads (tara's MCP tools). */
  bridge?: Bridge;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  newSessionId?: () => string;
  now?: () => number;
}

const BASE_PROMPT = `You are running headless for a Slack thread, through tara-agent.
- People read your replies in Slack, often on a phone: lead with the answer, keep it short, use bullets, avoid wide tables.
- Your text appears in the thread as you write it, including notes between tool calls, so keep those to a word or two and put the answer at the end.
- Each message starts with the sender's Slack mention, e.g. "<@U123>: ...". Several people may share a thread.
- You cannot ask questions mid-turn. If you need input, end your turn with the question.
- Temporary files go in $TARA_SCRATCH (this conversation's own folder, deleted automatically later), never in the repo.`;

const HELP = `*Thread commands*
• \`!new\` forget this thread's session; the next message starts fresh
• \`!model <name>\` switch model for this thread (e.g. \`opus\`, \`sonnet\`, \`haiku\`)
• \`!stop\` stop the running turn
• \`!status\` show session, model and queue
• \`!jobs\` list this channel's scheduled jobs
• \`run <job name>\` run a scheduled job now, e.g. "run weekly redis health audit" (\`!run <job-id>\` works too)
• \`!health\` the last 24 hours: runs, problems, missed slots, usage`;

export const threadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`;

export class SessionManager {
  private readonly byChannel: Map<string, Project>;
  private readonly queue = new KeyedQueue();
  private readonly slots: Semaphore;
  private readonly running = new Map<string, AbortController>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: Logger;
  private readonly newSessionId: () => string;
  private readonly now: () => number;

  constructor(private readonly deps: ManagerDeps) {
    this.byChannel = new Map(deps.projects.map((p) => [p.config.slackChannel, p]));
    this.slots = new Semaphore(deps.host.concurrency);
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? console;
    this.newSessionId = deps.newSessionId ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  /** Resolves once the message is fully handled (for a prompt: after its turn finished). */
  async handle(msg: IncomingMessage): Promise<void> {
    const project = this.byChannel.get(msg.channel);
    if (!project) return;
    const { allowedUsers } = project.config;
    if (allowedUsers.length > 0 && !allowedUsers.includes(msg.user)) {
      this.log.warn(`[${project.config.name}] ignored message from ${msg.user} (not in allowedUsers)`);
      return;
    }
    const text = msg.text.trim();
    if (!text) return;
    const key = threadKey(msg.channel, msg.threadTs);

    const command = /^!(\w+)\s*(.*)$/s.exec(text);
    if (command)
      return this.command(project, key, msg, command[1]?.toLowerCase() ?? '', command[2]?.trim() ?? '');

    // "Run Weekly Redis Health Audit": start the job straight away, no model needed.
    if (await this.runRequest(project, msg, text)) return;

    await this.queue.run(key, () => this.turn(project, key, msg));
  }

  /** Handles "run <job name>". False when the message isn't one (it then goes to Claude). */
  private async runRequest(project: Project, msg: IncomingMessage, text: string): Promise<boolean> {
    const jobs = this.deps.jobs;
    if (!jobs) return false;
    const match = matchJob(text, jobs.list(project.config.name));
    if (!match) return false;
    // A top-level request gets its own thread for the run; inside a conversation, the run posts its own message.
    const ownThread = msg.threadTs === msg.ts;
    if ('job' in match) {
      await this.startJob(project, match.job, msg.user, msg.channel, msg.threadTs, ownThread);
      return true;
    }
    await this.deps.chat.postBlocks(msg.channel, msg.threadTs, 'Which job should I run?', [
      { type: 'section', text: { type: 'mrkdwn', text: '*Which job should I run?*' } },
      {
        type: 'actions',
        elements: match.choices.map((job, i) => ({
          type: 'button',
          text: { type: 'plain_text', text: job.name.slice(0, 75) },
          action_id: `tara:runjob:${i}`,
          value: `${job.id}|${ownThread ? 1 : 0}`,
        })),
      },
    ]);
    return true;
  }

  /** A tap on one of the "Which job should I run?" buttons. */
  async runButton(tap: ButtonTap): Promise<void> {
    const project = this.byChannel.get(tap.channel);
    const [id = '', own] = tap.value.split('|');
    const job = project && this.deps.jobs?.list(project.config.name).find((j) => j.id === id);
    if (!project || !job) return;
    const { allowedUsers } = project.config;
    if (allowedUsers.length > 0 && !allowedUsers.includes(tap.user)) return;
    await this.deps.chat
      .update(tap.channel, tap.messageTs, `▶️ ${job.name}`, [
        { type: 'section', text: { type: 'mrkdwn', text: `▶️ *${job.name}*, picked by <@${tap.user}>` } },
      ])
      .catch(() => {});
    await this.startJob(project, job, tap.user, tap.channel, tap.threadTs ?? tap.messageTs, own === '1');
  }

  private async startJob(
    project: Project,
    job: JobInfo,
    user: string,
    channel: string,
    threadTs: string,
    ownThread: boolean,
  ): Promise<void> {
    const reply = (text: string) => this.deps.chat.post(channel, threadTs, text);
    if (!job.enabled) {
      await reply(
        `⏸ *${job.name}* is paused. Turn it back on in \`.tara/jobs.json\` (or the dashboard) first.`,
      );
      return;
    }
    const result = this.deps.jobs?.trigger(
      project.config.name,
      job.id,
      user,
      ownThread ? { channel, ts: threadTs } : undefined,
    );
    if (result === 'running') await reply(`🔄 *${job.name}* is already running.`);
    else if (result === 'started' && !ownThread)
      await reply(`▶️ Started *${job.name}*. It posts its own message in this channel.`);
  }

  /** Stops every running turn (used on shutdown). */
  stopAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  private async command(project: Project, key: string, msg: IncomingMessage, name: string, arg: string) {
    const reply = (text: string) => this.deps.chat.post(msg.channel, msg.threadTs, text);
    const session = this.deps.store.getSession(key);
    switch (name) {
      case 'new':
        if (this.running.has(key)) return void (await reply('A turn is still running. Use `!stop` first.'));
        this.deps.store.deleteSession(key);
        return void (await reply('🧹 Session cleared. The next message starts a fresh one.'));
      case 'model': {
        if (!/^[\w.[\]-]+$/.test(arg))
          return void (await reply('Usage: `!model <name>`, e.g. `!model opus`'));
        this.deps.store.saveSession({ ...(session ?? this.freshSession(project, key)), model: arg });
        return void (await reply(`🧠 Model for this thread: \`${arg}\` (from the next message).`));
      }
      case 'stop': {
        const controller = this.running.get(key);
        if (!controller) return void (await reply('Nothing is running in this thread.'));
        controller.abort();
        return;
      }
      case 'status': {
        const queued = Math.max(0, this.queue.size(key) - (this.running.has(key) ? 1 : 0));
        return void (await reply(
          [
            `*Project:* ${project.config.name}`,
            `*Model:* ${session?.model ?? project.config.chatModel}`,
            `*Session:* ${session?.started ? `\`${session.sessionId}\`` : 'not started'}`,
            `*Running:* ${this.running.has(key) ? 'yes' : 'no'}${queued ? ` (${queued} queued)` : ''}`,
            `*Permissions:* ${project.config.permissionMode}`,
          ].join('\n'),
        ));
      }
      case 'jobs': {
        const jobs = this.deps.jobs?.list(project.config.name) ?? [];
        if (jobs.length === 0) return void (await reply('No scheduled jobs for this channel.'));
        const timeZone = this.deps.host.timezone;
        const when = (d?: Date) =>
          d
            ? d.toLocaleString('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' })
            : 'off';
        const lines = jobs.map(
          (j) =>
            `• \`${j.id}\` ${j.running ? '🔄 ' : j.enabled ? '' : '⏸ '}${j.name} · ${when(j.nextRun)} · ${j.model}` +
            (j.lastStatus ? ` · last: ${j.lastStatus}` : ''),
        );
        return void (await reply(`*Jobs* (next run, ${timeZone})\n${lines.join('\n')}`));
      }
      case 'health': {
        const digest = this.deps.jobs?.digest(project.config.name);
        if (!digest) return void (await reply('Nothing ran or was missed in the last 24 hours.'));
        await reply(digest.headline);
        for (const chunk of splitMessage(digest.details)) await reply(chunk);
        return;
      }
      case 'run': {
        if (!this.deps.jobs) return void (await reply('Scheduling is not enabled.'));
        if (!arg) return void (await reply('Usage: `!run <job-id>` (see `!jobs`)'));
        const result = this.deps.jobs.trigger(project.config.name, arg, msg.user);
        const text =
          result === 'started'
            ? `▶️ Started \`${arg}\`. It posts its own thread in this channel.`
            : result === 'running'
              ? `\`${arg}\` is already running.`
              : `No job \`${arg}\` here. See \`!jobs\`.`;
        return void (await reply(text));
      }
      default:
        return void (await reply(HELP));
    }
  }

  private freshSession(project: Project, key: string): SessionRow {
    return {
      threadKey: key,
      project: project.config.name,
      sessionId: this.newSessionId(),
      model: project.config.chatModel,
      started: false,
    };
  }

  private async turn(project: Project, key: string, msg: IncomingMessage): Promise<void> {
    const { chat, store, host } = this.deps;
    const name = project.config.name;
    const intervalMs = host.statusIntervalSeconds * 1000;
    const streaming = chat.stream && !chat.stream.disabled;
    const reply: TurnReply = streaming
      ? new StreamReply(
          chat,
          chat.stream as StreamPort,
          msg.channel,
          msg.threadTs,
          msg.user,
          this.slots.busy,
          Math.min(intervalMs, 1000),
        )
      : new EditReply(chat, msg.channel, msg.threadTs, this.slots.busy, intervalMs);
    await chat.react(msg.channel, msg.ts, 'eyes').catch(() => {});
    const release = await this.slots.acquire();
    reply.working();
    const controller = new AbortController();
    this.running.set(key, controller);
    const startedAt = this.now();

    let session = store.getSession(key) ?? this.freshSession(project, key);
    store.saveSession(session);
    const permissionPrompts = wantsPermissionPrompts(project.config.permissionMode);
    const bridgeContext: RunContext = {
      project,
      channel: msg.channel,
      threadTs: msg.threadTs,
      kind: 'chat',
      permissionPrompts,
      user: msg.user,
    };
    const bridged = this.deps.bridge?.open(bridgeContext);
    const appendSystemPrompt = [
      identityPrompt(host.agentName),
      BASE_PROMPT,
      bridged && this.deps.bridge?.prompt(),
      bridged && this.deps.jobs && JOB_TOOLS_PROMPT,
      project.systemPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
    let env: NodeJS.ProcessEnv = {};
    let toolErrors = 0;
    let outcome: RunOutcome;
    try {
      const scratch = sessionScratch(project, host.stateDir as string, 'chat', session.sessionId);
      env = { ...buildChildEnv(this.env, project.config.billing), TARA_SCRATCH: scratch };
      // The first message of a session says where the folder is (the Write tool needs absolute paths).
      const prompt = `<@${msg.user}>: ${msg.text}${session.started ? '' : `\n\n${foldersNote({ scratch })}`}`;
      outcome = await this.deps.run({
        bin: host.claude.bin,
        args: buildClaudeArgs({
          sessionId: session.sessionId,
          resume: session.started,
          permissionMode: project.config.permissionMode,
          model: session.model,
          effort: host.claude.effort,
          allowedTools: project.config.allowedTools,
          mcpConfig: bridged?.mcpConfigPath,
          permissionPrompts,
          partialMessages: Boolean(streaming),
        }),
        cwd: project.dir,
        env,
        prompt,
        systemPrompt: appendSystemPrompt,
        timeoutMs: host.claude.chatTimeoutMinutes * 60_000,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === 'init' && !session.started) {
            session = { ...session, started: true };
            store.saveSession(session);
          }
          // Sub-agents work out of sight; their parent "Agent" step stands for them.
          if ('parent' in event && event.parent) return;
          if (event.kind === 'tool') reply.toolStart(event.id, event.status);
          else if (event.kind === 'tool_result') {
            if (event.isError) toolErrors++;
            reply.toolEnd(event.id, !event.isError);
          } else if (event.kind === 'text_start') reply.textBreak();
          else if (event.kind === 'text') reply.text(event.text);
        },
      });
    } catch (err) {
      // Setup failed before the CLI ran (e.g. billing "api" without a key).
      outcome = {
        status: 'error',
        text: '',
        durationMs: 0,
        toolCalls: 0,
        permissionDenials: [],
        error: (err as Error).message,
      };
    } finally {
      bridged?.dispose();
      this.running.delete(key);
      release();
    }

    try {
      await this.report(project, key, msg, reply, outcome);
    } catch (err) {
      this.log.error(`[${name}] failed to post result: ${(err as Error).message}`);
    }
    store.recordRun({
      kind: 'chat',
      project: name,
      threadKey: key,
      sessionId: outcome.sessionId ?? session.sessionId,
      model: outcome.model ?? session.model,
      startedAt,
      endedAt: this.now(),
      status: outcome.status,
      costUsd: outcome.costUsd,
      inputTokens: outcome.usage?.input,
      outputTokens: outcome.usage?.output,
      cacheReadTokens: outcome.usage?.cacheRead,
      cacheCreationTokens: outcome.usage?.cacheCreation,
      toolCalls: outcome.toolCalls,
      rateLimitUtilization: outcome.rateLimit?.utilization,
      error: outcome.error,
    });
    this.log.info(
      `[${name}] turn ${outcome.status} in ${formatDuration(outcome.durationMs)} (${outcome.toolCalls} tools)`,
    );

    // Learn from a turn that had trouble (selfImprove). Still inside this thread's queue, so the next
    // message waits for it instead of resuming the same session at the same time.
    // Only when the CLI really started the session (setup errors have nothing to learn from).
    const reasons = project.config.selfImprove && session.started ? troubleReasons(outcome, toolErrors) : [];
    if (reasons.length) {
      const releaseLearn = await this.slots.acquire();
      try {
        await learnFromRun(
          { host, store, chat, run: this.deps.run, log: this.log, bridge: this.deps.bridge, now: this.now },
          {
            project,
            sessionId: outcome.sessionId ?? session.sessionId,
            model: session.model,
            appendSystemPrompt,
            bridge: bridged ? bridgeContext : undefined,
            allowedTools: project.config.allowedTools,
            env,
            reasons,
            channel: msg.channel,
            threadTs: msg.threadTs,
            threadKey: key,
            label: 'This conversation',
          },
        );
      } finally {
        releaseLearn();
      }
    }
  }

  private async report(project: Project, key: string, msg: IncomingMessage, reply: TurnReply, o: RunOutcome) {
    const { chat, store } = this.deps;
    const meta = [
      formatDuration(o.durationMs),
      `${o.toolCalls} ${o.toolCalls === 1 ? 'step' : 'steps'}`,
      o.model,
    ]
      .filter(Boolean)
      .join(' · ');
    const cost =
      project.config.billing === 'api' && o.costUsd !== undefined ? ` · $${o.costUsd.toFixed(2)}` : '';

    let summary: string;
    let reaction: string;
    switch (o.status) {
      case 'ok':
        summary = `✅ Done · ${meta}${cost}`;
        reaction = 'white_check_mark';
        break;
      case 'limit': {
        const resets = o.rateLimit?.resetsAt
          ? ` Resets at ${new Date(o.rateLimit.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
          : '';
        summary = `⏸ Claude usage limit reached.${resets} Reply again later to continue.`;
        reaction = 'double_vertical_bar';
        break;
      }
      case 'timeout':
        summary = `⌛ Timed out after ${formatDuration(o.durationMs)}. The session is kept; reply to continue.`;
        reaction = 'hourglass';
        break;
      case 'aborted':
        summary = `⏹ Stopped after ${formatDuration(o.durationMs)}.`;
        reaction = 'black_square_for_stop';
        break;
      default: {
        if (/no conversation found/i.test(o.error ?? '')) {
          store.deleteSession(key);
          summary =
            '❌ This thread’s session no longer exists on the host. The next message starts a fresh one.';
        } else {
          summary = `❌ Failed: ${(o.error ?? 'unknown error').slice(0, 800)}`;
        }
        reaction = 'x';
      }
    }

    const notes =
      o.permissionDenials.length > 0
        ? [
            `⚠️ Blocked by permission mode \`${project.config.permissionMode}\`: ${o.permissionDenials.join(', ')}. ` +
              'Allow them with `allowedTools` in `.tara/config.json`.',
          ]
        : [];
    await reply.finish({ summary, ok: o.status === 'ok', answer: o.text, notes });
    await chat.unreact(msg.channel, msg.ts, 'eyes').catch(() => {});
    await chat.react(msg.channel, msg.ts, reaction).catch(() => {});
  }
}
