# Command (design)

Status: steps 1–7 built (attention feed, Gemini Live session, the page, panels and actions, live tasks, the console look, urgent alerts and briefings). Later: a wake word, a Mac-wide hotkey, a wall mode for a second screen.

Command is a voice-driven control room for every connected project. You talk to tara from a browser tab, it answers out loud in real time, and whatever it looks up or does shows up on screen next to the conversation: what needs you, a project's jobs, a repo's changes, approval cards with their buttons, answers to questions. Every Claude run (a Slack chat, a scheduled job, a question, a task handed over by voice) shows as a **live task** with its steps as they happen, and can be stopped from there. It also works without voice: each project's buttons open the same panels.

It is quiet by default. It speaks when you talk to it, and interrupts on its own only for what you have marked urgent.

(Command was called Live before. `/live` redirects to `/command`, and `/live/ws` still connects.)

## Goals

- **Real-time conversation.** Under a second to the first spoken word, and you can talk over it to cut it off.
- **Every project.** It sees every connected project: jobs, approvals, repo state. Work still runs in that project's own session, with its CLAUDE.md, skills, approvals and Slack channel.
- **Say little, show a lot.** Spoken answers are a sentence or two; lists, diffs and cards go on screen.
- **Acts, with care.** It runs and pauses jobs and decides approvals, but only after you confirm. Anything bigger goes to Claude in Slack.
- **Not a distraction.** No small talk, no unprompted updates.

Not goals: a wake word, a phone UI (the page works on a phone, but isn't designed for it), replacing Slack.

## Shape

A realtime voice model listens and speaks. Claude stays the brain, reached through tools. Claude has no speech-to-speech API, and tara only drives Claude through the `claude` CLI.

```
Browser /command ──WS (PCM audio, JSON)──► tara-agent ──WS──► Gemini Live (Google AI Studio)
  Systems · voice · Operations             │  ▲
         ▲                                 │  └── tool calls ◄──┘
         └──── panels, overview ◄──────────┤
                                           ▼
      attention · projects · jobs · job · repo · approvals · decide · ask · dispatch · status · focus
                                           │
                       Store, scheduler, git, gh, claude -p, approvals, Slack
```

- **tara proxies the audio.** The browser never sees the API key, and every tool call is checked on the server.
- **Every tool call is also a panel.** The session sends the tab a `panel` event with the same data it gives the model, so the model can say "it's on your screen" instead of reading a list.
- **Every run is a live task.** The one Runner the process uses is wrapped by an activity bus (`src/live/activity.ts`). Runs carry a `label` (project, kind, title, Slack thread); the bus turns their stream events into tasks with steps ("Reading src/sync.ts", "Running npm test"), streamed text and the outcome, and passes on the CLI's usage-window reports. Runs without a label (learning after a session) aren't shown.
- **Buttons and voice share one path. A panel's Run now or Approve goes over the same WebSocket into the same code as the `job` and `decide` tools.
- **Session only while talking.** The upstream session opens when you start talking and closes after `idleSeconds` of quiet. A closed session can't speak, which keeps it quiet and costs nothing per minute. The page itself (Systems, buttons, panels) works with the voice session closed.
- **Protocol:** Gemini Live (`BidiGenerateContent`) first, behind a small adapter (`open`, `sendAudio`, `onAudio`, `onToolCall`, `sendToolResult`, `close`) so an OpenAI Realtime adapter can be added later.

## Tools the voice model gets

| Tool | Does | Panel | Speed |
|---|---|---|---|
| `attention()` | Tiered list: pending approvals and permission prompts, failing jobs, uncommitted work, PRs waiting on you / red CI from `gh` (cached) | Needs you | Instant |
| `projects()` | Every project: running, failing and paused jobs, waiting approvals, branch, uncommitted files | Refreshes Systems | Instant |
| `jobs(project?)` | Scheduled jobs with state, next run, last error | Jobs, with Run now / Pause / Resume | Instant |
| `job(action, project, job)` | `run`, `pause` or `resume` one job, matched by id or name ("sync" finds "Payments sync" if only one job contains it) | Action line; Jobs refreshed | Instant |
| `repo(repo, file?)` | Branch, last commit, uncommitted changes (from the Code page's reader); with `file`, that file's diff | Changes (each file opens its diff), or Diff | Instant (cached) |
| `approvals(project?)` | Waiting cards with ids and options | Approvals, with option buttons | Instant |
| `decide(id, option)` | Decides a card as its project's owner, as on the Approvals page | Action line; Approvals refreshed | Instant |
| `ask(project, question)` | `claude -p` in the project, read-only tools, fast model. Answered at once with "checking"; the answer is spoken when it comes back | Asked (checking → answer) | 5–30 s |
| `dispatch(project, task)` | Starts a run in the project's channel the way **Ask** on the Code page does; the result lands in Slack | Sent to Slack, with the thread link | Instant ack |
| `status()` | Running tasks (chats, jobs, questions) with their current step and minutes so far, and questions still being answered | – | Instant |
| `watch(task)` | Puts one running or recent task in the middle of the stage (the Watch view) | Watch | Instant |
| `stop(task)` | Stops a running task, matched by project (when only one runs there) or words from its title; asks which when more than one fits | Action line | Instant |
| `focus(minutes)` | Holds urgent alerts and spoken "done" lines (see below), except `alwaysInterrupt` jobs | Focus pill and gauge | Instant |
| `brief()` | What needs you, each project with something going on (and the quiet ones by name), running tasks, tasks that ended in the last 3 hours, focus mode. The model says the most important in two or three sentences | – | Instant |

The system prompt lists the projects (and any extra Code repos), tells the model to answer about them **only** from tool results, to keep speech to one or two sentences, and never to start a topic itself.

### Guards on actions

- `decide` only takes a card **this tab has shown** (through `approvals` or the Approvals panel), with one of **its own options**. The model is told to repeat the card and option back and wait for a yes; the server refuses anything else ("Call approvals first, so the user sees the card").
- `job` with `run` starts real work; the model is told to confirm when the job wasn't named clearly. An unknown or ambiguous name is refused with the project's job list.
- On the page, Run now, Pause and every approval option ask once more ("Confirm: Approve") before they act.
- Editing a card's fields, Revise with a reply, and bulk decisions stay on the Approvals page.
- `stop` and a task's Stop button abort the run through a second signal the bus adds, so it ends `aborted` exactly as "stop" in its Slack thread would: work so far stays, the thread says it stopped.

### Telling you when work is done

When a task this tab started ends (a `dispatch` thread, a job run with `job`), the model gets a text turn starting `TASK DONE` with how it ended and Claude's last words, and says one sentence about it. Only while the voice session is still open: a closed session isn't reopened. Other people's runs, and later runs in the same thread, aren't announced.

## Attention tiers

| Tier | Examples | Behavior |
|---|---|---|
| **Urgent** | Matches `attention.urgent` rules, e.g. a job failing 3 times in a row, a named job failing | An alert: a chime, the core flashes red, a panel, and one spoken line |
| **Waiting** | Approval pending, job failed once, review requested | Count on screen, no sound |
| **Later** | Uncommitted work, finished jobs, stale branches | Only when you ask "what's up?" |

With no `urgent` rules (the default), it never interrupts.

### Alerts

One watcher on the server (`src/live/alerts.ts`) checks what needs you every minute, and 3 s after a job ends. An urgent item it hasn't seen raises an alert on every open Command tab:

- **Who says it.** While you're talking to it, the voice model says it (a text turn starting `URGENT`). Otherwise the tab says it in the browser's own voice (`live.alertLang` picks one, e.g. `en-IN`), without opening a voice session. With several tabs open, one speaks.
- **How often.** At most one spoken alert per `urgentGapMinutes` (30); later ones show as panels, marked as not said. Several new items at once are one line ("Heads up: 3 urgent items. Payments sync failed 3 times in a row, and 2 more.").
- **Focus mode** holds them. When it ends, one line says what came up and is still urgent ("Focus time is over. While you were away: …"). Jobs in `alwaysInterrupt` (`project/jobId`) are said anyway, and skip the gap.
- Items already urgent when tara starts aren't announced (they are on screen); an item that clears and comes back is new again; another failure in a row is a new item.
- The chime plays with Sound off; it's what alerts are for. Browsers only let a page make sound after you've clicked or typed on it once: until then an alert shows in the red bar at the top with a note saying so.

### Done, said out loud

Work you started from Command (a `dispatch`, a job run with `job`) that ends while the voice session is closed is said in one line by the browser's voice, with a tone: "Fix the retry, in shop, is done." In focus mode it's only shown. While the voice session is open the model says it instead (`TASK DONE`, above).

### Brief me

**Brief me** in the header (or saying "brief me", "catch me up") sends a typed turn; the model calls `brief` and says what needs you first, then what is running or just finished, skipping what is quiet.

## The page

`/command` on the dashboard: an agent console. Everything is drawn from the dashboard's colours, without libraries or files from elsewhere.

| Part | Shows |
|---|---|
| **Stage** | The core, drawn on a canvas: a tick ring, three arcs that turn faster while it connects or thinks, a waveform of 72 bars around it from the real microphone (while you talk) or voice (while it speaks), and a glow that follows the loudness. Its colour gives the state: blue listening, amber thinking, green speaking. **Space** (while the tab has focus) or a click on the core toggles talking. Every project sits around the core as a node with its health colour (red: failing job or unreadable repo; amber: approvals waiting; blue: work running; green: quiet) and its main count; the links to the core pulse while work runs in that project, and a node lights up when a panel about it arrives. A click opens the project's panel (counts, and Jobs, Changes, Approvals, its own dashboard). Subtitles at the bottom show the end of what you and it are saying, and fade a few seconds after it stops. A clock and corner brackets frame it |
| **Watch** | Watch on a task (or `watch` by voice) moves the core to the corner and gives the stage to that task: every step with its time since the start, the end of what Claude writes, Stop and Slack. **Esc** or Back returns |
| **Boot** | The first time the page opens in a browser session: the rings draw in while a short systems check lists each project and what needs you, then the nodes fade in (about 2 s; any key or click skips it; never with reduced motion) |
| **Live tasks** | Under the stage: each running task with its kind, project, a running clock, the latest steps (sub-agent steps indented; earlier ones on request, up to 40), the end of what Claude is writing, Watch, Stop and its Slack thread; then the last four finished ones, folded, with their result |
| **Operations** | Beside the stage (below it on narrower screens): panels, newest first; a panel with the same id is replaced and moves to the top (an `ask` goes from "Checking…" to its answer). Kinds: needs you, project, jobs (with a bar per recent run, height by duration, red for failures), changes, diff, approvals, asked, sent to Slack, and one-line actions. Up to 24; each can be closed, or all cleared |
| **Gauges** | A strip along the bottom: running tasks, running jobs, approvals waiting, failing jobs, items that need you (urgent and waiting), pull requests waiting on you, the latest usage-window share the CLI reported (amber from 70%, red from 90%, with a meter), and focus mode. Numbers count up when they change; each opens its panel |

The header shows the connection, focus mode, and **Sound**: short tones made in the browser when a task starts, ends or fails and when a panel arrives. Off by default, remembered per browser, and silent until you've clicked or typed on the page.

Narrow screens (under 900 px) drop the nodes and list the projects as cards below the tasks instead. With reduced motion, nothing turns or travels and there's no boot.

**Cost.** The canvas draws only as often as something moves: 60 frames a second while sound plays, it thinks or connects, or the stage changes; 30 while work pulses along a link; 12 otherwise; none while the stage is off screen or the tab is hidden (4 with reduced motion). Glows are wide faint strokes rather than `shadowBlur`, and bars and ticks go out in a few paths. Measured in Chromium on a laptop: about 2% of one core idle, 3–4% with tasks streaming (it was 10% at a constant 60 frames). On the server, nothing runs per frame: each open tab reads the overview every 30 s (git status is cached 15 s per repo, GitHub 5 min), task updates go out at most every 500 ms, and the alert check runs every minute only while a Command tab is open.

The page is split into `src/http/command-page.ts` (markup), `command-style.ts`, `command-hud.ts` (canvas, nodes, boot, sounds) and `command-script.ts` (everything else).

Audio: `getUserMedia` → AudioWorklet → 16 kHz PCM up; 24 kHz PCM down, played through an AudioWorklet queue that is flushed when you talk over it. While it speaks, only clearly louder mic sound is sent, so its own voice leaking into the mic doesn't cut it off; headphones avoid that entirely.

A Mac-wide hotkey can come later, via a menu-bar helper or Raycast hitting `/command/toggle`.

## Configuration

Host `config.yaml`. What counts as urgent lives in `attention` (built, see [configuration.md](configuration.md)), since `GET /attention` is useful without voice. Command is off unless `live` is set (the key is named after the voice protocol it configures). The `repo` tool and the Changes buttons need the Code page (`code`).

```yaml
attention:
  github: true                    # your PRs and review requests through `gh`
  urgent:                         # default: none, never interrupts
    - consecutiveFailures: 3
    - job: shop/payments-sync

live:
  url: wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
  model: gemini-live-…            # whatever the upstream calls it
  voice: Kore
  language: Indian English with an Indian accent. If I speak Hindi or Hinglish, answer in the same.
  idleSeconds: 20                 # close the upstream session after this much quiet
  askModel: haiku                 # model for ask(); read-only tools only
  urgentGapMinutes: 30            # at most one spoken alert per 30 minutes
  alwaysInterrupt: []             # project/jobId: said even in focus mode
  alertLang: en-IN                # browser voice for alerts; default: the browser's
```

`language` is plain words added to the model's instructions: Live's native-audio models choose the language themselves and take no language code, but follow instructions and switch languages mid-conversation (tested: a Hindi question got a Hinglish answer).

The key (a Google AI Studio API key) comes from `TARA_LIVE_API_KEY`. `url` can point at any endpoint that speaks the Gemini Live protocol.

## Security

- `/command` and its WebSocket sit behind `allowFrom` and `TARA_HTTP_TOKEN` like every page, and need the unlock cookie (`TARA_ADMIN_TOKEN`) and another device, as decisions on the Approvals page do: the tab can start Claude conversations, run jobs and decide approvals. The WebSocket also checks the origin.
- The microphone needs a secure context: `localhost` works, but a Tailscale IP over plain HTTP doesn't. When tara runs on another machine, turn on `http.tls` with a Tailscale certificate:
  ```sh
  sudo tailscale cert --cert-file /etc/tara-agent/tls.crt --key-file /etc/tara-agent/tls.key <host>.<tailnet>.ts.net
  sudo chgrp tara-agent /etc/tara-agent/tls.* && sudo chmod 640 /etc/tara-agent/tls.*
  ```
  ```yaml
  http:
    tls: { port: 4443, cert: /etc/tara-agent/tls.crt, key: /etc/tara-agent/tls.key }
  ```
  Then open `https://<host>.<tailnet>.ts.net:4443/command`. Re-run `tailscale cert` monthly (a timer); tara picks up the new file.
- Don't put `tailscale serve` (or any proxy on the same machine) in front: requests would then come from the machine itself, which tara refuses for unlocking and decisions, so the agent running there can't approve its own requests.
- `ask` runs with read-only tools. Anything that writes code goes through `dispatch`, into the project's normal session, approvals and Slack thread.
- Decisions made here are recorded like the Approvals page's (`via: dashboard`, by the project's owner).
- Task steps and text show file paths and commands. Before they leave the process, things that look like secrets are masked: Slack, GitHub, Anthropic, Google and AWS keys, `Bearer` tokens, passwords in URLs, and values of `*token*`, `*secret*`, `*password*` and `*api_key*` settings. Masking is best effort; the page stays behind the unlock cookie.
- Audio isn't stored. Transcripts of tool calls are stored like other runs.

## Build order

1. **Attention feed** ✅ `GET /attention`: approvals, permission prompts, failing and paused jobs, uncommitted work, and PRs through `gh`, in tiers (`src/live/attention.ts`).
2. **Gemini Live session and audio relay** ✅ `src/live/gemini.ts` (setup, audio, transcripts, tool calls, resume on "go away"), `src/live/session.ts` (one tab ↔ one Gemini session, idle close, ask results after the current turn), `src/live/ask.ts` (read-only `claude -p`), `/command/ws`.
3. **The page** ✅ Talk (and <kbd>Space</kbd>), mic resampled to 16 kHz and played back at 24 kHz in AudioWorklets, speech dropped on interruption, transcript, typed turns.
4. **HUD and actions** ✅ `src/http/command-page.ts`: Systems, Operations and panels; `projects`, `jobs`, `job`, `repo`, `approvals` and `decide` (`src/live/tools.ts`); panel buttons through the same session code.
5. **Live tasks** ✅ `src/live/activity.ts`: run labels from chat turns, job runs and `ask`; tasks streamed to every tab; `status` and `stop` tools and a Stop button; `TASK DONE` for work the tab started; secret masking; usage pill.
6. **The console look** ✅ The canvas core with a real waveform, projects around it with pulsing links, the Watch view and `watch` tool, the boot, the gauge strip, project, diff and run-history panels (`repo` with `file`), UI sounds.
7. **Urgent tier, focus mode, briefings** ✅ `src/live/alerts.ts` (one watcher, gap, focus hold and summary, `alwaysInterrupt`); alerts and done lines said by the voice model or the browser's voice, one tab speaking; `brief` tool and button.
8. **Later.** A wake word (on-device keyword spotting; check licences), a Mac-wide hotkey through `/command/toggle`, a full-screen wall mode for a second monitor.

## Browser protocol (`/command/ws`)

| Direction | Frame | Meaning |
|---|---|---|
| tab → tara | binary | Microphone: 16 kHz, 16-bit LE, mono. Ignored until `talk` |
| tab → tara | `{"type":"talk"}` / `{"type":"mute"}` | Start / stop talking. `talk` opens the Gemini session if it is closed |
| tab → tara | `{"type":"text","text":…}` | A typed turn |
| tab → tara | `{"type":"show","what":"attention"\|"jobs"\|"repo"\|"approvals","project"?:…,"file"?:…}` | Open a panel without the voice model (project, gauge and file buttons) |
| tab → tara | `{"type":"job","action":"run"\|"pause"\|"resume","project":…,"id":…}` | A Jobs panel button |
| tab → tara | `{"type":"decide","id":…,"option":…}` | An Approvals panel button |
| tab → tara | `{"type":"stop","id":…}` | A live task's Stop button |
| tara → tab | binary | Speech: 24 kHz, 16-bit LE, mono |
| tara → tab | `{"type":"state","state":…}` | `idle`, `connecting`, `listening`, `thinking`, `speaking` |
| tara → tab | `{"type":"transcript","who":"user"\|"model","text":…}` | Pieces of what was said |
| tara → tab | `{"type":"interrupted"}` | Drop speech not yet played |
| tara → tab | `{"type":"overview","projects":[…],"focusUntil":…,"needs":{"urgent","waiting","later","prs"}}` | The projects and gauges; on connect, every 30 s, and after actions |
| tara → tab | `{"type":"watch","id":…}` | Put this task in the Watch view |
| tara → tab | `{"type":"alert","alert":{id,kind,items,text,at,quiet},"voice":…}` | An urgent alert (`kind` `urgent` or `focus-over`). `voice`: the model says it, so the tab doesn't; `quiet`: show only |
| tara → tab | `{"type":"notify","text":…,"ok":…,"quiet":…}` | One line for the tab to say: work it started ended while the voice session was closed |
| tara → tab | `{"type":"config","alertLang"?:…}` | On connect: the browser voice for alerts |
| tara → tab | `{"type":"tasks","tasks":[…],"usage"?:…}` | Every task (running, then the last finished) on connect |
| tara → tab | `{"type":"task","task":{…}}` | One task started, changed (at most every 500 ms) or ended. `status` is `running`, `ok`, `error`, `timeout`, `limit` or `aborted` |
| tara → tab | `{"type":"usage","usage":{"window","utilization","resetsAt"}}` | The CLI's latest usage-window report |
| tara → tab | `{"type":"panel","id":…,"panel":{"kind":…}}` | Show a panel, or replace the one with this id. Kinds: `attention`, `jobs`, `repo`, `approvals`, `ask`, `dispatch`, `action` |
| tara → tab | `{"type":"tool",…}`, `{"type":"error",…}` | A tool call; a problem |

`ask` is answered at once ("checking") so the model stays responsive; the answer is sent to the model as a text turn starting `ASK RESULT` after its current turn, since asynchronous function calls aren't supported on every Live model.

## Tested

- Against the real API (`gemini-3.8-live`, Oct 2026): connects in about 1.5 s; a spoken "What needs my attention?" got a tool call to `attention` and a spoken answer built from its result.
- In a browser (Chromium, typed turns): `attention`, `ask` (a real haiku turn, answered in 6–15 s and then spoken) and `dispatch`. The microphone path has only been tested by hand.
- The page in Chromium against a stand-in session (no voice): the boot, the nodes and their panels, jobs with run bars, changes and a diff, the two-click approve, live tasks from simulated runs (steps streaming, a masked token, Stop, Watch and Esc), the gauges, sound on and off, reduced motion, 1440 and 390 px wide. An urgent alert from a stand-in attention source: the panel, the subtitle, one spoken line through the browser's voice. Not yet tried: the waveform with a real microphone and voice, the new tools against the real voice model, real Claude runs, and alerts across several tabs.
- Gemini's transcripts contain markers such as `<no speech>` and `{pause}`, split across pieces; the page removes them per turn.
