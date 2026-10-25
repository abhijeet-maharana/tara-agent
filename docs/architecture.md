# Architecture

tara-agent is one Node process per host. It never calls the Anthropic API: every piece of model work is a run of the official `claude` CLI in headless mode, started in the right project directory.

```
                 ┌────────────────────────── tara-agent (one process) ───────────────────────────┐
 Slack ◄────────►│ Slack adapter (Bolt, Socket Mode)                                              │
 (threads,       │   messages ─► SessionManager ─┐                                                │
  buttons)       │   buttons  ─► Bridge ─────────┤                                                │
                 │                               ▼                                                │
                 │ Scheduler (croner) ─► job runner ─► Runner ─► claude -p … (cwd = project repo) │
                 │       ▲                                         │   ├─ repo's CLAUDE.md, skills  │
                 │  .tara/jobs.json (each repo)                    │   ├─ repo's .mcp.json servers  │
                 │                                                 │   └─ tara MCP server (stdio) ──┼─┐
                 │ HTTP API 127.0.0.1:4100 ◄──── dashboards, scripts                              │ │
                 │   /internal/* ◄──────────────────────── per-run token ─────────────────────────┼─┘
                 │ Store (SQLite): sessions, runs, slot claims, approvals                         │
                 └────────────────────────────────────────────────────────────────────────────────┘
```

## Modules

| Path | Responsibility |
|---|---|
| `src/config/` | Host config (YAML), project config and jobs files (JSON), all validated with zod |
| `src/runner/` | Builds `claude` arguments, strips credentials from the environment, spawns the CLI, parses `stream-json`, kills the process group on timeout or `!stop` |
| `src/sessions/manager.ts` | Slack thread ↔ Claude session, one turn at a time per thread, chat concurrency cap, live status message, thread commands |
| `src/scheduler/` | Job timing (croner), slot claims, catch-up, locks, pre-scripts, job delivery, health digest |
| `src/bridge/bridge.ts` | Per-run MCP config and token, approval buttons, permission prompts, file uploads |
| `src/mcp/server.ts` | The stdio MCP server Claude starts: `request_approval`, `send_file`, `permission` |
| `src/http/server.ts` | Local API for other tools, plus `/internal/*` for the MCP server |
| `src/slack/` | Bolt app, mrkdwn conversion, message splitting |
| `src/store/store.ts` | `node:sqlite` with numbered migrations |

## A chat turn

1. A message arrives in a mapped channel. Thread replies use the thread's root `ts`, so a thread is one key.
2. `SessionManager` queues it behind any running turn in that thread, then waits for a chat slot.
3. It reacts 👀 and opens a native Slack stream in the thread (`chat.startStream`, plan mode), then starts `claude -p --include-partial-messages --session-id <new>` (or `--resume <id>`), with the prompt on stdin and `cwd` set to the project.
4. `tool_use` / `tool_result` events become task lines on the card; text deltas are appended as Markdown (batched about once a second, sub-agent output left out). The `result` event gives the reply, session id, usage and the 5-hour window, and the card's title becomes "✅ Done · 13s · 2 steps". The stream is the answer: nothing is reposted. Slack seals long streams after a few minutes, so a sealed stream reopens with the full card state; text Slack refuses is posted as plain messages; an app without streaming falls back to an edited status message.
5. The reply is converted to Slack mrkdwn and posted. The run is stored with its usage.

## A scheduled job

1. croner fires; the scheduler works out the slot time and **claims** it in SQLite. A claimed slot never runs again, even after a restart.
2. The job waits for a job slot (`jobConcurrency`) and its named locks (for example `chrome`).
3. The pre-script runs from the repo root. Empty output or `{"wakeAgent": false}` ends the run silently. Otherwise its output goes in front of the prompt.
4. The run posts a channel message and streams status into it. Replies `[SILENT]` → the message is deleted; `[CRON_FAILURE]` → marked failed; otherwise headline in the channel and details in the thread.
5. The job thread is saved as a session, so replying to it continues the job's conversation.

On start, each enabled job runs its most recent missed slot once if it is younger than `catchUpHours` and after the job was first seen on this host.

## An approval

1. During a turn, Claude calls `request_approval` on tara's MCP server.
2. The MCP server posts to `/internal/approval` with its run token. tara-agent stores the approval and posts a Block Kit card with buttons.
3. The tool tells Claude to end its turn without acting.
4. A tap is recorded once (SQLite `UPDATE … WHERE status = 'pending'`), the card shows who chose what, and `USER DECISION on "<title>": <option>` is fed into the thread like a typed message, which resumes the session.

Permission prompts work the same way, except the MCP call blocks (polling every 45 s) until Allow, Deny or the 10-minute timeout.

## Design choices

- **One CLI process per turn**, not a long-lived process: sessions live in Claude Code's own storage, so restarts lose nothing.
- **Hermes-compatible cron conventions** (wake gate, `## Script Output`, `[SILENT]`, `[CRON_FAILURE]`) so existing jobs and gate scripts move over unchanged.
- **Local HTTP for the MCP bridge** instead of a socket per session: one code path, easy to test, token per run.
- **No outbound calls except Slack and the CLI.** No telemetry.
