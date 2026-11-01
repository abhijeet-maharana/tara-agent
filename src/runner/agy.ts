import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgyPermissions, PermissionMode } from '../config/schema.js';
import type { RunAs } from './as-user.js';
import { emit, type Runner, type RunOptions, type RunStatus, spawnCli } from './run.js';
import type { StreamEvent, TokenUsage } from './stream.js';

/**
 * Google's Antigravity CLI (`agy`) as a second harness. One turn = one `agy -p` process in stream-json
 * mode: the prompt goes to stdin as a `user` event (never on the command line, and no TTY needed), and
 * stdout is NDJSON (`init`, `step_update`, `result`). tara's MCP tools and the system prompt reach agy
 * through a plugin in a per-run folder added with `--add-dir`, since agy has no `--mcp-config` or
 * `--append-system-prompt`. Checked against agy 1.4.12.
 */

/** tara's MCP server inside the per-run plugin `tara`: agy names plugin servers `<plugin>_<server>`. */
export const AGY_TARA_SERVER = 'tara_tara';
const TARA_RULE = `mcp(${AGY_TARA_SERVER}/*)`;

/** Seconds kept back from the run's timeout so agy can stop by itself and still report. */
const PRINT_TIMEOUT_MARGIN_S = 30;
const LIMIT_TEXT = /quota|rate limit|resource.?exhausted|usage limit/i;

export interface AgyArgsInput {
  /** The agy conversation to continue (`--conversation`); unset starts a new one. */
  conversationId?: string;
  model?: string;
  permissionMode: PermissionMode;
  /** The job's own rules; without them the permission mode decides. */
  permissions?: AgyPermissions;
  timeoutMs: number;
}

/**
 * Arguments for one agy turn, plus its session-only settings. `bypassPermissions` without job rules
 * skips agy's checks like Claude's bypass mode; otherwise only tara's tools and the job's rules are
 * allowed (headless agy denies anything it would ask about).
 */
export function buildAgyArgs(input: AgyArgsInput): { args: string[]; settings?: object } {
  const printTimeout = Math.max(60, Math.floor(input.timeoutMs / 1000) - PRINT_TIMEOUT_MARGIN_S);
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  args.push('--print-timeout', `${printTimeout}s`, '--disable-slash-commands');
  if (input.model) args.push('--model', input.model);
  if (input.conversationId) args.push('--conversation', input.conversationId);
  if (!input.permissions && input.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
    return { args };
  }
  const p = input.permissions;
  return {
    args,
    settings: {
      permissions: { allow: [...(p?.allow ?? []), TARA_RULE], deny: p?.deny ?? [], ask: p?.ask ?? [] },
    },
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** One short line describing an agy tool step, for the live status message. */
export function describeAgyTool(name: string, params: unknown): string {
  const p = isObject(params) ? params : {};
  if (name === 'call_mcp_tool') return `${str(p.ServerName) ?? 'mcp'}: ${str(p.ToolName) ?? ''}`;
  const target = str(p.CommandLine) ?? str(p.Path) ?? str(p.AbsolutePath) ?? str(p.TargetFile) ?? str(p.Url);
  if (!target) return name;
  const short = target.includes('/') && !target.includes(' ') ? path.basename(target) : target;
  const line = short.replace(/\s+/g, ' ').trim();
  return `${name}: ${line.length > 80 ? `${line.slice(0, 79)}…` : line}`;
}

export interface AgyResult {
  conversationId?: string;
  status?: string;
  finishedReason?: string;
  text: string;
  error?: string;
  durationMs?: number;
  numTurns?: number;
  usage?: TokenUsage;
  deniedActions: string[];
}

/** agy's token counts in tara's shape; thinking tokens are billed as output. */
function usageOf(u: unknown): TokenUsage | undefined {
  if (!isObject(u)) return undefined;
  return {
    input: num(u.input_tokens) ?? 0,
    output: (num(u.output_tokens) ?? 0) + (num(u.thinking_tokens) ?? 0),
    cacheRead: num(u.cache_read_tokens) ?? 0,
    cacheCreation: 0,
  };
}

/**
 * Turns agy's stream-json lines into tara's stream events. Stateful: a tool step can arrive as
 * ACTIVE then DONE, or only as DONE, and a new agent_response step starts a new text block.
 */
export class AgyParser {
  result?: AgyResult;
  private readonly openTools = new Set<number>();
  private textStep?: number;

  line(line: string): StreamEvent[] {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(obj)) return [];
    if (obj.event === 'init') {
      const init = isObject(obj.init) ? obj.init : {};
      const id = str(obj.conversation_id);
      return id ? [{ kind: 'init', sessionId: id, model: str(init.model) ?? '' }] : [];
    }
    if (obj.event === 'step_update' && isObject(obj.step_update)) return this.step(obj.step_update);
    if (obj.event === 'result' && isObject(obj.result)) {
      const r = obj.result;
      const error = isObject(r.error) ? (str(r.error.message) ?? JSON.stringify(r.error)) : str(r.error);
      const denied = Array.isArray(r.denied_actions) ? r.denied_actions : [];
      this.result = {
        conversationId: str(r.conversation_id),
        status: str(r.status),
        finishedReason: str(r.finished_reason),
        text: str(r.response) ?? '',
        error,
        durationMs:
          num(r.duration_seconds) !== undefined
            ? Math.round((r.duration_seconds as number) * 1000)
            : undefined,
        numTurns: num(r.num_turns),
        usage: usageOf(r.usage),
        deniedActions: denied.map((d) =>
          isObject(d) ? `${str(d.action) ?? ''}: ${str(d.display_name) ?? ''}` : String(d),
        ),
      };
      return [
        {
          kind: 'result',
          isError: this.result.status !== 'SUCCESS',
          subtype: this.result.finishedReason ?? this.result.status ?? '',
          text: this.result.text,
          sessionId: this.result.conversationId ?? '',
          durationMs: this.result.durationMs,
          numTurns: this.result.numTurns,
          usage: this.result.usage,
          permissionDenials: this.result.deniedActions,
        },
      ];
    }
    return [];
  }

  private step(s: Json): StreamEvent[] {
    const index = num(s.step_index);
    if (index === undefined) return [];
    if (s.step_type === 'tool') {
      const id = `agy-${index}`;
      const info = isObject(s.tool_info) ? s.tool_info : {};
      const name = str(s.tool_name) ?? str(info.name) ?? 'tool';
      const out: StreamEvent[] = [];
      if (!this.openTools.has(index)) {
        this.openTools.add(index);
        out.push({ kind: 'tool', id, name, status: describeAgyTool(name, info.parameters) });
      }
      if (s.state === 'DONE' || s.state === 'ERROR')
        out.push({ kind: 'tool_result', id, isError: Boolean(info.error) || s.state === 'ERROR' });
      return out;
    }
    if (s.step_type === 'agent_response') {
      const delta = str(s.text_delta);
      if (!delta) return [];
      const out: StreamEvent[] = [];
      if (this.textStep !== index) {
        if (this.textStep !== undefined) out.push({ kind: 'text_start' });
        this.textStep = index;
      }
      out.push({ kind: 'text', text: delta });
      return out;
    }
    return [];
  }
}

/** Lets the run user read a file or folder tara-agent wrote (group read, like the system prompt file). */
function share(p: string, runAs: RunAs | undefined, mode: number): void {
  if (!runAs) return;
  chownSync(p, process.getuid?.() ?? -1, runAs.gid);
  chmodSync(p, mode);
}

/**
 * The per-run folder agy gets with `--add-dir`: a plugin `tara` with tara's MCP server and the system
 * prompt as its rules, and the settings file. Removed after the run.
 */
function runFolder(options: RunOptions): { root: string; settings?: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'tara-agy-'));
  const plugin = path.join(root, '.agents', 'plugins', 'tara');
  mkdirSync(path.join(plugin, 'rules'), { recursive: true });
  const files: string[] = [];
  const write = (file: string, text: string) => {
    writeFileSync(file, text, { mode: 0o600 });
    files.push(file);
  };
  write(path.join(plugin, 'plugin.json'), JSON.stringify({ name: 'tara' }));
  // The server entry (and per-run token) the bridge wrote for Claude's --mcp-config, plus the job's own.
  const tara = options.agy?.mcpConfig
    ? JSON.parse(readFileSync(options.agy.mcpConfig, 'utf8')).mcpServers
    : {};
  const servers = { ...options.mcpServers, ...tara };
  if (Object.keys(servers).length)
    write(path.join(plugin, 'mcp_config.json'), JSON.stringify({ mcpServers: servers }));
  if (options.systemPrompt) write(path.join(plugin, 'rules', 'AGENTS.md'), options.systemPrompt);
  const settings = options.agy?.settings ? path.join(root, 'settings.json') : undefined;
  if (settings) write(settings, JSON.stringify(options.agy?.settings));
  for (const dir of [
    root,
    path.join(root, '.agents'),
    path.join(root, '.agents', 'plugins'),
    plugin,
    path.join(plugin, 'rules'),
  ])
    share(dir, options.runAs, 0o750);
  for (const file of files) share(file, options.runAs, 0o640);
  return { root, settings, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** Runs one headless agy turn and resolves when the process exits. Never rejects. */
export const runAgy: Runner = async (options) => {
  const started = Date.now();
  const parser = new AgyParser();
  let init: Extract<StreamEvent, { kind: 'init' }> | undefined;
  let toolCalls = 0;

  const folder = runFolder(options);
  const args = [...options.args, '--add-dir', folder.root];
  if (folder.settings) args.push('--settings', folder.settings);
  // In stream-json mode the prompt comes from stdin; -p only switches print mode on.
  args.push('-p', '');
  const stdin = `${JSON.stringify({ event: 'user', message: { content: options.prompt } })}\n`;
  const exit = await spawnCli(options, args, stdin, (line) => {
    for (const event of parser.line(line)) {
      if (event.kind === 'init') init = event;
      else if (event.kind === 'tool') toolCalls++;
      emit(options, event);
    }
  }).finally(folder.dispose);

  const result = parser.result;
  const base = {
    text: result?.text ?? '',
    sessionId: result?.conversationId || init?.sessionId,
    model: init?.model || undefined,
    durationMs: Date.now() - started,
    numTurns: result?.numTurns,
    toolCalls,
    usage: result?.usage,
    permissionDenials: result?.deniedActions ?? [],
  };

  let status: RunStatus;
  let error: string | undefined;
  const failure = result?.error || exit.stderr.trim();
  if (exit.spawnError) {
    status = 'error';
    error =
      (exit.spawnError as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Antigravity CLI not found ("${options.bin}"). Install it and log in as the run user.`
        : exit.spawnError.message;
  } else if (exit.stopReason) {
    status = exit.stopReason;
  } else if (result?.finishedReason === 'print_timeout') {
    status = 'timeout';
  } else if (result?.status === 'SUCCESS' && exit.code === 0 && !result.text.trim()) {
    // agy ends "successfully" with no answer when a tool it needed was denied.
    status = 'error';
    error = `agy gave no answer${result.deniedActions.length ? ` (denied: ${result.deniedActions.join(', ')})` : ''}`;
  } else if (result?.status === 'SUCCESS' && exit.code === 0) {
    status = 'ok';
  } else if (failure && LIMIT_TEXT.test(failure)) {
    status = 'limit';
    error = failure;
  } else {
    status = 'error';
    error = failure || `agy exited with code ${exit.code}${result?.status ? ` (${result.status})` : ''}`;
  }
  return { ...base, status, error };
};
