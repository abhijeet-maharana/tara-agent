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
| `src/runner/` | Builds CLI arguments, strips credentials from the environment, spawns the CLI, parses its stream, kills the process group on timeout or stop. `run.ts` is Claude Code; `agy.ts` is the Antigravity CLI harness for `harness: "agy"` jobs (stream-json in and out, tara's MCP tools through a per-run plugin) |
| `src/sessions/manager.ts` | Slack thread ↔ Claude session, chat concurrency cap, live status message, "stop" and "run <job name>" |
| `src/sessions/threads.ts` | One run at a time per Slack thread, shared by chat turns and jobs: replies wait for the run, "stop" ends it |
| `src/scheduler/` | Job timing (croner), slot claims, catch-up, locks, job `steps` (`steps.ts`), job delivery |
| `src/bridge/bridge.ts` | Per-run MCP config and token, approval buttons, permission prompts, file uploads |
| `src/mcp/server.ts` | The stdio MCP server Claude starts: `request_approval`, `request_privileged`, `send_file`, `permission`, items and tasks |
| `src/privileged/` | Root actions through the root-owned helper `deploy/tara-priv.mjs` (list, plan, run) |
| `src/http/server.ts` | Local API for other tools, plus `/internal/*` for the MCP server |
| `src/code/repo.ts`, `src/http/code.ts` | The Code page: read-only git status, diffs and files of each repo, through a private index copy ([code-view.md](code-view.md)) |
| `src/health/`, `src/http/health.ts`, `src/http/observe.ts` | The Health page. Now: checks of tara-agent, each project's jobs and each project's `healthUrl`, with red-twice-in-a-row alerts and recoveries in a `📌 Health` day thread. Trends: runs, cost, usage, job lengths, uptime and machine samples over days. Logs: tara-agent's own warnings and errors plus `logUnits` from the journal, grouped. `GET /metrics` for Prometheus |
| `src/http/dashboard.ts` | Server-rendered dashboard (home, jobs, runs, sessions); `cron-text.ts` turns schedules into plain English |
| `src/slack/` | Bolt app, mrkdwn conversion, message splitting |
| `src/store/store.ts` | `node:sqlite` with numbered migrations |

## A chat turn

1. A message arrives in a mapped channel. Thread replies use the thread's root `ts`, so a thread is one key.
2. `SessionManager` queues it behind any running turn in that thread, then waits for a chat slot.
3. It reacts 👀 and opens a native Slack stream in the thread (`chat.startStream`, plan mode), then starts `claude -p --include-partial-messages --session-id <new>` (or `--resume <id>`), with the prompt on stdin and `cwd` set to the project.
4. `tool_use` / `tool_result` events become task lines on the card; text deltas are appended as Markdown (batched about once a second, sub-agent output left out). The `result` event gives the reply, session id, usage and the 5-hour window, and the card's title becomes "✅ Done · 13s · 2 steps". The stream is the answer: nothing is reposted. Slack seals long streams after a few minutes, so a sealed stream reopens with the full card state; text Slack refuses is posted as plain messages; an app without streaming falls back to an edited status message.
5. The reply is converted to Slack mrkdwn and posted. The run is stored with its usage.

## A scheduled job

Scheduled runs go through Slack: the scheduler only posts a message, and the bot runs the job it names.

1. croner fires; the scheduler works out the slot time and **claims** it in SQLite. A claimed slot never runs again, even after a restart.
2. It posts a trigger message in the project channel: `Run <job name>` (e.g. `Run Weekly GA4 Audit`; the id only when two jobs share a name), the words a person would type (`src/scheduler/slack-trigger.ts`). With `SLACK_USER_TOKEN` set it is posted as that person, otherwise as the bot. It starts the scheduled slot only while one is waiting for that job; a person typing `Run <name>` otherwise gets a normal run.
3. The bot receives its own message from Slack (`ignoreSelf: false`; `toIncoming` lets through only its top-level trigger messages, as `fromSelf`) and starts that job in the message's thread. The scheduler takes the slot once, so a redelivered event starts nothing. A trigger not picked up within 2 minutes (a dropped event) is started by the scheduler itself in the same thread; one lost to a restart leaves the slot `running`, and the next start catches it up. A trigger-looking message that doesn't parse is dropped, never sent to Claude.
4. The job waits for a job slot (`jobConcurrency`) and its named locks (for example `chrome`).
5. The status line is the thread's first reply (the trigger message is never edited: a channel holds only `Run <name>` messages), and the run streams its steps and text live into the thread (addressed to the project `owner`). An empty reply → "🔇 nothing to report", the thread and session stay; a reply starting with `❌` → marked failed; otherwise the headline on the status line and the full reply in the thread (a reply that is only a headline, with no details, stays on the status line: the thread keeps just the steps and the `✅ Done` summary).
6. The job thread is saved as a session, so replying to it continues the job's conversation ("why didn't you check X?").

On start, each enabled job posts its most recent missed slot once if it is younger than `catchUpHours` and after the job was first seen on this host (also `Run <job name>`). Runs started with `run <job name>` or a card decision run in that thread; a queue and Run now open their own `Run <job name>` thread (`openRunThread`).

## An approval

1. During a turn, Claude calls `request_approval` on tara's MCP server.
2. The MCP server posts to `/internal/approval` with its run token. tara-agent stores the approval and posts a Block Kit card with buttons.
3. The tool tells Claude to end its turn without acting.
4. A tap is recorded once (SQLite `UPDATE … WHERE status = 'pending'`), the card shows who chose what, and `USER DECISION on "<title>": <option>` is fed into the thread like a typed message, which resumes the session. If the job that asked was renamed or removed since (e.g. merged into another job), the decision goes to a chat in the card's thread instead of being dropped.
5. From the Approvals page, a **note** is always posted in the card's thread as the `SLACK_USER_TOKEN` person, and Slack hands it to Jarvis like any reply, so the thread holds it. Slack shows a short line that mentions who sent it, so they are notified at once (`From @you on the Approvals page: …`; the token may be another account, e.g. a brand one), and Jarvis gets the full text. Once Jarvis has answered, a short new message mentions that person (`<@you> ↑ answered your note…`), since Slack notifies neither on your own message nor on a streamed answer. A **decision** is posted that way only when it would start a new chat (the thread has no session yet, e.g. a day `Run <kind>` thread); one that continues a session goes to it directly, since a job's decision resumes the job (its locks, timeout and handoff), which a Slack reply can't. Without a user token, if that post fails, or if Slack doesn't deliver it within 2 minutes, it goes directly.

Permission prompts work the same way, except the MCP call blocks (polling every 45 s) until Allow, Deny or the 10-minute timeout.

## Design choices

- **One CLI process per turn**, not a long-lived process: sessions live in the CLI's own storage (Claude Code sessions, agy conversations), so restarts lose nothing. A session remembers its harness, so later turns use the same CLI.
- **Plain replies**: a `✅`/`⚠️` headline, or `❌` first when the job could not be done (no code words).
- **A job's instructions and scripts live in its skill**, not in `jobs.json`: one place to read and edit, and learning turns improve them with the rest of the skill. `jobs.json` holds only when and how a job runs.
- **Local HTTP for the MCP bridge** instead of a socket per session: one code path, easy to test, token per run.
- **No outbound calls except Slack and the CLI.** No telemetry: `/metrics` is only scraped by what you point at it.
