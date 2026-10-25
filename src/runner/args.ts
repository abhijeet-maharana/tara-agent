import type { PermissionMode } from '../config/schema.js';

/** tara's own MCP tools; allowed without asking whatever the permission mode. */
export const TARA_TOOLS = [
  'mcp__tara__request_approval',
  'mcp__tara__send_file',
  'mcp__tara__list_jobs',
  'mcp__tara__run_job',
];
export const TARA_PERMISSION_TOOL = 'mcp__tara__permission';

export interface ClaudeArgsInput {
  sessionId: string;
  /** true = continue an existing session (`--resume`), false = start it (`--session-id`). */
  resume: boolean;
  permissionMode: PermissionMode;
  model?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  /** MCP config file with tara's server (added to the repo's own `.mcp.json` servers). */
  mcpConfig?: string;
  /** Route permission prompts to tara's Slack buttons. */
  permissionPrompts?: boolean;
  /** Emit text as it is written (`stream_event` deltas), for live streaming into Slack. */
  partialMessages?: boolean;
}

/** Arguments for one headless turn. The prompt itself goes to stdin. */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (input.partialMessages) args.push('--include-partial-messages');
  args.push('--permission-mode', input.permissionMode);
  if (input.model) args.push('--model', input.model);
  args.push(input.resume ? '--resume' : '--session-id', input.sessionId);
  if (input.appendSystemPrompt) args.push('--append-system-prompt', input.appendSystemPrompt);
  if (input.mcpConfig) {
    args.push('--mcp-config', input.mcpConfig);
    if (input.permissionPrompts) args.push('--permission-prompt-tool', TARA_PERMISSION_TOOL);
  }
  const allowed = [...(input.allowedTools ?? []), ...(input.mcpConfig ? TARA_TOOLS : [])];
  // Variadic, so it goes last.
  if (allowed.length) args.push('--allowedTools', ...allowed);
  return args;
}
