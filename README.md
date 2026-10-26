# tara-agent

**A 24/7 AI agent that works on your projects, with a human in the loop through Slack and a web dashboard.**

tara-agent runs on your own server around the clock. It runs scheduled jobs, answers you in Slack, and does real work in your project repos: reports, checks, outreach drafts, fixes. Whenever something needs a person (sending a message, a risky change, a login), it stops and asks. You approve from Slack or the dashboard, usually from your phone, and it carries on.

## Features

**Always on**
- **Scheduled jobs.** Cron jobs per project, run day and night. A job can run a cheap script first and only wake the agent when there is something to do.
- **Survives restarts.** Sessions, approvals and schedules are stored locally. Missed jobs catch up after downtime, and no job slot runs twice.
- **Learns from mistakes.** After a run that had trouble, the agent gets one chance to fix the instructions it followed.

**Human in the loop**
- **Approval buttons in Slack.** The agent asks with Approve / Reject (or your own options). Your tap continues the same session.
- **Approvals dashboard.** Drafts (messages, emails, posts) wait as cards you can edit, approve, reject or send back for a new version. Approved ones go out on a schedule, with daily limits.
- **Permission prompts.** When the agent wants a tool it isn't allowed to use, you get **Allow / Deny** in the thread.
- **Root actions on approval.** It never gets sudo. It asks for actions from an allowlist, and you approve them.

**Talk to it**
- **Chat in Slack.** Each channel is one project. A message starts a session, and replies in the thread continue it. Progress streams live.
- **Many projects, one agent.** Every project keeps its own repo, instructions, skills and tools.

**See everything**
- **Web dashboard.** What's running, what needs you, failing jobs, the day's schedule, full transcripts of every run, and your repos' uncommitted changes. Works on a phone.
- **Daily health digest** in each project channel.

## How it works

```
Slack thread ──► tara-agent ──► claude -p --resume <session>   (runs inside the project repo)
   ▲                 │
   └── live progress, final answer, files, buttons
```

1. tara-agent connects to Slack (Socket Mode, so no public URL is needed).
2. A message comes in. tara-agent finds the project for that channel and starts the `claude` CLI in headless mode inside that repo, or resumes the thread's session.
3. Claude's progress streams into the thread as a task list, followed by the answer.
4. Scheduled jobs use the same path: on their cron time, tara-agent runs the job's script and prompt and posts the result in the project channel. Replying to that post continues the job's session.
5. Everything (sessions, runs, approvals) is stored in a local SQLite file. The dashboard and local API read from it.

## Quick start

**You need:** Node 22.13 or newer, and Claude Code installed and logged in (`claude`, then `/login`) as the user that will run tara-agent.

1. **Create the Slack app** from [`deploy/slack-app-manifest.yaml`](deploy/slack-app-manifest.yaml) and invite the bot to your project channels.
2. **Install:**
   ```sh
   git clone https://github.com/abhijeet-maharana/tara-agent && cd tara-agent
   npm ci && npm run build
   ```
3. **Host config:** copy [`examples/config.yaml`](examples/config.yaml) to `~/.config/tara-agent/config.yaml` and list your project paths.
4. **Secrets:** put `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `~/.config/tara-agent/env` (see [`.env.example`](.env.example)).
5. **Each project:** add `<repo>/.tara/config.json` with at least a `name` and a `slackChannel` (see [`examples/project`](examples/project/.tara)).
6. **Run:** `node dist/index.js`.

Post a message in a mapped channel. Claude replies in the thread.

### Add a scheduled job

Create `<repo>/.tara/jobs.json`. tara-agent picks up changes within 30 seconds.

```json
{
  "tz": "Asia/Kolkata",
  "jobs": [
    {
      "id": "daily-report",
      "name": "Daily report",
      "cron": "45 10 * * *",
      "prompt": "Check yesterday's late orders and summarise them."
    }
  ]
}
```

Type `run daily report` in the channel to try it right away.

## Run it as a service

On Linux, use the systemd units in [`deploy/systemd/`](deploy/systemd/):

```sh
cp deploy/systemd/tara-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now tara-agent
loginctl enable-linger "$USER"
journalctl --user -u tara-agent -f
```

- If `claude` isn't on the service's `PATH`, set `claude.bin` to its full path in the host config.
- If a project uses MCP servers from its `.mcp.json`, approve them for headless runs: add `"enableAllProjectMcpServers": true` to that repo's `.claude/settings.local.json`, then check with `claude mcp list`.
- On an always-on machine, **run it as its own user** with access only to the project repos. Setup steps are in [`docs/security.md`](docs/security.md#run-as-a-dedicated-user).
- Only one bot can use a Slack app's tokens at a time. Stop any old bot on the same app first.

## In Slack

| You type | What happens |
|---|---|
| Any message | Starts a session in the project repo; replies in the thread continue it |
| `run <job name>` | Runs a job now, in your message's thread |
| `!new` | Starts fresh in this thread |
| `!model <name>` | Switches model for this thread |
| `!stop` | Stops the current turn |
| `!status` | Shows project, model, session and queue |
| `!jobs` | Lists this channel's jobs and their next run |
| `!health` | Shows the last 24 hours: runs, problems, usage |

## Dashboard

Open `http://127.0.0.1:4100` (or the address you set under `http`).

| Page | Shows |
|---|---|
| **Home** | What's running, what needs attention, upcoming and recent runs |
| **Approvals** | Cards waiting for a decision, scheduled drafts, and past decisions |
| **Jobs** | Every job with its schedule, recent results, **Run now** and **Pause** |
| **Schedule** | A day's timeline of jobs, with overlaps and free time |
| **Sessions** | Every Slack thread and job run, with full transcripts |
| **Code** | Each repo's uncommitted changes, diffs and files (read-only) |

## Security

**Anyone who can post in a mapped channel can make Claude act on your machine.** Treat that channel like a shell.

- Keep project channels private and set `allowedUsers`.
- The default `permissionMode: default` runs only the tools in `allowedTools`. For anything else, the thread gets **Allow / Deny** buttons.
- `bypassPermissions` runs everything without asking. Use it only in channels you fully control.
- Claude never gets your Slack tokens or other secrets in its environment.

Full threat model: [`docs/security.md`](docs/security.md).

## Documentation

| Doc | Covers |
|---|---|
| [`docs/configuration.md`](docs/configuration.md) | Every setting: host, project, jobs, files, approvals, queues, local API |
| [`docs/security.md`](docs/security.md) | Threat model, dedicated user, split users, privileged actions |
| [`docs/architecture.md`](docs/architecture.md) | Modules and how a chat turn, job and approval flow |
| [`docs/code-view.md`](docs/code-view.md) | The Code page |
| [`docs/dashboard-look.md`](docs/dashboard-look.md) | Reusing the dashboard style in your own project dashboards |
| [`CHANGELOG.md`](CHANGELOG.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) | Changes and how to contribute |

## Development

```sh
npm run typecheck && npm run lint && npm test
npm run dev -- --config ./my-config.yaml
```

## License

[MIT](LICENSE)
