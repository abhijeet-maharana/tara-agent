import { describe, expect, it, vi } from 'vitest';
import { decodeMessage, encodeMessage } from '../src/live/cast.js';
import { Music } from '../src/live/music.js';
import { type LiveToolKit, mergeKits, type ToolContext } from '../src/live/phone-live.js';

const silent = { info: () => {}, warn: () => {} };

const ctx = (cards: unknown[] = []): ToolContext => ({
  step: () => 's',
  finishStep: () => {},
  card: (_id, card) => cards.push(card),
  watchRun: () => {},
  signal: new AbortController().signal,
});

describe('Cast framing', () => {
  it('round-trips a CastMessage', () => {
    const payload = JSON.stringify({ type: 'LOAD', requestId: 3, media: { contentId: 'https://x/é' } });
    const frame = encodeMessage('sender-tara', 'receiver-0', 'urn:x-cast:com.google.cast.media', payload);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(decodeMessage(frame.subarray(4))).toEqual({
      source: 'sender-tara',
      dest: 'receiver-0',
      ns: 'urn:x-cast:com.google.cast.media',
      payload,
    });
  });

  it('encodes long payloads with multi-byte lengths', () => {
    const payload = 'x'.repeat(5_000);
    expect(decodeMessage(encodeMessage('a', 'b', 'c', payload).subarray(4)).payload).toBe(payload);
  });
});

function music(over: Partial<ConstructorParameters<typeof Music>[0]> = {}) {
  const play = vi.fn(async () => {});
  const control = vi.fn(async () => ({ playing: 'Lofi', state: 'paused', volume: 0.3 }));
  const discover = vi.fn(async () => [
    { host: '10.0.0.7', name: 'My Room speaker', model: 'Google Home Mini' },
  ]);
  const m = new Music({
    speaker: 'my room speaker',
    log: silent,
    find: async (q) => ({
      url: 'https://audio',
      contentType: 'audio/mp4',
      title: `${q} mix`,
      subtitle: 'Chan',
    }),
    cast: { play, control, discover },
    ...over,
  });
  return { m, play, control, discover };
}

describe('Music', () => {
  it('finds the speaker by name, plays, and remembers it', async () => {
    const { m, play, discover } = music();
    const r = await m.play('lofi');
    expect(r.speaker).toBe('My Room speaker');
    expect(play).toHaveBeenCalledWith('10.0.0.7', expect.objectContaining({ title: 'lofi mix' }));
    await m.play('jazz');
    expect(discover).toHaveBeenCalledOnce();
  });

  it('play_music answers at once and plays in the background, then ends the conversation', async () => {
    const { m } = music();
    const cards: unknown[] = [];
    const out = await m.kit().run({ id: 'c1', name: 'play_music', args: { query: 'lofi' } }, ctx(cards));
    expect(out?.response).toMatchObject({ status: 'searching' });
    expect(out?.background?.endAfter).toBe(true);
    expect(await out?.background?.done).toBe('music started on My Room speaker: "lofi mix" by Chan');
    expect(cards[0]).toMatchObject({ kind: 'music', title: 'lofi mix', state: 'playing' });
  });

  it('sets the volume in percent', async () => {
    const { m, control } = music();
    const out = await m.kit().run({ id: 'c1', name: 'music', args: { action: 'volume', volume: 30 } }, ctx());
    expect(control).toHaveBeenCalledWith('10.0.0.7', 'volume', 0.3);
    expect(out?.label).toBe('Volume 30');
  });

  it('says which speakers it found when the named one is missing', async () => {
    const { m } = music({ speaker: 'Kitchen' });
    await expect(m.play('x')).rejects.toThrow(/found: My Room speaker/);
  });
});

describe('mergeKits', () => {
  it('routes each tool to its kit', async () => {
    const a: LiveToolKit = {
      declarations: [{ name: 'a', description: '' }],
      gated: ['a'],
      question: () => 'A?',
      run: async () => ({ response: { from: 'a' } }),
    };
    const b: LiveToolKit = {
      declarations: [{ name: 'b', description: '' }],
      run: async () => ({ response: { from: 'b' } }),
    };
    const k = mergeKits(a, undefined, b) as LiveToolKit;
    expect(k.declarations.map((d) => d.name)).toEqual(['a', 'b']);
    expect(k.gated).toEqual(['a']);
    expect(await k.question?.({ id: '1', name: 'a', args: {} })).toBe('A?');
    expect((await k.run({ id: '1', name: 'b', args: {} }, ctx()))?.response).toEqual({ from: 'b' });
    expect(mergeKits(undefined, b)).toBe(b);
  });
});
