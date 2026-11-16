import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Lines the Home page shows one of at random: a project's `.tara/quotes.txt`, one per line. Blank
 * lines and `#` comments are skipped, and a leading Markdown bullet or checkbox (`- `, `* `,
 * `- [ ] `) is dropped, so a pasted checklist works as it is. Read on every visit, so edits show
 * without a restart.
 */
export const QUOTES_FILE = '.tara/quotes.txt';

/** The lines of one quotes file's text. */
export function parseQuotes(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
        .trim(),
    )
    .filter((line) => line && !line.startsWith('#'));
}

/** Every project's quotes, in project order; a project without the file adds none. */
export function loadQuotes(dirs: string[]): string[] {
  return dirs.flatMap((dir) => {
    try {
      return parseQuotes(readFileSync(path.join(dir, QUOTES_FILE), 'utf8'));
    } catch {
      return [];
    }
  });
}

/** One of the quotes at random; undefined when there are none. */
export function pickQuote(quotes: string[], random: () => number = Math.random): string | undefined {
  return quotes.length ? quotes[Math.floor(random() * quotes.length)] : undefined;
}
