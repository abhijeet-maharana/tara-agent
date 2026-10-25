# Changelog

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
