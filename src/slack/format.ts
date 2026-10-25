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

/** Converts Claude's GitHub-flavoured markdown to Slack mrkdwn. Code blocks pass through untouched. */
export function toSlackMrkdwn(markdown: string): string {
  let inFence = false;
  return markdown
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

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
