import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type CastDevice,
  type CastMedia,
  castControl,
  castPlay,
  discover,
  type MusicAction,
} from './cast.js';
import type { LiveToolKit, ToolOutcome } from './phone-live.js';

/**
 * Voice v2 step 3: music on a Cast speaker (the Google Home Mini). `play_music` finds the track on
 * YouTube with yt-dlp (best audio, m4a) and casts its stream to the speaker; `music` pauses, resumes,
 * stops or sets the volume. Harmless, so no unlock or yes. The speaker is found by its name over mDNS
 * and remembered.
 */

export interface MusicDeps {
  /** The speaker's name as the Google Home app shows it (default: the first Cast device found). */
  speaker?: string;
  /** Or its address, skipping discovery. */
  host?: string;
  ytdlp?: string;
  log: { info(msg: string): void; warn(msg: string): void };
  /** Tests: stand-ins for the network. */
  find?: (query: string) => Promise<Track>;
  cast?: { play: typeof castPlay; control: typeof castControl; discover: typeof discover };
}

export interface Track extends CastMedia {
  duration?: number;
}

const exec = promisify(execFile);

/** The first YouTube result for `query`, as an audio stream URL the speaker can fetch. */
export async function findTrack(query: string, bin = 'yt-dlp'): Promise<Track> {
  const { stdout } = await exec(
    bin,
    ['-j', '--no-playlist', '--no-warnings', '-f', 'bestaudio[ext=m4a]/bestaudio', `ytsearch1:${query}`],
    { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
  );
  const j = JSON.parse(stdout) as {
    url?: string;
    ext?: string;
    title?: string;
    channel?: string;
    uploader?: string;
    thumbnail?: string;
    duration?: number;
  };
  if (!j.url) throw new Error(`Nothing found for "${query}"`);
  return {
    url: j.url,
    contentType:
      j.ext === 'm4a' || j.ext === 'mp4' ? 'audio/mp4' : j.ext === 'webm' ? 'audio/webm' : 'audio/mpeg',
    title: j.title ?? query,
    subtitle: j.channel ?? j.uploader,
    image: j.thumbnail,
    duration: j.duration,
  };
}

export class Music {
  private device?: CastDevice;
  private readonly cast: NonNullable<MusicDeps['cast']>;

  constructor(private readonly deps: MusicDeps) {
    this.cast = deps.cast ?? { play: castPlay, control: castControl, discover };
    if (deps.host) this.device = { host: deps.host, name: deps.speaker ?? deps.host };
  }

  /** Finds the speaker ahead of the first request (mDNS takes ~2.5 s). */
  warm(): this {
    if (!this.device)
      void this.speaker().catch((err: Error) => this.deps.log.warn(`phone live: ${err.message}`));
    return this;
  }

  private async speaker(fresh = false): Promise<CastDevice> {
    if (this.device && !fresh) return this.device;
    const found = await this.cast.discover(2_500);
    const want = this.deps.speaker?.toLowerCase();
    const d = want ? found.find((x) => x.name.toLowerCase() === want) : found[0];
    if (!d)
      throw new Error(
        found.length
          ? `No speaker named "${this.deps.speaker}" (found: ${found.map((x) => x.name).join(', ')})`
          : 'No Cast speaker answered on the network',
      );
    this.deps.log.info(`phone live: speaker "${d.name}" (${d.model ?? 'Cast'}) found`);
    this.device = d;
    return d;
  }

  /** Runs `fn` on the speaker, finding it again once if its address changed. */
  private async onSpeaker<T>(fn: (host: string) => Promise<T>): Promise<T> {
    try {
      return await fn((await this.speaker()).host);
    } catch (err) {
      if (this.deps.host) throw err;
      return fn((await this.speaker(true)).host);
    }
  }

  async play(query: string): Promise<{ track: Track; speaker: string; ms: { find: number; cast: number } }> {
    const t0 = Date.now();
    const [track, speaker] = await Promise.all([
      (this.deps.find ?? ((q) => findTrack(q, this.deps.ytdlp)))(query),
      this.speaker(),
    ]);
    const t1 = Date.now();
    await this.onSpeaker((host) => this.cast.play(host, track));
    const ms = { find: t1 - t0, cast: Date.now() - t1 };
    this.deps.log.info(
      `phone live: playing "${track.title}" on ${speaker.name} (found in ${ms.find} ms, cast in ${ms.cast} ms)`,
    );
    return { track, speaker: speaker.name, ms };
  }

  control(action: MusicAction, level?: number) {
    return this.onSpeaker((host) => this.cast.control(host, action, level));
  }

  kit(): LiveToolKit {
    return {
      declarations: [
        {
          name: 'play_music',
          description:
            'Play music on the room speaker (Google Home Mini): a song, artist, genre, mood or playlist, found on YouTube. Takes a few seconds: say "putting it on" in a few words and stop.',
          parameters: {
            type: 'OBJECT',
            properties: {
              query: {
                type: 'STRING',
                description: 'What to search, e.g. "lofi beats", "Arijit Singh hits", "Kesariya".',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'music',
          description:
            "Control the room speaker's music: pause, resume, stop, set the volume, or what's playing.",
          parameters: {
            type: 'OBJECT',
            properties: {
              action: {
                type: 'STRING',
                description: 'What to do.',
                enum: ['pause', 'resume', 'stop', 'volume', 'status'],
              },
              volume: { type: 'INTEGER', description: 'For volume: 0-100.' },
            },
            required: ['action'],
          },
        },
      ],
      labels: { play_music: 'Music', music: 'Speaker' },
      instructions:
        '- Music: play_music and music (the room speaker). After a RESULT saying music started, say only its title in a few words; the conversation then closes so the microphone does not hear the music.',
      run: async (call, ctx): Promise<ToolOutcome | undefined> => {
        if (call.name === 'play_music') {
          const query = String(call.args.query ?? '').trim();
          if (!query) throw new Error('"query" is required');
          const done = this.play(query).then(({ track, speaker }) => {
            ctx.card(`music-${call.id}`, {
              kind: 'music',
              title: track.title,
              sub: [track.subtitle, speaker].filter(Boolean).join(' · '),
              ...(track.image && { image: track.image }),
              state: 'playing',
            });
            return `music started on ${speaker}: "${track.title}"${track.subtitle ? ` by ${track.subtitle}` : ''}`;
          });
          return {
            response: {
              status: 'searching',
              note: 'Say "putting it on" in a few words and stop; a RESULT follows.',
            },
            background: { id: call.id, label: `play "${query.slice(0, 60)}"`, done, endAfter: true },
            label: `Music: ${query.slice(0, 40)}`,
          };
        }
        if (call.name === 'music') {
          const action = String(call.args.action ?? '') as MusicAction;
          if (!['pause', 'resume', 'stop', 'volume', 'status'].includes(action))
            throw new Error('Unknown action');
          const v = Number(call.args.volume);
          const r = await this.control(action, Number.isFinite(v) ? v / 100 : undefined);
          return {
            response: { ...r, ...(r.volume !== undefined && { volume: Math.round(r.volume * 100) }) },
            card: {
              kind: 'music',
              title: r.playing ?? (action === 'volume' ? 'Volume' : 'Speaker'),
              sub: r.volume !== undefined ? `Volume ${Math.round(r.volume * 100)}` : undefined,
              state: r.state ?? action,
            },
            label: action === 'volume' ? `Volume ${Math.round((r.volume ?? 0) * 100)}` : `Music: ${action}`,
          };
        }
        return undefined;
      },
    };
  }
}
