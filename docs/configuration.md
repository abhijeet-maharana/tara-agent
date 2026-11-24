# Configuration

Every setting tara-agent reads, plus the job conventions, approval tools, queues and local API. For a first setup, start with the [README](../README.md#quick-start).

| File | Where | Committed? |
|---|---|---|
| Host config | `~/.config/tara-agent/config.yaml` | No |
| Secrets | `~/.config/tara-agent/env` (mode 600) | No |
| Project config | `<repo>/.tara/config.json` | Yes, in that repo |
| Jobs | `<repo>/.tara/jobs.json` | Yes |
| Queues | `<repo>/.tara/queues.json` | Yes |

`tara-agent validate` checks all of them.

## Host config

| Key | Default | Meaning |
|---|---|---|
| `projects` | required | Paths of project repos |
| `agentName` | `tara` | The agent's name: Claude is told "Your name is …" in every run, and the dashboard shows it. The name on Slack messages is the Slack app's bot name (App Home → Display name) |
| `concurrency` | `8` | Max chat sessions at once |
| `jobConcurrency` | `1` | Max scheduled jobs at once |
| `claude.bin` | `claude` | CLI path |
| `claude.chatTimeoutMinutes` | `20` | Time limit per chat turn |
| `claude.effort` | model's default | `--effort` for every run: `low`, `medium`, `high`, `xhigh` or `max`. A job's own `effort` wins |
| `claude.runAs` | none | Run Claude and pre-run scripts as this OS user through sudo ([split users](security.md#split-users-approvals)) |
| `agy.bin` | `agy` | Antigravity CLI path, for [agy jobs](#agy-jobs). Under `claude.runAs` the run user's install, e.g. `/home/tara/.local/bin/agy` |
| `stateDir` | `~/.local/state/tara-agent` | SQLite database, and default home of scratch and job data folders |
| `scratchDays` | `3` | Days after its last use that a session's scratch folder is deleted (see [Files](#files)) |
| `retentionDays` | `90` | Days of history kept in the state database (min 14). Runs, slot claims, sessions not used since, and the machine and VM host samples are deleted daily; each job's latest run is kept. Finished approval cards are kept 60 days (the keys of decided cards for good, so auto-approve never sees an old key as new) |
| `backup.dir` | `<stateDir>/backups` | Where the daily copy of the state database goes (`tara-YYYY-MM-DD.db`, checked with `quick_check` before it gets its name). Point it at another disk, or copy the folder off the machine (`deploy/pull-backups.sh <ssh host>`, run daily on the other machine), so a failing disk doesn't take the copies with it. The Health page shows a **Database backup** check |
| `backup.keep` | `7` | Days of copies kept |
| `backup.offsite` | unset | The off-site backup's status file (`statusFile`), plus `maxAgeHours` (30: red after that without a good backup) and `restoreTestDays` (35: amber after that without a passed restore test). Shows **Off-site backup** and **Restore test** on the Health page. See [`backups.md`](backups.md) |
| `streaming` | `true` | Stream replies as a live task card and text. Needs the Slack app's "Agents & AI Apps" feature and the `assistant:write` scope; without them, tara-agent falls back to one edited status message |
| `browsers` | `[{lock: chrome, cdpUrl: http://127.0.0.1:9222, closeTabs: true, staleMinutes: 30}]` | The shared Chromes runs drive (e.g. one per signed-in identity: its own `--user-data-dir` and `--remote-debugging-port`). `lock` is its name on the Browsers page. Runs share a browser without locks ([shared browsers](#shared-browsers)); with `closeTabs`, tara closes stale tabs every 5 minutes: open over `staleMinutes` and since before every conversation still going in that browser began (a job run, or a chat thread: going while a turn runs and for `staleMinutes` after its last turn), never a kept tab (project `keepTabsUrl`) or the last tab. Point the project's Chrome MCP server (`--browserUrl`) at the same `cdpUrl` |
| `voice` | unset | Speech-to-text for Slack voice notes that Slack didn't transcribe (it skips short clips and some languages): `url` (an OpenAI-compatible chat completions endpoint whose models take `input_audio`, e.g. Gemini) and `models` (tried in order). Key from `TARA_VOICE_API_KEY`. Unset = Slack's transcript only, and voice notes without one get a "please type it" reply |
| `delivery` | `summary` | Where runs nobody started from Slack happen (scheduled, catch-up, Run now, queues, decisions, scheduled tasks, voice and Code-page requests). `summary`: on the dashboard (see [Dashboard runs](#dashboard-runs)), with one result message in Slack. `thread`: a `Run <name>` thread in Slack with every step. Projects and jobs override it with their own `delivery` |
| `dashboardUrl` | `http://<host name>:<http.port>` | The dashboard's address as you open it, for the "Open the run" links in Slack summaries and card copies. The default (e.g. `http://jarvis:4000`) works over Tailscale MagicDNS; set it when you open the dashboard by another name |
| `statusIntervalSeconds` | `5` | Min gap between status edits in the fallback mode |
| `catchUpHours` | `6` | After downtime, run a job's latest missed slot if it is at most this old (`0` = never) |
| `timezone` | host's | Default timezone for job schedules and times shown in Slack |
| `autoApprove` | none | Draft cards a project's own server may approve without a person: a list of `{project, kind, url}`. A card of that kind proposed over `POST /items` with `autoApprove: true` is approved as `auto` (sealed, then queued as usual) when `url` answers `{approve: true, reason}` to `POST {kind, key, fields}`. Only a key's first card and only one with no checks; anything else waits for a person. Host config only, so a run can't turn it on ([auto-approved cards](security.md#auto-approved-cards)) |
| `github` | none | Projects whose runs may open pull requests: a list of `{project, repo, base}` (`repo` is `owner/name`, `base` defaults to `main`). Token: `TARA_GITHUB_TOKEN` in tara-agent's env, never given to a run. Runs get `start_pull_request` (a fresh copy of `base`, or of the PR's branch, in a temp folder) and `open_pull_request` (commit, push to `<agentName>/<name>`, open or update the PR). No merges, no force pushes, no `.github/`, env or key files ([pull requests](security.md#pull-requests)). They also get `read_ci_job` (read-only: a job's failed steps and log excerpt; the token needs **Actions** read) ([CI jobs](security.md#ci-jobs)) |
| `privileged.command` | off | Root actions a run may ask for through the root-owned helper `deploy/tara-priv.mjs`, usually `["sudo", "-n", "/usr/local/sbin/tara-priv"]` ([privileged actions](security.md#privileged-actions)) |
| `http` | `127.0.0.1:4100` | Local API and dashboard (`enabled`, `bind`, `port`, `allowFrom`). Set `TARA_HTTP_TOKEN` to require a bearer token (open a page once with `?token=…` to sign a browser in). The MCP tools need it enabled |
| `http.allowFrom` | `127.0.0.0/8`, `::1/128` | CIDR ranges allowed to connect. Transcripts hold everything Claude saw, so keep this to a trusted network, e.g. add `100.64.0.0/10` and `fd7a:115c:a1e0::/48` for Tailscale |
| `http.hosts` | none | Extra host names the dashboard is opened by, when `bind` is beyond localhost. IP addresses, `localhost`, one-word names (`jarvis`), Tailscale names (`*.ts.net`) and the host of `dashboardUrl` always work; a request whose Host is any other name is refused (it stops DNS-rebinding pages). Add a LAN name like `jarvis.home.lan` here |
| `http.fallback` | none | URL that receives every request tara-agent doesn't serve, passed through unchanged. Useful when taking over a port from another service |
| `http.tls` | off | Also serve HTTPS on `port` (default `4443`) with `cert` and `key` files, e.g. from `tailscale cert`. The certificate is re-read when its file changes, so renewing it needs no restart. `tls.appPort`: the HTTPS twin of `http.appPort` |
| `http.appPort` | off | Serve project apps shown as tabs (`/app/<name>/…`) on this port, another origin than the dashboard, so an app's pages can't use your unlocked browser to decide cards. The frame follows the app's address through a small script the proxy adds to its HTML pages. Old `/app/…` links on the dashboard's port are sent on. An app that decided cards from its own pages (`fetch('/items/<id>/decide')`) can't any more ([project tabs](security.md#project-tabs)) |
| `trusted` | none | Settings of a project that only the host config may set, keyed by its repo path as listed in `projects`: any of `slackChannel`, `owner`, `permissionMode`, `billing`, `systemPromptFile`, `dashboardUrl`, `healthUrl`, `keepTabsUrl`, `approvals`, `reminders`, plus `executorUrls` (the only URLs its queues may send to). For a listed project those keys come from here only; the repo's values are ignored and shown on the Health page when they differ ([pinned project settings](security.md#pinned-project-settings)) |
| `http.quietHours` | `23:00`–`07:00` | `{from, to}` in local `HH:MM`, sent in `GET /glance` as `quiet`: desk panels such as the macOS desk widget hold their notifications then |
| `code` | on, the projects | The Code page: `repos` (`path`, `gitDir`, `title`, `askIn`) and `exclude` globs never shown (default `.env*`, `*.pem`, `*.key`). See [code-view.md](code-view.md) |
| `attention` | GitHub on, nothing urgent | What needs you (`GET /attention`): `github` (your open PRs and review requests through `gh`, logged in as the user tara-agent runs as) and `urgent` rules that put a failing job in the urgent tier: `{consecutiveFailures: 3}` or `{job: "project/jobId"}` |
| `health` | on, every 5 min, alerts on | The Health page (see [Dashboard](#dashboard)): `enabled`, `intervalMinutes`, `alerts` (post red checks and recoveries in Slack), `alertProject` (whose channel hears about tara-agent itself; default the first project), `stuckMinutes` (180: a run going longer is stuck), `failingAfter` (3: failures in a row that turn a job red), `diskWarnPercent` / `diskBadPercent` (85 / 95), `logUnits` (systemd units whose warnings and errors the Logs view shows; tara-agent's user must read the journal: `sudo usermod -aG systemd-journal <user>`) |

## Project config

| Key | Default | Meaning |
|---|---|---|
| `name` | required | Short id (`a-z0-9-`) |
| `slackChannel` | required | Channel ID (`C…` / `G…`) |
| `title` | `name` | Display name on the dashboard |
| `permissionMode` | `default` | `default`, `acceptEdits`, `plan` or `bypassPermissions` |
| `allowedTools` | `[]` | Tools allowed without asking, in `--allowedTools` syntax |
| `allowedUsers` | `[]` (everyone in the channel) | Slack user IDs allowed to talk to the bot |
| `delivery` | host `delivery` | `summary` or `thread` for this project's runs |
| `chatModel` | `sonnet` | Model for new threads |
| `systemPromptFile` | none | Extra instructions added to every session |
| `owner` | none | Slack user ID that receives live progress of jobs started from the API or dashboard |
| `billing` | `subscription` | `api` runs the CLI with `ANTHROPIC_API_KEY` |
| `dashboardUrl` | none | The project's own web dashboard. Without `tabs`: linked from the sidebar. With `tabs`: the app's origin as tara-agent reaches it (`http://127.0.0.1:4001`) |
| `tabs` | none | `[{path, label, icon?}]`: pages of that app shown in tara-agent's sidebar at `/p/<name><path>`, proxied from `/app/<name>/` (see [dashboard-look.md](dashboard-look.md#project-tabs)) |
| `scratchDir` | `<stateDir>/scratch/<name>` | Parent of per-session scratch folders, relative to the repo. Keep it out of git |
| `jobDataDir` | `<stateDir>/job-data/<name>` | Parent of per-job data folders, relative to the repo |
| `selfImprove` | `"always"` | After every run (`always`), only runs with trouble (`trouble`), or never (`off`), let Claude fix the skill it followed (see [Self-improvement](#self-improvement)) |
| `healthUrl` | none | The project's own checks for the Health page: GET returns `{checks: [{name, ok, warn?, detail, group?, link?}]}` (also bare, or under `result`). Without it, `dashboardUrl` is only checked for an answer |
| `dataUrl` | none | The project's data API (`packages/kit` `DataApi`, e.g. `http://127.0.0.1:4002/api/db`): its own database's tables, rows and read-only SQL on the dashboard's **Data** tab (sidebar 🗄️); an unlocked browser can edit and add rows of `agentWritable` tables there. Runs of the project get `data_*` tools for the same API. Pinnable in host `trusted` |
| `keepTabsUrl` | none | Tabs tara never closes as stale (host `browsers`): GET returns a JSON list of `{url}` or URL strings, bare or under `result`, matched without query or fragment. For a page a person must finish, such as a form stopped at a captcha. If it doesn't answer, no tab in that browser is closed |
| `words` | none | How skill-name words are written in job names: `{"linkedin": "LinkedIn", "sla": "SLA"}`; other words are capitalised |
| `approvals.validateUrl` | none | Asked for extra checks on every proposed or edited draft (see [Queues](#queues)) |
| `approvals.hookUrl` | none | Told when a draft is decided or finished |
| `approvals.expireDays` | `7` | Pending drafts expire after this many days |
| `reminders.hookUrl` | none | Where a reminder set with `notify` also goes: POST `{id, text}` (e.g. the project's endpoint that posts to a WhatsApp group). Without it, reminders are Slack only and `notify` is refused |
| `reminders.label` | `hook` | What the hook sends to, as the Reminders page shows it (e.g. `Ops WhatsApp`) |

## Jobs

`<repo>/.tara/jobs.json`, reloaded within 30 seconds of a change:

```json
{
  "tz": "Asia/Kolkata",
  "env": { "DATA_DIR": "~/data" },
  "defaults": { "model": "opus", "timeoutMinutes": 40 },
  "jobs": [
    { "skill": "order-sla-report", "cron": "45 10 * * *", "durationMinutes": 5, "model": "haiku" }
  ]
}
```

**A job is its skill.** `skill` names the one skill that holds the job's instructions; it is also the job's id, and its name is the skill's words capitalised (`order-sla-report` → `Run Order SLA Report` with project `words` `{"sla": "SLA"}`). One job per skill in a project. Other skills it needs are named in its skill, which loads them. There are no locks: runs share a browser, each on its own tabs ([shared browsers](#shared-browsers)).

**`defaults`** (optional) sets `harness`, `model`, `effort` or `timeoutMinutes` for every job in the file, so a value most jobs share is written once. A job's own value wins. Other keys are refused. The defaults in the table below apply when neither the job nor `defaults` sets the key.

*Older form, still read:* `id`, `name`, `skills` (a list, the first holding a `## Job: <id>` section) and `locks` instead of `skill`. A job with `skill` refuses those four keys.

| Key | Default | Meaning |
|---|---|---|
| `skill` | required | The job's skill: its instructions, id and name |
| `cron` | none | Cron expression (5 or 6 fields). Leave it out for a job a queue runs (its `executor`) or an **on-demand** job, listed on the Jobs page's **On demand** tab and started only with **Run now** there, `POST /jobs/<project>/<id>/run`, or by asking in chat (`run_job`) |
| `tz` | file-level `tz`, else host `timezone` | Timezone of `cron` |
| `harness` | `claude` | The CLI the job runs on: `claude`, or `agy` ([agy jobs](#agy-jobs)) |
| `model` | `sonnet` | Model for this job (for `agy`, an id from `agy models`, e.g. `gemini-3.8-flash-high`) |
| `effort` | host `claude.effort` | Claude jobs: `--effort` for the run, its steps, its learning turn and replies in its thread (`low` … `max`), e.g. `max` for a tax filing, `low` for a short summary. A step may set its own |
| `agyPermissions` | none | `agy` jobs only: `{allow, deny, ask}` rules ([agy jobs](#agy-jobs)) |
| `handoff` | none | `{harness, model}`: an approved card continues in a fresh session on this harness ([handoff](#handoff)) |
| `fallback` | none | `{harness, model}`: a session whose harness is out of quota or capacity reruns on this one ([fallback](#fallback)) |
| `mcpServers` | none | The job's own stdio MCP servers by name (`{command, args, env}`), for every session of the job ([steps and MCP servers](#steps-and-mcp-servers)) |
| `steps` | `[]` | Sessions run one after the other before the main prompt ([steps and MCP servers](#steps-and-mcp-servers)) |
| `timeoutMinutes` | `30` | Time limit for each session of the run (a step, the main prompt), and for any one command it runs (Claude's Bash timeout is set to it) |
| `runTimeoutMinutes` | twice `timeoutMinutes` with steps, else `timeoutMinutes` | Time for the whole run, steps included: a session gets no more than what is left (the main session always at least 5 minutes, to report), and a step with no time left is skipped and marked so |
| `maxWaitMinutes` | none | A scheduled run that waited longer than this for its locks or a job slot is skipped instead of starting late (a morning report at noon). Runs a person asked for always start |
| `catchUp` | `true` | Run the latest missed slot after downtime |
| `selfImprove` | project's | Overrides the project's `selfImprove` for this job, e.g. `"trouble"` for a monitor that runs every few minutes |
| `channel` | project channel | Where the job posts (its thread, or its summary) |
| `delivery` | project `delivery` | `thread`: this job's whole run in a Slack thread; `summary`: on the dashboard, its result in Slack |
| `env` | `{}` | Extra environment for Claude and the scripts it runs (`~/` expanded), merged over the file-level `env` |
| `durationMinutes` | none | Typical run time: the Jobs Timeline plans with it (change it on the job's card in Jobs → List) |
| `enabled` | `true` | `false` keeps the job listed but never scheduled |
| `gate` | none | A command run before the model (see [Gate, requires and budget](#gate-requires-and-budget)). No output: the run ends `skipped`, no model session |
| `requires` | none | URLs that must answer before the run (a browser, a project server). Down: the run ends `blocked`, no model session |
| `budgetUsd` | none | Stop the main session once it has spent this many dollars (`--max-budget-usd`); the run ends `over-budget`. A runaway guard, not a quota |

### Gate, requires and budget

Three checks that keep a run from starting a model session it doesn't need, or from running away. All are optional; a job without them runs as before.

- **`gate`**: a shell command (`sh -c`, in the repo, as the run user, with the job's environment and `$TARA_JOB_DATA`) that tara-agent runs **before** a scheduled, catch-up or Run now run. Exit 0 with no output, or with only one line starting `Skipping` (the reason, e.g. `Skipping: no new mail`), means nothing to do: the run ends `skipped` with no model session; a scheduled one posts nothing, Run now says "✅ Nothing to do". Any output (or a non-zero exit, or a timeout after the job's `timeoutMinutes`) starts the run as usual, with what the gate printed in the prompt under `## Gate output` (its first 128,000 characters, with a line saying when the rest was cut) and an instruction not to run it again; a failing gate's error is there too, to fix or report. The skill's `### Before you start` then says to work from the gate output instead of running the check itself. Queue runs and continued sessions don't run the gate.
- **`requires`**: URLs that must answer (any status below 500, within 6 s) before a scheduled, catch-up, Run now or queue run starts. When one doesn't, the run ends `blocked` with no model session. Slack hears once per streak (a Run now always says why), and a queue's items go back to the queue, to try again in 15 minutes: nothing was sent. `blocked` counts as a failure on the Jobs page and in the Health page's failing-run checks.
- **`budgetUsd`**: passed to Claude as `--max-budget-usd` for the main session. The CLI checks it between turns, so a run may go a little over; it then ends `over-budget` (💸 on the status line and in the summary). Unset, nothing is limited.

`tara-agent doctor` lists every job's `requires` that doesn't answer right now.

### Job instructions

What a job does lives in its skill, in a `## Job` section, not in `jobs.json`:

```markdown
## Job

### Before you start

Run `python3 scripts/sla-gate.py` from the repo root. If it prints nothing, reply with one line `✅ Nothing to do` and stop. Otherwise its output is your input.

Check yesterday's late orders in that output and summarise them. On STATUS: FAILED, …
```

- The run is told: *do what the "## Job" section of the `<skill>` skill says, with the rest of that skill.* The skill's other sections are the reusable how-to; this one is the job's wiring (which scripts to run first, what to do with their output, where to report).
- **Scripts:** Claude runs them itself, as the skill says, any number and in any order. Each Bash call may take up to the job's `timeoutMinutes`. A job that is only a script has a skill that runs it and replies with what it printed. Scripts worth keeping go in the skill's `scripts/` folder; runs and learning turns may add or fix them there (and in `.tara/scripts/`), with `SKILL.md` saying when and how to run them. A script that must run without the model (a monitor every few minutes) belongs in the host's crontab, posting through `POST /items/ask` (`kind: "notice"`).
- A job that needs other skills names them in its `## Job` section ("Load these skills first: `a`, `b`"); Claude loads them with the Skill tool.
- Steps: `### Step: <name>` parts inside the section, plus an optional `### Every step` part.
- Learning turns improve this section along with the rest of the skill.

### How a run goes

> With `delivery: summary` (the default) the next paragraphs describe what happens **on the dashboard** instead of in Slack; see [Dashboard runs](#dashboard-runs). They apply as written to `delivery: thread` and to runs started from Slack.

**A project channel holds only `Run <name>` messages.** Every run starts with one at the top level, and everything else (status, the answer, cards, notes, learning notes) goes in its thread. `Run` messages are never edited. The name is always in title case: a kebab-case id is never shown raw (`code-question` → `Run Code Question`; two jobs sharing a name → their ids, e.g. `Run Pnl 2`). Things that aren't job runs follow the same rule: a Code-page question opens a `Run Code Question` thread. An invalid jobs file posts nothing in Slack: it is in the logs and on the dashboard. A trigger that can't run (the job is paused or already running) says so inside its own thread and gets a ⏸ / 🔁 reaction. A card a project server raises **for a run** (the run called the server) goes in that run's thread too: the server passes the run's `TARA_THREAD` as `thread` to `POST /items` or `POST /items/ask`. Cards a project server raises on its own (drafts, `POST /items/ask` questions and notices, no `thread`) are not runs: they wait on the Approvals page only, with nothing posted in Slack. Once Jarvis has to act on one (a decision on a question, a revise, a note from the page), a `Run <Kind>` thread opens for it (e.g. `Run Decision`, `Run Replies`) with the card's title as its first reply; its outcome follows there. A chat started in a thread of cards is told which cards it holds.

1. **Trigger message.** At cron time a `Run <job name>` message is posted (the skill's words capitalised, e.g. `Run Google Analytics`) in the project channel, as the `SLACK_USER_TOKEN` person if set (else, or when that person isn't in the channel, as the bot). The bot picks it up and runs the job in its thread; if Slack doesn't deliver it within 2 minutes, the scheduler starts it there itself.
2. **Claude** runs the job's skill section (its scripts first, as the section says), streaming into the thread.
3. **The reply**: the part before a `---` line is the headline on the status line (the thread's first reply), the rest goes in the thread. A short reply with no `---` is all headline: it shows only on the status line, not again in the thread.
   - Nothing to report: a one-line `✅ …` reply. Claude's whole reply always goes in the thread, even a one-liner, so you can see what it checked. An empty reply shows "🔇 nothing to report" and a `🔇 Claude finished without a written reply` line in the thread; the thread and session stay, so you can ask why.
   - A reply starting with `❌` marks the run failed (problems the job found are `⚠️`, not failures).
4. **Replying** in the job's thread continues its session, so a job can ask a question and act on your answer.

Other rules:

- **Every slot runs at most once**, even across restarts. A job added while tara-agent was down doesn't run for past slots.
- **Watching live:** every run streams its steps and text into its Slack thread (the status line, its first reply, keeps the current step and, at the end, the headline). A run you start with `run <job name>` streams in your message's thread; scheduled, queue and dashboard/API runs stream in their `Run <job name>` thread, addressed to the project `owner` (Slack's streaming needs a recipient; without `owner` they post the status line and Claude's whole reply at the end). A run with no thread of its own (a queue, Run now) opens its `Run <job name>` thread. A run that replies nothing keeps its thread, with the steps it took, its session, a `🔇 … · nothing to report` status line and a line saying Claude wrote no reply.

### Dashboard runs

With `delivery: summary`, a run nobody started from Slack happens in a **dashboard thread** (`web-<project>`) instead of a `Run <name>` Slack thread. Nothing is posted in Slack while it runs.

1. **Start.** A scheduled slot starts the run straight away (no trigger message). Run now, `run_job`, queues, decisions on cards, scheduled tasks and voice or Code-page requests open a dashboard thread too.
2. **Watch.** The run's session page (Sessions, or the home page's running job) shows its steps and text live, then the whole transcript, the files it sent, and a **Reply** box (an unlocked browser) that continues the session.
3. **Result in Slack: one summary after every run.** When it ends, one top-level message. Its first line is the headline's status emoji, the run's name and the headline's first line (`⚠️ *UI Review* · 3 UI issues found`, `✅ *Spam Rescue* · Nothing to do: no mail in spam since 18:00`); the rest of the headline (the part before `---`; a table there is drawn as one) follows, then a small line with the time and an **Open the run ↗** link (`dashboardUrl`). Files it sent are attached in that message's thread. A failure or timeout posts one line. A run with no reply (🔇) or one you stopped posts nothing. The job prompt asks every ✅ line to say why.
4. **Cards go in the summary's thread.** The run's message then shows only its first line, plus `🟡 3 cards wait for you on the Approvals page ↗` (a link to `<dashboardUrl>/approvals`). Each approval card it left follows as a reply in that message's thread, with its buttons: a tap there decides it, and a decision, update or withdrawal on the Approvals page edits the Slack copy too. Drafts (reviewed and edited on the Approvals page) get one reply listing them, each linked to its card. Replies in a thread don't notify, so the channel still gets one message per run. A permission prompt (which blocks its run) is still copied to Slack as its own message, and a tap there decides it.
5. **After your decision: a reply under the job's summary.** The result of the job continuing after your decision, acting on a card with handoff notes (in its new dashboard thread), or working approved queue items is a **reply in the thread of the job's summary** when it went fine (✅, no new cards), so approving ten cards adds no channel messages. A ⚠️, a failure or new cards get their own message, so they notify. With no summary to go under, it is a message of its own.
6. **Usage limits and lost logins.** A run stopped by the usage limit, or failing because the CLI's login ran out, doesn't post its own line: the channel gets one message per incident (`⏸ *Claude usage limit reached*` / `🔑 *Claude login failed*` with the fix), edited as more runs hit it (`Skipped (11): …`). It closes once a run on that CLI works again (the message says so) or after 12 hours without a new hit (`src/slack/incidents.ts`).
7. **Replies.** A reply in the thread of a summary or a permission prompt's copy goes to the run's session: Jarvis answers in that Slack thread, with the run's whole context.

A run asked for as a top-level `run <job name>` message (or a `slack` queue's cards) stays in that message's thread, as before. **Asked for as a reply inside a thread** (under a run's summary, in a chat), it runs on the dashboard and its summary is posted as a reply **in that same thread**, whatever the result (`🔇 Nothing to report` too), so the answer is where you asked. A job on `delivery: thread` still opens its own `Run <name>` message.

### agy jobs

A job with `"harness": "agy"` runs on Google's Antigravity CLI (`agy`) instead of Claude Code, e.g. to use an idle Google AI Pro plan. Everything else works the same: the skill section, the ✅/❌ headline, Slack thread, tara's tools (`request_approval`, `send_file`, …), and a decision on its card or a reply in its thread continues the same agy conversation.

- **Setup:** install agy as the run user and sign in once interactively (`agy`, then Google OAuth); check with `agy models`. Set host `agy.bin` if it isn't on the service's `PATH`.
- **How it runs:** one `agy` process per turn in stream-json mode, the prompt on stdin (no TTY needed, nothing on the command line), `--print-timeout` 30 s inside `timeoutMinutes` so agy stops and reports by itself. tara's MCP server and the system prompt reach agy as a plugin `tara` in a per-run folder added with `--add-dir` (agy has no `--mcp-config`); agy names the server `tara_tara`.
- **Permissions:** with `agyPermissions`, the job's rules go to agy as session-only settings (`--settings`), plus `mcp(tara_tara/*)`. Rules are `action(target)`: `command(npx tsc)`, `write_file(/home)`, `read_url(github.com)`, `mcp(server/*)`; deny beats allow, and headless agy denies anything not allowed. Without `agyPermissions`, a `bypassPermissions` project passes `--dangerously-skip-permissions` (like Claude's bypass); other modes allow only tara's tools. Note agy's file tool writes anywhere the user can unless a deny rule says otherwise.
- **Thread replies:** a reply in an agy job's thread continues its agy conversation under the job's `agyPermissions` (only tara's tools if the job has none), never with `--dangerously-skip-permissions`. A denied tool ends a headless agy turn with no answer, so allow the harmless read-only commands the model tends to try (`ls`, `cat`, `find`).
- **Not on agy (yet):** self-improvement turns (they resume with Claude), the Session transcript page, cost in USD. Usage counts thinking tokens as output.

### Handoff

`"handoff": {"harness": "claude", "model": "claude-opus-5-5"}` splits a job between two CLIs: the run (steps and main prompt) reports on its own harness, e.g. agy on a Google plan, and an **approved** card carries on in a fresh session on the handoff's harness and model, e.g. Claude Code making the fix.

- That session never saw the run, so its first prompt has the card (title and details), the decision and the job's instructions (its skill section); write that section so its "on approval" part stands on its own, and put everything the fix needs (page, steps, screenshot path, suspected file) in the card's details.
- It uses the run's scratch folder, so files the run saved there (screenshots) are still at the paths on the card.
- Later approvals and thread replies continue that session; each later card comes with its details, since that session never saw it either. A declined card (Skip, Reject, …) runs no model at all: the card and its Slack message already show the decision.
- The session is a normal job session on its harness: Claude gets the project's permission mode and `allowedTools`, self-improvement and the transcript page.

### Fallback

`"fallback": {"harness": "claude", "model": "claude-opus-5-5"}` keeps a job running when its own harness can't: e.g. an agy job on a Google plan that runs out of quota (`RESOURCE_EXHAUSTED`, 429) or finds Gemini busy (`503 UNAVAILABLE`, overloaded).

- **What falls back:** a step or the main session that ends with the harness's limit (status `limit`) or an error saying 429, 503, unavailable, overloaded, capacity or resource exhausted. A timeout or any other error is the job's own trouble and doesn't.
- **How:** that session reruns from the start on the fallback's harness and model, in the same scratch folder, and the rest of the run (later steps, the main session) starts there directly. A step's own `model` is for the job's harness, so on the fallback the fallback's `model` runs it.
- **The thread says so:** one line per session that moved, e.g. `↪️ Step "Capture" ran on claude (claude-opus-5-5): agy was unavailable (RESOURCE_EXHAUSTED …)`.
- **After the run:** replies and approved cards continue on the harness the main session ended on. With a [handoff](#handoff) to that same harness, approved cards simply resume that session.
- Only fresh sessions fall back: a reply that continues an agy conversation stays on agy. The fallback must be another harness than the job's own.

### Steps and MCP servers

For a long job that is better split, e.g. a UI test of five journeys where one long session would fill its context and a timeout would lose everything:

```json
{
  "mcpServers": {
    "browser": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@1.12.0", "--isolated", "--headless", "--workspace=${TARA_SCRATCH}"] }
  },
  "skills": ["ui-test"],
  "steps": [
    { "name": "Home and menu" },
    { "name": "Checkout", "timeoutMinutes": 40 }
  ]
}
```

with this in `.claude/skills/ui-test/SKILL.md`:

```markdown
## Job: `ui-test-weekly`

Check the findings in Step Output, post them and raise a card per fix.

### Every step

Use the shared browser; save screenshots in $TARA_SCRATCH.

### Step: Home and menu

Test the home page and the menu.

### Step: Checkout

Test the cart and checkout.
```

- **`mcpServers`**: added next to tara's own server in every session of the job (steps and main), on both harnesses. `${VAR}` in `command`, `args` and `env` is replaced from the run's environment (`TARA_SCRATCH`, `TARA_JOB_DATA`, the job's `env`). Under agy the tools are named `tara_<name>` (permission rule `mcp(tara_<name>/*)`).
- **`steps`**: each runs in a fresh session of the job's harness and model, before the main prompt. It is told to load the job's skill (or the step's own `skill`) and do only its `### Step: <name>` part (plus `### Every step`), then gets the folders note. Steps get the job's MCP servers but no Slack tools, and share the run's `$TARA_SCRATCH`, so files they save there can be sent by the main session. `timeoutMinutes`, `model` and `effort` default to the job's (same harness); agy steps can have their own `agyPermissions`. The status line shows `step i/n`.
- **Main prompt**: gets every step's reply under `## Step Output` (`### <name>`, marked `(timeout)` or `(error)` if it didn't finish; the next step still runs). Steps don't run again when the run continues after a decision. Their cost, tokens and tool calls count towards the run (the Jobs page and Trends include them).

### Self-improvement

After a job run or chat turn, tara-agent resumes the same session once and asks Claude to fix the instructions it followed: the skill's `SKILL.md` or another `.md` file it used. Never code, never a new skill. The same turn keeps the [project memory](#project-memory) (`.tara/memory.md`); a step's turn doesn't.

| `selfImprove` | When it runs |
|---|---|
| `"always"` (default; `true` also means this) | After **every** run that used a tool. A clean run gets a short look back ("what did you have to figure out?"); a run with trouble gets the list of what went wrong |
| `"trouble"` | Only after a run that failed, timed out or errored, or where 5+ tool calls errored and they were at least a quarter of its calls (a few errors are normal work: a `grep` that finds nothing) |
| `"off"` (or `false`) | Never |

- **Skills stay short.** The turn edits the instruction where it belongs (fix the step, replace the wrong line, put the trap in its step), never appends notes, writes timeless rules (no dates or who said it: git has that), moves detail only some runs need to `references/<topic>.md`, keeps `SKILL.md` under 25,000 characters (`SKILL_MAX_CHARS`) and leaves the front matter alone except the `description` (no version bumps). Only `name` and `description` in a skill's front matter mean anything to Claude Code. The Health page warns (quietly, no Slack) when a project has skills over the limit (`Skill size` under Jobs).
- **Shared skills.** A skill used by several projects (e.g. a humanizer) is vendored: the same folder in each project's `.agents/skills/`, with a `SHARED` file in it. Lines of `SHARED` that name a file of the skill (e.g. `voice-samples.md`) are that project's own. `tara-agent doctor` warns when the other files differ between projects, so a fix a learning turn made in one copy gets ported to the others.
- **Steps learn too.** Each Claude step's session gets its own turn under the same rule, told to change only its `### Step: <name>` part (or `### Every step`) and the scripts that step runs. Its note reads `🔧 <job> · step "<name>" learned from this run`.
- **It sees what the run used**: the session's cost at API prices, tokens, tool calls and minutes, the whole run's when there were steps (and a step's share of it), and the job's usual run: the median of the first run in each thread over the last 14 days, from 3 such runs. A run at 1.5× the usual or more is called out, and Claude is asked what made it expensive; otherwise it is asked for a cheaper path only when it sees one. Coverage and correctness always come first. Runs after a card or for queue items aren't compared.
- Usage-limit and stopped runs, agy runs, and replies that used no tool never get one.
- Claude replies `NONE` when nothing should change.
- A change is posted in the thread (`🔧 … learned from this run`).
- Cost: one extra short turn per session, on its cached prompt (a job with 3 steps gets up to 4). For jobs that run every few minutes, set `"selfImprove": "trouble"` on the job.

## Files

Each session gets its own folders, passed as environment variables and as absolute paths in its first message:

| Variable | What | Lifetime |
|---|---|---|
| `TARA_SCRATCH` | This session's scratch folder: helper scripts, downloads, temp files | Deleted `scratchDays` after its last use. An active chat thread keeps its folder |
| `TARA_THREAD` | This run's or chat's thread, `<channel>:<ts>` (a Slack thread, or a dashboard thread `web-<project>:<ts>`) | Pass it to your project server, which sends it as `thread` to `POST /items` or `POST /items/ask`: the card then lands in this thread, not only on the Approvals page |
| `TARA_JOB_DATA` | The job's data folder: what the job needs on its next run. Scripts the run starts get it too | Never deleted |

- A scratch folder is only made when Claude runs, so skipped runs leave nothing behind.
- Cleanup only deletes folders tara-agent made (they hold a `.tara-scratch` marker).
- Claude is told to keep temporary files out of the repo.

## Shared browsers

Jobs and chats use a project's Chrome (its `.mcp.json` `--browserUrl`) at the same time, with no locks. Each Claude run there gets a hook on that MCP server (`src/hooks/own-tabs.ts`, through `--settings`): page tools are refused until the run opens its own tab with `new_page`, and `select_page`/`close_page`, or a page tool given a `pageId`, work only on tabs it opened. A later turn of the same session (e.g. resumed after an approval card, with new page numbers) gets its tabs back by address: `list_pages`, then `select_page` or any page tool with the `pageId` of a page at an address it had (query and `#hash` ignored), so a sign-up can go on in its tab after a captcha or OTP card. Runs close their own tabs; tara closes stale ones (host `browsers`), but not a chat thread's tabs while that chat is still going. A page a person must finish, such as a form stopped at a captcha, is listed by the project's `keepTabsUrl` and never closed. Scripts that drive the same Chrome over CDP should follow the same rules: open their own tab, never reuse another, close only theirs.

## Approval tools

Every run gets tara-agent's own MCP server alongside the repo's `.mcp.json` servers:

| Tool | What it does |
|---|---|
| `request_approval` | Asks a person: a decision before acting, a suggestion, or something only a person can do (a login, an OTP). Posts buttons (default **Approve / Reject**, up to 5 options) and ends the turn. With `handoff` notes (the usual case), the decision is acted on by a fresh session in a new `Run` thread ([decisions in a new thread](#decisions-in-a-new-thread)); without them (an OTP, a login in an open browser), a tap resumes the session with the choice. Replying in the card's thread in words always goes to the run that raised it. Each card can only be decided once |
| `request_privileged` | Asks for an action that needs root, from an allowlist. `auto` actions run at once; others wait for approval. See [privileged actions](security.md#privileged-actions) |
| `send_file` | Uploads a file (screenshot, PDF, CSV, image) into the thread. Only files inside the project or temp directory, up to 100 MB |
| `permission` | In chat, when Claude wants a tool not in `allowedTools`, the thread gets **Allow / Deny** buttons (denied after 10 minutes). Scheduled jobs never wait on this |
| `propose_item`, `list_items`, `finish_item` | Drafts that go out later (a message, email, post): each becomes a card on the Approvals page and, once approved, runs through a [queue](#queues) |
| `withdraw_card` | Closes any waiting card of the run's project, no approval needed (the person did it themselves, it no longer applies, a duplicate, or a newer card replaces it). It ends as cancelled with the reason; another project's cards are refused |
| `set_reminder`, `list_reminders`, `cancel_reminder` | A reminder in the channel at a time (`at`, ISO with offset) or on a schedule (`cron`, host timezone). tara-agent posts it itself, no run: a `Run Reminder` thread mentioning the project `owner`, late ones marked late, a missed repeat posted once. `notify` also sends it to the project's `reminders.hookUrl`, only when the person asks |
| `schedule_task` | Do something later, once: at `at` (ISO with offset) tara-agent opens a fresh `Run <title>` thread, posts the `note` and starts a chat run on it as whoever set it (the project `owner` if a job did), then the task is gone. The note is all the run knows, so it must stand alone. Missed by more than host `catchUpHours`: skipped with a note instead. Listed by `list_reminders` (`task: true`), stopped by `cancel_reminder`. Runs and chats with tara's tools get a short prompt section on when to use it vs `set_reminder` |
| `list_jobs`, `run_job` | Chat turns only: lists the channel's jobs (id, next run, last status), or starts one now in its own `Run` thread |
| `start_pull_request`, `open_pull_request` | Only for host `github` projects: a workspace copy of the base branch (or of the PR's branch), then a commit pushed to `<agentName>/<name>` and the PR opened or updated. See [pull requests](security.md#pull-requests) |
| `read_ci_job` | Only for host `github` projects, read-only: a GitHub Actions job (URL or id) of the project's repo: workflow, branch, commit, conclusion, failed steps, the lines around the first `##[error]` and the last 300 log lines. Other repos are refused. See [CI jobs](security.md#ci-jobs) |

The tools reach tara-agent through the local API with a per-run token, so `http.enabled` must stay on.

### Where a decision is acted on: a new session or the same one

Every waiting card says where its decision will be acted on, the same on the Approvals page and in Slack: `Upon approval, a new session will be created · large context (140k tokens)` or `Upon approval, this will continue in the existing session · follow-up in a small session (30k tokens, 2 turns)`. The advice comes from the session that raised the card (`src/approvals/session-choice.ts`):

| The session | Advice |
|---|---|
| Context at or over 100k tokens (its last model call's input and cache tokens) | New session |
| 8 or more turns in its thread | New session |
| Idle for 3 days or more | New session |
| Otherwise (a follow-up while it is still small) | Continue it |
| No handoff notes (an OTP, a login in its open browser), or a root action | Continue only |
| No session to continue (never started, or no thread) | New only |

- **Override it** on the card: on the Approvals page pick *use a new session* / *continue the existing session* before an option; in Slack, the extra button (`Approve · new session` or `Approve · same session`) next to the options. Every Slack button carries its mode, so a tap does what the card said when it was shown.
- **The advice updates** after each run or turn in the card's thread (its context grew, more turns), and when the Approvals page finds it changed with time: the card's message and its Slack copy are edited, so both always offer the same default. The decision records the mode it used (`items.session_mode`).
- **Continuing** resumes the session that asked, in its own thread: a job's card resumes as the job (its slot, locks and timeout), a chat's card as the chat.

A card raised with `handoff` notes is a complete brief: the card says what is proposed, the notes say how to carry it out (every id, URL, file path, number and command), for a session that never saw the run. In a **new session**:

- **On a decision**, tara opens a new `Run <Job>` thread (a chat's card: `Run <Kind>`, e.g. `Run Decision`) and starts a **fresh session** there with the project memory, the card, its notes and the decision. A job's card runs as the job (its slot, locks, timeout, effort, and its [handoff](#handoff) harness when approved); a chat's card, or one whose job is gone, runs as a chat.
- **Both threads link to each other**: the old one gets `➡️ Your decision on "<title>" continues in a new thread`, the new one starts with `📝 <title> · earlier thread`.
- **If the notes leave something out**, the new session is told where the earlier thread and its session transcript are, to read only the part it needs. A job's new session keeps the earlier run's scratch folder, so screenshots and downloads are still at the paths in the notes.
- **A plain no** (Reject, Skip, … with no note) starts nothing: the card shows it, and later runs see it under recent decisions in the project memory. A no with a note starts a run that does what the note asks.
- **Cards without notes** always resume the session that asked. Runs leave the notes out only when the answer must reach that very session (an OTP, a login in a browser it has open). Privileged cards always resume.
- The Approvals page shows the notes folded under the card.

**Writing in a session on the dashboard shows in Slack too.** The session page's reply box posts your message in the session's Slack thread (or, for a dashboard run, under its Slack summary) as you, through `SLACK_USER_TOKEN` (`From @you on the dashboard: …`; over 500 characters it is cut, with the rest on the dashboard), and Jarvis answers there. Without a user token, or if Slack doesn't deliver it within 2 minutes, a bot line `💬 From the dashboard: …` shows it and Jarvis answers that. A session only the dashboard has stays there.

**A card has no chat of its own.** *Open session ↗* on a card opens the session behind it (`/t/<channel>/<ts>`), live while it runs, with a box to write to Jarvis. **Ask…** → **Send** on a card sends a note to that session without deciding (a card no run raised gets its `Run <Kind>` thread first) and then opens the session page, where the answer streams in.

### Project memory

`.tara/memory.md` in the project holds what runs need to know that no skill or file says: what was decided or done and when, the person's preferences, the state of work in progress. Commit it with the repo like the skills.

- **Written by learning turns** ([self-improvement](#self-improvement)) after each run of a main session: one short line per fact under a `## ` heading per topic, dated when it changes, replaced when it is no longer true, under about 150 lines.
- **Read by every fresh session** in its first prompt, as `## Project memory`: a job run, a run acting on a decision, a [handoff](#handoff) session, and the first message of a chat. Continued sessions already have it. Over 12,000 characters, the rest is left for the session to read.
- **Health warns** (quietly, row "Project memory") when the file is over 150 lines or 12,000 characters: the part past the limit never reaches a session. Move what it says into skills or docs where it belongs, drop facts no longer true, and keep an archive file next to it if old detail matters.
- **Recent decisions** come with it, straight from the store: what people chose on the project's cards in the last 14 days (up to 15, newest first, with their notes), without notices or auto-approvals. So a turned-down idea isn't raised again.

## Queues

Approved drafts are sent through queues declared in `<repo>/.tara/queues.json`:

```json
{ "queues": {
  "linkedin": { "executor": { "skill": "linkedin-sender" }, "batch": 5,
    "windows": { "EU": { "tz": "Europe/Berlin", "days": "tue-thu", "from": "10:00", "to": "12:00" } },
    "caps": { "perDay": 12, "perWeek": 40 }, "gapMinutes": 3 },
  "email":    { "executor": { "url": "http://127.0.0.1:4002/api/send" }, "caps": { "perDay": 10 } },
  "content":  { "executor": { "skill": "publisher" }, "slots": "30 18 * * 1,3,5", "alternate": ["image-post", "reel"] } } }
```

**When items run**

- One batch at a time per queue, oldest approval first. With `"reorder": true`, a person sets the order on the **Queue** page instead (drag a row, or **Top**, **↑**, **↓**, **Bottom** per item). Items approved after a move go to the end, unless they carry a `priority`: those go ahead of the first approved item ranked lower (or unranked). In a queue with `alternate`, an item moves among items of its own kind, because kinds take turns.
- `windows`: items run only while their window is open. `slots`: one batch per cron slot instead, rotating through the `alternate` kinds.
- `fills`: instead of windows or slots, the queue runs only in the slots of the named queue that it leaves empty (nothing of its own due), e.g. `"channel": { "executor": { "skill": "publisher" }, "fills": "content" }` posts only on `content` slots with no approved item waiting. The filled queue must have `slots`.
- `caps` (per day, per rolling week) and `gapMinutes` limit how fast items go out.
- "Approve & run now" skips windows and slots.

**Executors**

| Type | How it works |
|---|---|
| `{ "job": "<id>" }` | The job gets the items in its prompt under `## Approved items` and reports each with `finish_item`: `done`, `failed`, or `later` (with an optional `retryAt`) to put it back in the queue, as a URL executor's "later" does |
| `{ "url": "…" }` | One POST `{item}` per item. Answer `{status: "done" \| "failed", result}`, or `{status: "later", result, retryAt?}` to retry later |
| `{ "external": true }` | The project's own server runs approved items and reports with `POST /items/<id>/report` |

An item whose run started but never reported it (a restart mid-send, a run that ended without `finish_item`) ends **`uncertain`**, not failed: it may have gone out. It is never run again on its own; the Approvals page lists it first under **Did these go out?** (and Home shows it) with **It went out** (done), **It didn't: send again** (back in its queue) and **Drop it** (failed), so nothing goes out twice.

**Decisions**

- The first option (default **Approve**) queues the item. A negative option (Reject, Skip…) closes it as rejected; any other closes it as done.
- **Revise** keeps the card pending (it stays on the page, marked as being revised) and asks the agent for a new version, which replaces it in place.
- A project server's `ask` with the `key` of a waiting card updates that card in place (page and Slack message), so a project can keep one live card (e.g. one a day) and add to it.
- When an option is off because of a blocking check, the card says why next to the buttons and offers **Fix it…**. Several drafts of one kind show as one card with a row each.
- `slack: true` on a queue also posts each card in Slack (decisions stay on the dashboard): a card a run proposed goes in that run's thread; any other card stays on the Approvals page only (a revise opens a `Run <Queue>` thread for Jarvis). A refresh edits it, and its outcome follows in its thread.
- `approvals.validateUrl` gets POST `{kind, key, fields}` and returns `{checks: [{text, blocking}]}`; blocking checks stop approval.
- `approvals.hookUrl` gets POST `{event: "decided" | "finished", item}`, signed with HMAC-SHA256 of the body using `APPROVAL_SEAL_KEY` in the `x-tara-signature` header. Best effort only.

## Dashboard

Open the HTTP address in a browser. Every page also answers JSON to tools.

- **Home** (`/`): what's running, what needs attention (waiting approvals, failing or paused jobs), upcoming and recent runs. If a project has a `.tara/quotes.txt` (one line each; blank lines, `#` comments and a leading `- ` or `- [ ] ` are ignored), one line from all of them shows under the title, picked at random each time the page is opened or refreshed by hand (the 60 s auto-refresh keeps it). The file is read on every visit, so edits need no restart.
- **Approvals** (`/approvals`): cards waiting for a person, and decisions from the last 30 days. Deciding needs the browser unlocked once on `/unlock` with `TARA_ADMIN_TOKEN`, from a device other than the server.
- **Queue** (`/queue`): approved drafts waiting to run, in run order with the next slot or window. Each queue with `"reorder": true` has its own section (per kind with `alternate`), shown even when empty, with how many cards wait for approval. Drag a row (mouse or touch) or use **Top** / **↑** / **↓** / **Bottom** to choose what goes out first; **Cancel** drops one. Reordering needs the unlocked browser. Other queues are listed read-only under **Other queues**.
- **Jobs** (`/jobs`): every job, failing first, with schedule, recent results, **Run now**, **Pause** / **Resume**, and run history.
- **Jobs → Timeline** (`/schedule`): a day's timeline with each job's planned length, queue slots, overlaps and free windows.
- **Sessions** (`/sessions`, `/sessions/<id>`): every thread and job run, with full transcripts and tool calls.
- **Runs** (`/runs/<id>`): one run's status, reply and script output.
- **Code** (`/code`): uncommitted changes, diffs, file browser and search. See [code-view.md](code-view.md).
- **Browsers** (`/browsers`): each Chrome in host `browsers` (up or not, version, open tabs, which projects' chats and jobs use it), then per project **the logins its browser needs**, from its `.tara/logins.json`: service, account, how it signs in, and the jobs and chats that used its sites over the last 30 days (read from the transcripts' browser tool calls). Sites opened in two or more sessions that no login or `public` entry covers are listed under it, so a missing login shows up; every site opened is folded below. **Logins more than one project needs** lists the same service and account in several projects: each Chrome profile those projects get must be signed in to it. The first visit after a restart reads every recent transcript, so the lists may be short for a minute.

  ```json
  {
    "logins": [
      { "service": "Google", "account": "brand@example.com", "note": "authuser=1. YouTube Studio, Ads", "sites": ["studio.youtube.com", "ads.google.com"] },
      { "service": "Workday", "account": "me@example.dev", "sites": ["*.myworkdayjobs.com"] }
    ],
    "public": ["www.amazon.in"]
  }
  ```

  `sites` are hosts; `*.example.com` covers example.com and its subdomains. `public` lists hosts the runs open that need no login.

- **Health** (`/health`): is everything working? Every `health.intervalMinutes` tara-agent checks itself (Slack connection, Claude runs ending in errors, the usage limit, runs stuck past `stuckMinutes`, disk, memory and load, each Chrome), each project's jobs (a jobs file that didn't load, a failing streak, a scheduled slot that never started or never finished), and each project's own `healthUrl` (or whether its dashboard answers). **Needs you** lists what is red or amber; below it every source with its checks, then every change of state over the last 7 days. The sidebar badge and Home count red checks; `GET /attention` lists them as `health` items.

  **Trends** (`/health/trends?days=7|14|30`): against the same number of days before, runs and failure rate, typical job length, API-equivalent cost and how many checks were up; runs per day by result and cost per day by project; the Claude usage window per hour; a jobs table (runs, failures, typical and slowest-5% length, whether the last 3 days ran longer, cost; failing or slowing jobs first); uptime strips of every check that had trouble; the machine's load, memory and disk (sampled every 5 minutes); and, when tara-agent runs in a VM whose host reports (`POST /vmhost/metrics`), the host's CPU temperature, the VM's share of its CPU and its memory. Every bar and line has a hover tip and a **Table** view.

  **Logs** (`/health/logs?hours=1|24|168`): tara-agent's own warnings and errors (kept 31 days) and those of host `health.logUnits` from the journal, per hour, then grouped: the same message with other numbers, ids or times counts once, with how often and when it was last seen.

  **Claude login** (the runs' login on this machine, which ends about 30 days after `claude auth login`) is never a health alert. From 3 days before it ends, and every day after it ended or while logged out, a top-level message in `health.alertProject`'s channel (from 09:00, once a day) mentions the `owner` with the `ssh -t <host> sudo -u <run user> -i claude auth login` steps. It stops once the login is renewed. The Health page shows it amber in those 3 days and red once it ended.

  A check counts as red only after two red checks in a row. Then it is posted once in the day's `Run Health Alert` thread of its project's channel (one a day, opened by its first alert) (tara-agent's own checks: `health.alertProject`), mentioning the `owner`, and once more when it is fine again. A job's single failure isn't posted (its thread already has the ❌ reply), nor is a jobs file that didn't load (it is in the logs and on the dashboard). The state is kept in the database, so a restart repeats no alert.

Project dashboards can share the look: see [dashboard-look.md](dashboard-look.md).

## Local API

For scripts and dashboards on the same host (`127.0.0.1:4100` by default).

**Jobs and runs**

| Call | Does |
|---|---|
| `GET /health` | `build` (`source`: a hash of the code it was built from, `builtAt`), uptime, job counts and the Health page's `checks` counts (`ok`, `warn`, `bad`); `idle` (no CLI process, job or queue batch: safe to restart), `draining`, `liveRuns`; `limits` (CLIs at their usage limit, with when scheduled runs on them start again) |
| `POST /drain` | Before a restart: `{on: true}` (default) stops starting scheduled and queue runs (slots that come up are left for the restarted process) and lets running work finish; restart once `/health` says `idle`. `{on: false}` undoes it. Needs `x-tara-admin` |
| `GET /health/checks` | The latest checks: `checks` (`key`, `group`, `name`, `status`, `detail`, `since`, `outages`), `sources`, `counts`, `checkedAt` |
| `POST /health/check` | Check everything now; returns `counts` |
| `GET /metrics` | Prometheus text: health check status, runs, cost and tokens of the last 24 hours by project, kind and result, each job's last run, failure streak and pause state, running runs, the usage window, the machine. Behind the bearer token like the rest |
| `GET /attention` | What needs you, most pressing first: `items` (`tier` urgent / waiting / later, `kind`, `title`, `project`, `url`) and `notes` for sources that couldn't be read |
| `GET /glance` | One read for a desk panel: `needs` (urgent and waiting counts, top 3), `approvals` (per project, oldest first), `running` (with each run's latest step), `recent`, `next` (3 runs today), `usage`, `quiet` (`http.quietHours`). `/attention` is read again when the last read is over a minute old. Read by [`examples/macos-desk-widget`](../examples/macos-desk-widget) |
| `POST /vmhost/metrics` | The VM host's own figures, when tara-agent runs in a VM: `{name?, cpuTemp?, thermal?, cpu?, memUsed?, swapBytes?, pressure?, vmCpu?, vmMemBytes?, powerW?, idleSec?}` (shares 0–1, `thermal` nominal / fair / serious / critical, `pressure` normal / warn / critical, `idleSec` seconds since the host's keyboard or mouse was used). Sent every 5 min by [`examples/macos-desk-widget`](../examples/macos-desk-widget) `install.sh --metrics`; shown on the Health page (a **VM host** group: reports, heat, memory; and Trends charts). Kept `retentionDays` |
| `GET /vmhost/metrics?hours=1` | Its reports over the last hours (up to 366 days) |
| `GET /host/metrics?hours=1` | This machine's own samples (every 5 min: `load`, `memUsed`, `diskUsed`, `swapUsed` incl. zram), kept `retentionDays`, e.g. for capacity reports |
| `GET /jobs?project=<name>` | Jobs with next run, last status and error; `&upcoming=7` adds start times for the next 7 days |
| `POST /jobs/<project>/<id>/run` `{"by": "who"}` | Run a job now |
| `POST /jobs/<project>/<id>/pause` | Set `"enabled": false` in `jobs.json` and reload |
| `POST /jobs/<project>/<id>/resume` | Remove the `enabled` key and reload |
| `POST /jobs/<project>/<id>/duration` `{"minutes": 20}` | Set `durationMinutes` |
| `GET /jobs/<project>/<id>/runs?limit=15` | Run history |
| `GET /runs?limit=30` | Latest runs of every project |
| `GET /runs/<id>` | One run, with reply and script output |
| `POST /reload` | Re-read every `jobs.json` now |
| `GET /reminders?project=<name>` | Reminders still to come, soonest first |
| `POST /reminders/<project>` | Add one: `{text, cron? \| at?, notify?, by?}`; a scheduled task: `{text: <note>, at, task: true, title?, by?}` |
| `POST /reminders/<project>/<id>/cancel` | Stop one |
| `GET /schedule?day=YYYY-MM-DD&project=<name>` | One day's runs, overlaps and free windows |
| `GET /schedule/conflicts?days=7` | Overlapping and back-to-back jobs |

**Sessions**

| Call | Does |
|---|---|
| `GET /sessions?project=&limit=30` | Latest sessions with their last run |
| `GET /sessions/<id>/transcript` | A session's conversation as JSON |
| `POST /sessions/<id>/message` `{text}` | Continue a thread as the project owner. Needs header `x-tara-admin: <TARA_ADMIN_TOKEN>` |

**Approvals and queues**

| Call | Does |
|---|---|
| `GET /items?project=&status=&kind=` | Approval items |
| `GET /items/<id>` | One item, with its seal |
| `POST /items` `{project, kind, key?, title, body?, fields?, media?, checks?, queue, window?, runAfter?, priority?, thread?}` | Propose a draft. `thread` (a run's `TARA_THREAD`) posts it in that run's thread; without it, the day's `<queue> cards` thread. `priority` (a number, higher first) lists the kind's drafts on the Approvals page best first and, once approved, puts the item in its queue ahead of approved items ranked lower |
| `POST /items/ask` `{project, title, details?, options?, kind?, key?, thread?}` | Ask a person something (2 to 5 options): posted with its buttons in that run's thread when `thread` (a run's `TARA_THREAD`) is given, else in the day's `<kind>` thread, and the answer goes to Claude there. With `kind: "notice"` the first option only acknowledges it (no run) |
| `POST /items/<id>/withdraw` `{reason?}` | Take back a waiting card |
| `POST /items/<id>/report` `{status, result?}` | Report an `external` queue item: done, failed or waiting |
| `GET /queues?project=<p>&upcoming=<n>` | A project's queues with their next slots |
| `POST /items/<id>/decide`, `POST /items/bulk`, `POST /items/<id>/cancel`, `POST /items/<id>/move` `{to: up\|down\|top}` | Human only: needs the unlock cookie, from another device |

**Code**

| Call | Does |
|---|---|
| `GET /code`, `/code/<repo>`, `/code/<repo>/diff?path=`, `/file?path=`, `/files?path=` | Uncommitted changes, diffs, files, folders; `?q=` searches |
| `POST /code/<repo>/ask` `{path, question}` | Human only: start a Slack thread about a file |
