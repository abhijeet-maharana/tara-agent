import path from 'node:path';

/** Token counts from the CLI `result` event. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface RateLimit {
  status: string;
  window?: string;
  /** 0–1 share of the current window already used, when the CLI reports it. */
  utilization?: number;
  resetsAt?: number;
}

export type StreamEvent =
  | { kind: 'init'; sessionId: string; model: string }
  /** `parent` is set for calls made inside a sub-agent (Task/Agent tool). */
  | { kind: 'tool'; id: string; name: string; status: string; parent?: string }
  | { kind: 'tool_result'; id: string; isError: boolean; parent?: string }
  /** A piece of Claude's text as it is written (needs `--include-partial-messages`). */
  | { kind: 'text'; text: string; parent?: string }
  /** A new text block starts (e.g. after tool calls). */
  | { kind: 'text_start'; parent?: string }
  | { kind: 'rate_limit'; rateLimit: RateLimit }
  | {
      kind: 'result';
      isError: boolean;
      subtype: string;
      text: string;
      sessionId: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      usage?: TokenUsage;
      permissionDenials: string[];
    };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function truncate(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One short line describing a tool call, for the live status message. */
export function describeTool(name: string, input: unknown): string {
  const i = isObject(input) ? input : {};
  const file = str(i.file_path) ?? str(i.notebook_path);
  if (name.startsWith('mcp__')) {
    const [, server = '', ...tool] = name.split('__');
    return `${server}: ${tool.join('__')}`;
  }
  switch (name) {
    case 'Bash':
      return `Bash: ${truncate(str(i.description) ?? str(i.command) ?? '')}`;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return file ? `${name}: ${path.basename(file)}` : name;
    case 'Grep':
    case 'Glob':
      return `${name}: ${truncate(str(i.pattern) ?? '')}`;
    case 'WebFetch': {
      const url = str(i.url);
      try {
        return url ? `WebFetch: ${new URL(url).host}` : name;
      } catch {
        return name;
      }
    }
    case 'WebSearch':
      return `WebSearch: ${truncate(str(i.query) ?? '')}`;
    case 'Skill':
      return `Skill: ${str(i.skill) ?? ''}`;
    case 'Task':
    case 'Agent':
      return `Agent: ${truncate(str(i.description) ?? '')}`;
    default:
      return name;
  }
}

function parseUsage(u: unknown): TokenUsage | undefined {
  if (!isObject(u)) return undefined;
  return {
    input: num(u.input_tokens) ?? 0,
    output: num(u.output_tokens) ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheCreation: num(u.cache_creation_input_tokens) ?? 0,
  };
}

function parseRateLimit(info: unknown): RateLimit | undefined {
  if (!isObject(info)) return undefined;
  const window = str(info.rateLimitType);
  const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
  const current = window && isObject(windows[window]) ? (windows[window] as Json) : {};
  return {
    status: str(info.status) ?? 'unknown',
    window,
    utilization: num(current.utilization),
    resetsAt: num(info.resetsAt),
  };
}

/**
 * Turns `claude -p --output-format stream-json` events into StreamEvents.
 * One CLI event can hold several tool calls, so this returns a list.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(e)) return [];
  const parent = str(e.parent_tool_use_id) ?? undefined;

  switch (e.type) {
    case 'system':
      return e.subtype === 'init'
        ? [{ kind: 'init', sessionId: str(e.session_id) ?? '', model: str(e.model) ?? '' }]
        : [];
    case 'assistant': {
      const content = isObject(e.message) && Array.isArray(e.message.content) ? e.message.content : [];
      return content
        .filter((c): c is Json => isObject(c) && c.type === 'tool_use')
        .map((c) => {
          const name = str(c.name) ?? 'tool';
          return { kind: 'tool', id: str(c.id) ?? '', name, status: describeTool(name, c.input), parent };
        });
    }
    case 'user': {
      const content = isObject(e.message) && Array.isArray(e.message.content) ? e.message.content : [];
      return content
        .filter((c): c is Json => isObject(c) && c.type === 'tool_result')
        .map((c) => ({
          kind: 'tool_result',
          id: str(c.tool_use_id) ?? '',
          isError: c.is_error === true,
          parent,
        }));
    }
    case 'stream_event': {
      const ev = isObject(e.event) ? e.event : {};
      if (
        ev.type === 'content_block_start' &&
        isObject(ev.content_block) &&
        ev.content_block.type === 'text'
      ) {
        return [{ kind: 'text_start', parent }];
      }
      if (ev.type === 'content_block_delta' && isObject(ev.delta) && ev.delta.type === 'text_delta') {
        const text = str(ev.delta.text);
        return text ? [{ kind: 'text', text, parent }] : [];
      }
      return [];
    }
    case 'rate_limit_event': {
      const rateLimit = parseRateLimit(e.rate_limit_info);
      return rateLimit ? [{ kind: 'rate_limit', rateLimit }] : [];
    }
    case 'result': {
      const denials = Array.isArray(e.permission_denials) ? e.permission_denials : [];
      return [
        {
          kind: 'result',
          isError: e.is_error === true,
          subtype: str(e.subtype) ?? '',
          text: str(e.result) ?? '',
          sessionId: str(e.session_id) ?? '',
          costUsd: num(e.total_cost_usd),
          durationMs: num(e.duration_ms),
          numTurns: num(e.num_turns),
          usage: parseUsage(e.usage),
          permissionDenials: [
            ...new Set(denials.map((d) => (isObject(d) ? str(d.tool_name) : undefined)).filter(Boolean)),
          ] as string[],
        },
      ];
    }
    default:
      return [];
  }
}
