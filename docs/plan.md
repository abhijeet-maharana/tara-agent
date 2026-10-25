# tara-agent: plan

> **Status:** approved 2026-10-25. P0–P3 done; running live on the author's home server for 3 project channels and 58 jobs since 2026-10-25. Next: P4 polish and v0.1.0.

**One line:** a self-hosted gateway that turns Slack threads and cron schedules into real Claude Code sessions on your own machine. It works across many project repos and stays within Anthropic's terms by running the official `claude` CLI.

---

## 1. Why this exists

Agent frameworks that let you plug in a Claude subscription (Hermes, OpenClaw-style tools) usually call the API directly with the subscription's OAuth token. To get through, they pretend to be Claude Code: a fake `user-agent`, a fake system prompt, and tool names renamed to dodge Anthropic's third-party classifier. That puts the whole account (or Team org) at risk of a ban.

tara-agent takes the opposite approach:
- **It never talks to Anthropic itself.** It starts the real `claude` binary in headless mode (`claude -p`), the same thing you'd type in a terminal.
- **Your login stays in Claude Code.** No token extraction, no proxying, no account pools.
- **Your project setup is reused as-is.** Skills, `CLAUDE.md`, MCP servers and plugins work exactly as they do in your terminal.

## 2. Goals and non-goals

**Goals (v0.1)**
1. **Chat in Slack threads:** a new message starts a session, a reply resumes it, and it survives restarts.
2. **Many projects:** a channel maps to a repo, and every session runs with `cwd` set to that repo.
3. **Scheduled jobs:** cron jobs declared in each repo. Each run posts a thread you can reply into.
4. **Human approval from the phone:** buttons in Slack, with no process kept waiting.
5. **Script-first jobs:** a pre-script can finish the job without any model call.
6. **Shared-resource locks**, e.g. one browser (Chrome over CDP) used by many jobs.
7. **Usage visibility:** per-run cost and tokens, plus a daily health digest.
8. **Safe by default:** approval mode on, bypass is opt-in per project.

**Non-goals (v0.1)**
- Other chat platforms (Discord, Telegram). An adapter interface is kept so they can come later.
- A web UI. Slack is the UI.
- Multi-account or seat pooling, ever.
- Calling the Anthropic API directly or using the Agent SDK with a subscription login.
- Hosting/SaaS. It runs on your own box.

## 3. Compliance principles (in the README and enforced in code)
1. Only the official `claude` binary authenticates with Anthropic.
2. tara-agent never reads, copies or forwards `~/.claude` credentials or `CLAUDE_CODE_OAUTH_TOKEN`.
3. No header, prompt or tool-name spoofing.
4. One login per host. No rotation across accounts.
5. API-key billing (`ANTHROPIC_API_KEY`) is supported as an explicit per-project or per-job option, for overflow or for shared/team use.

The README will say plainly that users are responsible for their own plan's terms, especially for unattended use and for letting other people use a bot that runs on their seat.

## 4. Architecture

```
Slack (Socket Mode) ──► tara-agent (one process per host, systemd)
                          ├─ Slack adapter     threads, reactions, buttons, files
                          ├─ Session manager   thread ↔ session_id, queue per thread
                          ├─ Scheduler         cron, catch-up, locks, timeouts
                          ├─ HTTP API          POST /run (localhost, bearer token)
                          ├─ MCP server        request_approval, send_file, permission prompt
                          ├─ Store (SQLite)    sessions, runs, approvals, schedule state
                          └─ Runner ──► claude -p --output-format stream-json …
                                         cwd = <project repo>
                                         uses the repo's .claude/skills, CLAUDE.md, .mcp.json
```

### 4.1 Runner
- One CLI process **per turn**: `claude -p --output-format stream-json --verbose`, prompt on stdin, plus the flags below. Simpler than a long-lived process and restart-safe, since the session lives in Claude Code's own storage.
  - `--model`, `--permission-mode` (from project/job config)
  - `--session-id <uuid>` for a new session, `--resume <id>` for a reply
  - `--append-system-prompt` (project prompt file + channel/run context)
  - `--mcp-config` (tara's own MCP server, merged with the repo's `.mcp.json`)
  - `--permission-prompt-tool mcp__tara__permission` when not in bypass mode
- Parses the stream-json events: text, tool_use (for live status), and `result` (final text, `session_id`, `total_cost_usd`, usage).
- Per-run timeout, then a kill of the process tree. Exit codes and errors map to clear Slack messages ("hit usage limit", "timed out after 20 min", "CLI not logged in").
- Clean child environment: only the variables the project allows, plus `ANTHROPIC_API_KEY` when that job or project uses API billing.
- The CLI version is pinned in config, and a mismatch shows a warning at startup.

### 4.2 Slack adapter
- Bolt in Socket Mode, so no public URL is needed.
- **New top-level message** in a mapped channel starts a session. **A thread reply** resumes it. **While a turn is running**, replies queue and run in order.
- Live status: one message, edited at most every ~5 s ("🔧 Bash: npm test", "🌐 chrome: navigate…"). The final answer is posted when the turn ends, and long answers are split.
- Reactions: 👀 started, ✅ done, ❌ failed, ⏸ waiting for a lock or approval.
- Files: uploads are saved to `<repo>/.tara/inbox/` and passed as paths. Claude posts files back with `send_file` (path must be inside the repo).
- Thread commands: `!new`, `!model <name>`, `!stop`, `!status`, `!jobs`, `!run <job-id>`.
- Access: by default, any member of a mapped channel. Optional `allowedUsers` per project.

### 4.3 Approvals (two kinds)
| Kind | When | How |
|---|---|---|
| **Decision approval** (`request_approval` MCP tool) | A skill wants a go/no-go on a business action ("apply these 4 bid changes?") | Buttons are posted, the tool returns "posted, end your turn", and the session ends. A tap **resumes** the session with `USER DECISION: <option> (by <user>, <time>)`. Nothing waits in memory, so it survives restarts. |
| **Tool permission** (`--permission-prompt-tool`) | Safe mode, when Claude wants to run a tool that isn't pre-allowed | Approve/deny buttons; the call blocks up to a timeout (default 10 min), then denies. Only used in chat, since jobs use explicit `allowedTools`. |

### 4.4 Scheduler
- Reads `.tara/jobs.json` from every registered project, and hot-reloads on change.
- Cron syntax with a per-job timezone.
- **preScript:** run before the model, in the project dir.
  - Exit 0 → its stdout is posted as the result, **with no model call**.
  - Non-zero → the job's prompt/skill runs with the script output attached (an LLM fallback).
- **Locks:** a job declares `locks: ["chrome"]`, and chat sessions can also take a lock when a tool needs it (configurable). Waiters show ⏸.
- **Concurrency cap** per host (default 2 sessions).
- **Catch-up:** after downtime, missed runs within `catchUp` (e.g. `"6h"`) run once. `catchUp: false` is for time-window jobs.
- **Exactly once:** each due run is claimed in SQLite before it starts, so a restart can't double-run it.
- **Delivery:** each run posts a new top-level message in the project channel, and you can reply into it.
- **Built-in job `tara:health`:** a daily digest of runs, failures, slowest jobs, cost and limit hits.

### 4.5 HTTP API
- `POST /run {project, prompt | job, thread?}` triggers a session from scripts or other services, and the result is posted to Slack.
- `GET /health`.
- Binds to `127.0.0.1` by default and needs a bearer token from env.

### 4.6 Store
- A single SQLite file in `~/.local/state/tara-agent/` with tables `sessions` (thread → session_id, project, model), `runs` (job, start, end, status, cost, tokens), `approvals` and `claims`.
- Nothing is written into project repos, so there's no git churn.

## 5. Configuration

### 5.1 Host config: `~/.config/tara-agent/config.yaml` (never committed)
```yaml
projects:            # just paths; each repo describes itself
  - ~/Projects/project-a
  - ~/Projects/project-b
concurrency: 2
claudeVersion: "2.1.x"
http: { bind: 127.0.0.1, port: 4100 }
locks: [chrome]
```
Secrets come only from env: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `TARA_HTTP_TOKEN`, and optionally `ANTHROPIC_API_KEY`.

### 5.2 Project config: `<repo>/.tara/config.json` (committed in that repo)
```json
{
  "name": "project-a",
  "slackChannel": "C0123456789",
  "permissionMode": "default",
  "chatModel": "opus",
  "systemPromptFile": ".tara/system-prompt.md",
  "allowedUsers": [],
  "billing": "subscription"
}
```

### 5.3 Jobs: `<repo>/.tara/jobs.json`
```json
[
  {
    "id": "daily-sla-report",
    "cron": "15 5 * * *",
    "tz": "UTC",
    "skill": "order-sla-report",
    "prompt": "Run the SLA report and post a mobile-friendly summary.",
    "preScript": ".tara/scripts/sla-report.sh",
    "model": "haiku",
    "locks": ["chrome"],
    "timeout": "40m",
    "catchUp": "6h",
    "allowedTools": ["Bash", "Read", "mcp__chrome__*"],
    "enabled": true
  }
]
```
A JSON Schema ships for all three files and is checked at startup. `tara-agent validate` reports errors.

## 6. Security model
- **Anyone who can post in a mapped channel can run code on the host** through Claude. The README says so up front, and the default `permissionMode: default` asks before every tool use.
- `bypassPermissions` is opt-in per project, with a startup warning.
- `send_file` and inbox paths are validated against the project root.
- Logs redact tokens. Prompts and outputs are not logged by default; `debug` turns that on.
- The HTTP API listens on localhost only and needs a token.
- CI runs **gitleaks** on every push. The repo never contains real channel IDs, user IDs, hostnames or IPs.

## 7. Tech stack
- **Node ≥ 22.13 + TypeScript (ESM).** Same ecosystem as Claude Code, and easy for users to install. CI tests Node 22 and 24.
- `@slack/bolt` (Socket Mode), `croner` (cron + timezones, P2), built-in `node:sqlite` (no native deps), `@modelcontextprotocol/sdk` (P3), `zod` (config validation), `yaml`.
- **Tests:** `vitest`. The stream-json parser is tested against recorded CLI output fixtures, the scheduler with a fake clock, and the session store with temp DBs.
- **Tooling:** `tsc --noEmit`, Biome (lint + format).
- **CI:** GitHub Actions running typecheck, tests and gitleaks on PRs and on main.
- **Deploy:** a systemd user unit in `deploy/systemd/`, plus a launchd plist for macOS.

## 8. Repo layout (target)
```
tara-agent/
  src/
    index.ts            # boot: config, store, slack, scheduler, http
    config/             # host + project + jobs loading, zod schemas
    runner/             # spawn claude, stream-json parser, env builder
    slack/              # bolt app, thread rendering, buttons, commands
    sessions/           # thread↔session, per-thread queue
    scheduler/          # cron, claims, catch-up, locks, preScript
    approvals/          # decision + permission flows
    mcp/                # tara MCP server (request_approval, send_file, permission)
    http/               # /run, /health
    store/              # sqlite + migrations
  schemas/              # JSON Schema for config files
  deploy/systemd/  deploy/launchd/
  docs/plan.md  docs/architecture.md  docs/configuration.md  docs/security.md
  test/fixtures/        # recorded stream-json transcripts
  README.md  LICENSE  CONTRIBUTING.md  .github/workflows/ci.yml
```

## 9. Phases

| # | Phase | Scope | Done when |
|---|---|---|---|
| P0 | **Scaffold** (½ day) | package.json, tsconfig, Biome, vitest, CI + gitleaks, LICENSE, README skeleton, `.gitignore` | CI green on an empty build |
| P1 | **Runner + Slack threads** (2–3 days) | runner, stream-json parser + fixtures, Slack adapter, sessions store, host/project config, systemd unit | From a phone: start a thread, reply, restart the service, reply again in the same session |
| P2 | **Scheduler** (2–3 days) | jobs.json, croner, claims, catch-up, locks, preScript, run log, `!jobs` / `!run` | 5 real jobs run for 7 days with no missed or double runs |
| P3 | **Approvals + MCP** (2 days) | `request_approval` buttons + resume, permission-prompt tool, `send_file` | Full cycle from the phone: proposal → tap Approve → action → confirmation |
| P4 | **Harden + v0.1.0** (2–3 days) | health digest, HTTP API, `validate` command, docs (architecture/config/security), demo GIF, CONTRIBUTING | Public release tagged; README runs end-to-end on a fresh Linux box |
| P5 | **Later** | voice-note transcription hook, more chat adapters, npm package (`npx tara-agent`) | — |

**Adoption by our own projects** runs alongside P1–P4. Each project tracks it privately: pilot in a test channel, move jobs in batches, then cut over the existing Slack app. That work lives in those repos, not here.

## 10. Risks
| Risk | Mitigation |
|---|---|
| CLI stream-json format changes | Pin the CLI version; fixture tests catch drift; upgrade deliberately |
| Subscription usage limits on unattended jobs | preScript-first jobs, a cheaper model for routine jobs, per-job API-key billing, limit hits surfaced in the health digest |
| Bypass mode + open channel = remote code execution | Safe default, loud warnings, `allowedUsers`, `allowedTools` per job |
| Lock starvation (browser busy with long jobs) | Lock wait timeout, status shown in thread, job timeouts |
| Maintenance load once public | "Personal project, PRs welcome, no support promises" in README; issue templates |

## 11. Decisions (2026-10-25)
1. **License:** MIT.
2. **Visibility:** private until v0.1.0, flip public at P4.
3. **Default HTTP port:** 4100.

## 12. Progress
| Phase | State |
|---|---|
| P0 Scaffold | ✅ package, tsconfig, Biome, vitest, CI (typecheck, lint, test, build on Node 22/24) + gitleaks, MIT, README, `.gitignore`, Slack manifest, systemd unit, examples |
| P1 Runner + Slack threads | ✅ runner, stream-json parser, env stripping, SQLite store, session manager (`!new`, `!model`, `!stop`, `!status`), Slack adapter. 70 unit tests; verified with the real CLI and live in Slack (thread reply, reactions, usage capture). Accepts messages people post through an app with a user token (they carry `bot_id` + `user`) |
| P2 Scheduler | ✅ `.tara/jobs.json` (zod-validated, hot reload), croner, SQLite slot claims (exactly once), catch-up only for slots after a job was first seen, `jobConcurrency` + named locks, pre-scripts with Hermes' contract (wake gate, `## Script Output`, `[SILENT]`, `[CRON_FAILURE]`), headline/details delivery, replies resume job sessions, `!jobs` / `!run`, `import-hermes`, `validate`, local HTTP API (moved up from P4). 110 tests |
| Hardening | ✅ (2026-10-25) runs as a dedicated unprivileged user on the author's server: system unit `deploy/systemd/tara-agent-dedicated-user.service`, root-only env file, repo access via group + default ACLs, secrets and the rest of the home dir unreachable, read-only access to its own code |
| P3 Approvals + MCP | ✅ per-run tara MCP server (stdio, `src/mcp/server.ts`) → local API with a per-run token (mode-600 config, private tmp): `request_approval` (Block Kit buttons, SQLite-backed, decided once, tap resumes the session with `USER DECISION …`), `send_file` (realpath-checked, project or tmp only), `permission` via `--permission-prompt-tool` (Allow/Deny, 10-minute deny, chat only). Verified live: approve tap → resumed Opus turn → file created and uploaded. 124 tests incl. MCP server end to end |
