import type WebSocket from 'ws';
import type { Logger } from '../sessions/manager.js';
import { type FunctionCall, GeminiLive, type LiveConnectOptions } from './gemini.js';
import {
  ASK_RESULT,
  attentionForModel,
  LIVE_TOOLS,
  type LiveDeps,
  type LiveState,
  matchProject,
  systemInstruction,
} from './tools.js';

/**
 * One browser tab talking to one Gemini Live session.
 *
 * Browser → tara: binary frames are microphone audio (16 kHz, 16-bit LE, mono), accepted only after
 * `{"type":"talk"}`; `{"type":"mute"}` ends talking. tara → browser: binary frames are speech (24 kHz),
 * and JSON `ServerEvent`s. The upstream session opens on "talk" and closes after `idleSeconds` with
 * nothing said by either side and no question still being answered, so the model can't speak unasked.
 */

export type LiveStateName = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export type ServerEvent =
  | { type: 'state'; state: LiveStateName }
  | { type: 'transcript'; who: 'user' | 'model'; text: string }
  | { type: 'interrupted' }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'card'; kind: 'ask'; project: string; question: string; answer?: string; error?: string }
  | { type: 'card'; kind: 'dispatch'; project: string; task: string; url?: string; error?: string }
  | { type: 'error'; message: string };

export type ClientMessage = { type: 'talk' } | { type: 'mute' } | { type: 'text'; text: string };

export interface LiveSessionConfig {
  url: string;
  apiKey: string;
  model: string;
  voice: string;
  idleSeconds: number;
  /** How to speak, added to the model's instructions (Live models take no language code). */
  language?: string;
}

/** Transcripts carry markers such as `<no speech>` and `{pause}`; they aren't words. */
export const cleanTranscript = (text: string) => text.replace(/<[^>\n]*>|\{[^}\n]*\}/g, '');

/** Audio kept while the upstream session opens: 5 s. */
const MAX_EARLY_AUDIO = 16_000 * 2 * 5;

export class LiveSession {
  private upstream?: GeminiLive;
  private opening = false;
  private state: LiveStateName = 'idle';
  private talking = false;
  private early: Buffer[] = [];
  private earlyBytes = 0;
  private modelTalking = false;
  /** Results to tell the model once it has finished its current turn. */
  private later: string[] = [];
  private readonly asks = new Map<
    string,
    { project: string; question: string; controller: AbortController }
  >();
  private idleTimer?: NodeJS.Timeout;
  private ended = false;
  /** What one upstream session carried, for the log line when it closes. */
  private stats = { opened: 0, micBytes: 0, speechBytes: 0, tools: 0 };

  constructor(
    private readonly client: WebSocket,
    private readonly cfg: LiveSessionConfig,
    private readonly deps: LiveDeps,
    private readonly shared: LiveState,
    private readonly log: Logger,
    private readonly connect: (o: LiveConnectOptions) => Promise<GeminiLive> = GeminiLive.connect,
  ) {
    client.on('message', (data, isBinary) => {
      if (isBinary) this.audio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      else this.control(data.toString());
    });
    client.on('close', () => this.end());
    client.on('error', () => this.end());
    this.emit({ type: 'state', state: 'idle' });
  }

  private emit(event: ServerEvent): void {
    if (this.client.readyState === this.client.OPEN) this.client.send(JSON.stringify(event));
  }

  private setState(state: LiveStateName): void {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: 'state', state });
  }

  private control(text: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === 'talk') {
      this.talking = true;
      void this.ensureUpstream();
    } else if (msg.type === 'mute') {
      this.talking = false;
      this.upstream?.endAudio();
      this.armIdle();
    } else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
      void this.ensureUpstream().then((up) => up?.sendText(msg.text.slice(0, 4_000)));
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

  private async ensureUpstream(): Promise<GeminiLive | undefined> {
    if (this.upstream) return this.upstream;
    if (this.opening) return undefined;
    this.opening = true;
    this.setState('connecting');
    try {
      const up = await this.connect({
        url: this.cfg.url,
        apiKey: this.cfg.apiKey,
        setup: {
          model: this.cfg.model,
          voice: this.cfg.voice,
          systemInstruction: systemInstruction(this.deps, this.cfg.language),
          tools: LIVE_TOOLS,
        },
        events: {
          onAudio: (pcm) => {
            this.modelTalking = true;
            this.setState('speaking');
            this.stats.speechBytes += pcm.length;
            if (this.client.readyState === this.client.OPEN) this.client.send(pcm);
          },
          onTranscript: (who, raw) => {
            const text = cleanTranscript(raw);
            if (!text.trim()) return;
            if (who === 'model') this.modelTalking = true;
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
            this.setState(this.asks.size ? 'thinking' : 'listening');
            this.flushLater();
            this.armIdle();
          },
          onClose: (reason) => {
            this.upstream = undefined;
            this.modelTalking = false;
            const { opened, micBytes, speechBytes, tools } = this.stats;
            // 16 kHz and 24 kHz, 16-bit mono: bytes per second.
            this.log.info(
              `live: voice session closed after ${Math.round((Date.now() - opened) / 1000)} s: heard ${(micBytes / 32_000).toFixed(1)} s, spoke ${(speechBytes / 48_000).toFixed(1)} s, ${tools} tool calls`,
            );
            if (reason) {
              this.log.warn(`live: Gemini session closed: ${reason}`);
              this.emit({ type: 'error', message: `Voice session ended: ${reason}` });
            }
            if (!this.ended) this.setState('idle');
          },
        },
      });
      if (this.ended) {
        up.close();
        return undefined;
      }
      this.upstream = up;
      this.stats = { opened: Date.now(), micBytes: this.earlyBytes, speechBytes: 0, tools: 0 };
      this.log.info(`live: voice session opened (${this.cfg.model})`);
      for (const pcm of this.early.splice(0)) up.sendAudio(pcm);
      this.earlyBytes = 0;
      this.setState('listening');
      this.armIdle();
      return up;
    } catch (err) {
      this.log.warn(`live: could not open a Gemini session: ${(err as Error).message}`);
      this.emit({ type: 'error', message: `Could not start the voice session: ${(err as Error).message}` });
      this.talking = false;
      this.early = [];
      this.earlyBytes = 0;
      this.setState('idle');
      return undefined;
    } finally {
      this.opening = false;
    }
  }

  /** Closes the upstream session after a quiet spell, unless something is still being answered. */
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.upstream) return;
    this.idleTimer = setTimeout(() => {
      if (this.asks.size || this.modelTalking || this.later.length) return this.armIdle();
      this.talking = false;
      this.upstream?.close();
    }, this.cfg.idleSeconds * 1000);
    this.idleTimer.unref();
  }

  private async tools(calls: FunctionCall[]): Promise<void> {
    this.setState('thinking');
    this.stats.tools += calls.length;
    const responses = await Promise.all(
      calls.map(async (call) => {
        this.emit({ type: 'tool', name: call.name, args: call.args });
        try {
          return { id: call.id, name: call.name, response: await this.tool(call) };
        } catch (err) {
          return { id: call.id, name: call.name, response: { error: (err as Error).message } };
        }
      }),
    );
    this.upstream?.sendToolResponses(responses);
    this.armIdle();
  }

  private async tool(call: FunctionCall): Promise<Record<string, unknown>> {
    const { deps } = this;
    const project = () => {
      const name = matchProject(deps.projects, call.args.project);
      if (!name)
        throw new Error(
          `Unknown project "${String(call.args.project)}". Projects: ${deps.projects.join(', ')}`,
        );
      return name;
    };
    const text = (key: string) => {
      const v = call.args[key];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`"${key}" is required`);
      return v.trim();
    };
    switch (call.name) {
      case 'attention':
        return attentionForModel(await deps.attention());
      case 'ask': {
        const p = project();
        const question = text('question');
        this.startAsk(call.id, p, question);
        return {
          status: 'checking',
          note: `The answer will arrive as a message starting with "${ASK_RESULT}".`,
        };
      }
      case 'dispatch': {
        const p = project();
        const task = text('task');
        try {
          const { url } = await deps.dispatch(p, task);
          this.emit({ type: 'card', kind: 'dispatch', project: p, task, url });
          return { status: 'started', where: `the ${p} Slack channel` };
        } catch (err) {
          this.emit({ type: 'card', kind: 'dispatch', project: p, task, error: (err as Error).message });
          throw err;
        }
      }
      case 'status':
        return {
          runningJobs: deps.running().map((j) => `${j.name} (${j.project})`),
          unansweredQuestions: [...this.asks.values()].map((a) => `${a.question} (${a.project})`),
        };
      case 'focus': {
        const minutes = Math.max(0, Math.min(8 * 60, Math.round(Number(call.args.minutes) || 0)));
        this.shared.focusUntil = minutes ? (deps.now ?? Date.now)() + minutes * 60_000 : 0;
        return { focus: minutes ? `on for ${minutes} minutes` : 'off' };
      }
      default:
        throw new Error(`No tool "${call.name}"`);
    }
  }

  private startAsk(id: string, project: string, question: string): void {
    const controller = new AbortController();
    this.asks.set(id, { project, question, controller });
    void this.deps
      .ask(project, question, controller.signal)
      .then(
        (answer) => {
          this.emit({ type: 'card', kind: 'ask', project, question, answer });
          return `${ASK_RESULT} for "${question}" (${project}): ${answer}`;
        },
        (err: Error) => {
          this.emit({ type: 'card', kind: 'ask', project, question, error: err.message });
          return `${ASK_RESULT} for "${question}" (${project}): it failed: ${err.message}`;
        },
      )
      .then((result) => {
        this.asks.delete(id);
        if (this.ended) return;
        this.later.push(result);
        if (!this.modelTalking) this.flushLater();
      });
  }

  private flushLater(): void {
    if (!this.later.length || !this.upstream) return;
    this.upstream.sendText(
      `${this.later.splice(0).join('\n\n')}\n\nTell the user now, in one or two sentences.`,
    );
    this.setState('thinking');
  }

  /** The tab went away: stop everything it started that only it was waiting for. */
  private end(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    for (const a of this.asks.values()) a.controller.abort();
    this.asks.clear();
    this.upstream?.close();
  }
}
