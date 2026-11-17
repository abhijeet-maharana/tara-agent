# Desk phone (plan)

Status: **Voice v2 built** (2026-11-17): "Hey Jarvis" on the phone, Gemini Live as the voice (~1.1–1.5 s from the end of speech to the first word), Phase 4's rules as its tools, Claude (API, or a full Claude Code run in Slack) for anything to check or do, music on the Google Home Mini, every tool call live on the screen. See [Voice v2, step 1](#voice-v2-step-1-as-built) to [step 4](#voice-v2-step-4-hey-jarvis-as-built) and [latency per lane](#voice-v2-latency-and-cost). **Phase 6 (battery) built**, waiting to see the level settle near 80 %. See also [Phase 1: as built](#phase-1-as-built), [Phase 2: as built](#phase-2-as-built), [Phase 3: as decided](#phase-3-as-decided), [Phase 4: as built](#phase-4-as-built) (now the fallback when the host has no Live voice) and [Phase 6: as built](#phase-6-as-built). A living document: update it as decisions are made and phases land.

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

Command's non-goals were a phone UI and a wake word. Those are this plan's main goals. Why it stayed off: jarvis's config says it was turned off on 2026-11-10 because live tasks and Stop moved onto each running session's page, so the tab had little left to do. **Phase 4 did not bring Gemini Live back** (decided 2026-11-17): Android's built-in recognizer and voice are free and answered in about a second; Command's tools and their matching rules (`matchJob`, `matchTask`, the read-only `ask`) were reused. Gemini Live stays the option if on-phone speech turns out too slow or too poor.

## Shape

```
Desk phone: tara phone app (Kotlin shell)
  WebView ── https://<host>:<tls port>/phone ── tara-agent
  │  glance tiles, voice UI, RustDesk button      │
  │                                               ├─ /attention, /runs, /items, /sessions/<id>/live   (existing)
  │  bridge: vibrate · speak · wake screen ·      ├─ /phone/events   SSE: attention changed, run started/ended, urgent alert, late voice answers
  │          lock state · battery · RustDesk ·    │
  │          listen (Android speech → text)       ├─ /phone/voice    POST {text, locked} → {say, panel, expect, unlock} (rules, then a text model)
  └─ foreground service: mic → wake word          └─ tools: needs · running · approvals (read) · jobs · stop · ask · dispatch · quiet · play_music · …
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

1. **Phase 4: push to talk** (built, see [Phase 4: as built](#phase-4-as-built)). Tap 🎙 or the clock. Android's speech recognizer turns it into words on the phone, `/phone/voice` decides the answer, Android's text to speech says it. (The volume-key trigger was left out: the volume keys are needed for the volume.)
2. **Wake word "Hey Jarvis"**: [openWakeWord](https://github.com/dscripka/openWakeWord)'s `hey_jarvis` model **on the phone** (decided and built 2026-11-17, Voice v2 step 4): ONNX Runtime in the shell; audio never leaves the phone until the wake word.
3. **Quiet mode** for films and calls: "Jarvis, quiet mode" (or a tile) pauses listening and spoken alerts for a set time.
4. **Short spoken answers, details on screen:** a tool's result also arrives as a panel, as Command did.

Tools, from Command plus new ones:

| Tool | Does | Allowed while locked |
|---|---|---|
| `attention`, `projects`, `jobs`, `approvals`, `repo`, `status`, `brief` | Read | ✅ |
| `show(page)`, `watch(run)`, quiet mode | Switch the screen, hold alerts | ✅ |
| `ask` (read-only Claude question about a project) | Read | ✅ |
| `play_music(query)`, `music(pause\|resume\|stop\|volume)` | Cast speaker (Phase 5) | ✅ (harmless) |
| `job(run\|pause\|resume)`, `stop`, `dispatch` (start work in Slack) | Act | ❌ needs unlock, then a spoken yes |
| `decide(card, option)` | Act | ❌ not by voice yet (needs the admin key in the Keystore, see below) |

## Music on a Cast speaker

- `play_music("…")` finds the track (`yt-dlp "ytsearch1:…"` for YouTube / YouTube Music; Spotify Connect instead if that is the service) and casts the audio stream to the speaker with the default media receiver (`pychromecast` or `catt`).
- The speaker must be on the same network as the host; discovery is mDNS (`_googlecast._tcp`).
- **Tested 2026-11-17** (Voice v2 step 3): a YouTube audio URL (m4a from `yt-dlp`) plays on the Google Home Mini through the Default Media Receiver, with our own Cast client (`src/live/cast.ts`, no `pychromecast`/`catt`). Stream URLs carry an `expire` about 6 h out; a track is cast right after it is found, so that's enough.
- **Music service:** YouTube (search through `yt-dlp`), decided 2026-11-17. Spotify Connect stays an option.

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
| Bridge (`window.Android`, keyed) | `vibrate`, `speak` (Android TTS for alerts), `lockState`, `battery`, `wakeScreen`; Phase 4: `hasVoice`, `listen`, `cancelVoice`, `voiceText`, `answer` |
| Foreground service | `LinkService` (`specialUse`, since Phase 2) keeps the network up with the screen off, for alerts. Push to talk (Phase 4) didn't need the microphone type: Google's recognizer listens for the app on screen. Phase 5 adds it for the wake word |
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
| 4 ✅ | **Voice**: ~~restore Command's session~~ Android's own speech in and out, Command's tools as rules + a text model, phone front end, push to talk, lock rules, quiet mode | "What's running?" gets a spoken answer in under a second. **Built 2026-11-17**: 0.95 s end of speech → voice for a rule answer (see [Phase 4: as built](#phase-4-as-built)) |
| 5 ✅ | **Wake word + music**: "Hey Jarvis", `play_music` to the Cast speaker | Hands-free from across the room; music plays on the speaker. **Built 2026-11-17 as part of Voice v2** (steps 3 and 4) |
| V2 ✅ | **Voice v2**: Gemini Live + Claude, live steps and cards | **Built 2026-11-17**, see the step sections below |
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
- **Alerts are spoken on the media stream**, so a muted phone speaks silently (seen 2026-11-17). Phase 4's answers raise the media volume to half while they speak, then put it back.

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

## Phase 4: as built

Built 2026-11-17 and checked on the moto g34 against jarvis, with real speech (the Mac's `say` voice next to the phone).

### How the pieces fit

```
Tap 🎙 or the clock
  │
Shell: Voice.kt ── Android SpeechRecognizer (Google's, en-IN, partial results) ──► words
  │                                                          │
  │   POST /phone/voice {text, locked}   (device key; locked = KeyguardManager.isDeviceLocked)
  ▼                                                          ▼
tara-agent: PhoneVoice (src/http/phone-voice.ts)
  1. a pending yes/no? → act or drop
  2. rules: what's running, what needs me, approvals, next up, brief, usage, time, quiet mode,
     run / pause / resume <job>, stop <run>, watch <run>, home / night            ~0–100 ms
  3. else: Gemini 3 Flash (host `voice` endpoint) with the glance as context → {say, panel, action}   1.5–3 s
       action ask      → Claude (haiku, read-only) in the project; answer later as a `voice` event
       action dispatch → a new thread in the project's Slack channel (after unlock + yes)
  │  ← {say, panel?, expect?: confirm, unlock?, watch?, show?, pending?}
  ▼
Shell: says it (Android text to speech, media volume raised to ≥ 50 % while it speaks, then put back)
       expect: confirm → listens again at once;  unlock → Android's unlock prompt, then the same words again
Page:  overlay with what was heard, the answer, its panel, Yes / No
```

| Part | Where | Notes |
|---|---|---|
| Voice turns | `src/http/phone-voice.ts` (`PhoneVoice`) | Rules first, then the model. Per-phone pending question (90 s). Job and run matching from Command's `matchJob` / `matchTask` |
| Route | `POST /phone/voice` in `src/http/server.ts` | Device key only (a token, when one is set, counts as an unlocked phone, for testing). Logs each turn: path, ms, words, answer |
| Quiet mode | `PhoneHub.setQuietMode` (`src/http/phone-events.ts`), `POST /phone/quiet` | Holds alerts like quiet hours (no wake, no buzz), without the Night page; ending it gives one "While you were quiet: …" summary. 🔔 in the bar = one hour; voice takes any length up to 24 h. Not kept across a tara-agent restart |
| Claude questions | `src/runner/ask.ts` (restored from Command) | `claude -p`, `--tools Read Grep Glob`, model `http.phone.askModel` (default haiku), 2 min timeout. The project's jobs (last status and error) go with the question: Claude sees the repo, not run history |
| Model | `chatModel` in `phone-voice.ts`, host `voice` (OmniRoute) | `http.phone.voiceModels` picks models (default `voice.models`); 8 s each, JSON answers |
| Shell | `Voice.kt`, `Bridge` (`hasVoice`, `listen`, `cancelVoice`, `voiceText`, `answer`) | `RECORD_AUDIO`; `<queries>` for `android.speech.RecognitionService` (without it the recognizer is invisible on API 30+). Logs `voice timing: …` per turn |
| Page | `src/http/phone-screen.ts` | 🎙 and a tap on the clock talk; the overlay shows the state (blue listening, amber thinking, green speaking, with the mic level), "Tap to stop" / "Tap to talk again", ✕ closes. Late answers come over `/phone/events` (`voice`) and are said through the shell |
| Config | host `http.phone.voiceModels`, `http.phone.askModel` | jarvis: `voiceModels: [agy/gemini-3-flash, agy/gemini-3.5-flash-lite]` |

### Lock rules, as built

| Request | Locked phone | Unlocked phone |
|---|---|---|
| Questions, screen switching, quiet mode, Claude questions | ✅ | ✅ |
| Run / pause / resume a job, stop a run, hand work to Slack | "Unlock the phone first": unlock prompt, then the question | "Run Blog writer, in Abtara, now?" → **yes** (spoken, or the Yes button) |
| Decide an approval card | ❌ "I can't decide cards by voice" | ❌ same |

The lock state comes from the shell with the device key, never from the page's cookie: a locked phone's page can't claim to be unlocked. A yes is checked again at the moment it arrives (the phone may have locked in between).

### Decisions made while building

- **Android's own speech, not Gemini Live** (owner's call: free first, Gemini Live only if too slow). It wasn't: the recognizer gives the words 80–150 ms after you stop talking.
- **Rules before a model.** Every model tried took 1.5 s or more, so the everyday questions never reach one. The model gets what the rules don't know, and its actions go through the same yes and unlock as the rules'.
- **Gemini 3 Flash, not Flash Lite**, for the model: with the glance as context, Flash Lite (the Slack voice-note models) took 3.7–5.7 s; Gemini 3 Flash 1.5–2.2 s, and its answers were better. Other fast models on OmniRoute weren't available (`agy/gemini-3.6-flash-low`, `dva/*`) or failed (`glm-4.7-flash`).
- **Answers are louder than the phone.** Media volume on the desk phone is 0, so answers raise it to half for as long as they speak, then put it back (unless someone changed it meanwhile). Alerts stay silent (`speakAlerts: false`).
- **No volume-key trigger:** the volume keys are needed for the volume. The wake word (Phase 5) is the hands-free way.
- **Approvals aren't decided by voice** yet: a desk phone that sits unlocked is the wrong place for it, and the plan's admin key in the Keystore behind the unlock isn't built.
- **The text to speech engine starts when the shell connects**: its cold start made the first answer 1.8 s late.

### Checked on the phone (2026-11-17)

Spoken by the Mac's `say -v Rishi` next to the phone; 🎙 tapped over adb. Times are from the end of speech to the first word of the answer (`voice timing` in logcat).

| Said | Heard as | Path | Answer | Time |
|---|---|---|---|---|
| What's running? | ✅ | rule | "Nothing is running." | **0.6 s** (first try 2.2 s: text to speech cold start, since fixed) |
| What needs me? | "what need me" | rule | "73 approval cards." (now "Nothing urgent. 73 approval cards waiting.") | 0.95 s |
| Quiet for ten minutes | "client for 10 minutes" | model | "Quiet until 14:06. Alerts will wait." | 3.0 s |
| Why did the last job fail? | ✅ | model → Claude | "Checking…" at 2.7 s; Claude's answer 31 s later, shown and said | 2.7 s |
| Run the approvals cleanup job | "run the approval screen of job" | rule | ⚠️ answered about approvals (fixed: verb-led sentences act first) | 0.6 s |

After the fixes (shell 461328+): "What needs me?" → rule, **0.43 s** ("Nothing urgent. 74 approval cards waiting."); "Why did the GST prep job stop?" → model, 3.9 s, answered from the job's history ("GSTR-1 Prep was stopped on November tenth").

⚠️ **Open: the recognizer often hears nothing.** In the later tests many sentences came back empty (`ERROR_NO_MATCH`; Google's log: speech detected for ~2 s, then `NO_SPEECH_DETECTED`, no partial results), for example "Any approvals waiting?", and once even "What needs me?", which had worked earlier. Others were cut to their last words ("run the approvals cleanup job" → "job"). Turning the Mac up didn't help. The US Mac voice (Samantha) failed on every sentence; the Indian one (Rishi) mostly worked (the last check: "What needs me?" → "what need me", 0.48 s; "What's running?" → "what's your name"). So the test voice matters, which is why a real voice decides it. The phone's only recognizer is Google's **on-device** one (Speech Services, `com.google.android.tts`, the en-IN pack, `ONDEVICE_MEDIUM_SHORT`); the Google app's online recognizer isn't offered as a service here. Not yet tried with a real voice next to the phone (the owner is checking by hand). If it fails for a real voice too, options: `en-US` instead of `en-IN`, Google's recognizer through `RecognizerIntent` (its own dialog), or Gemini transcription of recorded audio on jarvis (the Slack voice-note path), or Gemini Live after all. The shell logs `partial:` and `final:` lines (`adb logcat -s TaraPhone`) to see what it heard.

### Not done yet

- **Spoken yes over a real job**: the confirm, unlock and run path is unit-tested and the question was asked on the phone, but no job was started by voice in the check (one answer was "no").
- Quiet mode is in memory: a tara-agent restart ends it.
- Hinglish: Google's en-IN recognizer writes Hindi words in Latin script ("kya chal raha hai" reached the model, which answered in Hinglish in the bench); not tried by voice.
- The recognizer is Google's (online when it wants); on-device recognition (`createOnDeviceSpeechRecognizer`) wasn't needed for speed.

## Voice v2: Gemini Live + Claude (decided 2026-11-17)

After Phase 4, the owner asked for "a real Jarvis": a real AI with full access that can do anything, starts on "Hey Jarvis", plays music on the Google Home Mini, finds a movie to watch, checks facts, runs jobs, reads logs and reports back, and shows its work live on the screen (tool calls, cards). Phase 4's Android recognizer hears too unreliably for that, and its rules only know a fixed set of questions.

**Shape: Gemini Live is the voice, Claude is the brain and the hands.**

```
"Hey Jarvis" (openWakeWord on the phone; nothing leaves the phone before it)
   ▼
Phone mic (16 kHz PCM) ──WS──► tara-agent ──WS──► Gemini Live: listens, talks, can be interrupted
   ▲  voice (24 kHz) + panel events      │ tool calls
   │                                     ├─ instant (~1 s): Phase 4's rules as tools (running, needs me, approvals,
   │                                     │    next, quiet, show/watch), play_music / music (Cast → Home Mini)
   │                                     ├─ look up (1–3 s): Google Search grounding (movies, facts), or Claude + web search
   │                                     └─ do (s–min): ask_claude → Claude API (Sonnet 5.5, tara tools + web_search),
   │                                          or a full Claude Code run in tara (repos, logs, browsers, Slack);
   │                                          "on it" now, the result spoken when it ends
   └── every tool call is also a `panel` event: the screen shows it live
```

| Decision | Why |
|---|---|
| Gemini Live for listening and speaking | Natural voice, interruptible, ~1 s, hears Hinglish; fixes Phase 4's recognizer |
| Claude for anything that does or checks something | Stronger at careful multi-step work; tara already runs it with full access |
| Claude API (`claude-sonnet-5-5`, Opus 5.5 for hard ones) for the middle lane | Anthropic API credit (~$900 for 5 months); first words in ~1 s vs several seconds for a `claude -p` start. ~$0.01–0.02 a turn |
| Full Claude Code runs (tara) for big jobs | Subscription, full tools; result spoken when done |
| Every tool call also a `panel` event | Live screen: step strip, cards (needs you, approval cards, run steps, logs, posters, sources, now playing, confirm) |
| Actions still need the phone unlocked + a spoken yes | A voice can't prove it's the owner (a guest, the TV). Questions, search, music, reading logs: no gate |

**Build order:** (1) Gemini Live session restored from Command (`git show 591b2b5^:src/live/gemini.ts`, `session.ts`, `tools.ts`) + phone mic/voice streaming over a WebSocket; (2) the lanes: Phase 4 rules as tools, Google Search, `ask_claude`, Claude Code runs, with a `panel` event per tool call and the new cards; (3) `play_music` to the Home Mini; (4) "Hey Jarvis" on the phone.

**Needs:** a Google AI Studio key (`TARA_LIVE_API_KEY`) and an Anthropic API key (`TARA_ANTHROPIC_API_KEY`) in `/etc/tara-agent.env`. **Both set on 2026-11-17** (the old Live key from Command, in a backup of that file, was no longer valid).

## Voice v2, step 1: as built

Built and checked 2026-11-17 on the moto g34 against jarvis: Gemini Live is the voice, Phase 4's rules are its tools, every tool call shows on the screen.

### How the pieces fit

```
🎙 (or the clock)                                                   jarvis: tara-agent
Shell: LiveVoice.kt ─── wss://<host>:<tls port>/phone/live (device key, pinned TLS) ──► PhoneLive (src/live/phone-live.ts)
  mic: voice-call source + echo canceller, 16 kHz PCM, 40 ms frames  ──────────►          │ GeminiLive (src/live/gemini.ts)
  speaker: AudioTrack 24 kHz, voice-call mode on the loudspeaker  ◄──────────            ├──► Gemini Live (gemini-3.8-live)
  JSON events → page window.taraLive: state, words, steps, cards ◄──────────            └── tools: Phase 4's rules (PhoneVoice), job/stop behind the gate
```

| Part | Where | Notes |
|---|---|---|
| Gemini client | `src/live/gemini.ts` | Restored from Command (`591b2b5^`), plus Google Search grounding, end-of-speech silence (`silenceMs`) and token usage (`usageMetadata`) |
| Session | `src/live/phone-live.ts` (`PhoneLive`) | One per connected shell. Opens Gemini on `start`, closes after `idleSeconds` quiet (nothing pending) or `end_conversation`. Logs each turn (lane, end of speech → first word, tools) and each session (seconds heard and spoken, tokens, ~$) |
| Tools | `RULE_TOOLS` | `running`, `needs_me`, `approvals` (read only), `next_up`, `brief`, `usage`, `jobs`, `quiet`, `show`, `watch`, `job` and `stop` (gated), `confirm`, `end_conversation`. The answers are Phase 4's rule answers (`PhoneVoice`, now public methods) |
| Route | `GET /phone/live` upgrade in `src/http/server.ts` | Same `allowFrom` as every request, device key required, both HTTP and HTTPS listeners. `/phone/session` now says `live: true` so the shell knows |
| Shell | `LiveVoice.kt` (OkHttp WebSocket, pinned like `Net`), `Bridge` (`hasLive`; `listen`, `cancelVoice`, Yes/No go to Live when it is up) | Falls back to Phase 4 (Android speech, `/phone/voice`) when the host has no Live voice |
| Page | `src/http/phone-screen.ts`: `window.taraLive` | Orb, your words, the answer, up to 2 cards (list, confirm Yes/No, sources, posters, Claude, log, run, music), the **step strip** (last 6 tool calls: ● running, ✓, ✗) |
| Config | host `http.phone.live` | jarvis: `model: gemini-3.8-live`, `voice: Charon`, `idleSeconds: 20`, `silenceMs: 400`, `googleSearch: false`, `language: Indian English…Hinglish`. Key `TARA_LIVE_API_KEY` in `/etc/tara-agent.env` |

### The gate for actions

| Situation | What happens |
|---|---|
| `job` / `stop` on a locked phone | Refused to the model; the shell shows Android's unlock prompt; once unlocked the model is told and calls again |
| Unlocked | Nothing runs yet: a **Confirm** card ("Run Content Creator, in Abtara, now?") with Yes / No, and the model asks the same question |
| The model calls `confirm(yes)` | Acts only if **the user's own words since the question** hold a yes (yes, haan, ji, chalao, go ahead…) and no no (no, nahi, mat, leave it…). The model can't say yes for the user |
| Yes / No tapped | Acts (or not) and tells the model what happened |
| 90 s with no answer | The question expires |

### Decisions made while building

- **gemini-3.8-live**, from a bench on jarvis with Rishi's recorded voice (tool call included, end of audio → first audio): 3.8-live **1.7 s** with Google's default end-of-speech wait, **1.25–1.5 s** with 300–500 ms; 3.1-flash-live-preview 2.2–2.4 s; 2.5-flash-native-audio 3.6–3.8 s. 3.8-live also wrote Hinglish correctly ("Jarvis, kya chal raha hai abhi?"); 2.5 heard it as Devanagari noise.
- **`silenceMs: 400`**: 300 was fastest but more likely to cut a sentence at a pause.
- ⚠️ **Google Search is off**: on 3.8-live and 3.1 the search tool closed the session with "You exceeded your current quota" (the key's project has no search-grounding quota; probably needs billing). It worked on 2.5 native audio but took 8 s. Lookups go to Claude with web search (step 2) unless billing is turned on.
- **Echo cancellation through the voice-call path**: mic source `VOICE_COMMUNICATION` with `AcousticEchoCanceler` (available on this phone), playback as `USAGE_VOICE_COMMUNICATION` in `MODE_IN_COMMUNICATION` on the loudspeaker; call volume raised to 70 % while talking, put back after. The model didn't hear itself in any test.
- **Latency is measured on the phone**: last loud mic frame (noise floor learned only while nothing plays) → first frame of the answer, sent to tara-agent and logged per turn with its lane. A turn runs from the user's words to their next words (a tool call splits Gemini's side in two).
- **Hinglish answers in Latin script** after the `language` line was set (the first try answered in Devanagari).

### Checked on the phone (2026-11-17)

Spoken by `say -v Rishi` next to the phone; 🎙 tapped over adb; phone unlocked.

| Said | Heard as | Tool | Answer | End of speech → first word |
|---|---|---|---|---|
| What's running right now? | ✅ | `running` | "Nothing is running right now." | 1.34 s, 1.36 s |
| What needs me? | ✅ | `needs_me` | "Nothing urgent, but there are 75 approval cards waiting." + card | ~1.3 s |
| What's next up? | "What's next" | `next_up` | Next three jobs + card | 1.34 s |
| Jarvis, kya chal raha hai abhi? | "John Lewis, kya chal raha hai abhi?" | `running` | "Abhi kuch nahi chal raha hai." | 1.22 s |
| Jarvis, brief me please | ✅ | `brief` | Briefing | 1.35 s |
| Pause the content creator job | ⚠️ "the content creator job" (said while the briefing was still playing) | `job` → gate | Confirm card "Run Content Creator, in Abtara, now?" | 1.42 s |
| No, leave it | "leave it" | `confirm(no)` | Nothing ran ✅ | 1.29 s |
| Thanks, that's all | ✅ | `end_conversation` | Goodbye, session closed | 1.18 s |

"Brief me" alone (half a second) was not taken as a turn once. The model now asks when it didn't hear the verb instead of assuming "run".

### Cost

Measured from `usageMetadata` (gemini-3.8-live list prices: audio $3 in / $12 out, text $0.75 in / $4.50 out per million tokens):

| Session | Length | Tokens in (text / audio) | Tokens out (audio) | Cost |
|---|---|---|---|---|
| 4 questions | 45 s | 7,425 / 1,966 | 245 | ~$0.014 |
| Briefing + action + bye | 38 s | 10,263 / 3,442 | 348 | ~$0.022 |

**About $0.02–0.04 a minute of conversation (₹2–3).** Text input (instructions, tool list and tool results, re-read on every turn) is the largest part and grows with a longer conversation, which is one more reason the session closes after 20 s of quiet. Nothing is spent while no conversation is open. Ten minutes a day would be roughly $6–12 a month.

## Voice v2, step 2: the lanes, as built

Built and checked 2026-11-17. Gemini answers the quick things itself (step 1's rule tools); everything that needs checking or doing goes to Claude.

| Lane | Tool (Gemini) | Where | What happens |
|---|---|---|---|
| Quick | `running`, `needs_me`, `approvals`, `next_up`, `brief`, `usage`, `jobs`, `quiet`, `show`, `watch`, `job`/`stop` (gated) | `src/live/phone-live.ts` | Phase 4's rule answers, a list card |
| Look up / check | `ask_claude(question, hard?)` | `src/live/claude-lane.ts` (`ClaudeLane`) | Gemini says "on it" at once; Claude (`claude-sonnet-5-5`, effort low; `hard: true` → `claude-opus-5-5`, effort high) works with read-only tara tools and web search; the spoken part is said when it comes, the details go on a **Claude card** |
| Do | `claude_code(project, task)` (gated) | same | A Slack thread in the project, like any tara run (`startThread`, all tools). Its end is told to Gemini (`TASK DONE`), which says how it went; a **run card** opens the Run view |
| Posters | `show_titles` (Gemini or Claude) | same | Poster cards with Wikipedia thumbnails (`/api/rest_v1/page/summary`, "Title (YEAR film)" first) |
| Google Search | built-in grounding | `gemini.ts` | Wired (step and **sources card** from `groundingMetadata`) but **off on jarvis**: the key's project has no quota for it on 3.x Live models |

Claude's own tools (`READ_TOOLS`): `jobs`, `job_runs` (latest runs: status, error, start of output), `run_output` (one run's stored output, script output and error; also a **log card**), `running` (runs in memory with their last steps), `service_log` (tara-agent's own journal, secrets blanked; also a log card), `show_titles`, and `web_search_20260209` (up to 5 searches). Each call is a step on the strip; web searches show as "Web: <query>". Claude answers in two parts: one or two sentences to speak, then `---` and the details for the screen (markdown stripped).

### Decisions made while building

- **The official SDK** (`@anthropic-ai/sdk`), a manual tool loop rather than the SDK's tool runner, so each tool call becomes a step on the screen as it happens. `fallbacks: "default"` (server-side refusal fallback) is on.
- **Long work doesn't block the voice.** `ask_claude` answers Gemini at once (`working`); the result comes as a text turn starting `RESULT` and is spoken 0.5–0.7 s after it arrives. Its step stays ● until then.
- **Prompt caching** on Claude's requests: each round re-sends the logs read so far. The same log question cost **$0.11 before, $0.043 after** (35k of 50k input tokens read from the cache).
- **Gemini goes straight to `ask_claude`** for checking work; when it called `jobs` first, "on it" came at 3.3 s instead of ~1 s.
- **Language follows the user**: an English question once got a Hinglish answer; the instructions now say to answer in the language of the user's last words.
- **`claude_code` is an action**: unlock + a spoken yes, like `job` (the question: "Start Claude in Personal to check how much free disk space is available?").
- Key `TARA_ANTHROPIC_API_KEY` in `/etc/tara-agent.env` (not `ANTHROPIC_API_KEY`, which would change how tara's own `claude` runs are billed). Without it, the Claude lanes are left out.

### Checked on the phone (2026-11-17)

| Said | Lane | What happened | First word | Answer |
|---|---|---|---|---|
| Which job failed most recently, and why? Check the logs. | Claude | 5 steps on the strip (jobs, runs, log, run output, log); "Job Application Submitter was aborted on 16 Nov…", details and two log cards on screen | 2.4 s ("On it, checking the logs") | Sonnet 12.9 s, spoken 0.55 s later |
| Suggest a good comedy movie to watch tonight. | Claude + web | Andaz Apna Apna, Hera Pheri, Chup Chup Ke with posters (Hera Pheri had none on Wikipedia) | 0.96 s | Sonnet 8.2 s, spoken 0.62 s later |
| Who won the cricket world cup in 2023? | Claude | "Australia, beating India in the final", details card | 0.85 s | Sonnet 1.7 s, spoken 0.72 s later |
| Start a Claude Code run in the personal project to check how much free disk space jarvis has | Claude Code | Confirm card → "Yes, go ahead" → thread in Personal's Slack → "There is 167 GB of free disk space available." | 1.64 s (the question) | Run took 7 s; spoken 0.5 s after it ended |
| Which jobs failed this week, and why? (after caching) | Claude | 4 rounds, ~$0.043 | 1.1 s | Sonnet 8.3 s |

## Voice v2, step 3: music, as built

Built and checked 2026-11-17.

| Part | Where | Notes |
|---|---|---|
| Cast client | `src/live/cast.ts` | mDNS discovery (`_googlecast._tcp`, name from the TXT record), Cast v2 over TLS :8009 with hand-encoded `CastMessage` frames, Default Media Receiver (`CC1AD845`): launch, `LOAD`, pause/resume/stop, volume |
| Tools | `src/live/music.ts` (`Music`) | `play_music(query)`: `yt-dlp -j -f bestaudio[ext=m4a]/bestaudio "ytsearch1:<query>"` → cast, a **now-playing card** with the thumbnail. `music(pause\|resume\|stop\|volume\|status)`. Not gated (harmless) |
| Config | host `http.phone.live.speaker` (or `speakerHost`), `music: true` | jarvis: the Home Mini's name as the Google Home app shows it (on the same LAN as jarvis) |

### Decisions made while building

- **Our own Cast client** (~200 lines) rather than Python's `pychromecast`: the protocol needs six protobuf fields; no new runtime on jarvis.
- **Never send a Cast `CLOSE`** when disconnecting: a `CLOSE` to the media app ended playback on the Home Mini (first test: "idle" 8 s after `LOAD`). The connection is just dropped; music goes on.
- **The speaker is found at startup** (`Music.warm()`): mDNS takes ~2.5 s, which made the first "pause" take 3.7 s.
- **The conversation closes once the music is announced** (`endAfter`): otherwise the microphone hears the song and Gemini answers the lyrics.

### Checked (2026-11-17)

| Check | Result |
|---|---|
| jarvis sees the speaker (mDNS) | ✅ the Google Home Mini, by its name |
| Play, pause, stop from a script on jarvis | ✅ (yt-dlp 3.8 s, cast 1.7 s) |
| "Jarvis, play some lofi music on the speaker" | ✅ "1 A.M Study Session [lofi hip hop]": "putting it on" at 1.53 s, found in 4.4 s, cast in 0.55 s, announced 0.64 s later (**music ~6.5 s after the request**), then the conversation closed |
| "Pause the music", "Stop the music" | ✅ 1.72 s, 1.44 s to the spoken answer |

## Voice v2, step 4: "Hey Jarvis", as built

Built and checked 2026-11-17.

```
LiveVoice.kt: one microphone (VOICE_COMMUNICATION, echo canceller) while the screen shows and quiet mode is off
  idle:     40 ms frames → last 1 s kept → WakeWord.kt every 80 ms → score ≥ 0.5 → a conversation opens
  talking:  frames → tara-agent (the kept second first, so "Hey Jarvis, what's running?" arrives whole)
```

| Part | Where | Notes |
|---|---|---|
| Detector | `WakeWord.kt` | openWakeWord's three models (mel spectrogram → embedding → `hey_jarvis_v0.1`) on ONNX Runtime (`onnxruntime-android` 1.20.0, one thread). Port checked against a Python run of the same steps: "Hey Jarvis, what's running right now?" 0.997, a sentence without it 0.001 |
| Models | `wakeWordModels` task in `android/app/build.gradle.kts` | Downloaded at build time from openWakeWord's v0.5.1 release into `build/`, SHA-256 checked. **Not committed**: they are CC BY-NC-SA 4.0 (non-commercial) |
| Shell | `LiveVoice.kt` | Mic on while the shell is on screen and quiet mode is off; 👂 in the bar shows it. A detection buzzes, opens a conversation and sends the last second first. Detections at least 2 s apart; the detector resets after each conversation |
| Page | `phone-screen.ts` | Quiet mode (🔕 or by voice) turns the wake word off (`taraPhone.setWake`) |
| APK | | 6 MB → 28 MB (ONNX Runtime's native library for arm64 only, plus 3.7 MB of models) |

### Decisions made while building

- **One microphone for both**, so nothing said after "Hey Jarvis" is lost to a second recorder starting.
- **The microphone restarts when Jarvis first answers.** Android sets up the echo canceller for the audio mode an input starts in; the wake word's mic starts in normal mode, so in the first version Jarvis heard its own voice and answered it (gibberish transcripts in several languages, and once it started a song). Restarting the mic when the conversation opened garbled the user's sentence ("brief me please" → "inglés"); restarting at the first sound of the answer (the user has finished) works. It restarts again in normal mode after the conversation.
- **A bare "Hey Jarvis" is told apart**: the kept second carries the wake words (heard as "jueves", "John Lewis"); the instructions say to answer "Yes?" and call no tool when that is all. Before that, a bare "Hey Jarvis" started a briefing.
- **Proactive audio** (`proactivity.proactiveAudio`, accepted by 3.8-live, same latency) and an instruction to ignore speech not meant for it: the room's TV and talk reach the microphone.
- The wake word runs in the activity (the shell is the home app and keeps the screen on), not yet in a microphone foreground service: with the screen off it doesn't listen.

### Checked on the phone (2026-11-17)

| Said (`say -v Rishi`, no tap) | Detection | Heard | Result | First word |
|---|---|---|---|---|
| Hey there, what's the weather like today in Mumbai? | none ✅ | | | |
| Hey Jarvis, what's running right now? | 0.88 | ⚠️ "What's playing right now?" | `music` status | 1.47 s |
| Hey Jarvis. … What needs me today? | 0.59 | ✅ (after "Yes?") | `needs_me` | 1.33 s |
| Hey Jarvis, kya chal raha hai abhi? | 0.94 | "Luis, क्या रहा है अभी?" | `running` | 1.23 s |
| Hey Jarvis, what's running right now? (×2) | 0.82, 0.84 | "Hey Jarvis, running right now." | `running` | 1.18 s, 1.29 s |
| Hey Jarvis, brief me please. | 0.98 | "please" | `brief` | — |

## Voice v2: latency and cost

End of speech → first word of the answer, measured on the phone (last loud mic frame → first sound), 2026-11-17, Rishi's voice from the Mac:

| Lane | First word | Full answer |
|---|---|---|
| Quick (rule tools) | **1.07–1.47 s** (typical 1.2–1.35 s) | same |
| Chat (no tool) | ~1.0–1.5 s | same |
| Wake word, one breath ("Hey Jarvis, what's running?") | 1.18–1.47 s | same |
| Claude: a fact | ~0.9 s ("on it") | +1.7 s Claude +0.7 s ≈ **3.5 s** |
| Claude: web + posters | ~1.0 s | +8.2 s +0.6 s ≈ **10 s** |
| Claude: read runs and logs | 1.1–2.4 s | +8–13 s +0.5 s ≈ **10–16 s** |
| Claude Code run | 1.6 s (the question), 1.9 s after "yes" | run time + 0.5 s |
| Music | 1.5 s ("putting it on") | music plays ~6.5 s after the request; pause/stop 1.4–1.7 s |
| (Phase 4, for comparison) | 0.43–0.95 s rules, 2–4 s model | |

The floor is Gemini's end-of-speech wait (`silenceMs: 400`) plus ~0.8 s to the first audio; a session opens in ~0.7 s, during which the mic is buffered on the server.

**Cost.** Gemini Live (gemini-3.8-live list prices: audio $3 in / $12 out, text $0.75 / $4.50 per million tokens), from `usageMetadata`: sessions of 16–56 s cost $0.008–0.03, **about $0.02–0.04 per minute of conversation (₹2–3)**, nothing while no conversation is open. Text input (instructions, tool list and results, re-read every turn) is the largest part, so a long conversation costs more per minute; sessions close after 20 s of quiet. **Not significant**: ten minutes a day is about $6–12 a month. Claude through the API: a fact ~$0.01, a log investigation ~$0.04 with caching (Sonnet 5.5; Opus 5.5 for `hard` is about twice that). The Claude Code lane runs on the subscription like every tara run.

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
| ~~Why did Command stay off?~~ | Answered: its tab had little left once live tasks moved to session pages. Phase 4 uses Android's own speech instead of Gemini Live |
| Decide approval cards by voice? | Needs the admin key sealed in the Keystore behind the phone's unlock (see [Locked vs unlocked](#locked-vs-unlocked)); until then, cards are read out and decided on the Approvals page or in Slack |
| ~~Phone model, Android version, OLED or LCD~~ | Answered: moto g34 5G, Android 15, LCD (see [The phone](#the-phone)). Shell targets API 35, min API 31 |
| Does Overcharge protection hold ~80 % on a phone that is never unplugged? | Whether root is needed at all. The limiter is on (`mUpperLimit:80`, seen 2026-11-17); the Health page's battery check now shows whether it holds |
| ~~Music service (YouTube Music, Spotify, …)~~ | Answered: YouTube through `yt-dlp`, cast to the Home Mini (Voice v2 step 3) |
| ~~Wake word on the phone or on the host~~ | Answered: on the phone (Voice v2 step 4) |
| ~~`android/` in this repo or its own repo~~ | Answered: `android/` in this repo |
| ~~Realtime voice cost per minute~~ | Answered: ~$0.02–0.04 per minute of conversation with gemini-3.8-live, nothing while closed (see [latency and cost](#voice-v2-latency-and-cost)) |
| Google Search grounding on 3.x Live models | The key's project returns "exceeded your current quota" for it; probably needs billing on the project. Until then lookups go to Claude with web search |
| Background speech (TV, other people) | Gemini sometimes answers speech not meant for it; once it started music from a German fragment. Proactive audio and an instruction reduce it; actions still need the unlock and a spoken yes, music doesn't |
| ~~How the pin survives monthly certificate renewals~~ | Answered: the pin moves with an HMAC proof from tara-agent (see [Phase 1: as built](#phase-1-as-built)) |
