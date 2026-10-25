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
    // Plain user messages and file shares only; skip edits, deletes, joins and every bot (including us).
    if (message.subtype !== undefined && message.subtype !== 'file_share') return;
    if (!('user' in message) || !message.user || ('bot_id' in message && message.bot_id)) return;
    if (message.user === botUserId) return;

    const text = decodeSlackText(message.text ?? '')
      .replace(botUserId ? new RegExp(`<@${botUserId}>\\s*`, 'g') : /$^/, '')
      .trim();
    // Don't block Bolt's listener on a whole Claude turn.
    void options
      .onMessage({
        channel: message.channel,
        threadTs: ('thread_ts' in message && message.thread_ts) || message.ts,
        ts: message.ts,
        user: message.user,
        text,
      })
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
