/**
 * Keeps each run on its own tabs in a shared Chrome (Claude Code PreToolUse/PostToolUse hook on the
 * project's browser MCP server, added by runner/run.ts). Jobs and chats use the same Chrome at once and
 * hold no lock, and a fresh Chrome MCP server starts on whatever tab is selected, which may be another
 * run's. So a run must open its own tab (`new_page`) before any other page tool, and may select or close
 * only tabs it opened. A later turn of the same session (a new CLI process, so new page numbers) gets
 * its tabs back by address: `list_pages`, then `select_page` on one at an address it had.
 *
 * State: one file per session in the temp folder; `TARA_RUN_NONCE` (one per CLI process) tells this
 * process's page numbers from an earlier one's.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Tools that act on the selected page (chrome-devtools-mcp). Others (new_page, list_pages) are free. */
const PAGE_TOOLS = new Set([
  'navigate_page',
  'click',
  'drag',
  'fill',
  'fill_form',
  'hover',
  'press_key',
  'type_text',
  'upload_file',
  'handle_dialog',
  'wait_for',
  'take_snapshot',
  'take_screenshot',
  'evaluate_script',
  'emulate',
  'resize_page',
  'list_console_messages',
  'get_console_message',
  'list_network_requests',
  'get_network_request',
  'get_css_styles',
  'set_logpoints',
  'take_heapsnapshot',
  'lighthouse_audit',
  'performance_start_trace',
  'performance_stop_trace',
  'performance_analyze_insight',
  'screencast_start',
  'screencast_stop',
]);
const PICK_TOOLS = new Set(['select_page', 'close_page']);

export interface OwnTabsState {
  /** The CLI process the page numbers below belong to. */
  nonce: string;
  /** Page numbers this process opened (or picked up again by address). */
  own: number[];
  /** Page number → address, from this process's last page list. */
  urls: Record<string, string>;
  /** Addresses of the session's own tabs, kept across processes. */
  ownUrls: string[];
}

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

export const emptyState = (nonce: string): OwnTabsState => ({ nonce, own: [], urls: {}, ownUrls: [] });

/** The tool's own name (`mcp__chrome__click` → `click`). */
const toolOf = (name = '') => name.slice(name.lastIndexOf('__') + 2);

const pageOf = (input: Record<string, unknown> = {}): number | undefined => {
  const n = input.pageId ?? input.pageIdx;
  return typeof n === 'number' ? n : typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : undefined;
};

const urlKey = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
};

/** Every string inside a tool response (MCP content blocks, or plain text). */
function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === 'object') return Object.values(value).flatMap(texts);
  return [];
}

/** The page list in a response: "2: Title (https://…) [selected]". */
export function pagesIn(response: unknown): { id: number; url: string; selected: boolean }[] {
  const pages: { id: number; url: string; selected: boolean }[] = [];
  for (const text of texts(response))
    for (const line of text.split('\n')) {
      const m = /^(\d+): .*\(([^()\s]+)\)( \[selected\])?\s*$/.exec(line.trim());
      if (m) pages.push({ id: Number(m[1]), url: m[2] as string, selected: Boolean(m[3]) });
    }
  return pages;
}

/** PreToolUse: why this call is refused, or undefined to let it run. */
export function refusal(state: OwnTabsState, input: HookInput): string | undefined {
  const tool = toolOf(input.tool_name);
  if (PICK_TOOLS.has(tool)) {
    const id = pageOf(input.tool_input);
    if (id === undefined || state.own.includes(id)) return undefined;
    const url = state.urls[String(id)];
    if (url && state.ownUrls.includes(urlKey(url))) return undefined;
    return `Page ${id} is not a tab this session opened: other jobs and chats share this Chrome. Open your own with new_page${tool === 'close_page' ? ', and close only your own tabs' : ''}.`;
  }
  if (PAGE_TOOLS.has(tool) && state.own.length === 0)
    return 'Open your own tab with new_page first: other jobs and chats share this Chrome, and the selected tab may be theirs. Never use, navigate or close a tab you did not open.';
  return undefined;
}

/** PostToolUse: what the call changed (tabs opened, closed, or seen at an address). */
export function record(state: OwnTabsState, input: HookInput): OwnTabsState {
  const tool = toolOf(input.tool_name);
  const next: OwnTabsState = {
    ...state,
    own: [...state.own],
    urls: { ...state.urls },
    ownUrls: [...state.ownUrls],
  };
  const pages = pagesIn(input.tool_response);
  if (pages.length) next.urls = Object.fromEntries(pages.map((p) => [String(p.id), p.url]));
  const selected = pages.find((p) => p.selected);
  if (tool === 'new_page' && selected && !next.own.includes(selected.id)) next.own.push(selected.id);
  if (tool === 'select_page') {
    const id = pageOf(input.tool_input);
    if (id !== undefined && !next.own.includes(id)) next.own.push(id); // refusal() let it through: it is ours
  }
  if (tool === 'close_page') {
    const id = pageOf(input.tool_input);
    next.own = next.own.filter((n) => n !== id);
  }
  // Where the session's own tabs are now, for a later turn.
  for (const p of pages)
    if (next.own.includes(p.id) && !p.url.startsWith('chrome://')) {
      const key = urlKey(p.url);
      if (!next.ownUrls.includes(key)) next.ownUrls.push(key);
    }
  next.ownUrls = next.ownUrls.slice(-50);
  return next;
}

function main(): void {
  let input: HookInput & { session_id?: string };
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return; // nothing to judge: let the call run
  }
  const nonce = process.env.TARA_RUN_NONCE ?? 'none';
  const dir = path.join(tmpdir(), 'tara-own-tabs');
  const file = path.join(dir, `${(input.session_id ?? 'unknown').replace(/[^\w-]/g, '')}.json`);
  let state = emptyState(nonce);
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as OwnTabsState;
    // Another process's page numbers mean nothing here; the addresses carry over.
    state = saved.nonce === nonce ? saved : { ...emptyState(nonce), ownUrls: saved.ownUrls ?? [] };
  } catch {}
  if (input.hook_event_name === 'PreToolUse') {
    const reason = refusal(state, input);
    if (reason)
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }),
      );
    return;
  }
  if (input.hook_event_name === 'PostToolUse') {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(record(state, input)), { mode: 0o600 });
    } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
