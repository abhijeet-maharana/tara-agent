import { randomUUID } from 'node:crypto';
import type { HostConfig, Project } from '../config/schema.js';
import { buildClaudeArgs } from '../runner/args.js';
import { buildChildEnv } from '../runner/env.js';
import type { Runner, RunOutcome } from '../runner/run.js';
import type { JobControl } from '../scheduler/scheduler.js';
import { formatDuration, splitMessage, toSlackMrkdwn } from '../slack/format.js';
import type { SessionRow, Store } from '../store/store.js';
import { KeyedQueue, Semaphore, Throttle } from '../util/concurrency.js';

/** The chat platform as the session manager sees it. Slack implements it; tests fake it. */
export interface ChatPort {
  /** Posts into a thread (or top-level when `threadTs` is undefined) and returns the new message's ts. */
  post(channel: string, threadTs: string | undefined, text: string): Promise<string>;
  delete(channel: string, ts: string): Promise<void>;
  update(channel: string, ts: string, text: string): Promise<void>;
  react(channel: string, ts: string, emoji: string): Promise<void>;
  unreact(channel: string, ts: string, emoji: string): Promise<void>;
}

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
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  newSessionId?: () => string;
  now?: () => number;
}

const BASE_PROMPT = `You are running headless for a Slack thread, through tara-agent.
- People read your replies in Slack, often on a phone: lead with the answer, keep it short, use bullets, avoid wide tables.
- Only your final message is posted to the thread. Text between tool calls is not shown.
- Each message starts with the sender's Slack mention, e.g. "<@U123>: ...". Several people may share a thread.
- You cannot ask questions mid-turn. If you need input, end your turn with the question.`;

const HELP = `*Thread commands*
• \`!new\` forget this thread's session; the next message starts fresh
• \`!model <name>\` switch model for this thread (e.g. \`opus\`, \`sonnet\`, \`haiku\`)
• \`!stop\` stop the running turn
• \`!status\` show session, model and queue
• \`!jobs\` list this channel's scheduled jobs
• \`!run <job-id>\` run a job now (it posts its own thread)`;

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

    await this.queue.run(key, () => this.turn(project, key, msg));
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
    const statusTs = await chat.post(
      msg.channel,
      msg.threadTs,
      this.slots.busy ? '⏳ Waiting for a free slot…' : '⏳ Working…',
    );
    await chat.react(msg.channel, msg.ts, 'eyes').catch(() => {});
    const release = await this.slots.acquire();
    const controller = new AbortController();
    this.running.set(key, controller);
    const startedAt = this.now();
    const steps: string[] = [];
    const status = new Throttle<string>(host.statusIntervalSeconds * 1000, (text) =>
      chat.update(msg.channel, statusTs, text),
    );

    let session = store.getSession(key) ?? this.freshSession(project, key);
    store.saveSession(session);
    let outcome: RunOutcome;
    try {
      outcome = await this.deps.run({
        bin: host.claude.bin,
        args: buildClaudeArgs({
          sessionId: session.sessionId,
          resume: session.started,
          permissionMode: project.config.permissionMode,
          model: session.model,
          appendSystemPrompt: [BASE_PROMPT, project.systemPrompt].filter(Boolean).join('\n\n'),
          allowedTools: project.config.allowedTools,
        }),
        cwd: project.dir,
        env: buildChildEnv(this.env, project.config.billing),
        prompt: `<@${msg.user}>: ${msg.text}`,
        timeoutMs: host.claude.chatTimeoutMinutes * 60_000,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === 'init' && !session.started) {
            session = { ...session, started: true };
            store.saveSession(session);
          } else if (event.kind === 'tool') {
            steps.push(event.status);
            status.push(`⏳ Working · step ${steps.length}\n> ${event.status}`);
          }
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
      this.running.delete(key);
      release();
    }

    await status.flush();
    try {
      await this.report(project, key, msg, statusTs, outcome);
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
  }

  private async report(project: Project, key: string, msg: IncomingMessage, statusTs: string, o: RunOutcome) {
    const { chat, store } = this.deps;
    const post = (text: string) => chat.post(msg.channel, msg.threadTs, text);
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

    await chat.update(msg.channel, statusTs, summary);
    if (o.status === 'ok') {
      for (const chunk of splitMessage(toSlackMrkdwn(o.text.trim() || '_(no text reply)_')))
        await post(chunk);
    }
    if (o.permissionDenials.length > 0) {
      await post(
        `⚠️ Blocked by permission mode \`${project.config.permissionMode}\`: ${o.permissionDenials.join(', ')}. ` +
          'Allow them with `allowedTools` in `.tara/config.json`.',
      );
    }
    await chat.unreact(msg.channel, msg.ts, 'eyes').catch(() => {});
    await chat.react(msg.channel, msg.ts, reaction).catch(() => {});
  }
}
