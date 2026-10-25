import { App, LogLevel } from '@slack/bolt';
import type { ChatPort, IncomingMessage, Logger } from '../sessions/manager.js';

export interface SlackOptions {
  botToken: string;
  appToken: string;
  log: Logger;
  onMessage: (msg: IncomingMessage) => Promise<void>;
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
    async update(channel, ts, text) {
      await app.client.chat.update({ channel, ts, text });
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
