import { readFile } from 'node:fs/promises';
import { splitAtSeparator } from '../scheduler/prompt.js';
import type { ChatPort, Logger, SlackBlock } from '../sessions/manager.js';
import { hasTable, MARKDOWN_MAX, sendWithFallback, textBlock } from '../slack/format.js';
import type { Store } from '../store/store.js';
import type { WebChat } from './chat.js';

/** Slack's limit for a section's text, less room for "… more on the dashboard". */
const SECTION_MAX = 2_800;

/**
 * What Slack shows of a run's reply: the headline (the part before a line of only `---`, or the first
 * paragraph of a long reply without one), tables included, cut to fit one message.
 */
export function summaryText(reply: string): { text: string; cut: boolean } {
  const { headline, details } = splitAtSeparator(reply);
  const max = hasTable(headline) ? MARKDOWN_MAX : SECTION_MAX;
  if (headline.length <= max) return { text: headline, cut: details.length > 0 };
  const at = headline.lastIndexOf('\n', max);
  return { text: headline.slice(0, at > max / 2 ? at : max).trimEnd(), cut: true };
}

/** A notification's one line: the headline's first line without markdown, e.g. "✅ Amazon Prime is now on". */
export function notificationLine(text: string): string {
  const first = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('|')) ?? text;
  return first
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
    .slice(0, 150);
}

export interface SummaryInput {
  /** Slack (or the router, which sends a Slack channel to Slack). */
  chat: ChatPort;
  store: Store;
  web: WebChat;
  log: Logger;
  /** Where the summary goes. */
  slackChannel: string;
  /** The dashboard thread the run happened in. */
  thread: { channel: string; ts: string };
  /** The run's name, e.g. "*Amazon Prime Check*" (Slack mrkdwn): the message's first line. */
  title: string;
  /** The reply to summarize, or a status line for a run that didn't finish. */
  text: string;
  /** e.g. "2m 13s · 14 steps". */
  meta?: string;
  /** The run's page on the dashboard. */
  link?: string;
  /** Files the run posted from this time (ms) on are attached in the summary's thread. */
  since?: number;
}

/** A title's plain words: "*Prime Check* (catch-up)" → "Prime Check (catch-up)". */
export function plainTitle(title: string): string {
  return title
    .replace(/<@[A-Z0-9]+>/g, 'you')
    .replace(/[*_`]/g, '')
    .trim();
}

/**
 * The headline without the run's name at its start ("✅ Prime Check: Prime is on" → "✅ Prime is on"),
 * since the message already opens with the name.
 */
export function withoutName(text: string, title: string): string {
  const name = plainTitle(title).replace(/\s*\(.*\)$/, '');
  if (!name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = new RegExp(`^(\\S+\\s+)?(?:\\*\\*|\\*)?${escaped}(?:\\*\\*|\\*)?\\s*(?:[:·—–-]\\s*)`, 'i');
  const [first = '', ...rest] = text.split('\n');
  const trimmed = first.replace(lead, (_, icon: string | undefined) => icon ?? '');
  return trimmed.trim() ? [trimmed, ...rest].join('\n') : text;
}

/**
 * Posts a dashboard run's result in Slack as one top-level message: the run's name, its headline (a
 * table renders as one), then a small line with its time and a link to the whole run. Files the run sent go in
 * that message's thread, and a reply there continues the run's session (`thread_aliases`). Returns the
 * message's ts, or undefined when it couldn't be posted (logged; the run itself is unaffected).
 */
export async function postSummary(input: SummaryInput): Promise<string | undefined> {
  const { chat, store, web, log, slackChannel, thread } = input;
  const summary = summaryText(input.text);
  const text = withoutName(summary.text, input.title);
  const footer = [
    input.meta,
    input.link ? `<${input.link}|${summary.cut ? 'Full details ↗' : 'Open the run ↗'}>` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const blocks: SlackBlock[] = [
    // The name first, on its own (a markdown block would read `*…*` as italics).
    {
      type: 'section',
      text: { type: 'mrkdwn', text: input.title.startsWith('*') ? input.title : `*${input.title}*` },
    },
    textBlock(text || '_(no reply)_', SECTION_MAX + 200),
    ...(footer ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }] : []),
  ];
  // The phone's notification: "Prime Check: ✅ Prime is on again".
  const notice =
    [plainTitle(input.title).replace(/\s*\(.*\)$/, ''), notificationLine(text)].filter(Boolean).join(': ') ||
    'Run finished';
  let ts: string;
  try {
    ts = await sendWithFallback(blocks, (b) => chat.postBlocks(slackChannel, undefined, notice, b ?? blocks));
  } catch (err) {
    log.warn(`summary not posted in Slack: ${(err as Error).message}`);
    return undefined;
  }
  store.saveThreadAlias(`${slackChannel}:${ts}`, `${thread.channel}:${thread.ts}`);
  for (const file of web.files(thread.channel, thread.ts, input.since ?? 0)) {
    try {
      const data = await readFile(file.path);
      await chat.uploadFile(slackChannel, ts, { name: file.name, data }, file.comment);
    } catch (err) {
      log.warn(`file ${file.name} not attached to the summary: ${(err as Error).message}`);
    }
  }
  return ts;
}
