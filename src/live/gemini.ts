import WebSocket from 'ws';

/**
 * A Gemini Live session (`BidiGenerateContent` over WebSocket): 16 kHz PCM in, 24 kHz PCM out, function
 * calls, and transcripts of both sides. Connections last about 10 minutes, so a dropped or "go away"
 * connection is picked up again with the latest resumption handle; callers don't see it.
 */

export const GEMINI_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** A function the model may call; `parameters` uses Gemini's schema types (`OBJECT`, `STRING`…). */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'OBJECT';
    properties: Record<
      string,
      { type: 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN'; description: string; enum?: string[] }
    >;
    required?: string[];
  };
}

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveSetup {
  model: string;
  voice: string;
  systemInstruction: string;
  tools: FunctionDeclaration[];
}

export interface LiveEvents {
  /** Model speech: 24 kHz, 16-bit little-endian, mono. */
  onAudio(pcm: Buffer): void;
  /** Pieces of what was said, as they are recognised. */
  onTranscript(who: 'user' | 'model', text: string): void;
  onToolCalls(calls: FunctionCall[]): void;
  onToolCancel(ids: string[]): void;
  /** The user talked over the model: drop the audio not yet played. */
  onInterrupted(): void;
  onTurnComplete(): void;
  /** The session ended for good (not a resumed reconnect); `reason` is unset when we closed it. */
  onClose(reason?: string): void;
}

export interface LiveConnectOptions {
  url: string;
  apiKey: string;
  setup: LiveSetup;
  events: LiveEvents;
  /** How long to wait for `setupComplete`. */
  timeoutMs?: number;
}

const MAX_RESUMES = 5;

export function setupMessage(setup: LiveSetup, handle?: string): Record<string, unknown> {
  return {
    setup: {
      model: setup.model.startsWith('models/') ? setup.model : `models/${setup.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: setup.voice } } },
      },
      systemInstruction: { parts: [{ text: setup.systemInstruction }] },
      tools: setup.tools.length ? [{ functionDeclarations: setup.tools }] : [],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Without compression an audio session ends after 15 minutes.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: handle ? { handle } : {},
    },
  };
}

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> };
    turnComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: { functionCalls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }> };
  toolCallCancellation?: { ids?: string[] };
  goAway?: unknown;
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
}

export class GeminiLive {
  private ws!: WebSocket;
  private handle?: string;
  private resumes = 0;
  private closing = false;
  private ready = false;
  /** Sent while a resumed connection is being set up. */
  private pending: string[] = [];

  private constructor(private readonly opts: LiveConnectOptions) {}

  /** Opens a session; resolves once the model has accepted the setup. */
  static async connect(opts: LiveConnectOptions): Promise<GeminiLive> {
    const live = new GeminiLive(opts);
    await live.open();
    return live;
  }

  private open(): Promise<void> {
    this.ready = false;
    const url = `${this.opts.url}${this.opts.url.includes('?') ? '&' : '?'}key=${encodeURIComponent(this.opts.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => fail('Gemini Live did not answer the setup in time'),
        this.opts.timeoutMs ?? 15_000,
      );
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
        reject(new Error(reason));
      };
      ws.on('open', () => ws.send(JSON.stringify(setupMessage(this.opts.setup, this.handle))));
      ws.on('error', (err) => fail(err.message));
      ws.on('close', (code, reason) => fail(closeReason(code, reason)));
      ws.on('message', (data) => {
        const msg = parse(data);
        if (!msg?.setupComplete) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        this.ready = true;
        for (const m of this.pending.splice(0)) ws.send(m);
        ws.on('message', (d) => this.receive(parse(d)));
        ws.on('error', () => {}); // a 'close' follows
        ws.on('close', (c, r) => void this.dropped(closeReason(c, r)));
        resolve();
      });
    });
  }

  private receive(msg: ServerMessage | undefined): void {
    if (!msg) return;
    const ev = this.opts.events;
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle)
      this.handle = msg.sessionResumptionUpdate.newHandle;
    if (msg.goAway) {
      // The server is about to close this connection: move to a new one now.
      void this.dropped('go away', true);
      return;
    }
    const content = msg.serverContent;
    if (content) {
      if (content.inputTranscription?.text) ev.onTranscript('user', content.inputTranscription.text);
      if (content.outputTranscription?.text) ev.onTranscript('model', content.outputTranscription.text);
      for (const part of content.modelTurn?.parts ?? [])
        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/'))
          ev.onAudio(Buffer.from(part.inlineData.data, 'base64'));
      if (content.interrupted) ev.onInterrupted();
      if (content.turnComplete) ev.onTurnComplete();
    }
    const calls = msg.toolCall?.functionCalls;
    if (calls?.length)
      ev.onToolCalls(calls.map((c, i) => ({ id: c.id ?? `call-${i}`, name: c.name, args: c.args ?? {} })));
    if (msg.toolCallCancellation?.ids?.length) ev.onToolCancel(msg.toolCallCancellation.ids);
  }

  /** The connection ended: resume with the latest handle, or report the session closed. */
  private async dropped(reason: string, goAway = false): Promise<void> {
    if (this.closing) return;
    const old = this.ws;
    old.removeAllListeners();
    old.on('error', () => {});
    if (goAway) old.close();
    if (!this.handle || this.resumes >= MAX_RESUMES) {
      this.closing = true;
      this.opts.events.onClose(reason);
      return;
    }
    this.resumes++;
    try {
      await this.open();
    } catch (err) {
      this.closing = true;
      this.opts.events.onClose(`could not resume: ${(err as Error).message}`);
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.closing) return;
    const text = JSON.stringify(msg);
    if (this.ready && this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.pending.push(text);
  }

  /** Microphone audio: 16 kHz, 16-bit little-endian, mono. */
  sendAudio(pcm: Buffer): void {
    this.send({
      realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: pcm.toString('base64') } },
    });
  }

  /** The microphone was turned off: lets the model answer without waiting for more silence. */
  endAudio(): void {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** A text turn (e.g. a result that arrived later), which the model answers out loud. */
  sendText(text: string): void {
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  }

  sendToolResponses(responses: Array<{ id: string; name: string; response: Record<string, unknown> }>): void {
    this.send({ toolResponse: { functionResponses: responses } });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.ws.removeAllListeners();
    this.ws.on('error', () => {});
    this.ws.close();
    this.opts.events.onClose();
  }
}

function parse(data: WebSocket.RawData): ServerMessage | undefined {
  try {
    return JSON.parse(data.toString()) as ServerMessage;
  } catch {
    return undefined;
  }
}

const closeReason = (code: number, reason: Buffer) =>
  `closed (${code})${reason.length ? `: ${reason.toString()}` : ''}`;
