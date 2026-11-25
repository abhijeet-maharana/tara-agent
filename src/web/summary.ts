import { readFile } from 'node:fs/promises';
import { splitAtSeparator } from '../scheduler/prompt.js';
import type { ChatPort, Logger, SlackBlock } from '../sessions/manager.js';
import { hasTable, MARKDOWN_MAX, sendWithFallback, textBlock, toSlackMrkdwn } from '../slack/format.js';
import type { Item, Store } from '../store/store.js';
import { isApprovalCard, type WebChat } from './chat.js';

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

/**
 * The Slack summary that stands for a dashboard thread (the first one posted for it), as its ts in
 * `slackChannel`, or undefined when it has none.
 */
export function slackSummaryOf(
  store: Pick<Store, 'aliasesOf' | 'isMirror'>,
  slackChannel: string,
  channel: string,
  threadTs: string,
): string | undefined {
  const key = store
    .aliasesOf(`${channel}:${threadTs}`)
    .find((k) => k.startsWith(`${slackChannel}:`) && !store.isMirror(k));
  return key?.slice(slackChannel.length + 1);
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
  /**
   * Cards the run left on the Approvals page. Slack then gets only the headline's first line and a link
   * there: the cards hold the details, and go in the summary's thread (`postCardsInThread`).
   */
  cards?: number;
  /** The Approvals page, for that link. */
  approvalsUrl?: string;
  /**
   * A follow-up (the job continuing after your decision, or acting on it): the job's Slack summary it
   * belongs under. It is then a reply there, not a new channel message.
   */
  replyIn?: string;
  /**
   * Who to mention in a `replyIn` follow-up (a Slack user id). A reply under an older bot message
   * notifies nobody unless they follow that thread, so the person who decided is mentioned instead.
   */
  mention?: string;
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
  // "✅ Prime Check: …", "*Prime Check:* …", "**Prime Check**: …" and "**Prime Check: …**" all lose the
  // name; a bold that opened before it and closes later is kept.
  const lead = new RegExp(
    `^(\\S+\\s+)?(\\*\\*|\\*)?${escaped}(\\*\\*|\\*)?\\s*[:·—–-]\\s*(\\*\\*|\\*)?\\s*`,
    'i',
  );
  const [first = '', ...rest] = text.split('\n');
  const trimmed = first.replace(
    lead,
    (_, icon: string | undefined, open: string | undefined, close?: string, after?: string) =>
      (icon ?? '') + (open && !close && !after ? open : ''),
  );
  return trimmed.trim() ? [trimmed, ...rest].join('\n') : text;
}

/** A headline's first line that fits next to the run's name: short, and not a table or code. */
const LEAD_MAX = 200;
/** The status emoji a headline starts with ("✅", "⚠️", "❌"…). */
const ICON = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\uFE0F?)\s*/u;

/**
 * The message's first line: the headline's status emoji, the run's name in bold, then the rest of the
 * headline's first line ("⚠️ *UI Review* · 3 low issues on 17 pages"), so Slack and the phone show the
 * outcome at a glance. The rest of the headline goes below. A first line that is long, a table or code
 * stays below in full, and the name stands alone.
 */
export function summaryHeader(title: string, text: string): { header: string; body: string } {
  const name = title.startsWith('*') ? title : `*${title}*`;
  const [first = '', ...rest] = text.split('\n');
  const line = first.trim();
  if (!line || line.length > LEAD_MAX || line.startsWith('|') || line.startsWith('```'))
    return { header: name, body: text };
  const icon = ICON.exec(line);
  const words = icon ? line.slice(icon[0].length) : line;
  return {
    header: [icon ? `${icon[1]} ${name}` : name, toSlackMrkdwn(words).trim()].filter(Boolean).join(' · '),
    body: rest.join('\n').trim(),
  };
}

/**
 * Posts a dashboard run's result in Slack as one top-level message: its status, name and headline on
 * the first line (a table renders as one below), then a small line with its time, the cards waiting on
 * the Approvals page and a link to the whole run. With cards, only the first line: "⚠️ *UI Review* · 3
 * UI issues found", and the cards follow in that message's thread, with their buttons. Files the run
 * sent go in that thread too, and a reply there continues the run's session (`thread_aliases`). Returns
 * the message's ts, or undefined when it couldn't be posted (logged; the run itself is unaffected).
 */
export async function postSummary(input: SummaryInput): Promise<string | undefined> {
  const { chat, store, web, log, slackChannel, thread } = input;
  const summary = summaryText(input.text);
  const text = withoutName(summary.text, input.title);
  const cards = input.cards ?? 0;
  const waiting = `🟡 ${cards} ${cards === 1 ? 'card waits' : 'cards wait'} for you`;
  const footer = [
    input.meta,
    cards
      ? input.approvalsUrl
        ? `<${input.approvalsUrl}|${waiting} on the Approvals page ↗>`
        : waiting
      : '',
    input.link ? `<${input.link}|${summary.cut || cards ? 'Full details ↗' : 'Open the run ↗'}>` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const shown = summaryHeader(input.title, text || '_(no reply)_');
  // With cards, one line is enough: what they are about is on each card.
  const { header, body } = !cards
    ? shown
    : shown.body === (text || '_(no reply)_')
      ? { header: `${shown.header} · ${waiting}`, body: '' }
      : { header: shown.header, body: '' };
  const who = input.replyIn && input.mention ? `<@${input.mention}> ` : '';
  const blocks: SlackBlock[] = [
    // A section, not a markdown block, which would read the name's `*…*` as italics.
    { type: 'section', text: { type: 'mrkdwn', text: `${who}${header}` } },
    ...(body ? [textBlock(body, SECTION_MAX + 200)] : []),
    ...(footer ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }] : []),
  ];
  // The phone's notification: "Prime Check: ✅ Prime is on again".
  const notice =
    who +
    ([plainTitle(input.title).replace(/\s*\(.*\)$/, ''), notificationLine(text)].filter(Boolean).join(': ') ||
      'Run finished');
  let ts: string;
  try {
    ts = await sendWithFallback(blocks, (b) =>
      chat.postBlocks(slackChannel, input.replyIn, notice, b ?? blocks),
    );
  } catch (err) {
    log.warn(`summary not posted in Slack: ${(err as Error).message}`);
    return undefined;
  }
  // A reply is not a thread of its own: the summary it went under already leads to the job's session.
  if (!input.replyIn) store.saveThreadAlias(`${slackChannel}:${ts}`, `${thread.channel}:${thread.ts}`);
  for (const file of web.files(thread.channel, thread.ts, input.since ?? 0)) {
    try {
      const data = await readFile(file.path);
      await chat.uploadFile(slackChannel, input.replyIn ?? ts, { name: file.name, data }, file.comment);
    } catch (err) {
      log.warn(`file ${file.name} not attached to the summary: ${(err as Error).message}`);
    }
  }
  if (cards) await postCardsInThread(input, input.replyIn ?? ts);
  return ts;
}

/** Drafts listed by name in one reply under a summary; the rest are counted. */
const DRAFTS_LISTED = 10;

/**
 * The cards a run left, as replies under its Slack summary (`at`), so they can be decided there
 * without the channel getting a message per card. An approval card is copied with its buttons and
 * linked to its dashboard message (`web_mirrors`), so a decision, an update or a withdrawal on either
 * side edits the copy too (`RoutedChat.update`), and a tap decides the card by its id. Drafts (no
 * buttons: they are reviewed and edited on the Approvals page) get one reply that links to each.
 */
async function postCardsInThread(input: SummaryInput, at: string): Promise<void> {
  const { chat, store, log, slackChannel, thread } = input;
  const since = input.since ?? 0;
  const items = store
    .itemsInThread(thread.channel, thread.ts, 200)
    .filter((i) => i.status === 'pending' && i.createdAt >= since);
  const drafts: Item[] = [];
  for (const item of items) {
    const card = item.messageTs ? store.getWebMessage(thread.channel, item.messageTs) : undefined;
    const blocks = card?.kind === 'blocks' ? (card.data as SlackBlock[]) : undefined;
    if (!card || !blocks || !isApprovalCard(blocks)) {
      drafts.push(item);
      continue;
    }
    // Already in Slack (a card updated in place by a later run): its copy follows it there.
    if (store.webMirror(card.ts)) continue;
    try {
      const copy = await chat.postBlocks(slackChannel, at, card.text, blocks);
      store.saveWebMirror(card.ts, slackChannel, copy);
    } catch (err) {
      log.warn(`card ${item.id} not copied under the summary: ${(err as Error).message}`);
    }
  }
  if (!drafts.length) return;
  const link = (i: Item) => {
    const title = i.title.replace(/[<>|&]/g, ' ').trim();
    return input.approvalsUrl ? `<${input.approvalsUrl}#item-${i.id}|${title}>` : title;
  };
  const more = drafts.length - DRAFTS_LISTED;
  const text = [
    `📝 *${drafts.length} ${drafts.length === 1 ? 'draft waits' : 'drafts wait'} on the Approvals page*`,
    ...drafts.slice(0, DRAFTS_LISTED).map((i) => `• ${link(i)}`),
    ...(more > 0 ? [`…and ${more} more`] : []),
  ].join('\n');
  await chat
    .post(slackChannel, at, text)
    .catch((err: Error) => log.warn(`drafts not listed under the summary: ${err.message}`));
}
