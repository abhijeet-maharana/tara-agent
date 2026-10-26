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
| Your Claude account is banned for automation through a third-party client | tara-agent only runs the official `claude` binary; no token extraction, header or prompt spoofing, or account pools. You are still responsible for your plan's terms |

## Run as a dedicated user

The recommended setup on an always-on machine (see also the README):

- A system user with no sudo and no docker group, with its own Claude Code login.
- Repo access through a shared group and **default ACLs** on every repo directory, so files created by either side stay writable for both whatever the umask. Name the owner in the ACLs too, so services started before a group change still work.
- If code reaches the machine by file sync (e.g. Mutagen), have the sync write files with that group: synced files are often staged elsewhere and don't inherit ACLs.
- Remove the group's access to `.env*`, session and key files in the repos, and give the user only pass-through (`--x`) on the owner's home.
- Tokens in a root-only env file that systemd reads before switching user (`deploy/systemd/tara-agent-dedicated-user.service`).
- A periodic root job that re-applies the ACLs to new files is a cheap safety net. Run it from a root-owned copy, never from a path the agent can write.

## Split users (approvals)

With approval cards (the Approvals page), a run must never be able to approve its own drafts. On one user it could: Claude runs as the same user as tara-agent, so it can read tara-agent's environment (`/proc/<pid>/environ`), its database and its config. Split users fixes that:

- **tara-agent runs as its own user** (`tara-agent`). Its database lives in `/var/lib/tara-agent` (mode 700), its config in `/etc/tara-agent/` (root:tara-agent 640), and `TARA_ADMIN_TOKEN` and `APPROVAL_SEAL_KEY` in the root-only env file.
- **Claude and pre-run scripts run as the run user** (`tara`), started through sudo (host `claude.runAs`). The sudoers rule allows tara-agent to become that user only, with `!use_pty` so stopping a run's process group stops Claude too. Child environments never carry the two keys.
- **No prompts on command lines.** The system prompt goes to Claude in a file (`--append-system-prompt-file`, in a temp dir only tara-agent and the run user's group can read, removed after the run), so it never fills sudo's log (sudo-rs has no setting to quiet it) or shows in `ps`.
- **Decisions need a person.** Dashboard decisions need the `tara_admin` cookie, set once per browser on `/unlock` with `TARA_ADMIN_TOKEN`, and are refused from any address of the machine itself (where the agent runs). Slack taps by `allowedUsers` are the other way to decide.
- **Approved items are sealed** (HMAC of kind, id, title and the approved field values with `APPROVAL_SEAL_KEY`). A job executor only ever gets items from tara-agent itself; a URL executor in another process (say a project server sending email) verifies the seal with the same key from its own root-only env file before it acts. (Or, simpler, it reads the item back with `GET /items/<id>` and acts only on what tara-agent holds; that is what the remote-job board does.)
- **What a run can still do** through the local API: propose drafts (`POST /items`) and ask a question (`POST /items/ask`), both harmless: a person still decides and report items of an `external` queue (`POST /items/<id>/report`). A false report only changes what the page shows; the project acts on its own sealed records, so nothing goes out that a person did not approve.
- tara-agent joins the run user's group, so it still reads transcripts, edits `.tara/jobs.json` (pause, resume, durations) and removes old scratch folders.

`deploy/split-users.sh` sets this up on a dedicated-user install (user, sudoers, ACLs, config, keys, database move, unit) and checks at the end that the run user can't read the state, config or env file. `--rollback` goes back to the single-user unit.

## Privileged actions

Runs have no sudo, yet some failures need root: a file a sync wrote with a tight mode, a project server that needs a restart after a code change. `request_privileged` covers them without giving Claude root:

- **A root-owned helper is the allowlist.** `deploy/tara-priv.mjs` runs only actions listed in `/etc/tara-agent/privileged.json` (root-owned; see `examples/privileged.json`): each a fixed command (absolute path, no shell) with named arguments that must match a pattern in full, never contain `..` or control characters. Install a root-owned copy and allow only that path, for the tara-agent user only (never the run user):
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

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
