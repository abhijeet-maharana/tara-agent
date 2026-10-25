# tara-agent

Self-hosted gateway that turns **Slack threads** (and soon **cron schedules**) into real **Claude Code** sessions on your own machine, across as many project repos as you like.

> **Status:** early development. Slack thread chat works. Scheduled jobs and approval buttons are next. See [docs/plan.md](docs/plan.md).

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

## Thread commands

| Command | Effect |
|---|---|
| `!new` | Forget this thread's session |
| `!model <name>` | Switch model for this thread |
| `!stop` | Stop the running turn |
| `!status` | Show project, model, session and queue |

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
