import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { describeTool } from '../runner/stream.js';

/** One readable step of a Claude Code session. */
export type TranscriptEntry =
  | { kind: 'user'; time?: string; text: string }
  | { kind: 'assistant'; time?: string; text: string }
  | {
      kind: 'tool';
      time?: string;
      id: string;
      name: string;
      summary: string;
      input: string;
      result?: string;
      isError?: boolean;
    };

const MAX_TOOL_TEXT = 6_000;

/** Where Claude Code keeps a session's transcript: `<config>/projects/<cwd, non-alphanumerics → '-'>/<id>.jsonl`. */
export function transcriptPath(cwd: string, sessionId: string, configDir?: string): string {
  const dir = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
  return path.join(dir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function cap(text: string): string {
  return text.length > MAX_TOOL_TEXT
    ? `${text.slice(0, MAX_TOOL_TEXT)}\n… (${text.length - MAX_TOOL_TEXT} more characters)`
    : text;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        isObject(c) && typeof c.text === 'string' ? c.text : isObject(c) ? `[${String(c.type)}]` : '',
      )
      .join('\n');
  }
  return '';
}

/**
 * The conversation in a Claude Code transcript (JSONL): prompts, replies, and each tool call with
 * its result. Internal records (request shapes, attachments, thinking, sub-agent sidechains, meta
 * messages) are left out, and unreadable lines are skipped.
 */
export function parseTranscript(jsonl: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, Extract<TranscriptEntry, { kind: 'tool' }>>();
  for (const line of jsonl.split('\n')) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(e) || e.isSidechain || e.isMeta || !isObject(e.message)) continue;
    const time = typeof e.timestamp === 'string' ? e.timestamp : undefined;
    const content = e.message.content;
    if (e.type === 'user') {
      if (typeof content === 'string') {
        entries.push({ kind: 'user', time, text: content });
        continue;
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (!isObject(c)) continue;
        if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
          const tool = tools.get(c.tool_use_id);
          if (tool) {
            tool.result = cap(resultText(c.content));
            tool.isError = c.is_error === true;
          }
        } else if (c.type === 'text' && typeof c.text === 'string') {
          entries.push({ kind: 'user', time, text: c.text });
        }
      }
    } else if (e.type === 'assistant') {
      for (const c of Array.isArray(content) ? content : []) {
        if (!isObject(c)) continue;
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          entries.push({ kind: 'assistant', time, text: c.text });
        } else if (c.type === 'tool_use') {
          const name = typeof c.name === 'string' ? c.name : 'tool';
          const tool = {
            kind: 'tool' as const,
            time,
            id: typeof c.id === 'string' ? c.id : '',
            name,
            summary: describeTool(name, c.input),
            input: cap(JSON.stringify(c.input ?? {}, null, 2)),
          };
          tools.set(tool.id, tool);
          entries.push(tool);
        }
      }
    }
  }
  return entries;
}

/**
 * The transcript of a session, or undefined when this host has no file for it. Claude Code writes
 * transcripts readable by their owner only, so with `claude.runAs` a file tara-agent can't open is
 * read as that user (the sudoers rule that starts runs allows it).
 */
/** Bytes read from the start of a transcript to find its first prompt. */
const HEAD_BYTES = 64 * 1024;

/**
 * A session's first prompt, from the first 64 KB of its transcript, for lists. Claude writes
 * transcripts readable by the run user only, so it is read as `readAs` (sudo head) when tara-agent
 * can't open the file itself.
 */
export function firstPromptOf(
  cwd: string,
  sessionId: string,
  configDir?: string,
  readAs?: string,
): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined;
  const file = transcriptPath(cwd, sessionId, configDir);
  let head: string;
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EACCES' || !readAs) return undefined;
    try {
      head = execFileSync(
        'sudo',
        ['-n', '-u', readAs, '/usr/bin/head', '-c', String(HEAD_BYTES), '--', file],
        {
          encoding: 'utf8',
        },
      );
    } catch {
      return undefined;
    }
  }
  return firstPrompt(parseTranscript(head.slice(0, head.lastIndexOf('\n'))));
}

export function readTranscript(
  cwd: string,
  sessionId: string,
  configDir?: string,
  readAs?: string,
): TranscriptEntry[] | undefined {
  const file = transcriptPath(cwd, sessionId, configDir);
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined;
  // The run user's folder may be closed to tara-agent (it can't even see the file): read it as them.
  const asRunUser = () => {
    if (!readAs) return undefined;
    try {
      return execFileSync('sudo', ['-n', '-u', readAs, '/bin/cat', '--', file], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (/No such file/i.test(String((err as { stderr?: unknown }).stderr ?? ''))) return undefined;
      throw err;
    }
  };
  let jsonl: string | undefined;
  if (!existsSync(file)) jsonl = asRunUser();
  else
    try {
      jsonl = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EACCES' || !readAs) throw err;
      jsonl = asRunUser();
    }
  return jsonl === undefined ? undefined : parseTranscript(jsonl);
}

/** Context tara-agent puts before a fresh session's message (memory.ts, manager.ts `threadCards`). */
const CONTEXT_HEADINGS = /^## (Project memory|Cards in this thread)\b/;
const TITLE_MAX = 80;

/**
 * What a session is called: the first line of the message its first prompt carries, without what
 * tara-agent puts around it. A chat's message follows the asker's mention (`<@U1>: …`), after the
 * project memory and the thread's cards; any other prompt is used from its first line, unless it opens
 * with that context (the message can't be told apart then: undefined, and the caller names it).
 */
export function promptTitle(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const mention = /^<@[^>\s]+>:[ \t]*/m.exec(prompt);
  const message = mention ? prompt.slice(mention.index + mention[0].length) : prompt;
  if (!mention && CONTEXT_HEADINGS.test(message.trimStart())) return undefined;
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** The first thing someone asked in a session, without the leading Slack mention. */
export function firstPrompt(entries: TranscriptEntry[]): string | undefined {
  const first = entries.find((e) => e.kind === 'user');
  return first?.text.replace(/^<@[A-Z0-9]+>:\s*/, '');
}
