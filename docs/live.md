# Live (design)

Status: steps 1–3 built (attention feed, Gemini Live session, `/live` page); the urgent tier and focus mode's effect are next.

Talk to tara out loud from a browser tab and hear it answer in real time: what needs you, what a job is doing, "go fix X". It is quiet by default. It speaks when you talk to it, and interrupts on its own only for what you have marked urgent.

## Goals

- **Real-time conversation.** Under a second to the first spoken word, and you can talk over it to cut it off.
- **Every repo.** Ask about any project. Work still runs in that project's own session, with its CLAUDE.md, skills, approvals and Slack channel.
- **Long work goes to Slack.** "On it, I'll post in #shop", then silence until you ask.
- **Not a distraction.** No small talk, no unprompted updates, short spoken answers with details on screen.

Not goals: a wake word, a phone UI (later), replacing Slack.

## Shape

A realtime voice model listens and speaks. Claude stays the brain, reached through tools. Claude has no speech-to-speech API, and tara only drives Claude through the `claude` CLI.

```
Browser /live ──WS (PCM audio)──► tara-agent ──WS──► Gemini Live (Google AI Studio)
   mic, speaker, transcript          │  ▲
                                     │  └── tool calls ◄──┘
                                     ▼
                     attention · ask · dispatch · status · stop · focus
                                     │
                         Store, git, gh, claude -p, job runner, Slack
```

- **tara proxies the audio.** The browser never sees the API key, and every tool call is checked on the server.
- **Session only while talking.** The upstream session opens when you start talking and closes after `idleSeconds` of quiet. A closed session can't speak, which keeps it quiet and costs nothing per minute.
- **Protocol:** Gemini Live (`BidiGenerateContent`) first, behind a small adapter (`open`, `sendAudio`, `onAudio`, `onToolCall`, `sendToolResult`, `close`) so an OpenAI Realtime adapter can be added later.

## Tools the voice model gets

| Tool | Does | Speed |
|---|---|---|
| `attention()` | Tiered list: pending approvals and permission prompts, failing jobs, running jobs, uncommitted work and unpushed commits per repo, and PRs waiting on you / red CI from `gh` (cached) | Instant, no LLM |
| `ask(project, question)` | `claude -p` in the project, read-only tools, fast model. The voice model says "checking" and stays responsive; the answer is spoken in a sentence or two when it comes back | 5–30 s |
| `dispatch(project, task)` | Starts a run in the project's channel the way **Ask** on the Code page does; the result lands in Slack | Instant ack |
| `status()` | Running jobs, and questions still being answered | Instant |
| `focus(minutes)` | Mutes the urgent tier (see below), except `alwaysInterrupt` | Instant |

The system prompt tells the model to answer about repos **only** from tool results, to keep speech to one or two sentences, and never to start a topic itself.

## Attention tiers

| Tier | Examples | Behavior |
|---|---|---|
| **Urgent** | Matches `live.urgent` rules, e.g. a job failing 3 times in a row, a named job failing | Chime and one spoken line, at most once per `urgentGapMinutes`. Spoken by the browser's built-in text-to-speech without opening a session; muted in focus mode |
| **Waiting** | Approval pending, job failed once, review requested | Count on screen, no sound |
| **Later** | Uncommitted work, finished jobs, stale branches | Only when you ask "what's up?" |

With no `urgent` rules (the default), it never interrupts.

## The page

- `/live` on the dashboard. **Space** (while the tab has focus) or a click on the orb toggles talking. A Mac-wide hotkey can come later, via a menu-bar helper or Raycast hitting `/live/toggle`.
- Shows: talking / listening / thinking / idle state, a live transcript, and cards for `ask` and `dispatch` results with Slack links. Deliberately not the list of what needs you (Home and Approvals have it; ask out loud).
- Audio: `getUserMedia` → AudioWorklet → 16 kHz PCM up; 24 kHz PCM down, played through an AudioWorklet queue that is flushed when you talk over it.

## Configuration

Host `config.yaml`. What counts as urgent lives in `attention` (built, see [configuration.md](configuration.md)), since `GET /attention` is useful without voice. Live is off unless `live` is set.

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
  urgentGapMinutes: 30
  alwaysInterrupt: []             # still interrupts in focus mode
```

`language` is plain words added to the model's instructions: Live's native-audio models choose the language themselves and take no language code, but follow instructions and switch languages mid-conversation (tested: a Hindi question got a Hinglish answer).

The key (a Google AI Studio API key) comes from `TARA_LIVE_API_KEY`. `url` can point at any endpoint that speaks the Gemini Live protocol.

## Security

- `/live` and its WebSocket sit behind `allowFrom` and `TARA_HTTP_TOKEN` like every page. `dispatch` and `stop` need the unlock cookie, as decisions and **Ask** do.
- The microphone needs a secure context: `localhost` works, but a Tailscale IP over plain HTTP doesn't. When tara runs on another machine, turn on `http.tls` with a Tailscale certificate:
  ```sh
  sudo tailscale cert --cert-file /etc/tara-agent/tls.crt --key-file /etc/tara-agent/tls.key <host>.<tailnet>.ts.net
  sudo chgrp tara-agent /etc/tara-agent/tls.* && sudo chmod 640 /etc/tara-agent/tls.*
  ```
  ```yaml
  http:
    tls: { port: 4443, cert: /etc/tara-agent/tls.crt, key: /etc/tara-agent/tls.key }
  ```
  Then open `https://<host>.<tailnet>.ts.net:4443/live`. Re-run `tailscale cert` monthly (a timer); tara picks up the new file.
- Don't put `tailscale serve` (or any proxy on the same machine) in front: requests would then come from the machine itself, which tara refuses for unlocking and decisions, so the agent running there can't approve its own requests.
- `ask` runs with read-only tools. Anything that writes goes through `dispatch`, into the project's normal session, approvals and Slack thread.
- Audio isn't stored. Transcripts of tool calls are stored like other runs.

## Build order

1. **Attention feed** ✅ `GET /attention`: approvals, permission prompts, failing and paused jobs, uncommitted work, and PRs through `gh`, in tiers (`src/live/attention.ts`).
2. **Gemini Live session and audio relay** ✅ `src/live/gemini.ts` (setup, audio, transcripts, tool calls, resume on "go away"), `src/live/session.ts` (one tab ↔ one Gemini session, idle close, ask results after the current turn), `src/live/ask.ts` (read-only `claude -p`), `/live/ws`. `stop` is left for later.
3. **`/live` page** ✅ `src/http/live-page.ts`: Talk button (and <kbd>Space</kbd>), mic resampled to 16 kHz and played back at 24 kHz in AudioWorklets, speech dropped on interruption, transcript, typed turns, result cards. No list of what needs you on the page: that's on Home and Approvals, and the voice tells you when you ask. Shown in the menu when `live` is set; needs an unlocked browser. While it speaks, only clearly louder mic sound is sent, so its own voice leaking into the mic doesn't cut it off; headphones avoid that entirely.
4. **Urgent tier and focus mode.**

## Browser protocol (`/live/ws`)

| Direction | Frame | Meaning |
|---|---|---|
| tab → tara | binary | Microphone: 16 kHz, 16-bit LE, mono. Ignored until `talk` |
| tab → tara | `{"type":"talk"}` / `{"type":"mute"}` | Start / stop talking. `talk` opens the Gemini session if it is closed |
| tab → tara | `{"type":"text","text":…}` | A typed turn |
| tara → tab | binary | Speech: 24 kHz, 16-bit LE, mono |
| tara → tab | `{"type":"state","state":…}` | `idle`, `connecting`, `listening`, `thinking`, `speaking` |
| tara → tab | `{"type":"transcript","who":"user"\|"model","text":…}` | Pieces of what was said |
| tara → tab | `{"type":"interrupted"}` | Drop speech not yet played |
| tara → tab | `{"type":"tool",…}`, `{"type":"card",…}`, `{"type":"error",…}` | A tool call; an `ask` answer or `dispatch` link; a problem |

`ask` is answered at once ("checking") so the model stays responsive; the answer is sent to the model as a text turn starting `ASK RESULT` after its current turn, since asynchronous function calls aren't supported on every Live model.

## Tested

- Against the real API (`gemini-3.8-live`, Oct 2026): connects in about 1.5 s; a spoken "What needs my attention?" got a tool call to `attention` and a spoken answer built from its result.
- In a browser (Chromium, typed turns): `attention`, `ask` (a real haiku turn, answered in 6–15 s and then spoken) and `dispatch` cards. The microphone path has only been tested by hand.
- Gemini's transcripts contain markers such as `<no speech>` and `{pause}`, split across pieces; the page removes them per turn.
