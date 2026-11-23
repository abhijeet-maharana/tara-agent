import { esc, inline } from './dashboard.js';

/**
 * A Markdown file as a document, for the Code page: YAML frontmatter as a small table, real headings
 * (with ids for `#links`), paragraphs, nested and numbered lists, quotes, tables, rules and code
 * blocks. Everything is escaped: raw HTML in a file shows as text, never as markup. `resolve` turns a
 * relative link into a Code page URL (or undefined: its label only). Chat replies and cards keep the
 * lighter `md` (dashboard.ts).
 */
export function markdownDoc(text: string, resolve?: (href: string) => string | undefined): string {
  const { meta, body } = frontmatter(text.replace(/\r\n?/g, '\n'));
  const out: string[] = [];
  if (meta.length)
    out.push(
      `<table class="md doc-meta"><tbody>${meta
        .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${inline(v, resolve)}</td></tr>`)
        .join('')}</tbody></table>`,
    );
  const lines = body.split('\n');
  const used = new Map<string, number>();
  const slug = (title: string) => {
    const base =
      title
        .toLowerCase()
        .replace(/[`*_[\]()]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '') || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, resolve)).join(' ')}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flushPara();
      const end = lines.findIndex((l, j) => j > i && l.trim().startsWith(fence[1] as string));
      const stop = end === -1 ? lines.length : end;
      out.push(`<pre class="doc-code">${esc(lines.slice(i + 1, stop).join('\n'))}</pre>`);
      i = stop;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushPara();
      // The page's own title is the h1: a file's `#` is an h2.
      const level = Math.min(6, (heading[1] as string).length + 1);
      const title = heading[2] as string;
      out.push(`<h${level} id="${esc(slug(title))}">${inline(title, resolve)}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push('<hr class="md">');
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flushPara();
      const rows: string[] = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|/.test(lines[j] as string)) rows.push(lines[j++] as string);
      out.push(table(line, rows, resolve));
      i = j - 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string))
        quoted.push((lines[i++] as string).replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote class="md">${markdownDoc(quoted.join('\n'), resolve)}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flushPara();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        const m = LIST_ITEM.exec(l);
        if (m) {
          const ordered = /\d/.test(m[2] as string);
          items.push({
            indent: indentOf(m[1] as string),
            ordered,
            ...(ordered && { num: Number.parseInt(m[2] as string, 10) }),
            text: m[3] as string,
          });
        } else if (/^\s*(```|~~~)/.test(l)) {
          break; // a code block (even one indented under an item) renders as one; the list goes on after
        } else if (l.trim() && /^\s+/.test(l) && items.length) {
          // A wrapped line of the item above.
          (items.at(-1) as ListItem).text += ` ${l.trim()}`;
        } else if (!l.trim()) {
          // A blank line between items (a "loose" list) doesn't end it; one before anything else does.
          let j = i + 1;
          while (j < lines.length && !(lines[j] as string).trim()) j++;
          const after = lines[j] ?? '';
          if (!LIST_ITEM.test(after) && !(/^\s+\S/.test(after) && !/^\s*(```|~~~)/.test(after))) break;
          i = j;
          continue;
        } else break;
        i++;
      }
      i--;
      out.push(list(items, 0, resolve).html);
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return `<div class="doc">${out.join('')}</div>`;
}

/** A GFM table's rule row, e.g. `| --- | :--: |`. */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

interface ListItem {
  indent: number;
  ordered: boolean;
  /** An ordered item's own number: a list that starts at 3 (after a code block, say) says so. */
  num?: number;
  text: string;
}

const indentOf = (s: string) => s.replace(/\t/g, '    ').length;

/** Items from `start` at one depth (deeper ones nest inside the item above), and where it stopped. */
function list(
  items: ListItem[],
  start: number,
  resolve?: (href: string) => string | undefined,
): { html: string; next: number } {
  const first = items[start] as ListItem;
  const tag = first.ordered ? 'ol' : 'ul';
  const lis: string[] = [];
  let i = start;
  while (i < items.length) {
    const item = items[i] as ListItem;
    if (item.indent < first.indent) break;
    if (item.indent > first.indent) {
      // Deeper: a sub-list of the previous item.
      const sub = list(items, i, resolve);
      if (lis.length) lis[lis.length - 1] = (lis.at(-1) as string).replace(/<\/li>$/, `${sub.html}</li>`);
      else lis.push(`<li>${sub.html}</li>`);
      i = sub.next;
      continue;
    }
    if (item.ordered !== first.ordered) break;
    const task = /^\[([ xX])\]\s+/.exec(item.text);
    const text = task ? item.text.slice(task[0].length) : item.text;
    lis.push(`<li>${task ? (task[1] === ' ' ? '☐ ' : '☑ ') : ''}${inline(text, resolve)}</li>`);
    i++;
  }
  // Two lists of different kinds side by side at one depth: the rest follows as its own list.
  const rest =
    i < items.length && (items[i] as ListItem).indent === first.indent ? list(items, i, resolve) : undefined;
  const from = first.ordered && first.num !== undefined && first.num !== 1 ? ` start="${first.num}"` : '';
  return {
    html: `<${tag} class="md"${from}>${lis.join('')}</${tag}>${rest?.html ?? ''}`,
    next: rest?.next ?? i,
  };
}

function table(head: string, rows: string[], resolve?: (href: string) => string | undefined): string {
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => inline(c.trim(), resolve));
  return `<div class="tbl-wrap"><table class="md"><thead><tr>${cells(head)
    .map((h) => `<th>${h}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr>${cells(r)
          .map((c) => `<td>${c}</td>`)
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

/**
 * A leading `---` block of `key: value` lines (a skill's name and description), and the rest. Values
 * that run over several indented lines (`description: >`) are joined; quotes around a value go.
 */
export function frontmatter(text: string): { meta: Array<[string, string]>; body: string } {
  const m = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(text);
  if (!m) return { meta: [], body: text };
  const meta: Array<[string, string]> = [];
  for (const line of (m[1] as string).split('\n')) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (kv) meta.push([kv[1] as string, (kv[2] as string).replace(/^[>|][-+]?$/, '')]);
    else if (line.trim() && meta.length) {
      const last = meta.at(-1) as [string, string];
      last[1] = `${last[1]} ${line.trim()}`.trim();
    }
  }
  for (const entry of meta) entry[1] = entry[1].replace(/^(["'])(.*)\1$/, '$2');
  return { meta, body: text.slice(m[0].length) };
}
