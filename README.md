# tara-agent

Self-hosted gateway that turns **Slack threads** and **cron schedules** into real **Claude Code** sessions on your own machine, across as many project repos as you like.

> **Status:** early development, running in production for one small business. Slack threads, scheduled jobs, approval buttons and Slack permission prompts work. See [docs/plan.md](docs/plan.md).

## Why

Many agent frameworks let you plug in a Claude subscription by calling the API with its OAuth token while pretending to be Claude Code: a spoofed user-agent, a spoofed system prompt, renamed tools. That can get an account, or a whole Team org, banned.

tara-agent never talks to Anthropic itself. It starts the official `claude` CLI in headless mode (`claude -p`), the same as you would in a terminal:

- **Your login stays inside Claude Code.** tara-agent never reads, copies or forwards credentials.
- **No spoofing, no account pools.**
- **Your project setup is used as-is:** skills, `CLAUDE.md`, MCP servers and plugins.
- **API-key billing is opt-in** per project, for overflow or for shared use.

You are still responsible for following your plan's terms, especially for unattended use and for letting other people use a bot that runs on your seat.

## How it works

```
Slack thread ──► tara-agent ──► claude -p --resume <session>   (cwd = the project repo)
   ▲                 │
   └── live status, final answer, reactions
```

- Each Slack channel maps to one project repo.
- A new message starts a Claude Code session, and replies in its thread resume it. Sessions survive restarts.
- While Claude works, one status message updates with the current step. The answer is posted when the turn ends.

## Quick start

Requirements: Node ≥ 22.13, Claude Code installed and logged in (`claude` then `/login`) as the user that runs tara-agent.

1. **Slack app:** create it from [`deploy/slack-app-manifest.yaml`](deploy/slack-app-manifest.yaml), then invite the bot to your project channels.
2. **Install:**
   ```sh
   git clone https://github.com/<you>/tara-agent && cd tara-agent
   npm ci && npm run build
   ```
3. **Host config:** copy [`examples/config.yaml`](examples/config.yaml) to `~/.config/tara-agent/config.yaml` and list your project paths.
4. **Secrets:** put `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `~/.config/tara-agent/env` (see [`.env.example`](.env.example)).
5. **Each project:** add `.tara/config.json` (see [`examples/project`](examples/project/.tara)).
6. **Run it:** `node dist/index.js`, or as a service with [`deploy/systemd/tara-agent.service`](deploy/systemd/tara-agent.service).

## Run on a server

1. Get the code onto the server (`git clone`, or a file sync such as Mutagen that skips `node_modules` and `dist`), then `npm ci && npm run build` there.
2. Log in to Claude Code as the service user: run `claude`, then `/login`.
3. Write `~/.config/tara-agent/config.yaml` and `~/.config/tara-agent/env` (mode 600). If `claude` isn't on the service's PATH, set `claude.bin` to its full path.
4. Install the unit:
   ```sh
   cp deploy/systemd/tara-agent.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now tara-agent
   loginctl enable-linger "$USER"
   journalctl --user -u tara-agent -f
   ```
5. Projects that use MCP servers from their `.mcp.json` must have them approved for headless runs. Put `"enableAllProjectMcpServers": true` (or `enabledMcpjsonServers`) in that repo's `.claude/settings.local.json`, then check with `claude mcp list` from the repo.

### Run as a dedicated user (recommended)

Scheduled jobs often read untrusted text (web pages, chat channels, email), and a job that gets talked into something runs with the rights of the user tara-agent runs as. On an always-on machine, give it its own user:

1. `sudo useradd --create-home --user-group tara` (no sudo, no docker group), then install Claude Code and log in as that user: `sudo -iu tara`, install, `claude`, `/login`.
2. Give it the project repos and nothing else. The setup that works well: a shared group with ACLs on the repo directories (`setfacl -m g:tara:rwx,d:g:tara:rwx` on every directory, default ACLs included), so files either side creates stay writable for both. If you sync code with Mutagen, create the session with `--default-group-beta=tara`; synced files are staged elsewhere and don't inherit ACLs.
3. Keep secrets out: remove the group's access to `.env` files and session/key files in the repos, and keep your home directory closed (`setfacl -m u:tara:--x ~` lets it pass through to the repos only).
4. Put the Slack tokens in a root-only `/etc/tara-agent.env` and install [`deploy/systemd/tara-agent-dedicated-user.service`](deploy/systemd/tara-agent-dedicated-user.service) as a system unit.

The agent then can't use your sudo, docker group, browser profile files, other projects or secrets, and can't edit tara-agent itself.

**Moving from another bot on the same Slack app:** with Socket Mode, Slack splits events across every connection of one app. Stop the old bot before starting tara-agent with the same tokens.

## Configuration

**Host** (`~/.config/tara-agent/config.yaml`, never committed)

| Key | Default | Meaning |
|---|---|---|
| `projects` | required | Paths of project repos |
| `concurrency` | `2` | Max Claude sessions at once |
| `claude.bin` | `claude` | CLI path |
| `claude.chatTimeoutMinutes` | `20` | Per-turn time limit |
| `stateDir` | `~/.local/state/tara-agent` | SQLite state (sessions, run history) |
| `statusIntervalSeconds` | `5` | Min gap between status-message edits |
| `jobConcurrency` | `1` | Max scheduled jobs at once (chat has its own limit) |
| `catchUpHours` | `6` | After downtime, run a job's latest missed slot if it is at most this old (`0` = never) |
| `timezone` | host's | Default timezone for job schedules and times shown in Slack |
| `http` | `127.0.0.1:4100` | Local control API (`enabled`, `bind`, `port`); set `TARA_HTTP_TOKEN` to require a bearer token |

**Project** (`<repo>/.tara/config.json`, committed in that repo)

| Key | Default | Meaning |
|---|---|---|
| `name` | required | Short id (`a-z0-9-`) |
| `slackChannel` | required | Channel ID (`C…`/`G…`) |
| `permissionMode` | `default` | `default`, `acceptEdits`, `plan` or `bypassPermissions` |
| `allowedTools` | `[]` | Tools allowed without asking, in `--allowedTools` syntax |
| `chatModel` | `sonnet` | Model for new threads |
| `systemPromptFile` | none | Extra instructions appended to every session |
| `allowedUsers` | `[]` (everyone in the channel) | Slack user IDs allowed to talk to the bot |
| `billing` | `subscription` | `api` runs the CLI with `ANTHROPIC_API_KEY` |

## Scheduled jobs

Each repo can declare jobs in `.tara/jobs.json` (reloaded within 30 s of a change):

```json
{
  "env": { "DATA_DIR": "~/data" },
  "jobs": [
    {
      "id": "daily-sla-report",
      "name": "Daily SLA report",
      "cron": "15 5 * * *",
      "tz": "UTC",
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
| `id`, `name`, `cron` | required | Slug for `!run`, display name, cron expression (5 or 6 fields) |
| `tz` | host `timezone` | Timezone of `cron` |
| `prompt` | required unless `agent: false` | What Claude should do |
| `skills` | `[]` | Skills named in the prompt so Claude reads them first |
| `preScript` | none | Runs first, from the repo root (`.py` → python3, `.sh` → bash) |
| `agent` | `true` | `false`: the script is the job; its stdout is posted as-is |
| `model` | `sonnet` | Model for this job |
| `locks` | `[]` | Named locks held for the run, e.g. `["chrome"]` |
| `timeoutMinutes` | `30` | Per-run limit (script and model each) |
| `catchUp` | `true` | Run the latest missed slot after downtime |
| `channel` | project channel | Where the job posts |
| `env` | `{}` | Extra environment for the script and the CLI (`~/` expanded); merged over the file-level `env` |
| `enabled` | `true` | `false` keeps the job listed but never scheduled |

**How a run goes.** The pre-script runs first. Empty output, or a last line of `{"wakeAgent": false}`, ends the run silently. Otherwise its output (or its error) is put in front of the prompt as a `## Script Output` block. Claude's reply goes to Slack: the headline (before a `---` line) as a new message in the channel, the details in its thread. A reply of `[SILENT]` posts nothing, and a first line of `[CRON_FAILURE]` marks the run failed. Replying in a job's thread continues that session, so a job can ask for approval and act on your answer. These conventions match Hermes Agent's, so Hermes jobs run unchanged.

**Every slot runs at most once**, even across restarts (claimed in SQLite). A job added while tara-agent was down never runs for its past slots.

**Moving from Hermes Agent:**
```sh
tara-agent import-hermes --from ~/.hermes/cron/jobs.json --out <repo>/.tara/jobs.json \
  --env REPO_ROOT=~/Projects/my-repo   # map container paths your scripts expect
```
Hermes' cron default model becomes `--default-model` (`haiku`), browser-capable jobs get the `chrome` lock, and schedules stay in UTC.

## Approvals, permission prompts and files

Every run gets tara's own MCP server (next to the repo's `.mcp.json` servers) with these tools:

| Tool | What happens |
|---|---|
| `request_approval` | Claude posts the proposal with buttons (default **Approve / Reject**, up to 5 options) and ends its turn. A tap updates the card ("✅ Approve, chosen by @you at 14:02") and resumes the same session with `USER DECISION on "<title>": <option>`. Replying in words works too. Taps are recorded once (a double tap or a second person can't decide twice) and survive restarts. |
| `send_file` | Uploads a screenshot, PDF, CSV or image into the thread. Only files inside the project or the temp directory, resolved through symlinks, up to 100 MB. |
| `permission` | Chat turns outside `bypassPermissions`/`dontAsk`: when Claude wants a tool your `allowedTools` don't cover, the thread gets **Allow / Deny** buttons and the call waits (denied after 10 minutes). Scheduled jobs never wait on a prompt. |

The tools reach tara-agent through its local API with a per-run token, written to a mode-600 config file, so the token never appears on a command line. This needs `http.enabled` (the default).

## Local API

For dashboards and scripts on the same host (`127.0.0.1:4100` by default):

| Call | Does |
|---|---|
| `GET /health` | Uptime and job counts |
| `GET /jobs?project=<name>` | Jobs with next run, last status and error |
| `POST /jobs/<project>/<id>/run` `{"by": "who"}` | Run a job now |
| `GET /jobs/<project>/<id>/runs?limit=15` | Run history |
| `GET /runs/<id>` | One run, with Claude's reply and the script output |
| `POST /reload` | Re-read every `.tara/jobs.json` now |

## Thread commands

| Command | Effect |
|---|---|
| `!new` | Forget this thread's session |
| `!model <name>` | Switch model for this thread |
| `!stop` | Stop the running turn |
| `!status` | Show project, model, session and queue |
| `!jobs` | List this channel's jobs with their next run |
| `!run <job-id>` | Run a job now (it posts its own thread) |

## Security

**Anyone who can post in a mapped channel can make Claude act on your machine.**
- The default `permissionMode: default` only runs tools listed in `allowedTools`. Anything else is blocked and reported in the thread.
- `bypassPermissions` runs everything without asking. Use it only in private channels you control, and limit `allowedUsers`.
- Credentials are stripped from the CLI's environment unless a project opts into API billing.

## Development

```sh
npm run typecheck && npm run lint && npm test
npm run dev -- --config ./my-config.yaml
```

## License

[MIT](LICENSE)
