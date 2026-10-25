# Dashboard look

tara-agent's dashboard is the home for everything about the agent: jobs, runs, the schedule, sessions and the inbox. A project can have its own dashboard for its own work (set `dashboardUrl` in `.tara/config.json`). These rules keep the dashboards feeling like one app.

## One home for each thing
- **Agent things live in tara-agent only.** That covers job lists, Run now, Pause and Resume, run history, the schedule, sessions, inbox tasks and **approval cards** (every decision and every draft waiting for approval). A project dashboard may show a one-line summary, e.g. "41 jobs · 0 failing", plus its own urgent and decide tasks. It links to tara-agent for the rest and never re-implements those pages.
- **Project dashboards show the project's own work and history**, such as orders, a pipeline or what was sent, plus one row "N approvals waiting →" that links to the Approvals page filtered to the project.
- **Change jobs and tasks only through tara-agent's API** (`POST /jobs/…`, `POST /inbox…`). Never write another repo's `.tara/jobs.json`.

## Tokens
- Copy `TOKENS` and `SWITCHER_CSS` from [`src/http/look.ts`](../src/http/look.ts) verbatim, with a comment `copied from tara-agent src/http/look.ts — edit there`.
- The theme is dark only.
- Use the variables (`--card-bg`, `--border`, `--text-dim`, `--accent`, `--red`…), not raw colours.

## Shell
- **Sidebar** of `var(--sidebar)` width. From top to bottom:
  - A brand row: a `.mark` letter plus the dashboard's name.
  - The page links (`.nav-item`, current page `.on`, red `.badge` for counts that need action).
  - The **Dashboards** switcher.
  - "Updated hh:mm ↻" at the foot.
- **Switcher**, the same everywhere:
  - Order: the agent first, then the projects in the order tara-agent lists them.
  - Each entry is a `.mark` letter plus the title, and the current dashboard is `.switch.on`.
  - Build links from `location.hostname` plus the port, so they work over a LAN or tailnet IP.
- **Phones** (under 760 px): the sidebar becomes a top bar with ☰. The page links and the switcher open from it.
- **Page:** an `h1` with one line of subtitle. Sections get an uppercase `h2` with a short dim note. Rows and cards have a coloured left border for state.

## Words
- The job button is always **Run now**.
- Job states: failing, running, paused, ok, not run yet.
- Run results: did work, nothing to do, failed, timed out, stopped.
- Task levels: **Urgent** (do today), **Decide** (approvals and drafts), **Later**.
- Keep raw cron, ids, script names and file paths inside a folded **Details** block, never in the main view or a dialog.
- Every action asks for confirmation, or offers **Undo** when it is easy to reverse, such as Done.

## States
- **An error is never shown as empty.** Say what failed and offer Retry. Don't show "Nothing urgent" when the tasks didn't load.
- **Loading** shows quiet placeholder rows. Text that may say "Loading…" forever doesn't count as a loading state.
- **Empty** says what would appear there, e.g. "No decisions waiting."
