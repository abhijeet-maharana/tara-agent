import { z } from 'zod';

/** Claude Code permission modes (`default` is the older name of `manual`). */
export const permissionModes = [
  'default',
  'manual',
  'auto',
  'dontAsk',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const;

/** `~/.config/tara-agent/config.yaml`: host-level settings. Never committed; secrets come from env. */
export const hostConfigSchema = z.object({
  /**
   * What the agent calls itself: told to Claude in every run and shown on the dashboard. The name
   * people see on its Slack messages is the Slack app's bot name, set in the app's settings.
   */
  agentName: z.string().min(1).default('tara'),
  /** Project repo paths. Each repo describes itself in `.tara/config.json`. */
  projects: z.array(z.string().min(1)).min(1),
  /** Max Claude sessions running at once on this host. */
  concurrency: z.number().int().min(1).max(16).default(2),
  claude: z
    .object({
      bin: z.string().default('claude'),
      /** Per-turn wall-clock limit for chat turns. */
      chatTimeoutMinutes: z.number().positive().default(20),
      /** Effort for every run (`--effort`); unset uses each model's default. */
      effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    })
    .default({ bin: 'claude', chatTimeoutMinutes: 20 }),
  /** Where the SQLite state lives. Defaults to `~/.local/state/tara-agent`. */
  stateDir: z.string().optional(),
  /** Days after its last use that a session's scratch folder (`TARA_SCRATCH`) is deleted. */
  scratchDays: z.number().min(1).default(3),
  /**
   * Stream replies into Slack threads as Claude writes them, with a live task card (needs the Slack
   * app's "Agents & AI Apps" feature; falls back to an edited status message without it).
   */
  streaming: z.boolean().default(true),
  /** Minimum gap between edits of the live status message. */
  statusIntervalSeconds: z.number().min(1).default(5),
  /** Max scheduled jobs running at once (separate from chat). */
  jobConcurrency: z.number().int().min(1).max(8).default(1),
  /** After downtime, run a job's most recent missed slot if it is at most this old. 0 disables catch-up. */
  catchUpHours: z.number().min(0).default(6),
  /** Default timezone for job schedules and for times shown in Slack. Defaults to the host's. */
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  /** Daily code-only health summary per project channel (runs, failures, missed slots, usage). */
  healthDigest: z
    .object({
      enabled: z.boolean().default(true),
      /** Cron expression in the host `timezone`. */
      cron: z.string().default('0 9 * * *'),
    })
    .default({ enabled: true, cron: '0 9 * * *' }),
  /** Local control API (jobs, runs, health). Set TARA_HTTP_TOKEN to require a bearer token. */
  http: z
    .object({
      enabled: z.boolean().default(true),
      bind: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(4100),
      /**
       * CIDR ranges allowed to connect. Transcripts hold everything Claude saw, so when binding beyond
       * localhost keep this to trusted networks, e.g. ["127.0.0.0/8", "::1/128", "100.64.0.0/10"] (Tailscale).
       */
      allowFrom: z.array(z.string()).default(['127.0.0.0/8', '::1/128']),
      /** Pass requests for paths tara-agent doesn't serve to this URL (e.g. the port's previous owner). */
      fallback: z.string().url().optional(),
    })
    .default({ enabled: true, bind: '127.0.0.1', port: 4100, allowFrom: ['127.0.0.0/8', '::1/128'] }),
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
  /**
   * Slack user who owns this project: jobs started from the local API or a dashboard stream their
   * thread live to this person (jobs started with `!run` stream to whoever typed it).
   */
  owner: z
    .string()
    .regex(/^[UW][A-Z0-9]+$/, 'a Slack user ID such as U0123456789')
    .optional(),
  /** Slack user IDs allowed to talk to the bot. Empty = every member of the channel. */
  allowedUsers: z.array(z.string()).default([]),
  /** `api` runs the CLI with ANTHROPIC_API_KEY instead of the host's Claude login. */
  billing: z.enum(['subscription', 'api']).default('subscription'),
  /** The project's own web dashboard, if it has one; the tara-agent dashboard links to it. */
  dashboardUrl: z.string().url().optional(),
  /**
   * After a job run that had trouble (failed, errored, timed out, or several tool errors), resume
   * its session once and let Claude fix the skill or instruction file it followed, so the same
   * problem doesn't happen twice. Clean runs cost nothing extra.
   */
  selfImprove: z.boolean().default(true),
  /**
   * Parent folder of the per-session scratch folders (`TARA_SCRATCH`), relative to the repo. Keep it
   * out of git. Defaults to `<stateDir>/scratch/<name>`.
   */
  scratchDir: z.string().optional(),
  /** Parent folder of the per-job data folders (`TARA_JOB_DATA`), relative to the repo. Defaults to `<stateDir>/job-data/<name>`. */
  jobDataDir: z.string().optional(),
});

const jobIdPattern = /^[a-z0-9][a-z0-9-]*$/;

/** One scheduled job in `<repo>/.tara/jobs.json`. */
export const jobSchema = z
  .object({
    id: z.string().regex(jobIdPattern, 'lowercase letters, digits and dashes'),
    name: z.string().min(1),
    /** Cron expression (5 or 6 fields). */
    cron: z.string().min(1),
    /** IANA timezone for `cron`. Defaults to the file's `tz`, then the host timezone. */
    tz: z.string().optional(),
    /** Typical run time, for schedule planning tools (overlap checks, calendars). tara doesn't use it. */
    durationMinutes: z.number().positive().optional(),
    /** What to do. Optional only for script-only jobs (`agent: false`). */
    prompt: z.string().optional(),
    /** Skills the job should follow; named in the prompt so Claude reads them first. */
    skills: z.array(z.string()).default([]),
    /**
     * Runs before the model, in the repo root (`.py` with python3, `.sh` with bash, else executed).
     * Empty stdout or a last line of `{"wakeAgent": false}` = silent run. Otherwise its output (or its
     * error) is put in front of the prompt.
     */
    preScript: z.string().optional(),
    /** false = the script is the job: its stdout is posted as-is and no model runs. */
    agent: z.boolean().default(true),
    model: z.string().min(1).default('sonnet'),
    /** Named locks held for the whole run, e.g. ["chrome"] for jobs that drive the shared browser. */
    locks: z.array(z.string()).default([]),
    timeoutMinutes: z.number().positive().default(30),
    /** Run the most recent missed slot after downtime (see host `catchUpHours`). */
    catchUp: z.boolean().default(true),
    /** Slack channel for this job's threads. Defaults to the project channel. */
    channel: z.string().optional(),
    /** Extra environment for the script and the CLI. `~/` is expanded. */
    env: z.record(z.string(), z.string()).default({}),
    allowedTools: z.array(z.string()).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((j) => j.prompt || !j.agent, { message: 'prompt is required unless agent is false' })
  .refine((j) => j.preScript || j.agent, { message: 'a job with agent: false needs a preScript' });

/** `<repo>/.tara/jobs.json`. */
export const jobsFileSchema = z.object({
  /** IANA timezone for every job's `cron` that doesn't set its own `tz`. Defaults to the host timezone. */
  tz: z.string().optional(),
  /** Environment shared by every job in this repo. `~/` is expanded. */
  env: z.record(z.string(), z.string()).default({}),
  jobs: z.array(jobSchema).superRefine((jobs, ctx) => {
    const seen = new Set<string>();
    for (const [i, j] of jobs.entries()) {
      if (seen.has(j.id))
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate job id "${j.id}"` });
      seen.add(j.id);
    }
  }),
});

export type HostConfig = z.infer<typeof hostConfigSchema>;
export type JobConfig = z.infer<typeof jobSchema>;
export type JobsFile = z.infer<typeof jobsFileSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type PermissionMode = (typeof permissionModes)[number];

export interface Project {
  dir: string;
  config: ProjectConfig;
  /** Contents of `systemPromptFile`, if set. */
  systemPrompt?: string;
}

/** A job with its project and fully merged environment. */
export interface ScheduledJob {
  project: Project;
  job: JobConfig;
  env: Record<string, string>;
}
