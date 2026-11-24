# Host tools

Small tools for the machine tara-agent runs on. Each is one dependency-free Node file in `deploy/`, run as root from a root-owned copy by a systemd timer, with its settings in `/etc/tara-agent/`. Nothing a run user can write is ever run as root.

| Tool | Timer | Settings | What it does |
|---|---|---|---|
| `deploy/backup/tara-backup.mjs` | nightly | `backup.json` | Checked, encrypted off-site backup ([backups.md](backups.md)) |
| `deploy/release/tara-release.mjs` | – (deploys) | `services.json` | Release folders with automatic rollback ([deploy.md](deploy.md)) |
| `deploy/host/tara-heartbeat.mjs` | every 5 min | `heartbeat.json` | Local service check, outside tara-agent |
| `deploy/host/tara-cleanup.mjs` | weekly | `cleanup.json` | Rule-based housekeeping |

## Heartbeat

tara-agent's Health page can't report that tara-agent is down. The heartbeat runs on its own timer and checks:

- **HTTP services**: up = any answer that isn't 5xx (an auth error still means up)
- **Files that must stay fresh**: by file time, or by an ISO time inside a JSON file (`"jsonTime": "lastGood.at"` for the off-site backup)
- **Disk and memory** thresholds

It writes `stampFile` (touched every run: when the host was last seen up) and `statusFile` (the problems, once they failed twice in a row; empty when fine). Both are written in place, so a service that bind-mounts them keeps seeing the live file. A project dashboard can read them and show a check on the Health page through its `healthUrl`. Nothing leaves the host.

```sh
sudo tara-heartbeat --dry-run
```

## Cleanup

Deletes only what `cleanup.json` names:

- **rules**: entries directly inside a folder, matching a glob (`*`, `?`), older than an age; a matching folder goes whole
- **protected**: never removed, nor anything inside, nor a folder that holds one
- **links** are removed as links; their targets are never followed
- **dockerDanglingImages**: untagged images only

```sh
sudo tara-cleanup --dry-run     # always preview a rule change
```

The last result is in `/var/lib/tara-cleanup/status.json`.

## Host is off: Mac alert

When the host is a VM on a Mac, the desk widget's metrics job (`examples/macos-desk-widget/lib/post-metrics.sh`, every 5 minutes) is also the alert: after two check-ins without an answer (10 minutes) a notification says the agent isn't answering, and whether the VM process is running at all; another says when it is back.

## Install

```sh
for t in backup/tara-backup host/tara-heartbeat host/tara-cleanup; do
  sudo install -o root -g root -m 755 deploy/$t.mjs /usr/local/sbin/$(basename $t)
done
sudo install -o root -g root -m 755 deploy/release/tara-release.mjs /usr/local/bin/tara-release
sudo cp deploy/systemd/tara-{backup,heartbeat,cleanup}.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tara-backup.timer tara-heartbeat.timer tara-cleanup.timer
```

Copy the matching files from `examples/` into `/etc/tara-agent/` and edit them first. Reinstall a tool's copy whenever its file in the repo changes.
