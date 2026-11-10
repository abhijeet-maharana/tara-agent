# Dashboard look

tara-agent's dashboard is the home for everything about the agent: jobs, runs, the schedule, sessions and approval cards. A project can have its own app for its own work (set `dashboardUrl` in `.tara/config.json`). With `tabs` its pages show inside tara-agent's dashboard (see [Project tabs](#project-tabs)); without, the sidebar's Dashboards switcher links to it. These rules keep everything feeling like one app.

## Project tabs
One dashboard for everything: a project lists its app's pages in `.tara/config.json`, and they open in tara-agent's sidebar under the project's title.

```json
"dashboardUrl": "http://127.0.0.1:4001",
"tabs": [
  { "path": "/posted", "label": "Posted", "icon": "📣" },
  { "path": "/media", "label": "Media", "icon": "🖼️" }
]
```

- `dashboardUrl` is the app's **origin** as tara-agent reaches it on the same machine; any path is ignored. The browser never talks to it.
- `/p/<name><path>` is the page: the sidebar plus a frame that fills the rest. `/p/<name>` opens the first tab.
- `/app/<name>/<rest>` is proxied to `<dashboardUrl>/<rest>` with every method, body and header. It is behind the dashboard token, and it adds `x-tara-prefix: /app/<name>`. tara-agent's own cookies (`tara_token`, `tara_admin`) are removed. The app's `Set-Cookie` comes back unchanged, so use `Path=/`.
- As the app moves between its pages (`pushState` or a full load), the page's address follows on `/p/<name>/…` and the matching tab lights up. The app needs no code for this.

What the app does:
- **Works under `/app/<name>/`.** Its assets, API calls, router base and server-side redirects use the prefix (Vite `base: '/app/<name>/'`). Its routes stay at its own root, since tara-agent strips the prefix. APIs that other programs call stay exactly where they are.
- **Content only:** no sidebar, brand, switcher or ☰ menu of its own. The page fills the frame's width and scrolls by itself.
- **Links to tara-agent pages** are same-origin: `/approvals?project=<name>` with `target="_top"`, or `window.top.location` from scripts.
- **A browser opening the app's port directly** (no `x-tara-prefix`) is redirected to `http://<host>:<tara port>/p/<name><path>`. Only page routes do this; APIs and files are served as usual.
- **Shows nothing tara-agent already shows**: jobs, failing runs, Run now, approvals, queue, schedule, sessions.


## One home for each thing
- **Agent things live in tara-agent only.** That covers job lists, Run now, Pause and Resume, run history, the schedule, sessions and **approval cards** (everything that needs a person: every decision, suggestion, login and draft). A project dashboard may show a one-line summary, e.g. "41 jobs · 0 failing". It links to tara-agent for the rest and never re-implements those pages.
- **Project dashboards show the project's own work and history**, such as orders, a pipeline or what was sent, plus one row "N approvals waiting →" that links to the Approvals page filtered to the project.
- **Change jobs and cards only through tara-agent's API** (`POST /jobs/…`, `POST /items…`). Never write another repo's `.tara/jobs.json`.

## Tokens
- Copy `TOKENS` from [`src/http/look.ts`](../src/http/look.ts) verbatim, with a comment `copied from tara-agent src/http/look.ts — edit there` (and `SWITCHER_CSS` too for a dashboard that isn't shown as tabs and draws its own shell).
- The theme is dark only.
- Use the variables (`--card-bg`, `--border`, `--text-dim`, `--accent`, `--red`…), not raw colours.

## Shell
- **Sidebar** of `var(--sidebar)` width. From top to bottom:
  - A brand row: a `.mark` letter plus the dashboard's name.
  - The page links (`.nav-item`, current page `.on`, red `.badge` for counts that need action).
  - Each tabbed project: a `.nav-group` heading (its title), then its tabs.
  - The **Dashboards** switcher, only for projects with a `dashboardUrl` and no `tabs`.
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
