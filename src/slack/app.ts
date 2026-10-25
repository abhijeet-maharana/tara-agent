import { createReadStream } from 'node:fs';
import path from 'node:path';
import { App, type BlockAction, type ButtonAction, LogLevel } from '@slack/bolt';
import type { ChatPort, IncomingMessage, Logger } from '../sessions/manager.js';
import { StreamError, type StreamPort } from './reply.js';

/** A tap on one of tara's buttons (action ids start with `tara:`). */
export interface ButtonTap {
  actionId: string;
  value: string;
  user: string;
  channel: string;
  messageTs: string;
  /** Thread the button message sits in, if any. */
  threadTs?: string;
}

export interface SlackOptions {
  botToken: string;
  appToken: string;
  log: Logger;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  onButton?: (tap: ButtonTap) => Promise<void>;
  /** Stream replies natively (Slack's "Agents & AI Apps" feature); default true. */
  streaming?: boolean;
}

/** Slack sends &, < and > escaped. Mentions and links (`<@U1>`, `<https://…>`) stay as they are. */
export function decodeSlackText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The parts of a Slack message event the gateway looks at. */
export interface SlackMessageEvent {
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
}

/**
 * Turns a message event into an IncomingMessage, or null when it should be ignored: edits, deletes,
 * joins, our own posts and pure bot posts (no `user`). Messages a person posts through an app with a
 * user token carry a `bot_id` but still have their `user`, so they count as that person.
 */
export function toIncoming(message: SlackMessageEvent, botUserId?: string): IncomingMessage | null {
  if (message.subtype !== undefined && message.subtype !== 'file_share') return null;
  if (!message.user || message.user === botUserId) return null;
  const text = decodeSlackText(message.text ?? '')
    .replace(botUserId ? new RegExp(`<@${botUserId}>\\s*`, 'g') : /$^/, '')
    .trim();
  return {
    channel: message.channel,
    threadTs: message.thread_ts || message.ts,
    ts: message.ts,
    user: message.user,
    text,
  };
}

export interface SlackGateway {
  chat: ChatPort;
  /** The workspace URL (https://acme.slack.com/), known after start(). */
  workspaceUrl(): string | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSlackGateway(options: SlackOptions): SlackGateway {
  const app = new App({
    token: options.botToken,
    appToken: options.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  let botUserId: string | undefined;
  let teamId: string | undefined;
  let workspaceUrl: string | undefined;

  /** Calls a streaming method, turning Slack errors into StreamError with Slack's error code. */
  const streamCall = async (method: string, args: Record<string, unknown>) => {
    try {
      return await app.client.apiCall(method, args);
    } catch (err) {
      const code = (err as { data?: { error?: string } }).data?.error ?? (err as Error).message;
      throw new StreamError(code);
    }
  };
  const stream: StreamPort = {
    disabled: options.streaming === false,
    async start(channel, threadTs, recipientUserId) {
      const res = await streamCall('chat.startStream', {
        channel,
        thread_ts: threadTs,
        recipient_user_id: recipientUserId,
        ...(teamId ? { recipient_team_id: teamId } : {}),
        task_display_mode: 'plan',
      });
      const ts = (res as { ts?: string }).ts;
      if (!ts) throw new StreamError('no_stream_ts');
      return ts;
    },
    async append(channel, ts, chunks) {
      await streamCall('chat.appendStream', { channel, ts, chunks });
    },
    async stop(channel, ts) {
      await streamCall('chat.stopStream', { channel, ts });
    },
  };

  app.message(async ({ message }) => {
    const incoming = toIncoming(message as SlackMessageEvent, botUserId);
    if (!incoming) return;
    // Don't block Bolt's listener on a whole Claude turn.
    void options
      .onMessage(incoming)
      .catch((err: Error) => options.log.error(`message handling failed: ${err.message}`));
  });

  app.action<BlockAction<ButtonAction>>(/^tara:/, async ({ ack, body, action }) => {
    await ack();
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;
    if (!channel || !messageTs || !options.onButton) return;
    void options
      .onButton({
        actionId: action.action_id,
        value: action.value ?? '',
        user: body.user.id,
        channel,
        messageTs,
        threadTs: (body.message as { thread_ts?: string } | undefined)?.thread_ts,
      })
      .catch((err: Error) => options.log.error(`button handling failed: ${err.message}`));
  });

  app.error(async (err) => {
    options.log.error(`slack error: ${err.message}`);
  });

  const chat: ChatPort = {
    stream,
    async post(channel, threadTs, text) {
      const res = await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      return res.ts as string;
    },
    async delete(channel, ts) {
      await app.client.chat.delete({ channel, ts });
    },
    async update(channel, ts, text, blocks) {
      await app.client.chat.update({ channel, ts, text, ...(blocks ? { blocks } : {}) });
    },
    async postBlocks(channel, threadTs, text, blocks) {
      const res = await app.client.chat.postMessage({ channel, thread_ts: threadTs, text, blocks });
      return res.ts as string;
    },
    async uploadFile(channel, threadTs, filePath, comment) {
      await app.client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: createReadStream(filePath),
        filename: path.basename(filePath),
        ...(comment ? { initial_comment: comment } : {}),
      });
    },
    async react(channel, ts, emoji) {
      await app.client.reactions.add({ channel, timestamp: ts, name: emoji });
    },
    async unreact(channel, ts, emoji) {
      await app.client.reactions.remove({ channel, timestamp: ts, name: emoji });
    },
  };

  return {
    chat,
    workspaceUrl: () => workspaceUrl,
    async start() {
      const auth = await app.client.auth.test();
      botUserId = auth.user_id;
      teamId = auth.team_id;
      workspaceUrl = auth.url;
      await app.start();
      options.log.info(`Slack connected as ${auth.user} (${auth.team})`);
    },
    async stop() {
      await app.stop();
    },
  };
}
