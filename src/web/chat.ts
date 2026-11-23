import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostConfig, JobConfig, Project } from '../config/schema.js';
import type { ChatPort, Logger, SlackBlock } from '../sessions/manager.js';
import type { StreamChunk, StreamPort, TaskStatus } from '../slack/reply.js';
import type { Store, WebMessage } from '../store/store.js';

/**
 * Dashboard threads: where runs nobody started from Slack happen (host `delivery: summary`). They look
 * like Slack threads to the rest of tara-agent (a channel and a thread ts, so sessions, locks, cards and
 * files work unchanged), but live in SQLite and show on the dashboard's session page. Slack gets one
 * summary when a run ends (`postSummary`), plus a copy of a permission prompt (`RoutedChat`), and a
 * reply in either Slack thread continues the run's session (`thread_aliases`).
 *
 * A dashboard channel is `web-<project>`: project names are lowercase with dashes, and Slack channel ids
 * start with C, D or G, so the two never meet, and neither has a ':' (thread keys split on it).
 */

const PREFIX = 'web-';

export const webChannel = (project: string) => `${PREFIX}${project}`;
export const isWebChannel = (channel: string | undefined): channel is string =>
  Boolean(channel?.startsWith(PREFIX));
/** The project a dashboard channel belongs to. */
export const webProject = (channel: string) =>
  isWebChannel(channel) ? channel.slice(PREFIX.length) : undefined;
export const isWebKey = (key: string) => key.startsWith(PREFIX);

export type Delivery = 'summary' | 'thread';

/** Where a project's (or one job's) unattended runs happen: the job, then the project, then the host. */
export function deliveryOf(
  host: Pick<HostConfig, 'delivery'>,
  project: Project,
  job?: Pick<JobConfig, 'delivery'>,
): Delivery {
  return job?.delivery ?? project.config.delivery ?? host.delivery ?? 'summary';
}

/** The task card of a streamed reply, as the dashboard shows it. */
export interface StreamState {
  title: string;
  tasks: Array<{ id: string; title: string; status: TaskStatus }>;
  done: boolean;
}

/** A file posted in a dashboard thread (`send_file`). */
export interface WebFile {
  name: string;
  /** Where it is kept on this machine. */
  path: string;
  comment?: string;
}

/**
 * The dashboard's side of the chat: every call lands in `web_messages`. Streams (Slack's live reply
 * with a task card) are kept as one message whose text grows and whose task list is updated.
 */
export class WebChat implements ChatPort {
  private lastMicros = 0;
  readonly filesDir: string;
  readonly stream: StreamPort;

  constructor(
    private readonly store: Store,
    stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.filesDir = path.join(stateDir, 'web-files');
    const streams = new Map<string, StreamState>();
    const save = (channel: string, ts: string, state: StreamState, text?: string) =>
      this.store.updateWebMessage(channel, ts, { data: state, ...(text === undefined ? {} : { text }) });
    this.stream = {
      disabled: false,
      start: async (channel, threadTs) => {
        const ts = this.nextTs();
        const state: StreamState = { title: '⏳ Working…', tasks: [], done: false };
        streams.set(ts, state);
        this.store.addWebMessage({ channel, threadTs, ts, kind: 'stream', text: '', data: state });
        return ts;
      },
      append: async (channel, ts, chunks: StreamChunk[]) => {
        const state = streams.get(ts) ?? { title: '', tasks: [], done: false };
        streams.set(ts, state);
        let text = '';
        for (const c of chunks) {
          if (c.type === 'markdown_text') text += c.text;
          else if (c.type === 'plan_update') state.title = c.title;
          else {
            const task = state.tasks.find((t) => t.id === c.id);
            if (task) Object.assign(task, { title: c.title, status: c.status });
            else state.tasks.push({ id: c.id, title: c.title, status: c.status });
          }
        }
        const prev = this.store.getWebMessage(channel, ts)?.text ?? '';
        save(channel, ts, state, text ? prev + text : undefined);
      },
      stop: async (channel, ts) => {
        const state = streams.get(ts);
        streams.delete(ts);
        if (state) save(channel, ts, { ...state, done: true });
      },
    };
  }

  /** A Slack-like ts ("1731999999.000123"), unique and rising, so anything that reads ts as a time still can. */
  nextTs(): string {
    const micros = Math.max(this.now() * 1000, this.lastMicros + 1);
    this.lastMicros = micros;
    return `${Math.floor(micros / 1e6)}.${String(micros % 1e6).padStart(6, '0')}`;
  }

  async post(channel: string, threadTs: string | undefined, text: string, user?: string): Promise<string> {
    const ts = this.nextTs();
    this.store.addWebMessage({ channel, threadTs: threadTs ?? ts, ts, kind: 'text', text, user });
    return ts;
  }

  async postAsUser(channel: string, text: string, threadTs?: string): Promise<string> {
    return this.post(channel, threadTs, text);
  }

  async delete(channel: string, ts: string): Promise<void> {
    this.store.deleteWebMessage(channel, ts);
  }

  async update(channel: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void> {
    this.store.updateWebMessage(channel, ts, blocks ? { text, data: blocks, kind: 'blocks' } : { text });
  }

  async postBlocks(
    channel: string,
    threadTs: string | undefined,
    text: string,
    blocks: SlackBlock[],
  ): Promise<string> {
    const ts = this.nextTs();
    this.store.addWebMessage({ channel, threadTs: threadTs ?? ts, ts, kind: 'blocks', text, data: blocks });
    return ts;
  }

  async uploadFile(
    channel: string,
    threadTs: string,
    file: { name: string; data: Buffer },
    comment?: string,
  ): Promise<void> {
    const ts = this.nextTs();
    const dir = path.join(this.filesDir, ts.replace('.', '-'));
    mkdirSync(dir, { recursive: true });
    const safe = file.name.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';
    const target = path.join(dir, safe);
    writeFileSync(target, file.data);
    const data: WebFile = { name: file.name, path: target, comment };
    this.store.addWebMessage({ channel, threadTs, ts, kind: 'file', text: comment ?? file.name, data });
  }

  async react(): Promise<void> {}
  async unreact(): Promise<void> {}

  /** The files posted in a thread since `since` (ms), oldest first. */
  files(channel: string, threadTs: string, since = 0): Array<WebFile & { id: number }> {
    return this.store
      .webThread(channel, threadTs)
      .filter((m) => m.kind === 'file' && m.createdAt >= since)
      .map((m) => ({ ...(m.data as WebFile), id: m.id }));
  }

  /** Deletes stored files older than `before` (ms); returns how many folders went. */
  sweep(before: number): number {
    let removed = 0;
    let names: string[];
    try {
      names = readdirSync(this.filesDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const dir = path.join(this.filesDir, name);
      try {
        if (statSync(dir).mtimeMs < before) {
          rmSync(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Gone already.
      }
    }
    return removed;
  }
}

/** Whether a Block Kit message has `tara:` buttons (an approval card, a permission prompt). */
export function hasButtons(blocks: SlackBlock[] | undefined): boolean {
  return Boolean(
    blocks?.some(
      (b) =>
        b.type === 'actions' &&
        Array.isArray(b.elements) &&
        (b.elements as Array<{ action_id?: string }>).some((e) => e.action_id?.startsWith('tara:')),
    ),
  );
}

export interface RoutedChatOptions {
  store: Store;
  log: Logger;
  /** The Slack channel a dashboard channel's cards are copied to (its project's channel). */
  slackChannelFor: (webChannel: string) => string | undefined;
  /** The dashboard link of a dashboard thread, for Slack copies of its cards. */
  link?: (channel: string, threadTs: string) => string | undefined;
}

/** Whether a Block Kit message is an approval card (`tara:approval:` buttons). */
export function isApprovalCard(blocks: SlackBlock[] | undefined): boolean {
  return Boolean(
    blocks?.some(
      (b) =>
        b.type === 'actions' &&
        Array.isArray(b.elements) &&
        (b.elements as Array<{ action_id?: string }>).some((e) => e.action_id?.startsWith('tara:approval:')),
    ),
  );
}

/**
 * The chat everything in tara-agent talks to: Slack for Slack channels, the dashboard for dashboard
 * ones. Approval cards are not copied as they are posted: the run's Slack summary says how many wait
 * and `postSummary` copies them into its thread. Only other cards with buttons (a permission prompt,
 * which blocks its run) are copied to the project's Slack channel at once. Edits of any copied message
 * follow it there (`web_mirrors`), and a reply in that copy's Slack thread goes to the run's session.
 */
export class RoutedChat implements ChatPort {
  constructor(
    private readonly slack: ChatPort,
    readonly web: WebChat,
    private readonly opts: RoutedChatOptions,
  ) {}

  /** Slack's stream (undefined for a dashboard channel's caller that asks `streamFor`). */
  get stream(): StreamPort | undefined {
    return this.slack.stream;
  }

  /** The stream for a channel: the dashboard always streams; Slack only when its app can. */
  streamFor(channel: string): StreamPort | undefined {
    return isWebChannel(channel) ? this.web.stream : this.slack.stream;
  }

  private to(channel: string): ChatPort {
    return isWebChannel(channel) ? this.web : this.slack;
  }

  post(channel: string, threadTs: string | undefined, text: string): Promise<string> {
    return this.to(channel).post(channel, threadTs, text);
  }

  get postAsUser(): ChatPort['postAsUser'] {
    const slack = this.slack.postAsUser?.bind(this.slack);
    if (!slack) return undefined;
    return (channel, text, threadTs) =>
      isWebChannel(channel) ? this.web.post(channel, threadTs, text) : slack(channel, text, threadTs);
  }

  async delete(channel: string, ts: string): Promise<void> {
    await this.to(channel).delete(channel, ts);
    const mirror = isWebChannel(channel) ? this.opts.store.webMirror(ts) : undefined;
    if (mirror) await this.slack.delete(mirror.channel, mirror.ts).catch(() => {});
  }

  async update(channel: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void> {
    await this.to(channel).update(channel, ts, text, blocks);
    // Slack copies (a permission prompt, approval cards under a summary) follow their card.
    const mirror = isWebChannel(channel) ? this.opts.store.webMirror(ts) : undefined;
    if (mirror) {
      const thread = this.opts.store.getWebMessage(channel, ts)?.threadTs;
      await this.slack
        .update(
          mirror.channel,
          mirror.ts,
          text,
          blocks && withLink(blocks, thread && this.opts.link?.(channel, thread)),
        )
        .catch((err: Error) =>
          this.opts.log.warn(`could not update the Slack copy of ${ts}: ${err.message}`),
        );
    }
  }

  async postBlocks(
    channel: string,
    threadTs: string | undefined,
    text: string,
    blocks: SlackBlock[],
  ): Promise<string> {
    const ts = await this.to(channel).postBlocks(channel, threadTs, text, blocks);
    // Approval cards wait on the Approvals page; a permission prompt blocks its run, so it goes to Slack.
    if (isWebChannel(channel) && hasButtons(blocks) && !isApprovalCard(blocks)) {
      const slackChannel = this.opts.slackChannelFor(channel);
      const thread = threadTs ?? ts;
      if (slackChannel) {
        try {
          const copy = await this.slack.postBlocks(
            slackChannel,
            undefined,
            text,
            withLink(blocks, this.opts.link?.(channel, thread)),
          );
          this.opts.store.saveWebMirror(ts, slackChannel, copy);
          this.opts.store.saveThreadAlias(`${slackChannel}:${copy}`, `${channel}:${thread}`);
        } catch (err) {
          this.opts.log.warn(`card not copied to Slack: ${(err as Error).message}`);
        }
      }
    }
    return ts;
  }

  uploadFile(
    channel: string,
    threadTs: string,
    file: { name: string; data: Buffer },
    comment?: string,
  ): Promise<void> {
    return this.to(channel).uploadFile(channel, threadTs, file, comment);
  }

  react(channel: string, ts: string, emoji: string): Promise<void> {
    return this.to(channel).react(channel, ts, emoji);
  }

  unreact(channel: string, ts: string, emoji: string): Promise<void> {
    return this.to(channel).unreact(channel, ts, emoji);
  }
}

/** The blocks with a last context line linking to the run on the dashboard. */
function withLink(blocks: SlackBlock[], link: string | undefined): SlackBlock[] {
  if (!link) return blocks;
  return [
    ...blocks,
    { type: 'context', elements: [{ type: 'mrkdwn', text: `<${link}|Open the run on the dashboard ↗>` }] },
  ];
}

/** The stream to use in a channel: the router's per-channel one, else the chat's own. */
export function streamFor(chat: ChatPort, channel: string): StreamPort | undefined {
  const routed = (chat as Partial<RoutedChat>).streamFor;
  const port = typeof routed === 'function' ? routed.call(chat, channel) : chat.stream;
  return port && !port.disabled ? port : undefined;
}

/** The dashboard side of a chat, when it has one (tests and old wiring pass Slack alone). */
export function webOf(chat: ChatPort): WebChat | undefined {
  return chat instanceof RoutedChat ? chat.web : undefined;
}

/** A thread's messages as the dashboard shows them. */
export type { WebMessage };
