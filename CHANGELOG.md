# Changelog

## Unreleased

- The system prompt reaches Claude in a file (`--append-system-prompt-file`), not on the command line: under split users sudo logged the whole prompt on every run.
- Host `agentName` (default `tara`): Claude is told its name in every run, and the dashboard shows it.
- `jobs.json` takes a file-level `tz` for every job that doesn't set its own, and an optional `durationMinutes` per job for planning tools.
- **Approvals**: one card per decision or draft, from every project, on a new Approvals page. `request_approval` cards are stored (with the proposal) and can be decided on the page or in Slack; a decision on a job's card continues that run **as the job** (its locks, prompt and timeout), not as a chat turn. New `propose_item`, `list_items` and `finish_item` tools for drafts that go out later through **queues** (`.tara/queues.json`: windows per region, cron slots with alternating kinds, daily and weekly caps, gaps, batches; job or URL executors; unreported items fail instead of running twice). Edits, bulk approve, approve-and-run-now and revise on the page; project checks through `approvals.validateUrl`; a signed `approvals.hookUrl` call when an item is decided or finishes; only the first option runs a draft, the others close it (Skip, "Applied by hand"); up to 40 fields per card, with their labels in the executor's prompt; a URL executor can answer "later" to keep an item queued until a given time; `external` queues that the project's server runs itself and reports (`POST /items/<id>/report`); a cancel is told to the project's hook; a project can withdraw a waiting card (`POST /items/<id>/withdraw`) and read its queues' next slots (`GET /queues`); pending items expire. API: `/items`.
- **Split users**: host `claude.runAs` runs Claude and pre-run scripts as another OS user through sudo, so runs can't read tara-agent's database or keys. Dashboard decisions need an unlock cookie (`TARA_ADMIN_TOKEN`) and another device; approved items are sealed with `APPROVAL_SEAL_KEY`. `deploy/split-users.sh` sets it up.
- **Inbox**: tasks for a person, per project, deduplicated by `key`. Claude adds and closes them with the new `add_task`, `list_tasks` and `complete_task` tools; the dashboard has an Inbox page and shows urgent tasks on Home; the API has `GET/POST /inbox`, `/inbox/close` and `/inbox/<id>/done|reopen`. `tara-agent import-tasks` moves an older JSON task board in.
- **Schedule** page and `GET /schedule`, `/schedule/conflicts`: each day's runs from the live scheduler with usual lengths, overlaps, tight gaps and free windows; `POST /jobs/<p>/<id>/duration` sets `durationMinutes`.
- Dashboard: dark only, in a shared look other dashboards can copy (`src/http/look.ts`, `docs/dashboard-look.md`); a "Dashboards" switcher from each project's `dashboardUrl` (new optional project `title`) replaces the project cards; Home shows urgent tasks, failing and paused jobs, coming up and just ran; plain wording ("Run now" everywhere, no file names in dialogs); HTML 404 and 500 pages.
- With `TARA_HTTP_TOKEN` set, the pages need the token too (open one once with `?token=…` to sign the browser in with a cookie); before, they were served without it while the dashboard's own buttons failed.

## 0.1.0 (2026-10-25)

First release.

- **Slack threads → Claude Code sessions**: one session per thread, resumed on reply and across restarts; native streaming (live task card + text as it is written, with an edited-message fallback); `!new`, `!model`, `!stop`, `!status`, `!jobs`, `!health`; start any scheduled job by typing "run <job name>" (buttons when ambiguous, Claude's `run_job` tool for anything looser).
- **Many projects**: each Slack channel maps to a repo; Claude runs with that repo's `CLAUDE.md`, skills and `.mcp.json`.
- **Scheduled jobs** from `<repo>/.tara/jobs.json`: cron with timezones, pre-scripts with a wake gate, `[SILENT]` / `[CRON_FAILURE]`, headline + thread delivery (hand-started runs stream live into the thread), exactly-once slot claims, catch-up after downtime, named locks, hot reload.
- **Approvals, permission prompts and files** through tara's own MCP server: `request_approval` buttons that resume the session, Allow/Deny prompts for tools outside `allowedTools`, `send_file`.
- **Daily health digest** per project: runs, problems, missed slots, peak 5-hour usage.
- **Dashboard and local API** on `127.0.0.1:4100`: sessions with full transcripts, jobs with Run now, single runs; JSON for tools on the same paths; `allowFrom` network allow-list; `fallback` pass-through for taking over a port.
- A scheduled run cut short by a restart (or a crash) runs again on the next start, once.
- **`import-hermes`** to move Hermes Agent cron jobs over, and **`validate`** to check config.
- Runs as a dedicated unprivileged user (`deploy/systemd/tara-agent-dedicated-user.service`, `docs/security.md`).
