import type { PermissionMode } from '../config/schema.js';

export interface ClaudeArgsInput {
  sessionId: string;
  /** true = continue an existing session (`--resume`), false = start it (`--session-id`). */
  resume: boolean;
  permissionMode: PermissionMode;
  model?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
}

/** Arguments for one headless turn. The prompt itself goes to stdin. */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-mode', input.permissionMode);
  if (input.model) args.push('--model', input.model);
  args.push(input.resume ? '--resume' : '--session-id', input.sessionId);
  if (input.appendSystemPrompt) args.push('--append-system-prompt', input.appendSystemPrompt);
  // Variadic, so it goes last.
  if (input.allowedTools?.length) args.push('--allowedTools', ...input.allowedTools);
  return args;
}
