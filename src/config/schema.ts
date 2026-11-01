import { z } from 'zod';
import { GEMINI_LIVE_URL } from '../live/gemini.js';

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

/** The agent CLI a run goes through: Claude Code, or Google's Antigravity CLI (`agy`). */
export const harnesses = ['claude', 'agy'] as const;
export type Harness = (typeof harnesses)[number];

/**
 * agy permission rules (`action(target)`, e.g. `command(npx tsc)`, `write_file(/tmp)`, `mcp(server/*)`),
 * passed as session-only settings. Headless agy can't ask, so anything not allowed is denied.
 */
export const agyPermissionsSchema = z.object({
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
  ask: z.array(z.string().min(1)).default([]),
});
export type AgyPermissions = z.infer<typeof agyPermissionsSchema>;

/**
 * A job's own stdio MCP server, added to tara's for every session of the job (both harnesses).
 * `${VAR}` in `command`, `args` and `env` is replaced from the run's environment (`TARA_SCRATCH`,
 * `TARA_JOB_DATA`, the job's `env`). Under agy its tools are named `tara_<name>`.
 */
export const mcpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

/**
 * One step of a job: a fresh session of the job's harness and model that runs before the main prompt,
 * with the job's MCP servers but no Slack tools. Its reply goes into the main prompt.
 */
export const jobStepSchema = z
  .object({
    name: z.string().min(1).max(80),
    prompt: z.string().optional(),
    /** Read from the repo and put before `prompt` (shared instructions for several steps). */
    promptFile: z.string().optional(),
    /** Defaults to the job's `timeoutMinutes`. */
    timeoutMinutes: z.number().positive().optional(),
    /** Defaults to the job's `model` (same harness), e.g. a faster model for long browser steps. */
    model: z.string().min(1).optional(),
    /** `agy` jobs: rules for this step instead of the job's `agyPermissions`. */
    agyPermissions: agyPermissionsSchema.optional(),
  })
  .refine((s) => s.prompt || s.promptFile, { message: 'a step needs a prompt or a promptFile' });
export type JobStep = z.infer<typeof jobStepSchema>;

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
  concurrency: z.number().int().min(1).max(16).default(8),
  claude: z
    .object({
      bin: z.string().default('claude'),
      /** Per-turn wall-clock limit for chat turns. */
      chatTimeoutMinutes: z.number().positive().default(20),
      /** Effort for every run (`--effort`); unset uses each model's default. */
      effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
      /**
       * Run Claude and pre-run scripts as this OS user (through sudo), so they can't read tara-agent's
       * database or secrets. See docs/security.md.
       */
      runAs: z.string().optional(),
    })
    .default({ bin: 'claude', chatTimeoutMinutes: 20 }),
  /**
   * Antigravity CLI, for jobs with `harness: "agy"`. Log it in once as the run user (`agy`, then
   * Google sign-in). See docs/configuration.md "agy jobs".
   */
  agy: z
    .object({
      bin: z.string().default('agy'),
    })
    .default({ bin: 'agy' }),
  /**
   * Root actions a run may ask for (`request_privileged`), through the root-owned helper
   * deploy/tara-priv.mjs. Unset = off. See docs/security.md "Privileged actions".
   */
  privileged: z
    .object({
      /** How to start the helper. */
      command: z.array(z.string().min(1)).min(1).default(['sudo', '-n', '/usr/local/sbin/tara-priv']),
    })
    .optional(),
  /** Where the SQLite state lives. Defaults to `~/.local/state/tara-agent`. */
  stateDir: z.string().optional(),
  /** Days after its last use that a session's scratch folder (`TARA_SCRATCH`) is deleted. */
  scratchDays: z.number().min(1).default(3),
  /**
   * Stream replies into Slack threads as Claude writes them, with a live task card (needs the Slack
   * app's "Agents & AI Apps" feature; falls back to an edited status message without it).
   */
  streaming: z.boolean().default(true),
  /**
   * Speech-to-text for Slack voice notes that Slack didn't transcribe: an OpenAI-compatible chat
   * completions URL whose models take audio (e.g. Gemini), tried in order. The key comes from
   * TARA_VOICE_API_KEY. Unset = Slack's own transcript only.
   */
  voice: z
    .object({
      url: z.string().url(),
      models: z.array(z.string().min(1)).min(1),
    })
    .optional(),
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
      /**
       * Also serve HTTPS on this port, e.g. with a Tailscale certificate (`tailscale cert`). Browsers
       * only allow the microphone (Live) over HTTPS. Plain HTTP on `port` stays as it is.
       */
      tls: z
        .object({
          port: z.number().int().min(1).max(65535).default(4443),
          cert: z.string().min(1),
          key: z.string().min(1),
        })
        .optional(),
    })
    .default({ enabled: true, bind: '127.0.0.1', port: 4100, allowFrom: ['127.0.0.0/8', '::1/128'] }),
  /**
   * The Code page: each repo's files and uncommitted changes, read-only. Without `repos`, the
   * projects are shown. See docs/code-view.md.
   */
  code: z
    .object({
      enabled: z.boolean().default(true),
      repos: z
        .array(
          z.object({
            path: z.string().min(1),
            /** Where its git data is, when not `<path>/.git` (e.g. a one-way copy from another machine). */
            gitDir: z.string().min(1).optional(),
            /** How the page names it. Defaults to the project's title, else the folder name. */
            title: z.string().min(1).max(40).optional(),
            /** Project whose channel "Ask" posts to, for a repo that isn't a project. */
            askIn: z.string().optional(),
          }),
        )
        .optional(),
      /** Never listed, shown or diffed (git pathspec globs). */
      exclude: z.array(z.string().min(1)).default(['**/.env*', '**/*.pem', '**/*.key']),
    })
    .default({ enabled: true, exclude: ['**/.env*', '**/*.pem', '**/*.key'] }),
  /**
   * What needs you (`GET /attention`, and what Live reads out): approvals, permission prompts,
   * failing jobs, uncommitted work, and your GitHub PRs. See docs/command.md.
   */
  attention: z
    .object({
      /** Your open PRs and review requests through the `gh` CLI, logged in as the user tara-agent runs as. */
      github: z.boolean().default(true),
      /** Failing jobs that may interrupt you. None (the default): nothing ever does. */
      urgent: z
        .array(
          z
            .object({
              /** A job that failed this many times in a row. */
              consecutiveFailures: z.number().int().min(1).optional(),
              /** This job failing, as `project/jobId`. */
              job: z
                .string()
                .regex(/^[^/]+\/[^/]+$/, 'Use "project/jobId"')
                .optional(),
            })
            .refine(
              (r) => r.consecutiveFailures !== undefined || r.job !== undefined,
              'Set consecutiveFailures or job',
            ),
        )
        .default([]),
    })
    .default({ github: true, urgent: [] }),
  /**
   * Command: talk to tara out loud from the dashboard (`/command`), through a Gemini Live session. The key
   * (Google AI Studio) comes from TARA_LIVE_API_KEY. Unset = off. See docs/command.md.
   */
  live: z
    .object({
      /** A Gemini Live (`BidiGenerateContent`) WebSocket endpoint. */
      url: z
        .string()
        .regex(/^wss?:\/\//, 'Use a ws:// or wss:// URL')
        .default(GEMINI_LIVE_URL),
      model: z.string().min(1).default('gemini-3.8-live'),
      voice: z.string().min(1).default('Kore'),
      /**
       * How it should speak, in plain words; Live models pick the language themselves and take no
       * language code. E.g. "Indian English with an Indian accent. If I speak Hindi or Hinglish,
       * answer in the same."
       */
      language: z.string().min(1).max(500).optional(),
      /** Close the voice session after this long with nothing said by either side. */
      idleSeconds: z.number().min(5).max(600).default(20),
      /** Model for `ask`: read-only questions about a project, answered by Claude. */
      askModel: z.string().min(1).default('haiku'),
      askTimeoutSeconds: z.number().min(10).max(900).default(120),
      /** At most one spoken urgent alert per this many minutes; later ones are shown, not said. */
      urgentGapMinutes: z.number().min(0).max(1440).default(30),
      /** Jobs (`project/jobId`) whose urgent failures are said even in focus mode, and without the gap. */
      alwaysInterrupt: z
        .array(z.string().regex(/^[a-z0-9][a-z0-9-]*\/[^/\s]+$/, 'project/jobId, e.g. shop/payments-sync'))
        .default([]),
      /**
       * The browser voice for alerts said while the voice session is closed, as a language tag
       * (e.g. `en-IN`). Unset: the browser's default voice.
       */
      alertLang: z.string().min(2).max(35).optional(),
    })
    .optional(),
});

/** `<repo>/.tara/config.json`: committed in the project repo. */
export const projectConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  /** How the dashboard names the project ("Online Shop" for `shop`). Defaults to `name`. */
  title: z.string().min(1).max(40).optional(),
  slackChannel: z.string().regex(/^[CG][A-Z0-9]+$/, 'a Slack channel ID such as C0123456789'),
  permissionMode: z.enum(permissionModes).default('default'),
  chatModel: z.string().min(1).default('sonnet'),
  /** Tools allowed without asking, in Claude Code `--allowedTools` syntax. */
  allowedTools: z.array(z.string()).default([]),
  /** Extra system prompt appended to every session, relative to the repo root. */
  systemPromptFile: z.string().optional(),
  /**
   * Slack user who owns this project: jobs started from the local API or a dashboard stream their
   * thread live to this person (jobs started from Slack stream to whoever asked).
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
  /** Approval items (the Approvals page). */
  approvals: z
    .object({
      /**
       * Checks the project's own rules (lengths, banned words…) on every proposed or edited item:
       * POST {kind, key, fields} → {checks: [{text, blocking}]}. A blocking check stops approval.
       */
      validateUrl: z.string().url().optional(),
      /**
       * Told when an item of this project is decided or finished: POST {event, item}, signed with
       * APPROVAL_SEAL_KEY (HMAC-SHA256 of the body in `x-tara-signature`).
       */
      hookUrl: z.string().url().optional(),
      /** Pending items expire after this many days (default 7). */
      expireDays: z.number().positive().optional(),
    })
    .optional(),
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
    /**
     * Cron expression (5 or 6 fields). Leave it out for a job that runs only when a queue hands it
     * approved items (`.tara/queues.json`) or when started by hand.
     */
    cron: z.string().min(1).optional(),
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
    /** The CLI the job runs on. `agy` jobs need an agy `model` (`agy models` lists them). */
    harness: z.enum(harnesses).default('claude'),
    model: z.string().min(1).default('sonnet'),
    /**
     * `agy` jobs only: allow/deny rules for this job. Without them the project's permission mode
     * applies (`bypassPermissions` skips agy's checks, any other mode allows only tara's own tools).
     */
    agyPermissions: agyPermissionsSchema.optional(),
    /**
     * When a card of the run is approved, carry on in a fresh session on this harness and model instead
     * of the run's own, e.g. an `agy` job that reports findings and leaves approved fixes to Claude. That
     * session gets the card, the decision and the job's prompt; later decisions and thread replies stay
     * on it. A declined card (Skip, Reject, …) runs no model at all.
     */
    handoff: z.object({ harness: z.enum(harnesses), model: z.string().min(1) }).optional(),
    /** The job's own MCP servers, by name (not `tara`). */
    mcpServers: z
      .record(z.string().regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, _ and -'), mcpServerSchema)
      .refine((m) => !('tara' in m), { message: '"tara" is tara-agent\'s own server' })
      .optional(),
    /** Sessions run one after the other before the main prompt, e.g. one per part of a long check. */
    steps: z.array(jobStepSchema).default([]),
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

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const days = z
  .string()
  .regex(
    /^(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?(,(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?)*$/,
    'e.g. "mon-fri" or "tue,thu"',
  );

/** A time window approved items may run in, in its own timezone (e.g. the recipient's morning). */
export const queueWindowSchema = z.object({
  tz: z.string().optional(),
  days: days.default('mon-sun'),
  from: hhmm,
  to: hhmm,
});

/** One queue in `<repo>/.tara/queues.json`: how approved items of a kind run, one at a time. */
export const queueSchema = z
  .object({
    /**
     * Who runs the items: a job (gets them in its prompt), a URL (gets a POST per item, sealed), or
     * `external`: the project's own server runs them on its own schedule and reports each one
     * (`POST /items/<id>/report`); tara-agent never starts them.
     */
    executor: z.union([
      z.object({ job: z.string().regex(jobIdPattern) }),
      z.object({ url: z.string().url() }),
      z.object({ external: z.literal(true) }),
    ]),
    /** Items given to one job run. */
    batch: z.number().int().positive().default(1),
    /** Items run only while their window (the item's `window`, or any) is open. */
    windows: z.record(z.string(), queueWindowSchema).optional(),
    /** Instead of windows: one batch per cron slot. */
    slots: z.string().optional(),
    /** With slots: take turns between these kinds (oldest approval first within a kind). */
    alternate: z.array(z.string()).optional(),
    caps: z
      .object({
        perDay: z.number().int().positive().optional(),
        perWeek: z.number().int().positive().optional(),
      })
      .default({}),
    /** A person sets the order of its approved items on the Queue page (otherwise oldest approval first). */
    reorder: z.boolean().optional(),
    /** Minutes between two runs of this queue. */
    gapMinutes: z.number().nonnegative().default(0),
    /**
     * Post each card in the project's Slack channel too, as its own thread (no buttons: decisions
     * stay on the Approvals page). The message shows the decision, and a Revise and the run that
     * executes the card reply in its thread.
     */
    slack: z.boolean().optional(),
    /** Timezone for slots, window defaults and the cap day. Defaults to the jobs file `tz`, then the host. */
    tz: z.string().optional(),
  })
  .refine((q) => !(q.windows && q.slots), { message: 'use windows or slots, not both' });

export const queuesFileSchema = z.object({ queues: z.record(z.string().regex(jobIdPattern), queueSchema) });

export type QueueWindow = z.infer<typeof queueWindowSchema>;
export type QueueConfig = z.infer<typeof queueSchema>;

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
