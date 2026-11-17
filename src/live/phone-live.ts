import WebSocket from 'ws';
import { findJob, findTask, type PhoneVoice, type VoiceJob, type VoiceReply } from '../http/phone-voice.js';
import type { ActivityEvent, Task } from '../runner/activity.js';
import {
  type FunctionCall,
  type FunctionDeclaration,
  GeminiLive,
  type Grounding,
  type LiveConnectOptions,
  type LiveUsage,
} from './gemini.js';

/**
 * The desk phone's Voice v2 (docs/jarvis-phone.md): Gemini Live is the voice, tara's tools (and, from
 * step 2, Claude) the brain and hands. One `PhoneLive` per connected phone shell.
 *
 * Shell → tara (WebSocket `/phone/live`, device key): binary frames are microphone audio (16 kHz,
 * 16-bit LE, mono), used only while talking; JSON `{type: start|stop|lock|confirm|timing}`.
 * tara → shell: binary frames are speech (24 kHz, 16-bit LE, mono); JSON `LiveEvent`s, which the shell
 * also hands to the page (`window.taraLive`): the state, both sides' words, a step per tool call (the
 * live step strip) and cards (lists, confirm Yes/No, sources, posters, Claude's work).
 *
 * The upstream Gemini session opens on `start` and closes after `idleSeconds` with nothing said and
 * nothing still being worked on, so it costs nothing while the room is quiet. Work that ends later
 * (a Claude run) opens a short session just to say how it went.
 *
 * Actions (run, pause or resume a job, stop a run, hand work to Claude) need the phone unlocked and a
 * spoken yes, checked here rather than trusted to the model: the user's own words since the question
 * must hold a yes, or the Yes button is tapped. Approval cards are never decided by voice.
 */

export type LiveStateName = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface Line {
  text: string;
  sub?: string;
  tone?: 'red' | 'amber' | 'blue' | 'green';
}

export type Card =
  | { kind: 'list'; title: string; lines: Line[] }
  | { kind: 'confirm'; question: string; state: 'asking' | 'yes' | 'no' | 'expired' }
  | { kind: 'sources'; queries: string[]; sources: Array<{ title: string; site: string }> }
  | {
      kind: 'titles';
      title: string;
      items: Array<{ title: string; sub?: string; image?: string; note?: string }>;
    }
  | {
      kind: 'claude';
      question: string;
      model: string;
      status: 'working' | 'done' | 'error';
      steps: string[];
      answer?: string;
    }
  | { kind: 'log'; title: string; lines: string[] }
  | { kind: 'run'; task: string; title: string; project: string; status: string }
  | { kind: 'music'; title: string; sub?: string; image?: string; state: string };

export type LiveEvent =
  | { type: 'state'; state: LiveStateName }
  | { type: 'transcript'; who: 'user' | 'model'; text: string }
  | { type: 'interrupted' }
  | { type: 'step'; id: string; label: string; status: 'running' | 'ok' | 'error'; detail?: string }
  /** Shows a card, or replaces the one with the same id. */
  | { type: 'card'; id: string; card: Card }
  | { type: 'show'; page: 'home' | 'night' }
  | { type: 'watch'; task: string }
  /** Ask Android for the unlock (an action needs it). */
  | { type: 'unlock' }
  /** The voice session closed: stop sending the microphone. */
  | { type: 'end'; reason?: string }
  | { type: 'error'; message: string };

type ShellMessage =
  | { type: 'start'; locked?: boolean }
  | { type: 'stop' }
  | { type: 'lock'; locked: boolean }
  | { type: 'confirm'; yes: boolean }
  /** End of the user's speech → first sound of the answer, measured on the phone. */
  | { type: 'timing'; ms: number };

/** A long piece of work (a Claude question or run) whose result the voice says when it comes. */
export interface Background {
  id: string;
  label: string;
  done: Promise<string>;
  /** Close the conversation once its result has been said (music: the mic would hear the song). */
  endAfter?: boolean;
}

/** Several tool kits as one (the Claude lanes, music). */
export function mergeKits(...kits: Array<LiveToolKit | undefined>): LiveToolKit | undefined {
  const ks = kits.filter((k): k is LiveToolKit => Boolean(k));
  if (ks.length <= 1) return ks[0];
  const owner = (name: string) => ks.find((k) => k.declarations.some((d) => d.name === name));
  return {
    declarations: ks.flatMap((k) => k.declarations),
    labels: Object.assign({}, ...ks.map((k) => k.labels ?? {})),
    gated: ks.flatMap((k) => k.gated ?? []),
    question: async (call) => {
      const k = owner(call.name);
      if (!k?.question) throw new Error(`No tool "${call.name}"`);
      return k.question(call);
    },
    run: async (call, ctx) => owner(call.name)?.run(call, ctx),
    instructions: ks
      .map((k) => k.instructions)
      .filter(Boolean)
      .join('\n'),
  };
}

/** What a tool gives back: the model's answer, and optionally a card for the screen. */
export interface ToolOutcome {
  response: Record<string, unknown>;
  card?: Card;
  /** Work that goes on after the answer; its result is spoken when it ends. */
  background?: Background;
  /** A friendlier step label than the tool's, e.g. "Run Blog writer". */
  label?: string;
}

/** Extra tools (the lanes of step 2 and 3) added next to the built-in ones. */
export interface LiveToolKit {
  declarations: FunctionDeclaration[];
  /** Labels for the step strip while the tool runs. */
  labels?: Record<string, string>;
  /** Tools that act, so they go through the unlock and the spoken yes first. */
  gated?: string[];
  /** For a gated tool: the question asked before it runs. */
  question?(call: FunctionCall): Promise<string> | string;
  run(call: FunctionCall, ctx: ToolContext): Promise<ToolOutcome | undefined>;
  /** Added to the system instruction. */
  instructions?: string;
}

export interface ToolContext {
  /** Shows a step on the strip (e.g. Claude's own tool calls while it works). */
  step(label: string, status?: 'running' | 'ok' | 'error', detail?: string): string;
  finishStep(id: string, status: 'ok' | 'error', detail?: string): void;
  card(id: string, card: Card): void;
  /** Follow this Claude run: its end is spoken. */
  watchRun(match: (t: Task) => boolean, what: string): void;
  signal: AbortSignal;
}

export interface PhoneLiveConfig {
  apiKey: string;
  url: string;
  model: string;
  voice: string;
  idleSeconds: number;
  /** How to speak, e.g. "Indian English; Hinglish when spoken to in Hindi". */
  language?: string;
  silenceMs?: number;
  googleSearch?: boolean;
  /** Ignore speech not meant for it (default on). */
  proactiveAudio?: boolean;
}

export interface PhoneLiveDeps {
  agentName: string;
  voice: PhoneVoice;
  jobs(): VoiceJob[];
  tasks(): Task[];
  runJob(project: string, id: string): 'started' | 'unknown' | 'running';
  setJobEnabled(project: string, id: string, enabled: boolean): 'ok' | 'unknown';
  stopTask(id: string): boolean;
  subscribe?(listener: (e: ActivityEvent) => void): () => void;
  kit?: LiveToolKit;
  log: { info(msg: string): void; warn(msg: string): void };
  now?: () => number;
  connect?: (o: LiveConnectOptions) => Promise<GeminiLive>;
}

export const RESULT = 'RESULT';
export const TASK_DONE = 'TASK DONE';

/** Transcripts carry markers such as `<noise>`; they aren't words. */
export const cleanTranscript = (text: string) => text.replace(/<[^>\n]*>|\{[^}\n]*\}/g, '');

/** A yes in the user's own words (English, Hindi, Hinglish), and a no, which wins. */
export const SPOKEN_YES =
  /\b(yes|yeah|yep|yup|ya|haan?|han|ha|ji|sure|ok(ay)?|do it|go ahead|go for it|confirm(ed)?|please do|correct|right|kar do|karo|chalao|chala do|हाँ|हां|जी)\b/i;
export const SPOKEN_NO =
  /\b(no|nope|nah|nahi|nahin|na|cancel|don'?t|do not|never ?mind|forget it|stop|mat|ruko|rehne do|नहीं|मत)\b/i;

/** Audio kept while the upstream session opens: 5 s. */
const MAX_EARLY_AUDIO = 16_000 * 2 * 5;
/** A question waits this long for its yes. */
const CONFIRM_MS = 90_000;

const RULE_LABELS: Record<string, string> = {
  running: "What's running",
  needs_me: 'What needs you',
  approvals: 'Approvals',
  next_up: 'Next up',
  brief: 'Briefing',
  usage: 'Claude usage',
  jobs: 'Jobs',
  quiet: 'Quiet mode',
  show: 'Screen',
  watch: 'Watch a run',
  job: 'Job',
  stop: 'Stop a run',
  confirm: 'Your answer',
  end_conversation: 'Bye',
};

const RUN_ARG = {
  type: 'STRING',
  description: 'Which run: words from its title, or its project when only one runs there.',
} as const;

export const RULE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'running',
    description:
      'What is running right now (Claude runs and jobs) and what ended last. Call it for "what\'s running", "kya chal raha hai".',
  },
  {
    name: 'needs_me',
    description:
      'What needs the user: urgent and waiting items (failing jobs, permission prompts, pull requests), and the approval card count.',
  },
  {
    name: 'approvals',
    description:
      'Approval cards waiting for a decision, per project. Read only: cards are never decided by voice; they are decided on the Approvals page or in Slack.',
  },
  { name: 'next_up', description: 'The next scheduled job runs today.' },
  {
    name: 'brief',
    description:
      'A short briefing: what needs the user, what is running, what failed lately, what is next. For "brief me", "catch me up", "good morning".',
  },
  { name: 'usage', description: "How much of Claude's usage window is used." },
  {
    name: 'jobs',
    description:
      'Every scheduled job with its state: paused, running, next run, last result and last error. Use it to answer why a job failed when the error says enough.',
    parameters: {
      type: 'OBJECT',
      properties: { project: { type: 'STRING', description: 'Only this project. Leave out for all.' } },
    },
  },
  {
    name: 'quiet',
    description: 'Quiet mode: holds alerts (no screen wake, no buzz) for this many minutes. 0 ends it.',
    parameters: {
      type: 'OBJECT',
      properties: { minutes: { type: 'INTEGER', description: 'Minutes, up to 1440; 0 turns it off.' } },
      required: ['minutes'],
    },
  },
  {
    name: 'show',
    description: 'Switch the phone screen: home, or the dim night clock.',
    parameters: {
      type: 'OBJECT',
      properties: { page: { type: 'STRING', description: 'The page.', enum: ['home', 'night'] } },
      required: ['page'],
    },
  },
  {
    name: 'watch',
    description:
      'Show one running (or just finished) run full screen with its live steps. For "show me", "let me watch".',
    parameters: { type: 'OBJECT', properties: { run: RUN_ARG }, required: ['run'] },
  },
  {
    name: 'job',
    description:
      "Run a scheduled job now, or pause or resume it. This acts: the server makes sure the phone is unlocked and asks the user to confirm; you then ask the returned question and call confirm with the user's answer.",
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'What to do.', enum: ['run', 'pause', 'resume'] },
        job: { type: 'STRING', description: 'The job, by name or id (from jobs).' },
        project: { type: 'STRING', description: "The job's project, if known." },
      },
      required: ['action', 'job'],
    },
  },
  {
    name: 'stop',
    description: 'Stop a running Claude run or job. Acts: needs the unlock and a confirmation, like job.',
    parameters: { type: 'OBJECT', properties: { run: RUN_ARG }, required: ['run'] },
  },
  {
    name: 'confirm',
    description:
      "The user's answer to the question an action asked (yes or no). Call it right after the user answers. The server checks their words.",
    parameters: {
      type: 'OBJECT',
      properties: { answer: { type: 'STRING', description: "The user's answer.", enum: ['yes', 'no'] } },
      required: ['answer'],
    },
  },
  {
    name: 'end_conversation',
    description:
      "Close the conversation when the user says bye, thanks, that's all, or asks you to stop listening.",
  },
];

const GATED = new Set(['job', 'stop']);

export function systemInstruction(agentName: string, language: string | undefined, extra?: string): string {
  return `You are ${agentName}, the user's assistant on a desk phone next to them. You run their software projects through tara-agent: Claude runs, scheduled jobs and approval cards. You speak; the phone's screen shows what your tools return (lists, cards, steps) as you call them.
${language ? `\nLanguage and accent: ${language}\n` : ''}
- A conversation often starts with the wake words "Hey ${agentName}", which the transcript may mishear (e.g. "jueves", "John Lewis"). If that is all the user said, only say "Yes?" and listen; never call a tool for the wake words alone.
- The microphone also hears the room: a TV, music, other people, sometimes your own voice. Answer only requests clearly meant for you, in English, Hindi or Hinglish. Fragments, other languages and words not meant for you: stay silent and call no tool.
- Speak briefly: one or two short sentences. Details are on screen; say "it's on the screen" rather than reading out a list. Never read out URLs, ids or code.
- Facts about projects, jobs, runs and approvals come only from your tools in this conversation. Call a tool rather than guess.
- Everyday questions: running, needs_me, approvals, next_up, brief, usage, jobs. Screen: show, watch. Holding alerts: quiet.
- Actions (job, stop, and any tool that says it acts): only when the user clearly said what to do. If you didn't hear the verb (run, pause, resume, stop) or the target, ask; never assume "run". The server checks the phone is unlocked and returns a question: ask exactly that, wait for the answer, then call confirm with it. Never call confirm for the user.
- Approval cards are never decided by voice: point to the Approvals page or Slack.
- A message starting with "${RESULT}" or "${TASK_DONE}" is work that finished: tell the user the gist in one or two sentences.
- Answer in the language of the user's last words: English to English, Hindi or Hinglish to casual Hinglish (Latin script). Results and tool answers are in English; that doesn't change the user's language.
- No small talk beyond one friendly line. When the user is done (bye, thanks, that's all), call end_conversation.${extra ? `\n${extra}` : ''}`;
}

export class PhoneLive {
  private upstream?: GeminiLive;
  private opening?: Promise<GeminiLive | undefined>;
  private state: LiveStateName = 'idle';
  private talking = false;
  private locked = true;
  private early: Buffer[] = [];
  private earlyBytes = 0;
  private modelTalking = false;
  /** Results to tell the model once it has finished its current turn. */
  private later: string[] = [];
  private readonly busy = new Map<string, { label: string; controller: AbortController }>();
  private idleTimer?: NodeJS.Timeout;
  private confirmTimer?: NodeJS.Timeout;
  private pending?: {
    id: string;
    question: string;
    act: () => Promise<Record<string, unknown>>;
    expires: number;
    heard: string;
  };
  /** Runs started from here, told to the model (or spoken) when they end. */
  private readonly watching: Array<{ match: (t: Task) => boolean; what: string; since: number }> = [];
  private readonly unsubscribe?: () => void;
  private ended = false;
  private seq = 0;
  /**
   * This turn, from the user's words to the next time they speak (a tool call splits the model's side
   * in two turns): what was heard, the tools called, and the phone's timing.
   */
  private turn = newTurn();
  private turnTimer?: NodeJS.Timeout;
  /** When a finished result was handed to the model, to log how soon it was spoken. */
  private resultSentAt?: number;
  /** Close once the current answer is said (after music starts). */
  private closeAfterTurn = false;
  private stats = { opened: 0, micBytes: 0, speechBytes: 0, tools: 0, tokens: emptyUsage() };
  private readonly now: () => number;

  constructor(
    private readonly client: WebSocket,
    private readonly cfg: PhoneLiveConfig,
    private readonly deps: PhoneLiveDeps,
  ) {
    this.now = deps.now ?? Date.now;
    client.on('message', (data, isBinary) => {
      if (isBinary) this.audio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      else this.control(data.toString());
    });
    client.on('close', () => this.end());
    client.on('error', () => this.end());
    this.unsubscribe = deps.subscribe?.((e) => this.onActivity(e));
    this.emit({ type: 'state', state: 'idle' });
  }

  // --- The phone ---

  private emit(event: LiveEvent): void {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(event));
  }

  private setState(state: LiveStateName): void {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: 'state', state });
  }

  private control(text: string): void {
    let msg: ShellMessage;
    try {
      msg = JSON.parse(text) as ShellMessage;
    } catch {
      return;
    }
    if (msg.type === 'start') {
      if (typeof msg.locked === 'boolean') this.locked = msg.locked;
      this.talking = true;
      void this.ensureUpstream();
    } else if (msg.type === 'stop') {
      this.talking = false;
      this.close('stopped');
    } else if (msg.type === 'lock' && typeof msg.locked === 'boolean') {
      const was = this.locked;
      this.locked = msg.locked;
      if (was && !msg.locked && this.upstream) this.tell('(The phone is unlocked now.)');
    } else if (msg.type === 'confirm') {
      void this.answerConfirm(msg.yes === true, 'tap');
    } else if (msg.type === 'timing' && typeof msg.ms === 'number' && msg.ms >= 0 && msg.ms < 120_000) {
      // The phone measures when the answer's first sound plays: the first one counts for the turn.
      this.turn.timing ??= Math.round(msg.ms);
    }
  }

  private audio(pcm: Buffer): void {
    if (!this.talking) return;
    if (this.upstream) {
      this.stats.micBytes += pcm.length;
      this.upstream.sendAudio(pcm);
      return;
    }
    if (this.earlyBytes + pcm.length > MAX_EARLY_AUDIO) return;
    this.early.push(pcm);
    this.earlyBytes += pcm.length;
  }

  // --- The voice session ---

  private ensureUpstream(): Promise<GeminiLive | undefined> {
    if (this.upstream) return Promise.resolve(this.upstream);
    this.opening ??= this.openUpstream().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async openUpstream(): Promise<GeminiLive | undefined> {
    this.setState('connecting');
    const kit = this.deps.kit;
    const started = this.now();
    try {
      const up = await (this.deps.connect ?? GeminiLive.connect)({
        url: this.cfg.url,
        apiKey: this.cfg.apiKey,
        setup: {
          model: this.cfg.model,
          voice: this.cfg.voice,
          systemInstruction: systemInstruction(this.deps.agentName, this.cfg.language, kit?.instructions),
          tools: [...RULE_TOOLS, ...(kit?.declarations ?? [])],
          googleSearch: this.cfg.googleSearch,
          silenceMs: this.cfg.silenceMs,
          proactiveAudio: this.cfg.proactiveAudio ?? true,
        },
        events: {
          onAudio: (pcm) => {
            if (this.resultSentAt) {
              this.deps.log.info(
                `phone live: result spoken ${this.now() - this.resultSentAt} ms after it came`,
              );
              this.resultSentAt = undefined;
            }
            this.modelTalking = true;
            this.turn.spoke = true;
            this.setState('speaking');
            this.stats.speechBytes += pcm.length;
            if (this.client.readyState === WebSocket.OPEN) this.client.send(pcm);
          },
          onTranscript: (who, raw) => {
            const text = cleanTranscript(raw);
            if (!text.trim()) return;
            if (who === 'model') this.modelTalking = true;
            else {
              if (this.turn.spoke) this.endTurn();
              this.turn.heard += text;
              if (this.pending) this.pending.heard += text;
            }
            this.emit({ type: 'transcript', who, text });
            this.armIdle();
          },
          onToolCalls: (calls) => void this.tools(calls),
          onToolCancel: () => {},
          onInterrupted: () => {
            this.modelTalking = false;
            this.emit({ type: 'interrupted' });
            this.setState('listening');
          },
          onTurnComplete: () => {
            this.modelTalking = false;
            if (this.closeAfterTurn && !this.later.length) {
              this.closeAfterTurn = false;
              setTimeout(() => this.close('done'), 1_500).unref();
            }
            // Logged once the user speaks again, or after a quiet moment.
            clearTimeout(this.turnTimer);
            this.turnTimer = setTimeout(() => this.endTurn(), 4_000);
            this.turnTimer.unref();
            this.setState(this.busy.size ? 'thinking' : 'listening');
            this.flushLater();
            this.armIdle();
          },
          onGrounding: (g) => this.grounded(g),
          onUsage: (u) => addUsage(this.stats.tokens, u),
          onClose: (reason) => this.upstreamClosed(reason),
        },
      });
      if (this.ended) {
        up.close();
        return undefined;
      }
      this.upstream = up;
      this.stats = {
        opened: this.now(),
        micBytes: this.earlyBytes,
        speechBytes: 0,
        tools: 0,
        tokens: emptyUsage(),
      };
      this.deps.log.info(
        `phone live: voice session opened in ${this.now() - started} ms (${this.cfg.model})`,
      );
      for (const pcm of this.early.splice(0)) up.sendAudio(pcm);
      this.earlyBytes = 0;
      this.setState(this.talking ? 'listening' : 'thinking');
      this.armIdle();
      return up;
    } catch (err) {
      this.deps.log.warn(`phone live: could not open a Gemini session: ${(err as Error).message}`);
      this.emit({ type: 'error', message: `Could not start the voice: ${(err as Error).message}` });
      this.talking = false;
      this.early = [];
      this.earlyBytes = 0;
      this.emit({ type: 'end', reason: 'error' });
      this.setState('idle');
      return undefined;
    }
  }

  private upstreamClosed(reason?: string): void {
    this.endTurn();
    this.upstream = undefined;
    this.modelTalking = false;
    clearTimeout(this.idleTimer);
    const { opened, micBytes, speechBytes, tools, tokens } = this.stats;
    const secs = Math.max(1, Math.round((this.now() - opened) / 1000));
    // 16 kHz and 24 kHz, 16-bit mono: bytes per second.
    this.deps.log.info(
      `phone live: voice session closed after ${secs} s: heard ${(micBytes / 32_000).toFixed(1)} s, spoke ${(speechBytes / 48_000).toFixed(1)} s, ${tools} tool calls; tokens ${tokens.total} (in ${fmtTokens(tokens.input)}; out ${fmtTokens(tokens.output)}), ~$${liveCost(tokens).toFixed(4)}`,
    );
    if (reason) {
      this.deps.log.warn(`phone live: Gemini session closed: ${reason}`);
      this.emit({ type: 'error', message: `Voice session ended: ${reason}` });
    }
    this.talking = false;
    if (!this.ended) {
      this.emit({ type: 'end', reason: reason ?? 'idle' });
      this.setState('idle');
    }
  }

  /** Closes the upstream session after a quiet spell, unless something is still being answered. */
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.upstream) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy.size || this.modelTalking || this.later.length) return this.armIdle();
      this.close('idle');
    }, this.cfg.idleSeconds * 1000);
    this.idleTimer.unref();
  }

  private close(why: string): void {
    if (this.upstream) this.deps.log.info(`phone live: closing the voice session (${why})`);
    clearTimeout(this.idleTimer);
    this.early = [];
    this.earlyBytes = 0;
    if (this.upstream) this.upstream.close();
    else if (why !== 'idle') {
      this.emit({ type: 'end', reason: why });
      this.setState('idle');
    }
  }

  /** A line for the model to say now (or after its current turn). */
  private tell(text: string): void {
    this.later.push(text);
    if (!this.modelTalking) this.flushLater();
  }

  private flushLater(): void {
    if (!this.later.length) return;
    if (!this.upstream) {
      // Nobody is talking to it: open a short session to say it (no microphone).
      void this.ensureUpstream().then((up) => up && this.flushLater());
      return;
    }
    const text = this.later.splice(0).join('\n\n');
    if (text.startsWith(RESULT) || text.startsWith(TASK_DONE)) this.resultSentAt = this.now();
    this.upstream.sendText(text);
    this.setState('thinking');
  }

  /** Logs the turn (lane, words, tools, the phone's timing) and starts the next. */
  private endTurn(): void {
    clearTimeout(this.turnTimer);
    const t = this.turn;
    this.turn = newTurn();
    if (!t.heard.trim() && !t.tools.length) return;
    const lane = laneOf(t.tools);
    this.deps.log.info(
      `phone live turn (${lane}${t.timing !== undefined ? `, end of speech → first word ${t.timing} ms` : ''}): "${t.heard.trim().slice(0, 80)}"${t.tools.length ? ` tools: ${t.tools.join(', ')}` : ''}`,
    );
  }

  // --- Tools ---

  private async tools(calls: FunctionCall[]): Promise<void> {
    this.setState('thinking');
    this.stats.tools += calls.length;
    const responses = await Promise.all(
      calls.map(async (call) => {
        this.turn.tools.push(call.name);
        const id = `t${++this.seq}`;
        const kit = this.deps.kit;
        const label = RULE_LABELS[call.name] ?? kit?.labels?.[call.name] ?? call.name;
        this.emit({ type: 'step', id, label, status: 'running', detail: argsText(call.args) });
        try {
          const out = await this.tool(call);
          const stepLabel = out.label ?? label;
          // Work that goes on stays ● on the strip until it ends.
          this.emit({
            type: 'step',
            id,
            label: stepLabel,
            status: out.response.error ? 'error' : out.background ? 'running' : 'ok',
          });
          if (out.card) this.emit({ type: 'card', id: `c-${call.name}-${id}`, card: out.card });
          if (out.background)
            this.background(out.background, (ok) =>
              this.emit({ type: 'step', id, label: stepLabel, status: ok ? 'ok' : 'error' }),
            );
          return { id: call.id, name: call.name, response: out.response };
        } catch (err) {
          const message = (err as Error).message;
          this.emit({ type: 'step', id, label, status: 'error', detail: message.slice(0, 120) });
          return { id: call.id, name: call.name, response: { error: message } };
        }
      }),
    );
    this.upstream?.sendToolResponses(responses);
    this.armIdle();
  }

  private ctx(signal: AbortSignal): ToolContext {
    return {
      step: (label, status = 'running', detail) => {
        const id = `s${++this.seq}`;
        this.emit({ type: 'step', id, label, status, ...(detail && { detail }) });
        return id;
      },
      finishStep: (id, status, detail) =>
        this.emit({ type: 'step', id, label: '', status, ...(detail && { detail }) }),
      card: (id, card) => this.emit({ type: 'card', id, card }),
      watchRun: (match, what) => this.watching.push({ match, what, since: this.now() }),
      signal,
    };
  }

  private async tool(call: FunctionCall): Promise<ToolOutcome> {
    const v = this.deps.voice;
    const a = call.args;
    const reply = (r: VoiceReply, title?: string): ToolOutcome => ({
      response: { answer: r.say },
      ...(r.panel && { card: { kind: 'list', title: title ?? r.panel.title, lines: r.panel.lines } }),
    });
    if (GATED.has(call.name) || this.deps.kit?.gated?.includes(call.name)) return this.gate(call);
    switch (call.name) {
      case 'running':
        return reply(v.running());
      case 'needs_me':
        return reply(await v.needs());
      case 'approvals':
        return reply(v.approvals());
      case 'next_up':
        return reply(v.nextUp());
      case 'brief':
        return reply(await v.brief());
      case 'usage':
        return reply(v.usage());
      case 'jobs': {
        const project = typeof a.project === 'string' ? a.project.toLowerCase() : '';
        const jobs = this.deps
          .jobs()
          .filter(
            (j) =>
              !project || j.project.toLowerCase() === project || j.projectTitle.toLowerCase() === project,
          );
        return {
          response: { jobs: jobs.map((j) => jobForModel(j, (t) => v.hm(t))) },
          card: {
            kind: 'list',
            title: 'Jobs',
            lines: jobs.slice(0, 8).map((j) => ({
              text: j.name,
              sub: [
                j.projectTitle,
                j.running ? 'running' : !j.enabled ? 'paused' : j.nextRun ? `next ${v.hm(j.nextRun)}` : '',
                j.lastStatus && j.lastStatus !== 'ok' ? `last: ${j.lastStatus}` : '',
              ]
                .filter(Boolean)
                .join(' · '),
              tone: j.running
                ? 'blue'
                : j.lastStatus && !['ok', 'silent'].includes(j.lastStatus)
                  ? 'red'
                  : undefined,
            })),
          },
        };
      }
      case 'quiet': {
        const m = Number(a.minutes);
        return reply(v.quiet(Number.isFinite(m) ? m : 60));
      }
      case 'show': {
        const page = a.page === 'night' ? 'night' : 'home';
        this.emit({ type: 'show', page });
        return { response: { showing: page } };
      }
      case 'watch': {
        const tasks = this.deps.tasks();
        const running = tasks.filter((t) => t.status === 'running');
        const hits = findTask(running.length ? running : tasks, String(a.run ?? ''), (p) => v.title(p));
        const t = hits[0];
        if (!t) throw new Error('No such run in memory');
        this.emit({ type: 'watch', task: t.id });
        return { response: { showing: t.title, status: t.status } };
      }
      case 'confirm':
        return { response: await this.answerConfirm(a.answer === 'yes', 'voice') };
      case 'end_conversation':
        setTimeout(() => this.close('bye'), 2_500).unref();
        return { response: { ok: true, note: 'Say a short goodbye; the session closes in a moment.' } };
      default: {
        const out = await this.deps.kit?.run(call, this.ctx(new AbortController().signal));
        if (!out) throw new Error(`No tool "${call.name}"`);
        return out;
      }
    }
  }

  /** An action: unlocked phone, then a question whose yes is checked against the user's own words. */
  private async gate(call: FunctionCall): Promise<ToolOutcome> {
    if (this.locked) {
      this.emit({ type: 'unlock' });
      return {
        response: {
          error:
            'The phone is locked. Tell the user to unlock it (the unlock prompt is on the screen); you will be told when it is unlocked, then call the tool again.',
        },
        label: 'Unlock needed',
      };
    }
    const prepared = await this.prepare(call);
    const id = `confirm-${++this.seq}`;
    this.pending = {
      id,
      question: prepared.question,
      act: prepared.act,
      expires: this.now() + CONFIRM_MS,
      heard: '',
    };
    clearTimeout(this.confirmTimer);
    this.confirmTimer = setTimeout(() => {
      if (this.pending?.id !== id) return;
      this.pending = undefined;
      this.emit({
        type: 'card',
        id,
        card: { kind: 'confirm', question: prepared.question, state: 'expired' },
      });
    }, CONFIRM_MS);
    this.confirmTimer.unref();
    this.emit({ type: 'card', id, card: { kind: 'confirm', question: prepared.question, state: 'asking' } });
    return {
      response: {
        needsConfirmation: true,
        question: prepared.question,
        note: 'Ask the user exactly this question, then call confirm with their answer. Nothing has happened yet.',
      },
      label: prepared.question.replace(/\?$/, ''),
    };
  }

  /** What a gated call would do, and the question that asks for it. */
  private async prepare(
    call: FunctionCall,
  ): Promise<{ question: string; act: () => Promise<Record<string, unknown>> }> {
    const a = call.args;
    const v = this.deps.voice;
    if (call.name === 'job') {
      const action = a.action === 'pause' ? 'pause' : a.action === 'resume' ? 'resume' : 'run';
      const jobs = this.deps.jobs();
      const said = String(a.job ?? '');
      const inProject = typeof a.project === 'string' ? `${said} in ${a.project}` : said;
      const exact = jobs.filter((j) => j.id === said);
      const { job, candidates } =
        exact.length === 1 ? { job: exact[0], candidates: exact } : findJob(jobs, inProject);
      const found = job ?? (candidates.length ? undefined : findJob(jobs, said).job);
      if (!found)
        throw new Error(
          candidates.length > 1
            ? `Which one? ${candidates
                .slice(0, 4)
                .map((j) => `${j.name} (${j.projectTitle})`)
                .join(', ')}`
            : `No job "${said}". Call jobs for the list.`,
        );
      if (action === 'run' && found.running) throw new Error(`${found.name} is already running`);
      if (action === 'pause' && !found.enabled) throw new Error(`${found.name} is already paused`);
      if (action === 'resume' && found.enabled) throw new Error(`${found.name} isn't paused`);
      const verb = action === 'run' ? 'Run' : action === 'pause' ? 'Pause' : 'Resume';
      return {
        question: `${verb} ${found.name}, in ${found.projectTitle}${action === 'run' ? ', now' : ''}?`,
        act: async () => {
          if (action === 'run') {
            const r = this.deps.runJob(found.project, found.id);
            if (r === 'started')
              this.watching.push({
                match: (t) => t.kind === 'job' && t.project === found.project && t.jobId === found.id,
                what: `The job ${found.name}`,
                since: this.now(),
              });
            return {
              job: found.name,
              result: r === 'started' ? 'started' : r === 'running' ? 'already running' : 'not found',
            };
          }
          const r = this.deps.setJobEnabled(found.project, found.id, action === 'resume');
          return {
            job: found.name,
            result: r === 'ok' ? (action === 'pause' ? 'paused' : 'resumed') : 'not found',
          };
        },
      };
    }
    if (call.name === 'stop') {
      const running = this.deps.tasks().filter((t) => t.status === 'running');
      const hits = findTask(running, String(a.run ?? ''), (p) => v.title(p));
      if (!hits.length) throw new Error(running.length ? 'No running run matches' : 'Nothing is running');
      if (hits.length > 1)
        throw new Error(
          `Which one? ${hits
            .slice(0, 3)
            .map((t) => t.title)
            .join(', ')}`,
        );
      const t = hits[0] as Task;
      return {
        question: `Stop ${t.title}, in ${v.title(t.project)}?`,
        act: async () => ({
          run: t.title,
          result: this.deps.stopTask(t.id) ? 'stopping' : 'no longer running',
        }),
      };
    }
    const kit = this.deps.kit;
    if (!kit?.question) throw new Error(`No tool "${call.name}"`);
    const question = await kit.question(call);
    return {
      question,
      act: async () => {
        const out = await kit.run(call, this.ctx(new AbortController().signal));
        if (!out) throw new Error(`No tool "${call.name}"`);
        if (out.card) this.emit({ type: 'card', id: `c-${call.name}-${++this.seq}`, card: out.card });
        if (out.background) this.background(out.background);
        return out.response;
      },
    };
  }

  /** The user answered the pending question: by voice (checked against their words) or a tap. */
  private async answerConfirm(yes: boolean, how: 'voice' | 'tap'): Promise<Record<string, unknown>> {
    const p = this.pending;
    if (!p || p.expires < this.now()) {
      this.pending = undefined;
      return { error: 'Nothing is waiting for a yes (it may have expired). Call the action again.' };
    }
    if (yes && how === 'voice') {
      const words = p.heard;
      if (SPOKEN_NO.test(words) || !SPOKEN_YES.test(words))
        return {
          error: `I didn't hear a yes from the user (heard: "${words.trim().slice(0, 80)}"). Ask again, or they can tap Yes.`,
        };
    }
    this.pending = undefined;
    clearTimeout(this.confirmTimer);
    if (!yes) {
      this.emit({ type: 'card', id: p.id, card: { kind: 'confirm', question: p.question, state: 'no' } });
      if (how === 'tap') this.tell('(The user tapped No. Say "okay" in two words.)');
      return { result: 'cancelled' };
    }
    if (this.locked) {
      this.emit({ type: 'unlock' });
      return { error: 'The phone locked meanwhile. Ask the user to unlock it, then call the action again.' };
    }
    this.emit({ type: 'card', id: p.id, card: { kind: 'confirm', question: p.question, state: 'yes' } });
    const stepId = `s${++this.seq}`;
    this.emit({ type: 'step', id: stepId, label: p.question.replace(/\?$/, ''), status: 'running' });
    try {
      const result = await p.act();
      this.emit({ type: 'step', id: stepId, label: p.question.replace(/\?$/, ''), status: 'ok' });
      this.deps.log.info(
        `phone live: "${p.question}" confirmed by ${how}: ${JSON.stringify(result).slice(0, 160)}`,
      );
      if (how === 'tap')
        this.tell(`${RESULT} of "${p.question}" (the user tapped Yes): ${JSON.stringify(result)}`);
      return result;
    } catch (err) {
      this.emit({
        type: 'step',
        id: stepId,
        label: p.question,
        status: 'error',
        detail: (err as Error).message,
      });
      return { error: (err as Error).message };
    }
  }

  private background(work: Background, finished?: (ok: boolean) => void): void {
    const controller = new AbortController();
    this.busy.set(work.id, { label: work.label, controller });
    void work.done
      .then(
        (text) => {
          finished?.(true);
          return `${RESULT} of ${work.label}: ${text}`;
        },
        (err: Error) => {
          finished?.(false);
          return `${RESULT} of ${work.label}: it failed: ${err.message}`;
        },
      )
      .then((line) => {
        this.busy.delete(work.id);
        if (this.ended) return;
        if (work.endAfter) this.closeAfterTurn = true;
        this.tell(
          `${line}\n\nTell the user the gist now, in one or two sentences; the details are on the screen.`,
        );
      });
  }

  private grounded(g: Grounding): void {
    if (!g.queries.length && !g.sources.length) return;
    this.turn.tools.push('google');
    const id = `g${++this.seq}`;
    this.emit({ type: 'step', id, label: `Google: ${g.queries[0] ?? 'search'}`, status: 'ok' });
    if (g.sources.length)
      this.emit({
        type: 'card',
        id: `sources-${id}`,
        card: {
          kind: 'sources',
          queries: g.queries,
          sources: g.sources.slice(0, 5).map((s) => ({ title: s.title, site: siteOf(s.title, s.uri) })),
        },
      });
  }

  private onActivity(e: ActivityEvent): void {
    if (e.type !== 'task' || e.task.status === 'running') return;
    const t = e.task;
    const i = this.watching.findIndex((w) => t.startedAt >= w.since - 5_000 && w.match(t));
    if (i < 0) return;
    const [w] = this.watching.splice(i, 1);
    const minutes = Math.max(1, Math.round(((t.endedAt ?? this.now()) - t.startedAt) / 60_000));
    const how =
      t.status === 'ok' ? 'finished' : t.status === 'aborted' ? 'was stopped' : `ended: ${t.status}`;
    const said = t.error ?? t.text;
    this.emit({
      type: 'card',
      id: `run-${t.id}`,
      card: { kind: 'run', task: t.id, title: t.title, project: t.project, status: t.status },
    });
    this.tell(
      `${TASK_DONE}: ${w?.what} (${t.project}) ${how} after ${minutes} min.${said ? ` Its last words: ${said.slice(-500)}` : ''}\n\nTell the user in one or two sentences.`,
    );
  }

  /** The phone went away: stop everything only it was waiting for. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.confirmTimer);
    this.unsubscribe?.();
    for (const b of this.busy.values()) b.controller.abort();
    this.busy.clear();
    this.upstream?.close();
  }
}

interface Turn {
  heard: string;
  tools: string[];
  spoke: boolean;
  timing?: number;
}

const newTurn = (): Turn => ({ heard: '', tools: [], spoke: false });

function jobForModel(j: VoiceJob, hm: (t: number) => string): Record<string, unknown> {
  return {
    project: j.projectTitle,
    id: j.id,
    name: j.name,
    ...(j.enabled ? {} : { paused: true }),
    ...(j.running && { running: true }),
    ...(j.nextRun && { next: hm(j.nextRun) }),
    ...(j.lastStatus && { last: j.lastStatus }),
    ...(j.lastRunAt && { lastAt: new Date(j.lastRunAt).toISOString().slice(0, 16) }),
    ...(j.lastError && j.lastStatus !== 'ok' && { error: j.lastError.slice(0, 200) }),
  };
}

const argsText = (args: Record<string, unknown>) => {
  const vals = Object.values(args).filter((v) => typeof v === 'string' || typeof v === 'number');
  return vals.length ? vals.join(' · ').slice(0, 100) : undefined;
};

/** Which lane a turn went through, from the tools it called. */
export function laneOf(tools: string[]): string {
  if (tools.some((t) => t === 'claude_code')) return 'claude-code';
  if (tools.some((t) => t === 'ask_claude')) return 'claude';
  if (tools.includes('google')) return 'search';
  if (tools.some((t) => t === 'play_music' || t === 'music')) return 'music';
  if (tools.length) return 'tools';
  return 'chat';
}

const siteOf = (title: string, uri: string) => {
  // Grounding links are redirects; the title is usually the site's domain.
  if (/^[\w.-]+\.[a-z]{2,}$/i.test(title)) return title;
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const emptyUsage = (): LiveUsage => ({ total: 0, input: {}, output: {} });

/** usageMetadata comes per answer; adds it up for the session. */
function addUsage(sum: LiveUsage, u: LiveUsage): void {
  sum.total += u.total;
  for (const [k, n] of Object.entries(u.input)) sum.input[k] = (sum.input[k] ?? 0) + n;
  for (const [k, n] of Object.entries(u.output)) sum.output[k] = (sum.output[k] ?? 0) + n;
}

const fmtTokens = (m: Record<string, number>) =>
  Object.entries(m)
    .map(([k, n]) => `${k.toLowerCase()} ${n}`)
    .join(', ') || '0';

/**
 * Rough price of a session (USD) at gemini-3.8-live list prices (per million tokens: audio in $3,
 * text in $0.75, audio out $12, text out $4.50; seen 2026-11-17). For the log; the bill is Google's.
 */
export function liveCost(u: LiveUsage): number {
  const p = (m: Record<string, number>, audio: number, text: number) =>
    Object.entries(m).reduce((s, [k, n]) => s + n * (k === 'AUDIO' ? audio : text), 0);
  return (p(u.input, 3, 0.75) + p(u.output, 12, 4.5)) / 1e6;
}
