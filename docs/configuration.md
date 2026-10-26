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
| `concurrency` | `2` | Max chat sessions at once |
| `jobConcurrency` | `1` | Max scheduled jobs at once |
| `claude.bin` | `claude` | CLI path |
| `claude.chatTimeoutMinutes` | `20` | Time limit per chat turn |
| `claude.effort` | model's default | `--effort` for every run: `low`, `medium`, `high` or `xhigh` |
| `claude.runAs` | none | Run Claude and pre-run scripts as this OS user through sudo ([split users](security.md#split-users-approvals)) |
| `stateDir` | `~/.local/state/tara-agent` | SQLite database, and default home of scratch and job data folders |
| `scratchDays` | `3` | Days after its last use that a session's scratch folder is deleted (see [Files](#files)) |
| `streaming` | `true` | Stream replies as a live task card and text. Needs the Slack app's "Agents & AI Apps" feature and the `assistant:write` scope; without them, tara-agent falls back to one edited status message |
| `statusIntervalSeconds` | `5` | Min gap between status edits in the fallback mode |
| `catchUpHours` | `6` | After downtime, run a job's latest missed slot if it is at most this old (`0` = never) |
| `timezone` | host's | Default timezone for job schedules and times shown in Slack |
| `healthDigest` | on, `0 9 * * *` | Daily summary per project channel (`enabled`, `cron`): runs, problems, missed slots, peak usage. Silent when there is nothing to report |
| `privileged.command` | off | Root actions a run may ask for through the root-owned helper `deploy/tara-priv.mjs`, usually `["sudo", "-n", "/usr/local/sbin/tara-priv"]` ([privileged actions](security.md#privileged-actions)) |
| `http` | `127.0.0.1:4100` | Local API and dashboard (`enabled`, `bind`, `port`, `allowFrom`). Set `TARA_HTTP_TOKEN` to require a bearer token (open a page once with `?token=…` to sign a browser in). The MCP tools need it enabled |
| `http.allowFrom` | `127.0.0.0/8`, `::1/128` | CIDR ranges allowed to connect. Transcripts hold everything Claude saw, so keep this to a trusted network, e.g. add `100.64.0.0/10` and `fd7a:115c:a1e0::/48` for Tailscale |
| `http.fallback` | none | URL that receives every request tara-agent doesn't serve, passed through unchanged. Useful when taking over a port from another service |
| `code` | on, the projects | The Code page: `repos` (`path`, `gitDir`, `title`, `askIn`) and `exclude` globs never shown (default `.env*`, `*.pem`, `*.key`). See [code-view.md](code-view.md) |

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
| `dashboardUrl` | none | The project's own web dashboard, linked from the sidebar |
| `scratchDir` | `<stateDir>/scratch/<name>` | Parent of per-session scratch folders, relative to the repo. Keep it out of git |
| `jobDataDir` | `<stateDir>/job-data/<name>` | Parent of per-job data folders, relative to the repo |
| `selfImprove` | `true` | After a run with trouble, let Claude fix the skill it followed (see [Self-improvement](#self-improvement)) |
| `approvals.validateUrl` | none | Asked for extra checks on every proposed or edited draft (see [Queues](#queues)) |
| `approvals.hookUrl` | none | Told when a draft is decided or finished |
| `approvals.expireDays` | `7` | Pending drafts expire after this many days |

## Jobs

`<repo>/.tara/jobs.json`, reloaded within 30 seconds of a change:

```json
{
  "tz": "Asia/Kolkata",
  "env": { "DATA_DIR": "~/data" },
  "jobs": [
    {
      "id": "daily-sla-report",
      "name": "Daily SLA report",
      "cron": "45 10 * * *",
      "durationMinutes": 5,
      "prompt": "Check yesterday's late orders and summarise them.",
      "skills": ["order-sla-report"],
      "preScript": "scripts/sla-gate.py",
      "model": "haiku",
      "locks": ["chrome"]
    }
  ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `id`, `name`, `cron` | required | Slug, display name, cron expression (5 or 6 fields) |
| `tz` | file-level `tz`, else host `timezone` | Timezone of `cron` |
| `prompt` | required unless `agent: false` | What Claude should do |
| `skills` | `[]` | Skills Claude should read first |
| `preScript` | none | Runs first, from the repo root (`.py` → python3, `.sh` → bash) |
| `agent` | `true` | `false`: the script is the whole job; its output is posted as-is |
| `model` | `sonnet` | Model for this job |
| `locks` | `[]` | Named locks held during the run, e.g. `["chrome"]` so jobs don't share a browser |
| `timeoutMinutes` | `30` | Time limit for the script and for Claude, each |
| `catchUp` | `true` | Run the latest missed slot after downtime |
| `channel` | project channel | Where the job posts |
| `env` | `{}` | Extra environment for the script and Claude (`~/` expanded), merged over the file-level `env` |
| `durationMinutes` | none | Typical run time, shown on the Schedule page |
| `enabled` | `true` | `false` keeps the job listed but never scheduled |

### How a run goes

1. **Pre-script** (if any) runs first. Empty output, or a last line of `{"wakeAgent": false}`, ends the run quietly. Otherwise its output is added to the prompt under `## Script Output`.
2. **Claude** runs the prompt.
3. **The reply** goes to Slack: the part before a `---` line as a new channel message, the rest in its thread.
   - A reply of `[SILENT]` posts nothing.
   - A first line of `[CRON_FAILURE]` marks the run failed.
4. **Replying** in the job's thread continues its session, so a job can ask a question and act on your answer.

Other rules:

- **Every slot runs at most once**, even across restarts. A job added while tara-agent was down doesn't run for past slots.
- **Watching live:** scheduled runs show their current step in the channel message. A run you start with `run <job name>` streams in your message's thread; runs started from the API or dashboard stream to the project `owner`.
- These conventions match Hermes Agent's, so Hermes jobs run unchanged. To import them:
  ```sh
  tara-agent import-hermes --from ~/.hermes/cron/jobs.json --out <repo>/.tara/jobs.json \
    --env REPO_ROOT=~/Projects/my-repo
  ```

### Self-improvement

When a job run or chat turn had trouble (it failed, timed out, or 2+ tool calls errored), tara-agent resumes the same session once and asks Claude to fix the instructions it followed: the skill's `SKILL.md` or another `.md` file it used. Never code, never a new skill.

- Claude replies `NONE` when nothing should change.
- A change is posted in the thread (`🔧 … learned from this run`) and listed in the daily health digest.
- Clean runs cost nothing extra. Turn it off with `"selfImprove": false`.

## Files

Each session gets its own folders, passed as environment variables and as absolute paths in its first message:

| Variable | What | Lifetime |
|---|---|---|
| `TARA_SCRATCH` | This session's scratch folder: helper scripts, downloads, temp files | Deleted `scratchDays` after its last use. An active chat thread keeps its folder |
| `TARA_JOB_DATA` | The job's data folder: what the job needs on its next run. Pre-scripts get it too | Never deleted |

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
| `run_job` | Starts one of the project's jobs |

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

- One batch at a time per queue, oldest approval first.
- `windows`: items run only while their window is open. `slots`: one batch per cron slot instead, rotating through the `alternate` kinds.
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
- `slack: true` on a queue also posts each card in the project channel (decisions stay on the dashboard).
- `approvals.validateUrl` gets POST `{kind, key, fields}` and returns `{checks: [{text, blocking}]}`; blocking checks stop approval.
- `approvals.hookUrl` gets POST `{event: "decided" | "finished", item}`, signed with HMAC-SHA256 of the body using `APPROVAL_SEAL_KEY` in the `x-tara-signature` header. Best effort only.

## Dashboard

Open the HTTP address in a browser. Every page also answers JSON to tools.

- **Home** (`/`): what's running, what needs attention (waiting approvals, failing or paused jobs), upcoming and recent runs.
- **Approvals** (`/approvals`): cards waiting for a person, scheduled drafts, and decisions from the last 30 days. Deciding needs the browser unlocked once on `/unlock` with `TARA_ADMIN_TOKEN`, from a device other than the server.
- **Jobs** (`/jobs`): every job, failing first, with schedule, recent results, **Run now**, **Pause** / **Resume**, and run history.
- **Schedule** (`/schedule`): a day's timeline with each job's usual length, overlaps and free windows.
- **Sessions** (`/sessions`, `/sessions/<id>`): every thread and job run, with full transcripts and tool calls.
- **Runs** (`/runs/<id>`): one run's status, reply and script output.
- **Code** (`/code`): uncommitted changes, diffs, file browser and search. See [code-view.md](code-view.md).

Project dashboards can share the look: see [dashboard-look.md](dashboard-look.md).

## Local API

For scripts and dashboards on the same host (`127.0.0.1:4100` by default).

**Jobs and runs**

| Call | Does |
|---|---|
| `GET /health` | Uptime and job counts |
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
| `POST /items/ask` `{project, title, details?, options?, kind?, key?}` | Ask a person something outside any run; the answer goes to Claude in a thread |
| `POST /items/<id>/withdraw` `{reason?}` | Take back a waiting card |
| `POST /items/<id>/report` `{status, result?}` | Report an `external` queue item: done, failed or waiting |
| `GET /queues?project=<p>&upcoming=<n>` | A project's queues with their next slots |
| `POST /items/<id>/decide`, `POST /items/bulk`, `POST /items/<id>/cancel` | Human only: needs the unlock cookie, from another device |

**Code**

| Call | Does |
|---|---|
| `GET /code`, `/code/<repo>`, `/code/<repo>/diff?path=`, `/file?path=`, `/files?path=` | Uncommitted changes, diffs, files, folders; `?q=` searches |
| `POST /code/<repo>/ask` `{path, question}` | Human only: start a Slack thread about a file |
