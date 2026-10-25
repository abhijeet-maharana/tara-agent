# Security

tara-agent lets people in Slack, and scheduled prompts, make Claude act on a machine. Treat a mapped channel like a shell on that machine.

## Threat model

| Risk | Mitigation |
|---|---|
| Someone in a mapped channel asks Claude to do damage | Keep channels private; set `allowedUsers`; prefer `permissionMode: default` with a tight `allowedTools`, so anything else asks for Allow/Deny in the thread |
| A job reads hostile text (web pages, chat channels, email) that tells Claude to do something else (prompt injection) | Run tara-agent as a **dedicated unprivileged user** (below); keep mutations behind `request_approval`; jobs never get permission prompts, so in non-bypass modes an unexpected tool is simply denied |
| Claude reads secrets | The CLI's environment has no Slack tokens or credentials (only `ANTHROPIC_API_KEY` for projects on API billing); with a dedicated user, repo `.env` files and the owner's home are unreadable |
| Claude edits tara-agent itself or its config | Dedicated user with read-only access to the checkout; config and env file outside its reach |
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

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.
