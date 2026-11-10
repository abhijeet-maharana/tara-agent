# Security

tara-agent lets people in Slack, and scheduled prompts, make Claude act on a machine. Treat a mapped channel like a shell on that machine.

## Threat model

| Risk | Mitigation |
|---|---|
| Someone in a mapped channel asks Claude to do damage | Keep channels private; set `allowedUsers`; prefer `permissionMode: default` with a tight `allowedTools`, so anything else asks for Allow/Deny in the thread |
| A job reads hostile text (web pages, chat channels, email) that tells Claude to do something else (prompt injection) | Run tara-agent as a **dedicated unprivileged user** (below); keep mutations behind `request_approval`; jobs never get permission prompts, so in non-bypass modes an unexpected tool is simply denied |
| Claude reads secrets | The CLI's environment has no Slack tokens or credentials (only `ANTHROPIC_API_KEY` for projects on API billing); with a dedicated user, repo `.env` files and the owner's home are unreadable |
| Claude edits tara-agent itself or its config | Dedicated user with read-only access to the checkout; config and env file outside its reach |
| A run needs root (a permission it lacks, a service restart) | It never gets sudo: it asks for a **privileged action** from a root-owned allowlist (below); anything not marked `auto` waits for a person's approval |
| Claude approves its own drafts (forges a decision) | **Split users** (below): decisions on the dashboard need a cookie key Claude can't read and must come from another device; approved items are sealed with a key Claude can't read, and executors in other processes check the seal |
| Another local process drives the bot | The API binds to `127.0.0.1`; set `TARA_HTTP_TOKEN` to require a bearer token; `/internal/*` needs a per-run token that exists only while that run is alive |
| A file upload leaks something outside the project | `send_file` resolves symlinks and only accepts files inside the project or the temp directory |
| A website open in your browser drives the local API (CSRF, DNS rebinding) | Writes whose `Origin` is another host are refused; a server bound to loopback answers only to `localhost`/`127.x`/`[::1]` Host names |
| A run changes a card after you looked at it | The dashboard sends the card version it showed; a card re-proposed since then is refused ("changed since you opened it") |
| A card links to a script (`javascript:` media) | Card media must be `http(s)` URLs or `/` paths, on input and when rendered |
| Model output pings the whole channel | `<!channel>`, `<!here>`, `<!everyone>` and group mentions in replies are posted as plain text |
| A learning turn edits code | Its tool calls are checked: an edit to a non-`.md` file or a shell/MCP call is listed with a ⚠️ in its Slack note |

## Run as a dedicated user

The recommended setup on an always-on machine. Scheduled jobs often read untrusted text, and a job that gets talked into something runs with the rights of the user tara-agent runs as.

1. `sudo useradd --create-home --user-group tara` (no sudo, no docker group), then install Claude Code and log in as that user: `sudo -iu tara`, install, `claude`, `/login`.
2. Give it the project repos and nothing else: a shared group with ACLs on the repo directories (`setfacl -m g:tara:rwx,d:g:tara:rwx` on every directory, default ACLs included). If you sync code with Mutagen, create the session with `--default-group-beta=tara`.
3. Keep secrets out: remove the group's access to `.env` files and session/key files in the repos, and keep your home closed (`setfacl -m u:tara:--x ~` lets it pass through to the repos only).
4. Put the Slack tokens in a root-only `/etc/tara-agent.env` and install `deploy/systemd/tara-agent-dedicated-user.service` as a system unit.

The agent then can't use your sudo, docker group, browser profiles, other projects or secrets, and can't edit tara-agent itself. In detail:

- A system user with no sudo and no docker group, with its own Claude Code login.
- Repo access through a shared group and **default ACLs** on every repo directory, so files created by either side stay writable for both whatever the umask. Name the owner in the ACLs too, so services started before a group change still work.
- If code reaches the machine by file sync (e.g. Mutagen), have the sync write files with that group: synced files are often staged elsewhere and don't inherit ACLs.
- Remove the group's access to `.env*`, session and key files in the repos, and give the user only pass-through (`--x`) on the owner's home.
- Tokens in a root-only env file that systemd reads before switching user (`deploy/systemd/tara-agent-dedicated-user.service`).
- A periodic root job that re-applies the ACLs to new files is a cheap safety net. Run it from a root-owned copy, never from a path the agent can write.
- **agy jobs** run as the same user with agy's own Google login (`~/.gemini/antigravity-cli`). agy's file tool writes anywhere that user can unless a deny rule stops it, and with `bypassPermissions` and no `agyPermissions` a job passes `--dangerously-skip-permissions`. For agy jobs that read untrusted pages, give them `agyPermissions` with deny rules for the places that matter (e.g. `write_file(/home)`) and only the commands they need.

## Split users (approvals)

With approval cards (the Approvals page), a run must never be able to approve its own drafts. On one user it could: Claude runs as the same user as tara-agent, so it can read tara-agent's environment (`/proc/<pid>/environ`), its database and its config. Split users fixes that:

- **tara-agent runs as its own user** (`tara-agent`). Its database lives in `/var/lib/tara-agent` (mode 700), its config in `/etc/tara-agent/` (root:tara-agent 640), and `TARA_ADMIN_TOKEN` and `APPROVAL_SEAL_KEY` in the root-only env file.
- **Claude and pre-run scripts run as the run user** (`tara`), started through sudo (host `claude.runAs`). The sudoers rule allows tara-agent to become that user only, with `!use_pty` so stopping a run's process group stops Claude too. Child environments never carry the two keys.
- **No prompts on command lines.** The system prompt goes to Claude in a file (`--append-system-prompt-file`, in a temp dir only tara-agent and the run user's group can read, removed after the run), so it never fills sudo's log (sudo-rs has no setting to quiet it) or shows in `ps`.
- **Decisions need a person.** Dashboard decisions need the `tara_admin` cookie, set once per browser on `/unlock` with `TARA_ADMIN_TOKEN`, and are refused from any address of the machine itself (where the agent runs). Slack taps by `allowedUsers` are the other way to decide.
- **Approved items are sealed** (HMAC of kind, id, title and the approved field values with `APPROVAL_SEAL_KEY`). A job executor only ever gets items from tara-agent itself; a URL executor in another process (say a project server sending email) verifies the seal with the same key from its own root-only env file before it acts. (Or, simpler, it reads the item back with `GET /items/<id>` and acts only on what tara-agent holds.)
- **What a run can still do** through the local API: propose drafts (`POST /items`) and ask a question (`POST /items/ask`), both harmless: a person still decides and report items of an `external` queue (`POST /items/<id>/report`). A false report only changes what the page shows; the project acts on its own sealed records, so nothing goes out that a person did not approve.
- tara-agent joins the run user's group, so it still reads transcripts, edits `.tara/jobs.json` (pause, resume, durations) and removes old scratch folders.

`deploy/split-users.sh` sets this up on a dedicated-user install (user, sudoers, ACLs, config, keys, database move, unit) and checks at the end that the run user can't read the state, config or env file. `--rollback` goes back to the single-user unit.

## Auto-approved cards

Some drafts need no person once a project's own server has checked them (an application whose every answer came from the applicant's profile, say). Host `autoApprove` lists them as `{project, kind, url}`:

- **The host config holds the rule.** It sits in `/etc/tara-agent/` with the other settings a run can't read or change. The repo's `.tara/config.json` can't add one or point it somewhere else.
- **The project's server decides, tara-agent records.** A card proposed over `POST /items` with `autoApprove: true` and a matching rule is sent to `url` (`POST {kind, key, fields}`). Only `{approve: true}` approves it: an error, a timeout or anything else leaves it waiting. The answer's `reason` is kept on the card.
- **Only a key's first card, and only with no checks.** The first card is asked again each time it is refreshed or revised while still pending (a person supplied a missing answer, say). A key that ever had a decided or closed card (approved, failed, rejected, expired, withdrawn) and any card with a check, blocking or not, waits for a person, so a failed send never retries on its own.
- **It is a normal approval otherwise**: sealed, decided by `auto`, shown on the Approvals page and in Slack ("Auto-approved: …"), told to the project's hook, and run by its queue.
- A run can ask too (`propose_item` with `autoApprove: true`, or `POST /items`), but the project's server answers for what it would propose, so the server must say yes only to content it built (compare the fields with its own draft) and only when nothing needs a person. For a kind whose content only a run writes (a comment, say), the server can only lint it: turn that on only for content the owner is willing to let a run publish.

## Pull requests

Host `github` lets a project's runs open pull requests (`start_pull_request`, then `open_pull_request`) without ever holding a GitHub token. A private repo on GitHub Free has no branch protection, so a token a run could read would let it push to `main` with `curl`; the rules live in tara-agent instead:

- **The token stays in tara-agent.** `TARA_GITHUB_TOKEN` (in tara-agent's env file) is stripped from every run's environment along with `GITHUB_TOKEN` and `GH_TOKEN`. Git gets it through its environment, never a command line. Use a fine-grained token for the listed repos only, with **Contents** and **Pull requests** read/write, and **Actions** read-only (for `read_ci_job`, below).
- **Host config holds the repo.** `github: [{project, repo, base}]` sits in `/etc/tara-agent/`, so a run can't point it at another repo or base branch.
- **Only `<agentName>/<name>` branches.** The name is checked (lowercase letters, digits, dashes) and always prefixed, so a push can never land on `base`. Pushes are never forced: a branch that moved on GitHub is rejected, not overwritten. Nothing merges; a person does.
- **Workspaces, not the project folder.** `start_pull_request` fetches the base (or the PR's branch) into tara-agent's own bare repo under `<stateDir>/github/` and checks it out into a temp folder the run user can write. `open_pull_request` commits what changed there. The project folder (with its local, unpushed work) is never touched.
- **Nothing a run writes can run code as tara-agent.** Git runs with no system or global config, no hooks and no fsmonitor, and its config and git data are where the run user can't write. Symlinks are committed as links, never followed.
- **Refused paths**: `.github/` (a pushed branch runs its own workflows with the repo's secrets), `.env*`, key and certificate files, SSH keys, `*credentials*`, `.npmrc`. At most 200 files per commit.
- Every PR is logged (`pull request <url> (<n> files)`) and the run replies with its link.

## CI jobs

The same host `github` projects get `read_ci_job`, so a run can see why a GitHub Actions job failed without holding the token:

- **Read-only.** tara-agent only sends `GET /repos/{repo}/actions/jobs/{id}` and `GET …/jobs/{id}/logs`. There is no tool to rerun, cancel or dispatch a workflow, and the token's **Actions** permission is read-only, so GitHub would refuse those anyway.
- **Only the project's own repo.** The input is a job id or a job URL (`github.com/<repo>/actions/runs/<run>/job/<job>`, `github.com/<repo>/runs/<job>`, or its `api.github.com` URL). A URL for any other repo (or host) is refused before any request; a bare id is always looked up in the host-config repo.
- **The token goes only to `api.github.com`.** The log endpoint redirects to a short-lived signed download URL; tara-agent follows it by hand without the `Authorization` header. The token is removed from errors and from the returned log lines.
- **What the run gets**: job name, workflow, branch, commit, status and conclusion, the failed steps, the lines around the first `##[error]` and the last 300 log lines, with timestamps and ANSI codes removed (lines cut at 1000 characters). GitHub masks the repo's secrets in logs, but anything a workflow prints unmasked reaches the run, so don't echo secrets in CI.

## Privileged actions

Runs have no sudo, yet some failures need root: a file a sync wrote with a tight mode, a project server that needs a restart after a code change. `request_privileged` covers them without giving Claude root:

- **A root-owned helper is the allowlist.** `deploy/tara-priv.mjs` runs only actions listed in `/etc/tara-agent/privileged.json` (root-owned; see `examples/privileged.json`): each a fixed command (absolute path, no shell) with named arguments that must match a pattern in full, never contain `..` or control characters. A path argument is checked again with its symlinks resolved, and the resolved path is what runs, so a link made inside an allowed folder can't point root elsewhere. Action scripts should still not follow links themselves (`chmod -h`, `setfacl -P`, `find -P`): a run can swap a folder for a link between the check and the action. Install a root-owned copy and allow only that path, for the tara-agent user only (never the run user):
  ```sh
  sudo install -o root -g root -m 755 deploy/tara-priv.mjs /usr/local/sbin/tara-priv
  sudo install -o root -g root -m 644 my-privileged.json /etc/tara-agent/privileged.json
  echo 'tara-agent ALL=(root) NOPASSWD: /usr/local/sbin/tara-priv' | sudo tee /etc/sudoers.d/tara-agent-priv
  sudo chmod 440 /etc/sudoers.d/tara-agent-priv && sudo visudo -c
  ```
  Then set host `privileged: {}` (the default command is `sudo -n /usr/local/sbin/tara-priv`) and restart. The helper reads its allowlist from that fixed path when it runs as root, whatever the environment says.
- **Approval by default.** An action runs only after a person approves its card (Slack `allowedUsers`, or the dashboard with the unlock cookie from another device), the same rules as any decision. The card shows the exact command; its action and arguments are read-only, and the helper checks them again when it runs. Mark an action `auto` only when it is harmless whatever the arguments (re-applying a permission policy, reading a status).
- **Never put in the allowlist** a command that runs code the run user can change as root: a script in a repo it can write, a shell, an editor, a package manager. Restarting a service whose code the run user can edit runs its edits as that service's user, so keep such restarts behind approval (never `auto`) and read what the run changed before you approve.
- **Everything is recorded**: each root action is a card that ends done or failed with its exit code and output, and sudo logs every call.
- Without `privileged`, `request_privileged` still works with a `command`: a card asks a person to run it, and **I ran it, continue** resumes the run.

## Code page

The Code page (`/code`) shows source code, so it is only as private as the dashboard: keep `http.allowFrom` to your own network and set `TARA_HTTP_TOKEN`. It serves only files git lists (never ignored ones), never `.git`, paths outside the repo or symlinks out of it, and hides `code.exclude` globs (`.env*`, keys) even when tracked. Git runs read-only (no optional locks, a private index copy, no hooks, external diff or textconv). Asking about a file starts a Claude run, so it needs the unlock cookie from another device. See [code-view.md](code-view.md).

## Project tabs

`/app/<name>/…` proxies to the project's `dashboardUrl`, so a project app shown as tabs is as private as the dashboard: it needs `http.allowFrom` and `TARA_HTTP_TOKEN` like every page. Only projects with `tabs` are proxied, and only to their configured origin (a path like `//other.host/` is refused). tara-agent's bearer token and its `x-tara-admin`/`x-tara-run` headers are never forwarded. The app's server never receives `tara_token` or the `tara_admin` unlock cookie. Its pages, though, run on tara-agent's origin, so their scripts can call tara-agent with your browser's cookies just like tara-agent's own pages. Serve only apps you trust as much as tara-agent itself. Actions that only a person may take keep their own check in the app. The app's port can then stay closed to browsers.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
