# Desk phone (plan)

Status: **Phase 3 closed** (2026-11-17): the desk phone shows the glance screen (Home, Run, Night) live from jarvis, a failing job turns its screen on with the alert, and 🖥 opens RustDesk to see the host's screen (the planned live Chrome view was dropped). **Phase 6 (battery) built** the same day, done before Phase 4: the phone reports its battery and the Health page watches it; waiting to see the level settle near 80 %. See [Phase 1: as built](#phase-1-as-built), [Phase 2: as built](#phase-2-as-built), [Phase 3: as decided](#phase-3-as-decided) and [Phase 6: as built](#phase-6-as-built). A living document: update it as decisions are made and phases land.

A spare Android phone sits on the desk, always on, and keeps you up to date while you do other things (work, a film, another job): what needs you, approval cards waiting, what is running, and (through RustDesk) the host's screen with the shared Chromes. You talk to it ("Hey Jarvis, what's running?", "play some lo-fi") and it answers out loud; music plays on a Cast speaker. When you are away it is locked: it still shows and tells, but it does nothing until unlocked.

The name it answers to is the host's `agentName` (here "Jarvis").

## Why a native app, not the dashboard in Chrome

The dashboard (`/`, `/approvals`, `/health`) is an admin app read up close. A desk panel needs a glance screen and a few powers a browser tab does not have.

| Need | Dashboard in Chrome | Installed web app (PWA) | Our Android shell |
|---|---|---|---|
| Glance tiles, readable across the room | ❌ | ✅ | ✅ |
| Full screen, no address bar | ❌ | ✅ | ✅ |
| Screen stays on | ❌ | While open (Wake Lock) | ✅ Always |
| Speak, vibrate, mic | Mic needs HTTPS | ✅ | ✅ |
| **Turn the screen on by itself for an alert** | ❌ | ❌ | ✅ |
| **Show on the lock screen while locked** | ❌ | ❌ | ✅ |
| **Start on boot, be the home screen (kiosk)** | ❌ | ❌ | ✅ |
| **Listen for a wake word all day** | ❌ | ❌ | ✅ (foreground service) |
| Report battery and charging to tara | ❌ | Partly | ✅ |

The bold rows are why this is a native shell. The screen itself is still a web page served by tara-agent, so it also opens on any other device as a normal page.

## Inspiration: PhoneBox

[PhoneBox](https://github.com/ersinkoc/phonebox) (MIT) turns an old Android phone into a desk panel for a PC. We don't install or fork it (it brings a second agent, ~117 widgets we don't need, and ships several releases a week); we take its ideas. Its "native feel" is a thin shell, not native widgets: ~860 lines of Kotlin around a WebView, and ~8,600 lines of plain JS widgets.

| PhoneBox idea | Where we use it |
|---|---|
| Full-screen WebView, immersive mode, `FLAG_KEEP_SCREEN_ON` | Shell |
| JS ↔ Kotlin bridge (`window.Android`), keyed so sandboxed frames can't call it | Shell bridge |
| Server can toast, vibrate, wake and switch page | Events + alerts |
| Kiosk: home app, start after reboot | Shell |
| Return to the home page when idle, night dim, burn-in pixel shift | Screen |
| App updates served by the agent (PhoneBox uses `adb install -r` over USB; ours is a one-tap prompt over Wi-Fi) | Updates |
| Battery care: keep 50–80 % by switching the power source | Battery |
| The phone only ever sends an action id; the server decides what it may do | Security |
| Pinned TLS certificate + paired key for the phone link | Connection |

The tara job `phonebox-watch` (abtara-monorepo, Sundays) reads new PhoneBox releases and reports ideas worth borrowing.

## Prior art: Command

tara-agent had **Command** (`/command`), a voice control room on Gemini Live, from 2026-11-01 (commit `3943749`) until it was removed on 2026-11-11 (`591b2b5`, "it was off on every host"). Its design is in `git show 3943749:docs/command.md`; its code was `src/live/` (`gemini.ts`, `session.ts`, `tools.ts`, `alerts.ts`, `ask.ts`) and `src/http/command-*`, with tests in `test/live.test.ts` and `test/alerts.test.ts`.

Still in the tree: `GET /attention` (`src/http/attention.ts`, tiers urgent / waiting / later, titles "fit to be read aloud") and the run activity bus (`src/runner/activity.ts`, behind `/sessions/<id>/live`).

Command's non-goals were a phone UI and a wake word. Those are this plan's main goals, so we restore its voice session and tools and give them a phone front end. **Open:** why it stayed off (voice quality, cost, or a desktop tab being the wrong place). The answer decides whether Phase 4 keeps Gemini Live.

## Shape

```
Desk phone: tara phone app (Kotlin shell)
  WebView ── https://<host>:<tls port>/phone ── tara-agent
  │  glance tiles, voice UI, RustDesk button      │
  │                                               ├─ /attention, /runs, /items, /sessions/<id>/live   (existing)
  │  bridge: vibrate · speak · wake screen ·      ├─ /phone/events   SSE: attention changed, run started/ended, urgent alert
  │          lock state · battery · RustDesk      │
  │                                               ├─ /phone/voice    WebSocket: mic PCM in, voice out (restored Command session)
  └─ foreground service: mic → wake word          └─ tools: attention · approvals · decide · jobs · play_music · …
                                                         │
                                                         └─ Cast ──► speaker (Google Home Mini)
```

- **The screen is served by tara-agent** (`/phone`) and cached by a service worker, so it opens at once with the last data and updates without a new APK. The APK only changes when the shell itself does.
- **Data comes from the APIs the dashboard already uses**; `/phone/events` pushes changes so the screen doesn't poll.
- **Connection:** Tailscale on the phone, tara-agent's `http.tls` port, certificate public key (SPKI SHA-256) pinned in the shell. `http.allowFrom` already admits only loopback and the tailnet.

## The screen

Pages, swiped or switched by voice and by the server. Returns to Home when idle.

| Page | Shows |
|---|---|
| **Home** | Needs you (count + top 3 from `/attention`), approvals waiting (per project, oldest age), running now (job, project, running clock, latest step), next up, Claude usage, clock |
| ~~**Chrome**~~ | Dropped: 🖥 in the bar opens RustDesk instead (Phase 3) |
| **Run** | One running session's live steps (`/sessions/<id>/live`), opened from Home or by voice ("watch the blog job") |
| **Night** | Large dim clock, urgent count only; after quiet hours begin or when the room is dark |

Design: big type, one idea per tile, dark theme, colours from the dashboard (red: failing; amber: waiting; blue: running; green: quiet). Reduced motion respected.

## Live Chrome view

> **Dropped on 2026-11-17** in favour of RustDesk (see [Phase 3: as decided](#phase-3-as-decided)). Kept as the design if it is ever wanted.

- **How:** tara-agent opens a CDP WebSocket to the Chrome (`cdpUrl` from host `browsers`), attaches to the chosen page target and calls `Page.startScreencast` (JPEG, max width ~720, quality ~60, every frame acked). Frames go to the phone as MJPEG (`multipart/x-mixed-replace`) at `/phone/chrome/<lock>/live?target=<id>`, so the screen only needs an `<img>`. Node 22's built-in `WebSocket` is enough on the CDP side.
- **Only while watched:** the screencast starts when a viewer connects and stops when the last one leaves.
- **Never disturbs a run:** read-only, no `Target.activateTarget`, no input, no new tabs. Frames arrive only when the page repaints, so a still page shows its last frame.
- **Later:** tap and type through `Input.dispatchMouseEvent` / `Input.insertText`, unlocked phone only, to finish a login from the phone.

## Voice

1. **Phase 4: push to talk.** Tap the core or press a volume key. The mic streams to `/phone/voice`; the restored Command session (realtime voice model + tara tools) answers out loud.
2. **Phase 5: wake word "Hey Jarvis".** [openWakeWord](https://github.com/dscripka/openWakeWord) has a ready-made `hey_jarvis` model. **Open:** run it on the phone (ONNX Runtime in the shell; audio never leaves the phone until the wake word) or on the host (the phone streams 16 kHz PCM all day; simpler app). Leaning to the phone.
3. **Quiet mode** for films and calls: "Jarvis, quiet mode" (or a tile) pauses listening and spoken alerts for a set time.
4. **Short spoken answers, details on screen:** a tool's result also arrives as a panel, as Command did.

Tools, from Command plus new ones:

| Tool | Does | Allowed while locked |
|---|---|---|
| `attention`, `projects`, `jobs`, `approvals`, `repo`, `status`, `brief` | Read | ✅ |
| `show(page)`, `watch(run)` | Switch the screen | ✅ |
| `play_music(query)`, `music(pause\|resume\|stop\|volume)` | Cast speaker | ✅ (harmless) |
| `decide(card, option)`, `job(run\|pause\|resume)`, `dispatch` (start work in Slack) | Act | ❌ needs unlock |

## Music on a Cast speaker

- `play_music("…")` finds the track (`yt-dlp "ytsearch1:…"` for YouTube / YouTube Music; Spotify Connect instead if that is the service) and casts the audio stream to the speaker with the default media receiver (`pychromecast` or `catt`).
- The speaker must be on the same network as the host; discovery is mDNS (`_googlecast._tcp`).
- **To test first:** casting a YouTube audio URL to an audio-only Google Home Mini, and how long a stream URL stays valid.
- **Open:** which music service.

## Locked vs unlocked

The phone uses Android's own lock (PIN / fingerprint). The shell knows the state (`KeyguardManager.isDeviceLocked`).

| State | Shows | Voice | Actions |
|---|---|---|---|
| Locked (you're away) | Everything, on the lock screen (`setShowWhenLocked`) | Questions and screen switching only | ❌ |
| Unlocked | Everything | Everything | ✅ Approve, run, stop, Chrome input |
| Urgent alert | Turns the screen on (`setTurnScreenOn`), shows and says one line | — | Needs unlock |

- **The admin key never sits usable on a locked phone:** `TARA_ADMIN_TOKEN` is stored in the Android Keystore with user authentication required (valid for a few minutes after unlock). A locked phone has no key to send, so the server refuses actions even if the screen is fooled.
- **Voice can't prove who is speaking**, so voice acts only when the phone is unlocked, and still asks for a spoken yes (as Command did).

## Alerts

From `/attention`'s `urgent` tier (and `attention.urgent` rules), pushed over `/phone/events`:

- Screen on, chime, vibrate, one spoken line ("Heads up: Payments sync failed 3 times in a row").
- At most one spoken alert per gap (Command used 30 min); later ones show only. Quiet hours and quiet mode hold them and give one summary after.
- `waiting` items are a count on screen; `later` items only when asked.

## The shell app

| Part | Does |
|---|---|
| Activity | Full-screen WebView on `/phone`, immersive, keep screen on, show when locked, turn screen on for alerts |
| Bridge (`window.Android`, keyed) | `vibrate`, `speak` (Android TTS for alerts when no voice session is open), `lockState`, `battery`, `wakeScreen` |
| Foreground service | `LinkService` (`specialUse`, since Phase 2) keeps the network up with the screen off, for alerts. Phase 4 adds the microphone type: mic for push-to-talk and the wake word; Android allows it because the app is on screen |
| Kiosk | Home app (`CATEGORY_HOME`), start after reboot; optional lock-task mode as device owner (`dpm set-device-owner`, needs a phone with no accounts) |
| Pairing | Scan a QR on the dashboard: host, TLS fingerprint, a one-time code → device key; admin key added separately with a fingerprint-protected unlock |
| Updates | tara-agent serves the APK and its version; the app shows an **Update** prompt (one tap, `REQUEST_INSTALL_PACKAGES`). The desk phone is on a plain charger, not on the host's USB (the host sits by the router), so no adb from the host. While developing, builds go on from the Mac (USB or wireless debugging) |
| Telemetry to tara | Battery %, charging, temperature; becomes a Health check (red when hot, or at 100 % for days) |

Where the code lives: **`android/` in this repo** (decided 2026-11-16), so the app and its `/phone` server change together in one commit and one review. Built and tested in `.github/workflows/ci.yml` next to the TypeScript.

## The phone

Read over adb on 2026-11-16.

| | |
|---|---|
| Model | Motorola **moto g34 5G** (XT2363-5, `fogos`), arm64 |
| Android | **15** (API 35), security patch 2026-09-01 |
| Screen | 720 × 1600, 280 dpi, **LCD** (no burn-in to manage) |
| Battery | 5,000 mAh, **41 cycles, full capacity = design capacity** (healthy) |
| Bootloader | Locked, verified boot green, OEM unlock not allowed in Developer options. Root would need Motorola's unlock program and wipes the phone |
| Built-in charge care | Moto **Overcharge protection** and **Optimized charging** (`com.motorola.actions`; `BatteryService` reports `AdaptiveCharging` upper/lower limits, `persist.sys.battery_care_dynamic_support=true`) |
| Already installed | Tailscale |

## Battery and power

- **Always on at 100 % wears and can swell the battery.** The moto g34 has a built-in cap, so **no root needed at first**: turn on **Settings › Battery › Overcharge protection** (holds the charge around 80 % when plugged in for long) and check the level settles there. Root (charge switch, or a module like ACC) only if that turns out not to hold.
- **What root would add:** software control of charging through the charger driver's sysfs switches (the phone exposes `battery`, `qcom_battery`, `mmi_battery`, `bms`, `usb` power supplies; their files need root to read). Typical Qualcomm switches: stop charging while the charger keeps powering the phone (battery idle), or cut the input so the phone runs on battery. Which ones this kernel has, and whether "battery idle" truly holds, is unknown until rooted. Software can't physically disconnect the battery.
- **Electricity:** about 2–3 W with the screen on at medium brightness, plus ~0.5–1 W charger loss: **~2–4 W, ~2 kWh a month** (about ₹15–20). Night dim lowers it. A wake word on the phone adds little; on the host it is a few % of one core. Estimates; a USB power meter gives the real figure.
- **Burn-in:** not a concern on this LCD. Keep the dim-after-idle and Night page for power and comfort; add pixel shift only if an OLED phone is used later.

## Phases

| # | Phase | Done when |
|---|---|---|
| 1 ✅ | **Shell app**: WebView, immersive, keep awake, show when locked, pairing + pinned TLS, bridge, APK served by tara-agent | The phone opens a placeholder `/phone` full screen, over Tailscale, and stays on after a reboot. **Done 2026-11-17** |
| 2 ✅ | **Glance screen + events**: Home, Run, Night pages; `/phone/events`; urgent alerts that wake the screen | You can see needs-you, approvals and running from across the room, and a failing job lights the phone up. **Done 2026-11-17** |
| 3 ✅ | ~~**Live Chrome**: CDP screencast, profile tiles, full view~~ → **RustDesk button** | 🖥 on the desk screen opens RustDesk (after the phone's unlock). **Closed 2026-11-17**: live view dropped, see [Phase 3: as decided](#phase-3-as-decided) |
| 4 | **Voice**: restore Command's session and tools, phone front end, push to talk, lock rules, quiet mode | "What's running?" gets a spoken answer in under a second |
| 5 | **Wake word + music**: "Hey Jarvis", `play_music` to the Cast speaker | Hands-free from across the room; music plays on the speaker |
| 6 🔶 | **Battery**: telemetry, Health check (red when hot or stuck at 100 %); Moto Overcharge protection, root only if it doesn't hold | Battery stays at or under ~80 %. **Built 2026-11-17** (done before 4 and 5: small, and the phone sat at 97–100 %); open until the level is seen holding near 80 %. See [Phase 6: as built](#phase-6-as-built) |
| Later | A text-only tab list per Chrome on the screen (no images, no cost) if RustDesk is too slow for a glance; more PhoneBox ideas from `phonebox-watch` | |

## Phase 1: as built

Built 2026-11-17 and checked on the moto g34 over Tailscale.

### How the pieces fit

```
Dashboard › Phone (/phone/pair) ── QR: tara-phone://pair?h=<host>&p=<tls port>&k=<spki>&c=<code>&n=<agentName>
      │
Shell scans it (or `adb shell am start -d '<link>'`)
      │  POST /phone/pair {code, name}           over HTTPS, trusted only if the key hash = k
      ▼  ← {id, key}                              key kept in the shell, sealed with an Android Keystore key
Shell: POST /phone/session  (Authorization: Device <id>:<key>)
      ▼  ← {session}                              day-long cookie tara_phone=<id>.<expiry>.<HMAC>
WebView: GET /phone  (cookie)                     page certificate checked against the pin again
```

| Part | Where | Notes |
|---|---|---|
| Server | `src/http/phone.ts`, routes in `src/http/server.ts` (`phoneRoute`) | Devices in the `phone_devices` table (key stored as SHA-256 only). Pairing codes: 80 bits, 10 min, once; 20 wrong in a row locks pairing until a good one |
| Session cookie | `tara_phone` | Signed with the device key's hash, 24 h, renewed by the shell every 12 h. Forgetting the phone on the dashboard ends it at once. Allows **GET anywhere** (Phase 2 reads `/attention`, `/runs`…) and `/phone/*`, never other writes |
| Dashboard | **Phone** in the sidebar (shown when `http.tls` is set or a phone is paired) | QR, paired phones (last seen, app version, Forget), APK version |
| Shell | `android/` (Kotlin, min API 31, target 35, AGP 8.13, Gradle 8.14, no AndroidX UI libs) | `MainActivity` (WebView, immersive, keep screen on, show when locked, home + launcher + pairing link), `Bridge`, `Net` (pinned HTTPS), `Settings` (Keystore-sealed key), `Updater`, `BootReceiver` |
| Bridge | `window.Android` (keyed) and `window.taraPhone` (key bound) | Methods: `vibrate(ms)`, `speak(text)`, `lockState()`, `battery()` (JSON), `wakeScreen()`, `version()`, `openSetup()`. The key goes only to frames from the paired origin (`addDocumentStartJavaScript` with an origin rule) |
| Updates | `cd android && ./gradlew publishApk` → `android/apk/tara-phone.{apk,json}` | Mutagen carries it to jarvis; `GET /phone/app.json` / `app.apk`. The shell checks 5 s after connecting and every 6 h, asks "Update", verifies SHA-256, hands it to Android's installer |
| CI | `android` job in `.github/workflows/ci.yml` | Unit tests, lint, release build (debug-signed) |

### Decisions made while building

- **Pin the public key, and let it move with proof.** jarvis's certificate is Let's Encrypt from `tailscale cert`, renewed monthly by `tara-agent-cert.timer`, possibly with a new key. A fixed pin would strand the phone each month. On a mismatch the shell asks `POST /phone/pin` with a nonce; tara-agent answers HMAC(sha256(device key), `pin.<nonce>.<spki>`). Only tara-agent has that hash, so the shell can move its pin without a new QR. The new certificate must also be system-trusted. A self-signed `http.tls` certificate works too (trusted by pin alone), but then a key change needs a new QR.
- **The device key never enters the WebView.** Native calls carry it; the WebView only gets the day-long session cookie. WebView has no pinning API, so the shell checks the pin on its own connections and on the page certificate after each load (`WebView.getCertificate()`); the tailnet's WireGuard is the main protection anyway.
- **Version code = minutes since 2026-01-01**, so any newer build is an update. Release signing key: `~/.android/tara-phone.jks` on the Mac, passwords in `~/.gradle/gradle.properties` (outside the public repo). **Keep that key**: an update signed with another key won't install (uninstall + re-pair would be needed). CI uses the debug key.
- **Mutagen** (`tara-agent-sync`) now also ignores `**/build`, `**/.gradle`, `**/.kotlin`, `**/local.properties`, so Gradle output never syncs to jarvis; `android/apk/` does.
- QR library on the server: `qrcode-generator` (MIT, no dependencies). QR scanning on the phone: Google's code scanner (Play services; no camera permission).

### Phone set-up (done over adb)

| Setting | Why |
|---|---|
| Tara Phone is the **home app** (`cmd role add-role-holder android.app.role.HOME com.abtara.taraphone`) | Opens after a reboot; Home goes back to it. Undo: Settings › Apps › Default apps › Home app, or the shell's **Choose home app** button |
| **Tailscale always-on VPN** (`settings put secure always_on_vpn_app com.tailscale.ipn`) | Tailscale reconnects after a reboot |
| **Install unknown apps** allowed for Tara Phone (`appops set … REQUEST_INSTALL_PACKAGES allow`) | One-tap updates |

The shell's own panel (⚙ on the page, or shown when unpaired / offline) has **Scan pairing QR**, **Retry**, **Phone apps** (opens Moto's launcher with every app; **Home** comes back to the desk screen), **Android settings** and **Choose home app**: the ways out of the kiosk.

**Back** never leaves the screen: it only closes that panel (before a fix on 2026-11-17 it went back in the page history to a blank page and left the screen black). The page history is cleared each time `/phone` loads.

**When to scan a QR again:** only for a new phone, after reinstalling the app or clearing its data, or after **Forget** on the dashboard. The QR is on the dashboard's **Phone** page (`https://<host>:<tls port>/phone/pair`, or Phone in the sidebar); on the phone, ⚙ › **Scan pairing QR**.

### Checked on the phone (2026-11-17)

| Check | Result |
|---|---|
| Pair from the dashboard's link, open `/phone` full screen over Tailscale | ✅ |
| Bridge: lock state, battery, version on the page; vibrate; speak (Google TTS) | ✅ |
| `wakeScreen` from the page with the screen off and the phone locked; page shows over the lock screen | ✅ |
| Force-stop → reopens and reconnects from the stored pairing | ✅ |
| Reboot → home app opens, Tailscale reconnects, `/phone` shows | ✅ (first tries fail until Tailscale is up; the retry with back-off gets it) |
| Update: newer APK on jarvis → prompt → install → back on screen at the new version | ✅ |
| Scanning the QR with the camera | Not tried yet (pairing used the same link through adb) |
| Pin move after a certificate renewal | Unit-tested (proof matches the server's); not yet seen live (next renewal ~2026-12-01) |

### Notes for later phases

- Tailscale on the phone can turn off (seen 2026-11-17, twice, cause unknown; always-on VPN was set). The shell then shows "Connecting…" and retries every ≤ 2 min, but can't turn Tailscale on itself. Phase 6's Health check should flag a phone not seen for a while (**done 2026-11-17**: "link" check, warn after 30 min, alert after 2 h). Over adb it comes back with `adb shell am broadcast -a com.tailscale.ipn.CONNECT_VPN -n com.tailscale.ipn/.IPNReceiver`. **Since 2026-11-17 the shell sends that itself** (`Tailscale.kt`) when a connection fails the way a missing tailnet does (name doesn't resolve, no route, timeout, link cut), at most every 2 min: Tailscale switched off by hand came back in 3 s.
- Landscape matters: the phone sits sideways, so pages must fit 914 × 411 CSS px (and 411 × 914 portrait) without scrolling. (Done in Phase 2: checked at both sizes, no scroll.) **Since 2026-11-17 the shell is fixed to landscape** (`screenOrientation="sensorLandscape"`: either way up by the sensor, even with auto-rotate off). Before, it followed Android's single rotation setting, which any portrait-only app (Tailscale, RustDesk, the installer) resets to portrait, so the desk screen kept coming back in portrait. Checked: rotation setting forced to portrait → the desk screen still shows landscape.
- After a reboot of a PIN-locked phone, Android keeps app storage locked until the first unlock, so apps (Tailscale too) wait for it. In the test reboot the user was already unlocked within a minute; not checked whether someone unlocked it by hand. If the screen waits after a power cut, one unlock starts it.
- Without `TARA_HTTP_TOKEN`, the dashboard (and so `/phone`, the Phone page, `app.json`) is open to every device `http.allowFrom` admits, e.g. the whole tailnet. Set the token when other people or devices share that network; the phone keeps working through its own session.

## Phase 2: as built

Built 2026-11-17 and checked on the moto g34 against jarvis.

### How the pieces fit

```
tara-agent                                                     desk phone
 PhoneHub (src/http/phone-events.ts)
  ├─ every 5 s: approvals, running, next up, usage → state  ──┐
  ├─ every 60 s, on connect, 3 s after a run ends: /attention │  GET /phone/events (SSE)
  │    new urgent item → alert (spoken? held?)              ──┼──► page (WebView, session cookie): Home / Run / Night, banner
  └─ run started / ended (activity bus)                     ──┘──► shell AlertStream (device key): wake, vibrate, speak
 GET /phone/run/<task id>  ◄── Run page, every 1.5 s
```

| Part | Where | Notes |
|---|---|---|
| Hub | `src/http/phone-events.ts` (`PhoneHub`) | Builds the glance, runs the alert rules, serves the event stream. Works only while a phone is connected (no git or GitHub reads otherwise) |
| Screen | `src/http/phone-screen.ts` (`phoneScreen`) | One page, three views, no libraries. Renders from `state`; keeps the last one in `localStorage` so a reload shows data at once |
| Routes | `src/http/server.ts` (`phoneRoute`) | `GET /phone/events`, `/phone/state` (the glance as JSON), `/phone/run/<task id>` (one run's steps and text). Session cookie or token; the events stream also takes the shell's device key |
| Config | host `http.phone` | `quietHours: {from, to}` (default 23:00–07:00, host timezone), `alertGapMinutes` (default 30), `speakAlerts` (default true). jarvis: `speakAlerts: false` (decided 2026-11-17, see below) |
| Urgent rule | host config | `attention.urgent: [{consecutiveFailures: 1}]`: any failing job is urgent (about one a week on jarvis). Without a rule nothing is ever urgent |
| Shell | `AlertStream.kt`, `LinkService.kt`, `Tailscale.kt` | The shell's own line to `/phone/events`; a foreground service keeps its network up with the screen off; when the tailnet looks down, the shell asks Tailscale to connect. Bridge adds `nativeAlerts: true` |

### Events (`/phone/events`)

| Event | When | Data |
|---|---|---|
| `state` | On connect, and whenever the glance changes ("attention changed") | Needs you (urgent and waiting counts, top 3, approvals left out), approvals per project (count, oldest, its title), running and recent runs (latest step), next 3 scheduled runs (jobs every ≤ 30 min left out), Claude usage, quiet hours, alerts of the last 6 h, held count, `build` |
| `run` | A run started or ended | `{phase, task}`: the page shows an 8 s toast (▶ started, ✓ done, ✗ failed) |
| `alert` | A new urgent item | `{text, items, wake, speak, held}` |
| `ping` | Every 20 s | Lets both ends notice a dead link (the page reconnects after 60 s of silence, the shell's read times out) |

`build` is when tara-agent started: an open page reloads itself when it changes, so a deploy reaches the phone without touching it.

### Alert rules

| Situation | Screen | Vibrate | Speak |
|---|---|---|---|
| New urgent item, nothing spoken in the last 30 min | On, red banner | 700 ms | ✅ "Heads up: Payments sync failed 3 times in a row." |
| Another within 30 min | On, banner | 300 ms | ❌ |
| In quiet hours (23:00–07:00) | Stays off; Night page counts it ("2 alerts for the morning") | ❌ | ❌ |
| First check after quiet hours, if any were held | On, amber "While you were away" banner | 700 ms | ✅ "Overnight: …" (one line for all) |
| `speakAlerts: false` (**jarvis**) | As above | 300 ms | ❌ never |
| Already urgent when tara-agent starts | Shown on Home, not announced | | |

Failing again (a longer streak) counts as new. The banner hides on a tap or after 5 min.

### The pages

| Page | Shows | Goes back |
|---|---|---|
| **Home** | Clock and date; Claude usage bar; Next up (3); tiles **Needs you** (red when urgent, amber when waiting, green when clear), **Approvals** (per project, oldest first), **Running** (running clock, project, latest step; tap one for Run). Landscape: clock column + 3 tiles side by side; portrait: stacked, count beside the list | |
| **Run** | Title, project, kind, steps count, big running clock; the latest ~30 steps (✓ ✗ ●, sub-agent steps indented, newest at the bottom); Claude's latest text | Home 60 s after the run ends, after 10 min untouched, or **‹** |
| **Night** | Black, large dim clock, date, urgent count, held alerts | In quiet hours after 60 s untouched; a tap shows Home for a minute |

### Decisions made while building

- **One stream with the whole glance, not the page calling `/attention`, `/runs`, `/items` itself.** The server already has every piece in memory; a single `state` event keeps the phone from polling and from showing half-updated tiles. Run steps come from `/phone/run/<task id>` (the activity bus), not `/sessions/<id>/live`: a run that just started has no session id yet.
- **Alerts are decided on the server**, so the 30-min gap and quiet hours hold for every screen at once, and tests cover them (`test/phone-events.test.ts`).
- **The shell, not the page, makes the noise.** With the screen off, Android 15 cuts the network of an app whose screen is asleep (`network_blocked_for_top_sleeping_and_above: true` in `dumpsys netpolicy`) and parks the WebView's page process. The first live test (12:12) failed for that reason: the job failed, the server knew, the phone stayed dark. Fix: `AlertStream` (native, device key) wakes the screen, vibrates and speaks; `LinkService`, a `specialUse` foreground service, keeps the app's network up. The page shows the banner (also for an alert that came while it wasn't listening, if under 3 min old) and leaves the sound to the shell when `taraPhone.nativeAlerts` is set. In a plain browser the page does it itself where it can.
- **Every connect reads `/attention`**, so a phone that was offline hears what turned urgent meanwhile.
- **Alerts on jarvis show, they don't speak** (owner's call, 2026-11-17): the phone sits by someone who watches films, works another job and sleeps nearby, so a voice out of nowhere disturbs. An alert lights the screen (over the lock screen) with the red banner and buzzes once, short; the phone stays muted. Spoken answers come when asked (Phase 4: "Jarvis, what happened?"). Host `http.phone.speakAlerts: false`.

### Checked on the phone (2026-11-17)

| Check | Result |
|---|---|
| Home with jarvis's live data (70 approvals over 3 projects, a running job, next up, usage) | ✅ |
| Fits 914 × 411 and 411 × 914 with no scroll (browser at both sizes; phone in portrait and landscape) | ✅ |
| Deploy reaches the phone: after a tara-agent restart the open page reloaded itself (new `build`) | ✅ |
| Run page (tap a running job): steps, clock, latest text | ✅ in the browser preview |
| Night page and the urgent count | ✅ in the browser preview (quiet hours forced) |
| **A failing job lights the phone up**: screen off and locked, a throwaway job that replies `❌` started at 12:28:24; screen on at 12:28:35 (`Waking up … details=tara:wake`), red banner "Phone alert test failed 3 times in a row." over the lock screen, vibration | ✅ |
| Spoken line | ⚠️ Second test (12:55, screen off): screen on, and text to speech played the line for 4 s (`CONTENT_TYPE_SPEECH` player in `dumpsys audio`), but Android muted it: the phone's **media volume is 0** (ringer silent, alarm 1/7). Speech uses the media stream. Settled by the decision below: alerts aren't spoken on jarvis |
| Tailscale switched off by hand → the shell turns it back on | ✅ in 3 s |
| Quiet-hours hold and morning summary | Unit-tested only |

The throwaway job (`personal/phone-alert-test` and its skill) was removed after the test; its three failed runs stay in the personal channel and run history.

### Not done yet

- **Service worker** (open at once offline): only `localStorage` of the last state so far.
- **Night dimming** is colour only; the backlight stays as set. A bridge `brightness(f)` would lower it (shell change).
- A spoken alert counts toward the 30-min gap even if no phone heard it (e.g. the shell was offline).
- The foreground service's notification is hidden (no notification permission asked); grant `POST_NOTIFICATIONS` to see "Listening for alerts".
- **Alerts are spoken on the media stream**, so a muted phone speaks silently (seen 2026-11-17). Matters again in Phase 4: spoken answers need the volume up while answering (or their own stream).

## Phase 3: as decided

Decided 2026-11-17, before the phone page was built.

### Why no live Chrome view

| | Live Chrome view (planned) | RustDesk (chosen) |
|---|---|---|
| To look | Swipe on the desk screen | 🖥, unlock, connect |
| Shows | Any tab, even one behind another window | jarvis's screen: the top window of the Chromes |
| Click and type (finish a login, a captcha, 2FA) | ❌ (a later phase) | ✅ |
| Cost while nobody watches | Zero | Zero |
| Cost while watching | A few % of a core on jarvis and ~0.3–0.6 MB/s (estimate, not measured) | Similar, only while connected |
| Work | A new server module, a phone page, tests | One button |

When a browser run needs the owner it is nearly always for a login or a captcha, which needs input; watching a run is nice but rare. RustDesk already does both.

### What was checked first

On jarvis's Chromes (headed, Wayland, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`), `Page.startScreencast` on a tab opened in the background gave ~10 frames a second for an animated page without activating it, and every tab reported `visibilityState: visible`. So a read-only live view of any tab is possible. Two more findings, useful if the view comes back:

- **CDP can't tell which tab is in front:** `document.hasFocus()` and visibility were true for both tabs, and `Target.getTargets` has no such field. `/json/list` order (most recently opened or active first) is the best guess.
- `Page.captureScreenshot` on a background tab with a still page hung (no new frame to capture); the screencast sends the current frame at once, so use that.

The test tabs were closed. The server code started for it (`src/http/phone-chrome.ts`, routes `/phone/chrome…`) was removed before commit.

### As built

| Part | Where | Notes |
|---|---|---|
| Button | `src/http/phone-screen.ts`, bar | 🖥, shown when the shell reports RustDesk installed (`taraPhone.hasRemote()`) |
| Bridge | `Bridge.kt`: `hasRemote()`, `openRemote()` | Opens `com.carriez.flutter_hbb` (RustDesk). On a locked phone it asks for the unlock first (`requestDismissKeyguard`): remote control is never one tap away on a locked phone |
| Manifest | `<queries>` adds RustDesk's package | Needed to see the app on API 30+ |

Home on the phone comes back to the desk screen from RustDesk (the shell is the home app).

### Checked on the phone (2026-11-17)

| Check | Result |
|---|---|
| 🖥 shows in the bar (shell 461270) | ✅ |
| Tap while locked → Android's unlock prompt | ✅ |
| Desk screen stays landscape after the rotation setting is reset to portrait (shell 461274) | ✅ |
| After unlocking, RustDesk opens and connects to jarvis | Not checked (needs the owner's unlock) |

## Phase 6: as built

Built 2026-11-17, ahead of Phases 4 and 5, and checked on the moto g34 against jarvis.

### How the pieces fit

```
Shell: Telemetry (every 10 min, device key) ── POST /phone/telemetry {battery: {level, charging, plugged, temperature}}
                                                     │
tara-agent: phone_battery table (14 days) ◄──────────┘
            ├─ Health page, group "Desk phone": <phone>: link, <phone>: battery  (bad → Slack alert, as other checks)
            └─ Dashboard › Phone: latest battery next to each paired phone
```

| Part | Where | Notes |
|---|---|---|
| Shell | `Telemetry.kt` (thread, started with the alert stream), `Bridge.batteryJson` | First report right after connecting, then every 10 min |
| Route | `POST /phone/telemetry` in `src/http/server.ts` | Device key only; level 0–100 checked; also counts as "seen" |
| Store | `phone_battery` (migration), `Store.addPhoneBattery` / `phoneBattery` | Rows older than 14 days dropped on insert; forgetting a phone drops its rows |
| Health | `phoneChecks` in `src/health/checks.ts`, wired in `src/index.ts` | Reads the last 4 days (`PHONE_BATTERY_DAYS`) |

### Health rules

| Check | Warn | Bad (posted to Slack) |
|---|---|---|
| **link** | Not heard from for 30 min, or never reported | 2 h |
| **battery**: heat | ≥ 40 °C | ≥ 45 °C |
| **battery**: held full | Every report ≥ 95 % for a day | For 3 days ("charge protection isn't holding") |
| **battery**: running down | ≤ 25 % and not charging ("is the charger plugged in?") | ≤ 10 % |

One report under 95 % in the span counts as protection working. Detail line example: `80 % · on battery · 30.2 °C`.

### Moto's charge limiter, as seen

`dumpsys battery` on 2026-11-17 (13:30): `AdaptiveCharging … mUpperLimit:80, mChargingDisabled:true`, level 97 %, no power coming in (`usb/online 0`, `plug=none`), drawing ~0.2 A with the screen on. So the limiter is on (upper limit 80) and had stopped charging 41 min earlier. Android then reports the phone as **on battery**, not "plugged in, not charging", so the Health detail says "on battery" while Moto holds it. The charger **was** plugged in (owner, 2026-11-17), so this is Moto cutting the input to bring the battery down to 80 %: on this phone "on battery" at 80–100 % with the charger in is the limiter working. Still to see: the level holding near 80 % over the next hours.

### Checked (2026-11-17)

| Check | Result |
|---|---|
| Report reaches jarvis after install (shell 461281) | ✅ 97 %, not charging, 30.2 °C |
| Health page: `moto g34 5G: link` and `: battery` | ✅ both ok |
| jarvis database backed up before the migration | ✅ `tara.db.bak-2026-11-17-phone-battery` in the state folder |
| Level settles near 80 % on the charger | Waiting |

## Open questions

| Question | Decides |
|---|---|
| Why did Command stay off? | Whether Phase 4 keeps Gemini Live or tries another realtime model |
| ~~Phone model, Android version, OLED or LCD~~ | Answered: moto g34 5G, Android 15, LCD (see [The phone](#the-phone)). Shell targets API 35, min API 31 |
| Does Overcharge protection hold ~80 % on a phone that is never unplugged? | Whether root is needed at all. The limiter is on (`mUpperLimit:80`, seen 2026-11-17); the Health page's battery check now shows whether it holds |
| Music service (YouTube Music, Spotify, …) | How `play_music` finds and casts |
| Wake word on the phone or on the host | Phase 5 design |
| ~~`android/` in this repo or its own repo~~ | Answered: `android/` in this repo |
| Realtime voice cost per minute | Session idle timeout, wake-word strictness |
| ~~How the pin survives monthly certificate renewals~~ | Answered: the pin moves with an HMAC proof from tara-agent (see [Phase 1: as built](#phase-1-as-built)) |
