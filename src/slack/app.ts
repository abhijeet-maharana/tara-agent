import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { App, type BlockAction, type ButtonAction, LogLevel } from '@slack/bolt';
import { parseScheduledRun } from '../scheduler/slack-trigger.js';
import type { ChatPort, IncomingMessage, Logger } from '../sessions/manager.js';
import { StreamError, type StreamPort } from './reply.js';
import { transcribeAudio, type VoiceOptions } from './voice.js';

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
  /** A person's token (xoxp-…): scheduled-run triggers are posted as them. */
  userToken?: string;
  log: Logger;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  onButton?: (tap: ButtonTap) => Promise<void>;
  /** Stream replies natively (Slack's "Agents & AI Apps" feature); default true. */
  streaming?: boolean;
  /** Speech-to-text for voice notes Slack didn't transcribe; unset = Slack's transcript only. */
  voice?: VoiceOptions;
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
  files?: SlackFile[];
}

/** The parts of a Slack file the gateway looks at: enough to read a voice note's transcript. */
export interface SlackFile {
  id: string;
  subtype?: string;
  media_display_type?: string;
  /** Slack's own speech-to-text for audio clips; usually still `processing` when the message arrives. */
  transcription?: { status?: string; preview?: { content?: string; has_more?: boolean } };
  /** The full transcript as WebVTT (needs the bot token), for when the preview is cut short. */
  vtt?: string;
  /** The audio itself (needs the bot token), for `voice` when Slack has no transcript. */
  url_private_download?: string;
  filetype?: string;
  name?: string;
  size?: number;
}

/** The first voice note (a Slack audio clip) in a message, if any. */
export function voiceClip(files: SlackFile[] | undefined): SlackFile | undefined {
  return files?.find((f) => f.subtype === 'slack_audio' || f.media_display_type === 'audio');
}

/** Files Claude gets to read (photos, PDFs, …): everything but voice clips, up to `MAX_FILE_BYTES` each. */
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export function attachedFiles(files: SlackFile[] | undefined): SlackFile[] {
  const clip = voiceClip(files);
  return (files ?? [])
    .filter((f) => f !== clip && f.url_private_download && (f.size ?? 0) <= MAX_FILE_BYTES)
    .slice(0, MAX_FILES);
}

/** The spoken text of a WebVTT transcript: cue text only, without the header, cue ids and timings. */
export function vttToText(vtt: string): string {
  const blocks = vtt.replace(/\r/g, '').split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const timing = lines.findIndex((l) => l.includes('-->'));
      return timing < 0
        ? ''
        : lines
            .slice(timing + 1)
            .join(' ')
            .trim();
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * Turns a message event into an IncomingMessage, or null when it should be ignored: edits, deletes,
 * joins, our own posts and pure bot posts (no `user`). Messages a person posts through an app with a
 * user token carry a `bot_id` but still have their `user`, so they count as that person.
 * The exception: our own scheduled-run trigger messages, which start the job they name.
 */
export function toIncoming(
  message: SlackMessageEvent,
  botUserId?: string,
  botId?: string,
): IncomingMessage | null {
  // A person posting through this app with a user token also carries its bot_id, but has their own user.
  const own =
    (botUserId !== undefined && message.user === botUserId) ||
    (botId !== undefined && !message.user && message.bot_id === botId);
  if (own) {
    const text = decodeSlackText(message.text ?? '');
    if (message.thread_ts || !parseScheduledRun(text)) return null;
    if (message.subtype !== undefined && message.subtype !== 'bot_message') return null;
    const user = botUserId ?? message.user ?? 'bot';
    return { channel: message.channel, threadTs: message.ts, ts: message.ts, user, text, fromSelf: true };
  }
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
    // Our own messages reach `toIncoming`, which drops all but the scheduled-run triggers.
    ignoreSelf: false,
    logLevel: LogLevel.WARN,
  });

  let botUserId: string | undefined;
  let botId: string | undefined;
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

  /**
   * The words of a voice note. Slack's own transcript comes first: it transcribes after posting, so
   * this polls the file (10 s with a `voice` fallback, a minute without). Slack skips some clips
   * (short ones, some languages), so then the audio goes to `voice` if set.
   */
  const transcribe = async (clip: SlackFile): Promise<string | undefined> => {
    let file = clip;
    const attempts = options.voice ? 5 : 30;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const status = file.transcription?.status;
      if (status === 'complete' || status === 'failed') break;
      await new Promise((r) => setTimeout(r, 2000));
      file = ((await app.client.files.info({ file: clip.id })).file as SlackFile | undefined) ?? file;
    }
    const auth = { headers: { Authorization: `Bearer ${options.botToken}` } };
    if (file.transcription?.status === 'complete') {
      const preview = file.transcription.preview;
      if (preview?.has_more && file.vtt) {
        const res = await fetch(file.vtt, auth);
        if (res.ok) return vttToText(await res.text()) || undefined;
      }
      if (preview?.content?.trim()) return preview.content.trim();
    }
    if (!options.voice || !file.url_private_download) return undefined;
    const res = await fetch(file.url_private_download, auth);
    if (!res.ok) return undefined;
    return transcribeAudio(Buffer.from(await res.arrayBuffer()), file.filetype ?? 'm4a', options.voice);
  };

  app.message(async ({ message }) => {
    const event = message as SlackMessageEvent;
    const incoming = toIncoming(event, botUserId, botId);
    if (!incoming) return;
    // Don't block Bolt's listener on a whole Claude turn.
    void (async () => {
      const clip = voiceClip(event.files);
      if (clip) {
        const spoken = await transcribe(clip);
        if (!spoken) {
          options.log.warn(`no transcript for voice note ${clip.id}`);
          await chat.post(
            incoming.channel,
            incoming.threadTs,
            'I couldn’t get a transcript for that voice note. Please type it.',
          );
          return;
        }
        incoming.text = [incoming.text, spoken].filter(Boolean).join('\n\n');
      }
      const files = attachedFiles(event.files);
      if (files.length > 0) {
        const auth = { headers: { Authorization: `Bearer ${options.botToken}` } };
        incoming.attachments = files.map((f) => ({
          name: f.name ?? `${f.id}.${f.filetype ?? 'bin'}`,
          async fetch() {
            const res = await fetch(f.url_private_download as string, auth);
            if (!res.ok) throw new Error(`download of ${f.id} failed: HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
          },
        }));
      }
      await options.onMessage(incoming);
    })().catch((err: Error) => options.log.error(`message handling failed: ${err.message}`));
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
    ...(options.userToken
      ? {
          async postAsUser(channel: string, text: string) {
            const res = await app.client.chat.postMessage({ token: options.userToken, channel, text });
            return res.ts as string;
          },
        }
      : {}),
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
      // Read up front: a stream that fails to open emits an 'error' nobody listens to and crashes the process.
      const file = await readFile(filePath);
      await app.client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file,
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
      botId = auth.bot_id;
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
