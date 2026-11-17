import { createSocket } from 'node:dgram';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';

/**
 * Just enough Google Cast to play audio on a speaker (docs/jarvis-phone.md, Voice v2 step 3): find it
 * by mDNS, open the Cast v2 channel (TLS on port 8009, length-prefixed protobuf `CastMessage`s with
 * JSON payloads), launch the Default Media Receiver and load a URL; pause, resume, stop and volume
 * for what is playing. No library: the protocol needs six protobuf fields.
 */

export interface CastDevice {
  host: string;
  name: string;
  model?: string;
}

/** Cast devices on the LAN that answer an mDNS query within `ms`. */
export function discover(ms = 3_000): Promise<CastDevice[]> {
  return new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map<string, CastDevice>();
    const query = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      ...'_googlecast._tcp.local'
        .split('.')
        .map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])),
      Buffer.from([0, 0, 0x0c, 0, 1]),
    ]);
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('latin1');
      const name = txtValue(text, 'fn');
      const model = txtValue(text, 'md');
      if (name)
        found.set(rinfo.address, {
          host: rinfo.address,
          name: Buffer.from(name, 'latin1').toString('utf8'),
          model,
        });
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      for (let i = 0; i < 2; i++) sock.send(query, 5353, '224.0.0.251');
    });
    setTimeout(() => {
      sock.close();
      resolve([...found.values()]);
    }, ms).unref();
  });
}

/** A `key=value` from an mDNS TXT record: the value runs to the next length byte (a control char). */
function txtValue(text: string, key: string): string | undefined {
  const at = text.indexOf(`${key}=`);
  if (at < 0) return undefined;
  let end = at + key.length + 1;
  while (end < text.length && end - at < 90 && text.charCodeAt(end) >= 0x20) end++;
  return text.slice(at + key.length + 1, end) || undefined;
}

// --- CastMessage (cast_channel.proto): 1 protocol_version, 2 source_id, 3 destination_id, 4 namespace,
// 5 payload_type (0 = string), 6 payload_utf8. ---

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

export function encodeMessage(source: string, dest: string, ns: string, payload: string): Buffer {
  const str = (field: number, s: string) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([varint((field << 3) | 2), varint(b.length), b]);
  };
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]),
    str(2, source),
    str(3, dest),
    str(4, ns),
    Buffer.from([0x28, 0x00]),
    str(6, payload),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

export function decodeMessage(b: Buffer): { source: string; dest: string; ns: string; payload: string } {
  const out = { source: '', dest: '', ns: '', payload: '' };
  let i = 0;
  const read = () => {
    let shift = 0;
    let v = 0;
    for (;;) {
      const byte = b[i++] as number;
      v |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return v >>> 0;
      shift += 7;
    }
  };
  while (i < b.length) {
    const key = read();
    const field = key >> 3;
    if ((key & 7) === 0) {
      read();
      continue;
    }
    const len = read();
    const s = b.subarray(i, i + len).toString('utf8');
    i += len;
    if (field === 2) out.source = s;
    else if (field === 3) out.dest = s;
    else if (field === 4) out.ns = s;
    else if (field === 6) out.payload = s;
  }
  return out;
}

const NS = {
  conn: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
/** Google's Default Media Receiver. */
const DEFAULT_RECEIVER = 'CC1AD845';
const SENDER = 'sender-tara';

type Json = Record<string, unknown>;

/** One Cast v2 connection to a device. */
export class CastChannel {
  private buf = Buffer.alloc(0);
  private requestId = 0;
  private readonly waiting = new Map<number, (msg: Json) => void>();
  private readonly connected = new Set<string>();
  private readonly ping: NodeJS.Timeout;

  private constructor(private readonly sock: TLSSocket) {
    sock.on('data', (d) => this.data(d));
    sock.on('error', () => {});
    this.ping = setInterval(() => this.send('receiver-0', NS.heartbeat, { type: 'PING' }), 5_000);
    this.ping.unref();
  }

  static open(host: string, timeoutMs = 5_000): Promise<CastChannel> {
    return new Promise((resolve, reject) => {
      // Cast devices present a certificate of their own, not one a CA signed.
      const sock = tlsConnect({ host, port: 8009, rejectUnauthorized: false });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`The speaker at ${host} didn't answer`));
      }, timeoutMs);
      sock.once('secureConnect', () => {
        clearTimeout(timer);
        const ch = new CastChannel(sock);
        ch.connectTo('receiver-0');
        resolve(ch);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private data(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) return;
      const msg = decodeMessage(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
      let payload: Json;
      try {
        payload = JSON.parse(msg.payload) as Json;
      } catch {
        continue;
      }
      if (msg.ns === NS.heartbeat && payload.type === 'PING')
        this.send(msg.source, NS.heartbeat, { type: 'PONG' });
      const id = payload.requestId;
      if (typeof id === 'number') {
        this.waiting.get(id)?.(payload);
        this.waiting.delete(id);
      }
    }
  }

  private send(dest: string, ns: string, payload: Json): void {
    this.sock.write(encodeMessage(SENDER, dest, ns, JSON.stringify(payload)));
  }

  connectTo(dest: string): void {
    if (this.connected.has(dest)) return;
    this.connected.add(dest);
    this.send(dest, NS.conn, { type: 'CONNECT' });
  }

  request(dest: string, ns: string, payload: Json, timeoutMs = 8_000): Promise<Json> {
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error(`The speaker didn't answer ${String(payload.type)}`));
      }, timeoutMs);
      this.waiting.set(requestId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send(dest, ns, { ...payload, requestId });
    });
  }

  /**
   * Drops the connection without a Cast CLOSE: a CLOSE to the media app ends what it plays (seen on a
   * Home Mini, 2026-11-17), and music must go on after the sender leaves.
   */
  close(): void {
    clearInterval(this.ping);
    this.sock.end();
  }
}

interface ReceiverApp {
  appId: string;
  transportId: string;
  displayName?: string;
}

const appsOf = (status: Json): ReceiverApp[] =>
  ((status.status as Json | undefined)?.applications as ReceiverApp[] | undefined) ?? [];

/** What to play: a URL the speaker can fetch, with what the speaker's app shows. */
export interface CastMedia {
  url: string;
  contentType: string;
  title: string;
  subtitle?: string;
  image?: string;
}

/** Launches the Default Media Receiver (if it isn't running) and plays `media`. */
export async function castPlay(host: string, media: CastMedia): Promise<void> {
  const ch = await CastChannel.open(host);
  try {
    let status = await ch.request('receiver-0', NS.receiver, { type: 'GET_STATUS' });
    let app = appsOf(status).find((a) => a.appId === DEFAULT_RECEIVER);
    if (!app) {
      status = await ch.request(
        'receiver-0',
        NS.receiver,
        { type: 'LAUNCH', appId: DEFAULT_RECEIVER },
        15_000,
      );
      app = appsOf(status).find((a) => a.appId === DEFAULT_RECEIVER);
    }
    if (!app) throw new Error('The speaker did not start its media player');
    ch.connectTo(app.transportId);
    const res = await ch.request(
      app.transportId,
      NS.media,
      {
        type: 'LOAD',
        autoplay: true,
        media: {
          contentId: media.url,
          contentType: media.contentType,
          streamType: 'BUFFERED',
          metadata: {
            metadataType: 3,
            title: media.title,
            ...(media.subtitle && { artist: media.subtitle }),
            ...(media.image && { images: [{ url: media.image }] }),
          },
        },
      },
      20_000,
    );
    if (res.type === 'LOAD_FAILED' || res.type === 'LOAD_CANCELLED' || res.type === 'INVALID_REQUEST')
      throw new Error(`The speaker couldn't play it (${String(res.type)})`);
  } finally {
    ch.close();
  }
}

export type MusicAction = 'pause' | 'resume' | 'stop' | 'volume' | 'status';

/** Pause, resume, stop or set the volume (0–1) of what the speaker plays; returns what it plays. */
export async function castControl(
  host: string,
  action: MusicAction,
  level?: number,
): Promise<{ playing?: string; state?: string; volume?: number }> {
  const ch = await CastChannel.open(host);
  try {
    const status = await ch.request('receiver-0', NS.receiver, { type: 'GET_STATUS' });
    const volume = ((status.status as Json | undefined)?.volume as { level?: number } | undefined)?.level;
    if (action === 'volume') {
      const l = Math.max(0, Math.min(1, level ?? 0.3));
      await ch.request('receiver-0', NS.receiver, { type: 'SET_VOLUME', volume: { level: l } });
      return { volume: l };
    }
    const app = appsOf(status).find((a) => a.appId === DEFAULT_RECEIVER) ?? appsOf(status)[0];
    if (!app) return { state: 'idle', volume };
    if (action === 'stop' && app.appId === DEFAULT_RECEIVER) {
      await ch.request('receiver-0', NS.receiver, {
        type: 'STOP',
        sessionId: (app as unknown as Json).sessionId,
      });
      return { state: 'stopped', volume };
    }
    ch.connectTo(app.transportId);
    const media = await ch.request(app.transportId, NS.media, { type: 'GET_STATUS' });
    const now = ((media.status as Json[] | undefined) ?? [])[0];
    const title = ((now?.media as Json | undefined)?.metadata as Json | undefined)?.title as
      | string
      | undefined;
    if (!now || action === 'status')
      return {
        playing: title ?? app.displayName,
        state: (now?.playerState as string | undefined) ?? 'idle',
        volume,
      };
    const type = action === 'pause' ? 'PAUSE' : action === 'resume' ? 'PLAY' : 'STOP';
    await ch.request(app.transportId, NS.media, { type, mediaSessionId: now.mediaSessionId });
    return {
      playing: title,
      state: action === 'pause' ? 'paused' : action === 'resume' ? 'playing' : 'stopped',
      volume,
    };
  } finally {
    ch.close();
  }
}
