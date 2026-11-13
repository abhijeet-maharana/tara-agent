import type { ChatPort, SlackBlock } from '../sessions/manager.js';

/** Slack rejects messages over 40k chars and truncates display far earlier; keep chunks readable. */
export const MAX_CHUNK = 3_500;

const FENCE = /^\s*```/;

function convertLine(line: string): string {
  return (
    line
      // Headings → bold line (as **…**, converted to Slack bold below)
      .replace(/^#{1,6}\s+(.+?)\s*#*$/, '**$1**')
      // Bullets: "- x" / "* x" → "• x"
      .replace(/^(\s*)[-*]\s+/, '$1• ')
      // Links [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>')
      // *italic* → _italic_ (before bold, so **bold** is untouched here)
      .replace(/(?<![*\w])\*(?!\*|\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, '_$1_')
      // **bold** / __bold__ → *bold*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '*$1*')
      // ~~strike~~ → ~strike~
      .replace(/~~(.+?)~~/g, '~$1~')
  );
}

/**
 * Turns broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^…>`) into plain text.
 * Model output can carry them from a page or email it read, and one would ping the whole channel.
 * Person mentions (`<@U…>`) stay: replies address the project owner.
 */
export function defuseBroadcasts(text: string): string {
  return text
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/gi, '@\u200b$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/gi, (_, name) => `@\u200b${name || 'group'}`);
}

/** Converts Claude's GitHub-flavoured markdown to Slack mrkdwn. Code blocks pass through untouched. */
export function toSlackMrkdwn(markdown: string): string {
  let inFence = false;
  return defuseBroadcasts(markdown)
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line.trim().startsWith('```') ? '```' : line; // Slack ignores the language tag but prints it
      }
      if (inFence) return line;
      // Leave inline code spans as they are.
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : convertLine(part),
        )
        .join('');
    })
    .join('\n');
}

/** Splits text into Slack-sized chunks on line boundaries, closing and reopening code fences across chunks. */
export function splitMessage(text: string, max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  let current = '';
  let inFence = false;

  const push = () => {
    if (!current.trim() || current === '```') return;
    chunks.push(inFence ? `${current}\n\`\`\`` : current);
    current = inFence ? '```' : '';
  };

  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    while (line.length > max) {
      // A single line longer than a chunk: hard-split it.
      if (current) push();
      current = (current ? `${current}\n` : '') + line.slice(0, max);
      line = line.slice(max);
      push();
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max - 4) {
      push();
      current = current ? `${current}\n${line}` : line;
    } else {
      current = candidate;
    }
    if (FENCE.test(line)) inFence = !inFence;
  }
  if (current.trim() && current !== '```') chunks.push(current);
  return chunks.length ? chunks : [''];
}

/** A GFM table's separator row, e.g. `| --- | :---: |`. */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;

/** Slack's limit for markdown blocks is 12,000 characters per message; leave room for the rest. */
export const MARKDOWN_MAX = 10_000;

/** Whether the markdown holds a table (mrkdwn can't draw one; a markdown block can). */
export function hasTable(markdown: string): boolean {
  return TABLE_RULE.test(markdown);
}

/** A text block for Claude's markdown: a markdown block when it holds a table, else a mrkdwn section. */
export function textBlock(markdown: string, max: number): SlackBlock {
  return hasTable(markdown)
    ? { type: 'markdown', text: defuseBroadcasts(markdown).slice(0, MARKDOWN_MAX) }
    : { type: 'section', text: { type: 'mrkdwn', text: toSlackMrkdwn(markdown).slice(0, max) } };
}

/** Slack's limit for a section's text. */
const SECTION_TEXT_MAX = 3_000;

/**
 * Sends a message's blocks; if Slack refuses one holding a markdown block, sends it once more with
 * each markdown block as a mrkdwn section (a table then shows as plain text, but the message goes out).
 */
export async function sendWithFallback<T>(
  blocks: SlackBlock[] | undefined,
  send: (blocks: SlackBlock[] | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await send(blocks);
  } catch (err) {
    if (!blocks?.some((b) => b.type === 'markdown')) throw err;
    return send(
      blocks.map((b) =>
        b.type === 'markdown'
          ? {
              type: 'section',
              text: { type: 'mrkdwn', text: toSlackMrkdwn(String(b.text)).slice(0, SECTION_TEXT_MAX) },
            }
          : b,
      ),
    );
  }
}

/**
 * Posts Claude's markdown into a thread, split to Slack's size. Mrkdwn can't draw tables, so a chunk
 * holding one goes as a markdown block (Slack renders the table) and, if Slack refuses it, as mrkdwn.
 */
export async function postMarkdown(
  chat: ChatPort,
  channel: string,
  threadTs: string | undefined,
  markdown: string,
): Promise<void> {
  for (const chunk of splitMessage(markdown)) {
    const text = toSlackMrkdwn(chunk);
    if (!text.trim()) continue;
    if (hasTable(chunk)) {
      const block = { type: 'markdown', text: defuseBroadcasts(chunk) };
      const posted = await chat.postBlocks(channel, threadTs, text, [block]).then(
        () => true,
        () => false,
      );
      if (posted) continue;
    }
    await chat.post(channel, threadTs, text);
  }
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
