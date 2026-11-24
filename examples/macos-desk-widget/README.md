# macOS desk widget

Two glance panels on the Mac desktop, drawn by [Übersicht](https://tracesof.net/uebersicht/):

- **Mac**: CPU temperature and thermal state, CPU use (performance / efficiency cores, 2-minute sparkline), RAM and swap, memory pressure, the virtual machine's share (if tara-agent runs in a VM on this Mac), the top 3 apps by CPU, power draw.
- **Agent**: tara-agent's glance from `GET /glance`: Claude usage (the 5-hour window, and the weekly one once a run since tara-agent's last restart has reported it), needs you with the failing jobs, approvals per project with the 3 oldest cards (`GET /attention`), running now with its latest step, next 3 jobs, and any extra tiles you add.

Both panels are look-only: clicks pass through to the desktop (`pointer-events: none`).

When tara-agent can't be reached, the agent panel dims, keeps the last data and says `offline since hh:mm`; the Mac panel keeps updating. In tara-agent's quiet hours the agent panel says 🌙 quiet; neither panel dims.

**Notifications.** Each new urgent item (a job that starts failing, a check gone red) gives a macOS notification. None in tara-agent's quiet hours; what came then is told in one "overnight" notification when they end. The widget reads `/attention` itself and decides what is new. With `brew install terminal-notifier`, clicking one opens the dashboard; otherwise it opens Script Editor.

**Reporting the Mac to tara-agent** (`./install.sh --metrics`), for a Mac that runs tara-agent's VM: a LaunchAgent posts the Mac panel's numbers to `POST /vmhost/metrics` every 5 minutes, so the Health page (a VM host group and Trends charts) shows the host's heat, memory and the VM's share too. To stop it: `launchctl bootout gui/$(id -u)/com.github.tara-agent.vmhost-metrics` (until the next login), and also delete `~/Library/LaunchAgents/com.github.tara-agent.vmhost-metrics.plist` to remove it for good. The Health rows then go amber after 15 minutes and red after an hour.

## Install

```sh
brew install --cask ubersicht
brew install macmon            # temperature, power, CPU per core type (no sudo)
./install.sh                   # helper, symlink, config.local.sh, Übersicht at login
./install.sh --metrics         # optional: also report the Mac to tara-agent every 5 min
```

Then set `TARA_URL` in `config.local.sh` (git-ignored) to where the dashboard listens, as seen from the Mac (e.g. `http://my-host:4000` on a tailnet). Both panels read it on every refresh.

| Setting (`config.local.sh`) | Default | What it does |
|---|---|---|
| `TARA_URL` | `http://localhost:4000` | tara-agent's HTTP server |
| `TARA_KEYCHAIN_SERVICE` | empty | Only if the host sets `TARA_HTTP_TOKEN`: the login Keychain item holding it (`security add-generic-password -s tara-agent -a "$USER" -w`). Never put the token in a file |
| `VM_LABEL` | `VM` | Name of the VM row (any Apple Virtualization, UTM, QEMU, Parallels or VMware process) |
| `AGENT_NAME` | `tara` | Agent panel title |
| `EXTRA_TILES_URL` | empty | A URL returning more tiles for the agent panel: `{"tiles": [{"label", "items": [{"text", "level": "ok\|warn\|bad\|info", "title"?}]}]}`. Read every 30 s with a 5 s timeout; a failure just hides them |
| `NOTIFY` | `1` | `0` turns the notifications off (including the "agent is not answering" alert from `lib/post-metrics.sh`: after 10 minutes without an answer, and again when it is back) |
| `HOST_NAME` | `Mac` | How this Mac is named in tara-agent when it reports (`--metrics`) |

Panel position and size: `className` at the top of `mac.jsx` and `agent.jsx`. Refresh: `refreshFrequency` (5 s Mac, 30 s agent). Quiet hours (🌙 and held notifications): tara-agent's `http.quietHours`.

## How it works

| File | Role |
|---|---|
| `mac.jsx`, `agent.jsx` | The two widgets. Übersicht runs each one's `command` from its widgets folder, so the folder must be linked there as `tara-desk-widget` (`install.sh` does it) |
| `lib/mac-stats.sh` | Mac numbers as one JSON line: cached macmon sample, `ps` grouped by app bundle, `sysctl` memory pressure, thermal state |
| `lib/macmon-feed.sh` | Keeps one `macmon pipe` running and its latest sample in `~/Library/Caches/tara-desk-widget/macmon.json`. Started by `mac-stats.sh`; stops itself a minute after the last read |
| `lib/thermal.swift` | `ProcessInfo.thermalState` (nominal / fair / serious / critical), compiled by `install.sh` into the cache folder |
| `lib/agent-state.sh` | `curl` of `/glance`, `/attention` and `EXTRA_TILES_URL` (5 s timeout each), as `{name, url, notify, state, attention, extra}` or `{name, url, error}` |
| `lib/notify.sh` | One notification (`terminal-notifier`, else `osascript`); the text goes in as arguments, never as code |
| `lib/post-metrics.sh` | `--metrics`: reshapes `mac-stats.sh` output (JavaScript for Automation, no installs), adds `idleSec` (seconds since keyboard/mouse use, from `ioreg`) and posts it to `/vmhost/metrics`. LaunchAgent `com.github.tara-agent.vmhost-metrics`, errors in `~/Library/Logs/tara-desk-widget.log` |

`/glance` needs no token when `TARA_HTTP_TOKEN` is unset; keep `http.allowFrom` to loopback and your tailnet in that case.

## Cost

Measured on a MacBook Air M4 (10 cores) over one minute: ~1 s of CPU in total (Übersicht's app, server and web view ~0.45 s, the macmon feeder ~0.15 s, the panels' commands ~0.4 s). That is about 0.2 % of the Mac, or under 1 % of one core for Übersicht itself. Starting a fresh `macmon` per sample instead costs ~0.09 s each, which is why the feeder exists.

## Gotchas

- **Use `<>…</>` only with `React` imported** from `uebersicht`: Übersicht compiles fragments to `React.Fragment` but doesn't make `React` global, and the widget fails with "React is not defined".
- **Don't debug a broken widget in Chrome at `http://127.0.0.1:41416`.** Chrome's errors carry no line number, so Übersicht's page asks its server for `?line=undefined` and the server crashes (its source-map lookup throws), taking the desktop widgets with it. Quit and reopen Übersicht if it happens. To test in a browser, run a second server on another port: `cd /Applications/Übersicht.app/Contents/Resources && ./node-arm64 server.js -d "$HOME/Library/Application Support/Übersicht/widgets" -p 41419 -s /tmp/ub`.
- **Anything a command writes to stderr turns its result into an error** (Übersicht answers 500), so the scripts send stderr to `/dev/null`.
- Übersicht runs commands with a bare `PATH`; `mac-stats.sh` adds `/opt/homebrew/bin` for macmon.
- Without macmon, temperature, CPU and power show `—`; RAM, pressure, VM and top apps still work.
- Notifications remember what they told in the widget's `localStorage`. The first run on a Mac only records what is already urgent, so installing it doesn't flood you.
- The VM's RAM is the resident memory of its process, so it can read lower than the VM's configured size.
