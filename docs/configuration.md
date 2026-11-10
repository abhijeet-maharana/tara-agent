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
| `claude.effort` | model's default | `--effort` for every run: `low`, `medium`, `high` or `xhigh` |
| `claude.runAs` | none | Run Claude and pre-run scripts as this OS user through sudo ([split users](security.md#split-users-approvals)) |
| `agy.bin` | `agy` | Antigravity CLI path, for [agy jobs](#agy-jobs). Under `claude.runAs` the run user's install, e.g. `/home/tara/.local/bin/agy` |
| `stateDir` | `~/.local/state/tara-agent` | SQLite database, and default home of scratch and job data folders |
| `scratchDays` | `3` | Days after its last use that a session's scratch folder is deleted (see [Files](#files)) |
| `retentionDays` | `90` | Days of history kept in the state database (min 14). Runs, slot claims and sessions not used since are deleted daily; each job's latest run and all approval cards are kept |
| `streaming` | `true` | Stream replies as a live task card and text. Needs the Slack app's "Agents & AI Apps" feature and the `assistant:write` scope; without them, tara-agent falls back to one edited status message |
| `browsers` | `[{lock: chrome, cdpUrl: http://127.0.0.1:9222, closeTabs: true}]` | The shared Chromes jobs drive, one entry per Chrome instance (e.g. one per signed-in identity: its own `--user-data-dir` and `--remote-debugging-port`), each with its own `lock`. After every run of a job holding a browser's `lock` (scheduled, on demand, queue or continued after a decision; also when it fails or times out), the tabs the run opened or moved to another page in that browser are closed through its DevTools endpoint; one new-tab page stays if they were all the run's. Chat turns, jobs without the lock and the other browsers are left alone. Point the project's Chrome MCP server (`--browserUrl`) at the same `cdpUrl` |
| `voice` | unset | Speech-to-text for Slack voice notes that Slack didn't transcribe (it skips short clips and some languages): `url` (an OpenAI-compatible chat completions endpoint whose models take `input_audio`, e.g. Gemini) and `models` (tried in order). Key from `TARA_VOICE_API_KEY`. Unset = Slack's transcript only, and voice notes without one get a "please type it" reply |
| `statusIntervalSeconds` | `5` | Min gap between status edits in the fallback mode |
| `catchUpHours` | `6` | After downtime, run a job's latest missed slot if it is at most this old (`0` = never) |
| `timezone` | host's | Default timezone for job schedules and times shown in Slack |
| `healthDigest` | on, `0 9 * * *` | Daily summary per project channel (`enabled`, `cron`): runs, problems, missed slots, peak usage. Silent when there is nothing to report |
| `autoApprove` | none | Draft cards a project's own server may approve without a person: a list of `{project, kind, url}`. A card of that kind proposed over `POST /items` with `autoApprove: true` is approved as `auto` (sealed, then queued as usual) when `url` answers `{approve: true, reason}` to `POST {kind, key, fields}`. Only a key's first card and only one with no checks; anything else waits for a person. Host config only, so a run can't turn it on ([auto-approved cards](security.md#auto-approved-cards)) |
| `github` | none | Projects whose runs may open pull requests: a list of `{project, repo, base}` (`repo` is `owner/name`, `base` defaults to `main`). Token: `TARA_GITHUB_TOKEN` in tara-agent's env, never given to a run. Runs get `start_pull_request` (a fresh copy of `base`, or of the PR's branch, in a temp folder) and `open_pull_request` (commit, push to `<agentName>/<name>`, open or update the PR). No merges, no force pushes, no `.github/`, env or key files ([pull requests](security.md#pull-requests)). They also get `read_ci_job` (read-only: a job's failed steps and log excerpt; the token needs **Actions** read) ([CI jobs](security.md#ci-jobs)) |
| `privileged.command` | off | Root actions a run may ask for through the root-owned helper `deploy/tara-priv.mjs`, usually `["sudo", "-n", "/usr/local/sbin/tara-priv"]` ([privileged actions](security.md#privileged-actions)) |
| `http` | `127.0.0.1:4100` | Local API and dashboard (`enabled`, `bind`, `port`, `allowFrom`). Set `TARA_HTTP_TOKEN` to require a bearer token (open a page once with `?token=…` to sign a browser in). The MCP tools need it enabled |
| `http.allowFrom` | `127.0.0.0/8`, `::1/128` | CIDR ranges allowed to connect. Transcripts hold everything Claude saw, so keep this to a trusted network, e.g. add `100.64.0.0/10` and `fd7a:115c:a1e0::/48` for Tailscale |
| `http.fallback` | none | URL that receives every request tara-agent doesn't serve, passed through unchanged. Useful when taking over a port from another service |
| `http.tls` | off | Also serve HTTPS on `port` (default `4443`) with `cert` and `key` files, e.g. from `tailscale cert`. Browsers only allow the microphone ([Command](command.md)) over HTTPS. The certificate is re-read when its file changes, so renewing it needs no restart |
| `code` | on, the projects | The Code page: `repos` (`path`, `gitDir`, `title`, `askIn`) and `exclude` globs never shown (default `.env*`, `*.pem`, `*.key`). See [code-view.md](code-view.md) |
| `attention` | GitHub on, nothing urgent | What needs you (`GET /attention`, read out by [Command](command.md)): `github` (your open PRs and review requests through `gh`, logged in as the user tara-agent runs as) and `urgent` rules that let a failing job interrupt: `{consecutiveFailures: 3}` or `{job: "project/jobId"}` |
| `live` | off | The voice behind the Command page ([command.md](command.md)): `url` (default Google's Gemini Live endpoint), `model` (`gemini-3.8-live`), `voice` (`Kore`), `language` (how to speak, in plain words, e.g. "Indian English; Hindi when I speak Hindi"), `idleSeconds` (`20`), `askModel` (`haiku`), `askTimeoutSeconds` (`120`), `urgentGapMinutes` (`30`: at most one spoken urgent alert per this long), `alwaysInterrupt` (`project/jobId` jobs said even in focus mode), `alertLang` (browser voice for alerts, e.g. `en-IN`). Key from `TARA_LIVE_API_KEY` (Google AI Studio) |

## Project config

| Key | Default | Meaning |
|---|---|---|
| `name` | required | Short id (`a-z0-9-`) |
| `slackChannel` | required | Channel ID (`C…` / `G…`) |
| `title` | `name` | Display name on the dashboard |
| `permissionMode` | `default` | `default`, `acceptEdits`, `plan` or `bypassPermissions` |
| `allowedTools` | `[]` | Tools allowed without asking, in `--allowedTools` syntax |
| `allowedUsers` | `[]` (everyone in the channel) | Slack user IDs allowed to talk to the bot |
| `chatModel` | `sonnet` | Model for new threads |
| `systemPromptFile` | none | Extra instructions added to every session |
| `owner` | none | Slack user ID that receives live progress of jobs started from the API or dashboard |
| `billing` | `subscription` | `api` runs the CLI with `ANTHROPIC_API_KEY` |
| `dashboardUrl` | none | The project's own web dashboard. Without `tabs`: linked from the sidebar. With `tabs`: the app's origin as tara-agent reaches it (`http://127.0.0.1:4001`) |
| `tabs` | none | `[{path, label, icon?}]`: pages of that app shown in tara-agent's sidebar at `/p/<name><path>`, proxied from `/app/<name>/` (see [dashboard-look.md](dashboard-look.md#project-tabs)) |
| `scratchDir` | `<stateDir>/scratch/<name>` | Parent of per-session scratch folders, relative to the repo. Keep it out of git |
| `jobDataDir` | `<stateDir>/job-data/<name>` | Parent of per-job data folders, relative to the repo |
| `selfImprove` | `"always"` | After every run (`always`), only runs with trouble (`trouble`), or never (`off`), let Claude fix the skill it followed (see [Self-improvement](#self-improvement)) |
| `approvals.validateUrl` | none | Asked for extra checks on every proposed or edited draft (see [Queues](#queues)) |
| `approvals.hookUrl` | none | Told when a draft is decided or finished |
| `approvals.expireDays` | `7` | Pending drafts expire after this many days |

## Jobs

`<repo>/.tara/jobs.json`, reloaded within 30 seconds of a change:

```json
{
  "tz": "Asia/Kolkata",
  "env": { "DATA_DIR": "~/data" },
  "defaults": { "model": "opus", "locks": ["chrome"], "timeoutMinutes": 40 },
  "jobs": [
    {
      "id": "daily-sla-report",
      "name": "Daily SLA report",
      "cron": "45 10 * * *",
      "durationMinutes": 5,
      "skills": ["order-sla-report"],
      "model": "haiku"
    }
  ]
}
```

**`defaults`** (optional) sets `harness`, `model`, `locks` or `timeoutMinutes` for every job in the file, so a value most jobs share is written once. A job's own value wins, including an empty one (`"locks": []` for a job that doesn't drive the browser). Other keys are refused. The defaults in the table below apply when neither the job nor `defaults` sets the key.

| Key | Default | Meaning |
|---|---|---|
| `id`, `name` | required | Slug, display name |
| `cron` | none | Cron expression (5 or 6 fields). Leave it out for a job a queue runs (its `executor`) or an **on-demand** job, listed on the Jobs page's **On demand** tab and started only with **Run now** there, `POST /jobs/<project>/<id>/run`, or by asking in chat (`run_job`) |
| `tz` | file-level `tz`, else host `timezone` | Timezone of `cron` |
| `skills` | required | Skills Claude loads first. The **first** one holds the job's instructions and the scripts it runs ([job instructions](#job-instructions)) |
| `harness` | `claude` | The CLI the job runs on: `claude`, or `agy` ([agy jobs](#agy-jobs)) |
| `model` | `sonnet` | Model for this job (for `agy`, an id from `agy models`, e.g. `gemini-3.8-flash-high`) |
| `agyPermissions` | none | `agy` jobs only: `{allow, deny, ask}` rules ([agy jobs](#agy-jobs)) |
| `handoff` | none | `{harness, model}`: an approved card continues in a fresh session on this harness ([handoff](#handoff)) |
| `mcpServers` | none | The job's own stdio MCP servers by name (`{command, args, env}`), for every session of the job ([steps and MCP servers](#steps-and-mcp-servers)) |
| `steps` | `[]` | Sessions run one after the other before the main prompt ([steps and MCP servers](#steps-and-mcp-servers)) |
| `locks` | `[]` | Named locks held during the run, e.g. `["chrome"]` so jobs don't share a browser (a browser's `lock` from host `browsers`) |
| `timeoutMinutes` | `30` | Time limit for the run, and for any one command it runs (Claude's Bash timeout is set to it) |
| `catchUp` | `true` | Run the latest missed slot after downtime |
| `selfImprove` | project's | Overrides the project's `selfImprove` for this job, e.g. `"trouble"` for a monitor that runs every few minutes |
| `channel` | project channel | Where the job posts |
| `env` | `{}` | Extra environment for Claude and the scripts it runs (`~/` expanded), merged over the file-level `env` |
| `durationMinutes` | none | Typical run time: the Jobs Timeline plans with it (change it on the job's card in Jobs → List) |
| `enabled` | `true` | `false` keeps the job listed but never scheduled |

### Job instructions

What a job does lives in its **first skill**, in a section named after the job, not in `jobs.json`:

```markdown
## Job: `daily-sla-report`

### Before you start

Run `python3 scripts/sla-gate.py` from the repo root. If it prints nothing, or its last line is
`{"wakeAgent": false}`, reply with exactly `[SILENT]` and stop. Otherwise its output is your input.

Check yesterday's late orders in that output and summarise them. On STATUS: FAILED, …
```

- The run is told: *do what the "## Job: `<id>`" section of the `<skill>` skill says, with the rest of that skill.* The skill's other sections are the reusable how-to; this one is the job's wiring (which scripts to run first, what to do with their output, where to report).
- **Scripts:** Claude runs them itself, as the skill says, any number and in any order. Each Bash call may take up to the job's `timeoutMinutes`. A job that is only a script has a skill that runs it and replies with what it printed. Scripts worth keeping go in the skill's `scripts/` folder; runs and learning turns may add or fix them there (and in `.tara/scripts/`), with `SKILL.md` saying when and how to run them. A script that must run without the model (a monitor every few minutes) belongs in the host's crontab, posting through `POST /items/ask` (`kind: "notice"`).
- A job with several skills gets a skill of its own (named after the job, listed first) that holds the section and names the others.
- Steps: `### Step: <name>` parts inside the section, plus an optional `### Every step` part.
- Learning turns improve this section along with the rest of the skill.
- **Older jobs files** with `prompt`, `preScript`, `agent` (or a step's `prompt` / `promptFile`) are refused. Move them with `tara-agent move-prompts <repo>` (prints the plan) and `--write`: a one-skill job's prompt goes into that skill (version bumped), any other job's into a new skill named after it; `preScript` becomes the section's `### Before you start` part (a script-only job gets a skill that runs it and posts its output); a restated schedule ("Every Monday at 9 AM IST, …") is dropped, since `cron` has it. `import-hermes` does the same for Hermes prompts and scripts.

### How a run goes

**A project channel holds only `Run <name>` messages.** Every run starts with one at the top level, and everything else (status, the answer, cards, notes, learning notes) goes in its thread. `Run` messages are never edited. Things that aren't job runs follow the same rule: the daily digest is a `Run health-digest` thread, an invalid jobs file a `Run jobs-reload` thread, a Code-page question a `Run code-question` thread. Cards a project server raises (drafts, `POST /items/ask` questions) go in one `Run <queue>` (or `Run <kind>`) thread per day, opened by the first such card that day: the card, its outcome, a revise and the run that sends it all follow there.

1. **Trigger message.** At cron time a `Run <job name>` message is posted (the job's `name`, e.g. `Run Weekly GA4 Audit`; its `id` only if another job has the same name) in the project channel, as the `SLACK_USER_TOKEN` person if set (else, or when that person isn't in the channel, as the bot). The bot picks it up and runs the job in its thread; if Slack doesn't deliver it within 2 minutes, the scheduler starts it there itself.
2. **Claude** runs the job's skill section (its scripts first, as the section says), streaming into the thread.
3. **The reply**: the part before a `---` line is the headline on the status line (the thread's first reply), the rest goes in the thread.
   - A reply of `[SILENT]` shows "🔇 nothing to report"; the thread and session stay, so you can ask why.
   - A first line of `[CRON_FAILURE]` marks the run failed.
4. **Replying** in the job's thread continues its session, so a job can ask a question and act on your answer.

Other rules:

- **Every slot runs at most once**, even across restarts. A job added while tara-agent was down doesn't run for past slots.
- **Watching live:** every run streams its steps and text into its Slack thread (the status line, its first reply, keeps the current step and, at the end, the headline). A run you start with `run <job name>` streams in your message's thread; scheduled, queue and dashboard/API runs stream in their `Run <job name>` thread, addressed to the project `owner` (Slack's streaming needs a recipient; without `owner` they post only the status line and the details at the end). A script-only job (`agent: false`) posts its result line and the script's output in its thread. A run with no thread of its own (a queue, Run now) opens its `Run <job name>` thread. A run that ends `[SILENT]` keeps its thread, with the steps it took, its session and a `🔇 … · nothing to report` status line.
- These conventions match Hermes Agent's, so Hermes jobs run unchanged. To import them:
  ```sh
  tara-agent import-hermes --from ~/.hermes/cron/jobs.json --out <repo>/.tara/jobs.json \
    --env REPO_ROOT=~/Projects/my-repo
  ```

### agy jobs

A job with `"harness": "agy"` runs on Google's Antigravity CLI (`agy`) instead of Claude Code, e.g. to use an idle Google AI Pro plan. Everything else works the same: the skill section, `[SILENT]`/`[CRON_FAILURE]`, Slack thread, tara's tools (`request_approval`, `send_file`, …), and a decision on its card or a reply in its thread continues the same agy conversation.

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
- **`steps`**: each runs in a fresh session of the job's harness and model, before the main prompt. It is told to load the job's skill (or the step's own `skill`) and do only its `### Step: <name>` part (plus `### Every step`), then gets the folders note. Steps get the job's MCP servers but no Slack tools, and share the run's `$TARA_SCRATCH`, so files they save there can be sent by the main session. `timeoutMinutes` and `model` default to the job's (same harness); agy steps can have their own `agyPermissions`. The status line shows `step i/n`.
- **Main prompt**: gets every step's reply under `## Step Output` (`### <name>`, marked `(timeout)` or `(error)` if it didn't finish; the next step still runs). Steps don't run again when the run continues after a decision. Their tokens and tool calls count towards the run.

### Self-improvement

After a job run or chat turn, tara-agent resumes the same session once and asks Claude to fix the instructions it followed: the skill's `SKILL.md` or another `.md` file it used. Never code, never a new skill.

| `selfImprove` | When it runs |
|---|---|
| `"always"` (default; `true` also means this) | After **every** run that used a tool. A clean run gets a short look back ("what did you have to figure out?"); a run with trouble gets the list of what went wrong |
| `"trouble"` | Only after a run that failed, timed out, errored, or had 2+ tool calls error |
| `"off"` (or `false`) | Never |

- Usage-limit and stopped runs, agy runs, and replies that used no tool never get one.
- Claude replies `NONE` when nothing should change.
- A change is posted in the thread (`🔧 … learned from this run`) and listed in the daily health digest.
- Cost: one extra short turn per run, on the run's cached prompt. For jobs that run every few minutes, set `"selfImprove": "trouble"` on the job.

## Files

Each session gets its own folders, passed as environment variables and as absolute paths in its first message:

| Variable | What | Lifetime |
|---|---|---|
| `TARA_SCRATCH` | This session's scratch folder: helper scripts, downloads, temp files | Deleted `scratchDays` after its last use. An active chat thread keeps its folder |
| `TARA_JOB_DATA` | The job's data folder: what the job needs on its next run. Scripts the run starts get it too | Never deleted |

- A scratch folder is only made when Claude runs, so skipped runs leave nothing behind.
- Cleanup only deletes folders tara-agent made (they hold a `.tara-scratch` marker).
- Claude is told to keep temporary files out of the repo.

## Approval tools

Every run gets tara-agent's own MCP server alongside the repo's `.mcp.json` servers:

| Tool | What it does |
|---|---|
| `request_approval` | Asks a person: a decision before acting, a suggestion, or something only a person can do (a login, an OTP). Posts buttons (default **Approve / Reject**, up to 5 options) and ends the turn. A tap resumes the session with the choice; replying in words works too. Each card can only be decided once |
| `request_privileged` | Asks for an action that needs root, from an allowlist. `auto` actions run at once; others wait for approval. See [privileged actions](security.md#privileged-actions) |
| `send_file` | Uploads a file (screenshot, PDF, CSV, image) into the thread. Only files inside the project or temp directory, up to 100 MB |
| `permission` | In chat, when Claude wants a tool not in `allowedTools`, the thread gets **Allow / Deny** buttons (denied after 10 minutes). Scheduled jobs never wait on this |
| `propose_item`, `list_items`, `finish_item` | Drafts that go out later (a message, email, post): each becomes a card on the Approvals page and, once approved, runs through a [queue](#queues) |
| `withdraw_card` | Closes a waiting card raised in the same thread (the person did it themselves, or it no longer applies). It ends as cancelled with the reason; cards of other threads are refused |
| `run_job` | Starts one of the project's jobs |
| `start_pull_request`, `open_pull_request` | Only for host `github` projects: a workspace copy of the base branch (or of the PR's branch), then a commit pushed to `<agentName>/<name>` and the PR opened or updated. See [pull requests](security.md#pull-requests) |
| `read_ci_job` | Only for host `github` projects, read-only: a GitHub Actions job (URL or id) of the project's repo: workflow, branch, commit, conclusion, failed steps, the lines around the first `##[error]` and the last 300 log lines. Other repos are refused. See [CI jobs](security.md#ci-jobs) |

The tools reach tara-agent through the local API with a per-run token, so `http.enabled` must stay on.

## Queues

Approved drafts are sent through queues declared in `<repo>/.tara/queues.json`:

```json
{ "queues": {
  "linkedin": { "executor": { "job": "linkedin-sender" }, "batch": 5,
    "windows": { "EU": { "tz": "Europe/Berlin", "days": "tue-thu", "from": "10:00", "to": "12:00" } },
    "caps": { "perDay": 12, "perWeek": 40 }, "gapMinutes": 3 },
  "email":    { "executor": { "url": "http://127.0.0.1:4002/api/send" }, "caps": { "perDay": 10 } },
  "content":  { "executor": { "job": "publisher" }, "slots": "30 18 * * 1,3,5", "alternate": ["image-post", "reel"] } } }
```

**When items run**

- One batch at a time per queue, oldest approval first. With `"reorder": true`, a person sets the order on the **Queue** page instead (drag a row, or **Top**, **↑**, **↓**, **Bottom** per item). Items approved after a move go to the end. In a queue with `alternate`, an item moves among items of its own kind, because kinds take turns.
- `windows`: items run only while their window is open. `slots`: one batch per cron slot instead, rotating through the `alternate` kinds.
- `fills`: instead of windows or slots, the queue runs only in the slots of the named queue that it leaves empty (nothing of its own due), e.g. `"channel": { "executor": { "job": "publisher" }, "fills": "content" }` posts only on `content` slots with no approved item waiting. The filled queue must have `slots`.
- `caps` (per day, per rolling week) and `gapMinutes` limit how fast items go out.
- "Approve & run now" skips windows and slots.

**Executors**

| Type | How it works |
|---|---|
| `{ "job": "<id>" }` | The job gets the items in its prompt under `## Approved items` and reports each with `finish_item` |
| `{ "url": "…" }` | One POST `{item}` per item. Answer `{status: "done" \| "failed", result}`, or `{status: "later", result, retryAt?}` to retry later |
| `{ "external": true }` | The project's own server runs approved items and reports with `POST /items/<id>/report` |

An item that is never reported ends as failed and is not retried, so nothing goes out twice.

**Decisions**

- The first option (default **Approve**) queues the item. A negative option (Reject, Skip…) closes it as rejected; any other closes it as done.
- **Revise** keeps the card pending and asks the agent for a new version.
- `slack: true` on a queue also posts each card in Slack (decisions stay on the dashboard): a card a run proposed goes in that run's thread; any other card goes in the day's `Run <queue>` thread (one per queue a day). A refresh edits it there, and its outcome and the run that sends it follow in that thread.
- `approvals.validateUrl` gets POST `{kind, key, fields}` and returns `{checks: [{text, blocking}]}`; blocking checks stop approval.
- `approvals.hookUrl` gets POST `{event: "decided" | "finished", item}`, signed with HMAC-SHA256 of the body using `APPROVAL_SEAL_KEY` in the `x-tara-signature` header. Best effort only.

## Dashboard

Open the HTTP address in a browser. Every page also answers JSON to tools.

- **Home** (`/`): what's running, what needs attention (waiting approvals, failing or paused jobs), upcoming and recent runs.
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

Project dashboards can share the look: see [dashboard-look.md](dashboard-look.md).

## Local API

For scripts and dashboards on the same host (`127.0.0.1:4100` by default).

**Jobs and runs**

| Call | Does |
|---|---|
| `GET /health` | Uptime and job counts |
| `GET /attention` | What needs you, most pressing first: `items` (`tier` urgent / waiting / later, `kind`, `title`, `project`, `url`) and `notes` for sources that couldn't be read |
| `GET /jobs?project=<name>` | Jobs with next run, last status and error; `&upcoming=7` adds start times for the next 7 days |
| `POST /jobs/<project>/<id>/run` `{"by": "who"}` | Run a job now |
| `POST /jobs/<project>/<id>/pause` | Set `"enabled": false` in `jobs.json` and reload |
| `POST /jobs/<project>/<id>/resume` | Remove the `enabled` key and reload |
| `POST /jobs/<project>/<id>/duration` `{"minutes": 20}` | Set `durationMinutes` |
| `GET /jobs/<project>/<id>/runs?limit=15` | Run history |
| `GET /runs?limit=30` | Latest runs of every project |
| `GET /runs/<id>` | One run, with reply and script output |
| `POST /reload` | Re-read every `jobs.json` now |
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
| `POST /items` `{project, kind, key?, title, body?, fields?, media?, checks?, queue, window?, runAfter?}` | Propose a draft |
| `POST /items/ask` `{project, title, details?, options?, kind?, key?}` | Ask a person something outside any run: posted with its buttons in the day's `Run <kind>` thread, and the answer goes to Claude there. With `kind: "notice"` the first option only acknowledges it (no run) |
| `POST /items/<id>/withdraw` `{reason?}` | Take back a waiting card |
| `POST /items/<id>/report` `{status, result?}` | Report an `external` queue item: done, failed or waiting |
| `GET /queues?project=<p>&upcoming=<n>` | A project's queues with their next slots |
| `POST /items/<id>/decide`, `POST /items/bulk`, `POST /items/<id>/cancel`, `POST /items/<id>/move` `{to: up\|down\|top}` | Human only: needs the unlock cookie, from another device |

**Code**

| Call | Does |
|---|---|
| `GET /code`, `/code/<repo>`, `/code/<repo>/diff?path=`, `/file?path=`, `/files?path=` | Uncommitted changes, diffs, files, folders; `?q=` searches |
| `POST /code/<repo>/ask` `{path, question}` | Human only: start a Slack thread about a file |
