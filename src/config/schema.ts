import { z } from 'zod';

export const permissionModes = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

/** `~/.config/tara-agent/config.yaml`: host-level settings. Never committed; secrets come from env. */
export const hostConfigSchema = z.object({
  /** Project repo paths. Each repo describes itself in `.tara/config.json`. */
  projects: z.array(z.string().min(1)).min(1),
  /** Max Claude sessions running at once on this host. */
  concurrency: z.number().int().min(1).max(16).default(2),
  claude: z
    .object({
      bin: z.string().default('claude'),
      /** Per-turn wall-clock limit for chat turns. */
      chatTimeoutMinutes: z.number().positive().default(20),
    })
    .default({ bin: 'claude', chatTimeoutMinutes: 20 }),
  /** Where the SQLite state lives. Defaults to `~/.local/state/tara-agent`. */
  stateDir: z.string().optional(),
  /** Minimum gap between edits of the live status message. */
  statusIntervalSeconds: z.number().min(1).default(5),
});

/** `<repo>/.tara/config.json`: committed in the project repo. */
export const projectConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  slackChannel: z.string().regex(/^[CG][A-Z0-9]+$/, 'a Slack channel ID such as C0123456789'),
  permissionMode: z.enum(permissionModes).default('default'),
  chatModel: z.string().min(1).default('sonnet'),
  /** Tools allowed without asking, in Claude Code `--allowedTools` syntax. */
  allowedTools: z.array(z.string()).default([]),
  /** Extra system prompt appended to every session, relative to the repo root. */
  systemPromptFile: z.string().optional(),
  /** Slack user IDs allowed to talk to the bot. Empty = every member of the channel. */
  allowedUsers: z.array(z.string()).default([]),
  /** `api` runs the CLI with ANTHROPIC_API_KEY instead of the host's Claude login. */
  billing: z.enum(['subscription', 'api']).default('subscription'),
});

export type HostConfig = z.infer<typeof hostConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type PermissionMode = (typeof permissionModes)[number];

export interface Project {
  dir: string;
  config: ProjectConfig;
  /** Contents of `systemPromptFile`, if set. */
  systemPrompt?: string;
}
