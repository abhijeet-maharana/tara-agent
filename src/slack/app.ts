import { createReadStream } from 'node:fs';
import path from 'node:path';
import { App, type BlockAction, type ButtonAction, LogLevel } from '@slack/bolt';
import type { ChatPort, IncomingMessage, Logger } from '../sessions/manager.js';

/** A tap on one of tara's buttons (action ids start with `tara:`). */
export interface ButtonTap {
  actionId: string;
  value: string;
  user: string;
  channel: string;
  messageTs: string;
}

export interface SlackOptions {
  botToken: string;
  appToken: string;
  log: Logger;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  onButton?: (tap: ButtonTap) => Promise<void>;
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
      })
      .catch((err: Error) => options.log.error(`button handling failed: ${err.message}`));
  });

  app.error(async (err) => {
    options.log.error(`slack error: ${err.message}`);
  });

  const chat: ChatPort = {
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
    async start() {
      const auth = await app.client.auth.test();
      botUserId = auth.user_id;
      await app.start();
      options.log.info(`Slack connected as ${auth.user} (${auth.team})`);
    },
    async stop() {
      await app.stop();
    },
  };
}
