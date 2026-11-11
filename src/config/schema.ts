import { Cron } from 'croner';
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
 * with the job's MCP servers but no Slack tools. Its reply goes into the main prompt. What it does is
 * the `### Step: <name>` part of the job's section in its skill.
 */
export const jobStepSchema = z.object({
  name: z.string().min(1).max(80),
  /** The skill holding this step's part. Defaults to the job's first skill. */
  skill: z.string().min(1).optional(),
  /** Defaults to the job's `timeoutMinutes`. */
  timeoutMinutes: z.number().positive().optional(),
  /** Defaults to the job's `model` (same harness), e.g. a faster model for long browser steps. */
  model: z.string().min(1).optional(),
  /** `agy` jobs: rules for this step instead of the job's `agyPermissions`. */
  agyPermissions: agyPermissionsSchema.optional(),
});
export type JobStep = z.infer<typeof jobStepSchema>;

/** A project's GitHub repo for pull requests (host `github`). */
export const githubRepoSchema = z.object({
  project: z.string().min(1),
  /** `owner/name`. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must be "owner/name"'),
  /** The branch PRs go into. */
  base: z.string().min(1).default('main'),
});
export type GithubRepo = z.input<typeof githubRepoSchema>;

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
  /**
   * Draft cards a project's own server may approve without a person. For a `kind` card of `project`
   * proposed over `POST /items` with `autoApprove: true`, tara-agent asks `url` (POST {kind, key,
   * fields} → {approve, reason}) and approves it as `auto` on a yes. Only a key's first card (also on a
   * refresh while it is still pending), and only one with no checks. Lives here, not in the repo's `.tara/config.json`, so a run can't turn it on
   * or point it at its own server. See docs/security.md "Auto-approved cards".
   */
  autoApprove: z
    .array(z.object({ project: z.string().min(1), kind: z.string().min(1), url: z.string().url() }))
    .default([]),
  /**
   * Projects whose runs may open pull requests (`start_pull_request`, `open_pull_request`) on GitHub,
   * on `<agentName>/<name>` branches into `base`. The token comes from TARA_GITHUB_TOKEN and never
   * reaches a run. Lives here, not in the repo, so a run can't point it at another repo or branch.
   * See docs/security.md "Pull requests".
   */
  github: z.array(githubRepoSchema).default([]),
  /** Where the SQLite state lives. Defaults to `~/.local/state/tara-agent`. */
  stateDir: z.string().optional(),
  /** Days after its last use that a session's scratch folder (`TARA_SCRATCH`) is deleted. */
  scratchDays: z.number().min(1).default(3),
  /**
   * Days of history kept in the state database: runs, slot claims and sessions not used since are
   * deleted daily (each job's latest run stays). Approval cards are kept.
   */
  retentionDays: z.number().int().min(14).default(90),
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
  /**
   * The shared browsers jobs drive (Chrome with remote debugging), one per Chrome instance, e.g. one
   * per signed-in identity. After every run of a job that holds a browser's `lock`, the tabs the run
   * opened or moved to another page in that browser are closed, also when it failed.
   */
  browsers: z
    .array(
      z.object({
        /** The job lock that means "this run drives this browser". */
        lock: z.string().min(1),
        /** Chrome's DevTools address, as in the Chrome MCP server's `--browserUrl`. */
        cdpUrl: z.string().url(),
        /** false: leave tabs as the run left them. */
        closeTabs: z.boolean().default(true),
      }),
    )
    .refine((b) => new Set(b.map((x) => x.lock)).size === b.length, {
      message: 'each browser needs its own lock',
    })
    .default([{ lock: 'chrome', cdpUrl: 'http://127.0.0.1:9222', closeTabs: true }]),
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
   * What needs you (`GET /attention`): approvals, permission prompts, failing jobs, uncommitted work,
   * and your GitHub PRs.
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
});

const selfImproveSchema = z.enum(['always', 'trouble', 'off']);
export type SelfImprove = z.infer<typeof selfImproveSchema>;

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
   * Slack user who owns this project: scheduled, queue, API and dashboard job runs address their live
   * thread stream to this person (jobs started from Slack stream to whoever asked).
   */
  owner: z
    .string()
    .regex(/^[UW][A-Z0-9]+$/, 'a Slack user ID such as U0123456789')
    .optional(),
  /** Slack user IDs allowed to talk to the bot. Empty = every member of the channel. */
  allowedUsers: z.array(z.string()).default([]),
  /** `api` runs the CLI with ANTHROPIC_API_KEY instead of the host's Claude login. */
  billing: z.enum(['subscription', 'api']).default('subscription'),
  /**
   * The project's own web dashboard, if it has one. Without `tabs` the sidebar links to it. With `tabs`
   * it is the app's origin as tara-agent reaches it (e.g. http://127.0.0.1:4001), and its pages show
   * inside tara-agent's dashboard (see docs/dashboard-look.md).
   */
  dashboardUrl: z.string().url().optional(),
  /**
   * Pages of the project's app (`dashboardUrl`) listed in tara-agent's sidebar, in order. Each opens at
   * `/p/<name><path>`, with the app proxied from `/app/<name>/`. The first is the project's landing page.
   */
  tabs: z
    .array(
      z.object({
        path: z.string().regex(/^\/[^\s]*$/, 'an app path starting with /'),
        label: z.string().min(1).max(30),
        icon: z.string().max(8).optional(),
      }),
    )
    .optional(),
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
   * Learning turns: resume a finished run's session once and let Claude fix the skill or instruction
   * file it followed. `always` (default, also `true`): after every run that used a tool; a clean run
   * gets a short look back, a run with trouble the list of what went wrong. `trouble`: only after a run
   * that failed, errored, timed out or had several tool errors. `off` (also `false`): never.
   */
  selfImprove: selfImproveSchema.default('always'),
  /**
   * Parent folder of the per-session scratch folders (`TARA_SCRATCH`), relative to the repo. Keep it
   * out of git. Defaults to `<stateDir>/scratch/<name>`.
   */
  scratchDir: z.string().optional(),
  /** Parent folder of the per-job data folders (`TARA_JOB_DATA`), relative to the repo. Defaults to `<stateDir>/job-data/<name>`. */
  jobDataDir: z.string().optional(),
});

const jobIdPattern = /^[a-z0-9][a-z0-9-]*$/;

/** A cron expression croner accepts; checked when the file loads, not when it first fires. */
const cronString = z.string().refine(
  (expr) => {
    try {
      new Cron(expr, { paused: true }).stop();
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not a valid cron expression' },
);

/** An IANA timezone the runtime knows. */
const timeZoneString = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not a known timezone' },
);

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
    /**
     * Skills the job loads first (at least one). The first one holds the job's instructions: its
     * `## Job: <id>` section, with the scripts to run first (`### Before you start`) and a
     * `### Step: <name>` part per step.
     */
    skills: z.array(z.string()).default([]),
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
     * session gets the card, the decision and the job's instructions (its skill section); later decisions and thread replies stay
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
    /** Overrides the project's `selfImprove` for this job, e.g. `trouble` for a job that runs every few minutes. */
    selfImprove: selfImproveSchema.optional(),
    /** Slack channel for this job's threads. Defaults to the project channel. */
    channel: z.string().optional(),
    /** Extra environment for the CLI (and the scripts it runs). `~/` is expanded. */
    env: z.record(z.string(), z.string()).default({}),
    allowedTools: z.array(z.string()).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((j) => j.skills.length > 0, {
    message: 'a job needs a skill: its instructions are the skill\'s "## Job: <id>" section',
    path: ['skills'],
  });

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
    slots: cronString.optional(),
    /** With slots: take turns between these kinds (oldest approval first within a kind). */
    alternate: z.array(z.string()).optional(),
    /**
     * Instead of slots or windows: run only in the slots of this other queue that it leaves empty
     * (nothing of its own due), e.g. extra posts that go out only when no main post is waiting.
     */
    fills: z.string().regex(jobIdPattern).optional(),
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
    tz: timeZoneString.optional(),
  })
  .refine((q) => !(q.windows && q.slots), { message: 'use windows or slots, not both' })
  .refine((q) => !(q.fills && (q.windows || q.slots)), {
    message: 'a queue that fills another has no windows or slots',
  });

export const queuesFileSchema = z
  .object({ queues: z.record(z.string().regex(jobIdPattern), queueSchema) })
  .superRefine(({ queues }, ctx) => {
    for (const [name, q] of Object.entries(queues))
      if (q.fills && !queues[q.fills]?.slots)
        ctx.addIssue({
          code: 'custom',
          path: ['queues', name, 'fills'],
          message: `"${q.fills}" is not a queue with slots`,
        });
  });

export type QueueWindow = z.infer<typeof queueWindowSchema>;
export type QueueConfig = z.infer<typeof queueSchema>;

/** `<repo>/.tara/jobs.json`. */
/**
 * Values every job in the file gets unless it sets its own, so a key most jobs share is written once.
 * A job overrides one by setting it (`"locks": []` for a job that doesn't need the shared lock).
 */
export const jobDefaultsSchema = z
  .object({
    harness: z.enum(harnesses),
    model: z.string().min(1),
    locks: z.array(z.string()),
    timeoutMinutes: z.number().positive(),
  })
  .partial()
  .strict();

const jobsArraySchema = z.array(jobSchema).superRefine((jobs, ctx) => {
  const seen = new Set<string>();
  for (const [i, j] of jobs.entries()) {
    if (seen.has(j.id))
      ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate job id "${j.id}"` });
    seen.add(j.id);
  }
});

export const jobsFileSchema = z
  .object({
    /** IANA timezone for every job's `cron` that doesn't set its own `tz`. Defaults to the host timezone. */
    tz: z.string().optional(),
    /** Environment shared by every job in this repo. `~/` is expanded. */
    env: z.record(z.string(), z.string()).default({}),
    defaults: jobDefaultsSchema.default({}),
    jobs: z.array(z.record(z.string(), z.unknown())),
  })
  .transform((file, ctx) => {
    // Applied before each job is parsed, so the job's own value (even `[]`) wins and errors point at the job.
    const jobs = jobsArraySchema.safeParse(file.jobs.map((job) => ({ ...file.defaults, ...job })));
    if (!jobs.success) {
      for (const issue of jobs.error.issues) ctx.addIssue({ ...issue, path: ['jobs', ...issue.path] });
      return z.NEVER;
    }
    const { defaults: _applied, ...rest } = file;
    return { ...rest, jobs: jobs.data };
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
  /** What its "Run <name>" messages say (`runName`): the job's name unless another job shares it. */
  runName?: string;
}
