import { describe, expect, it } from 'vitest';
import { transcribeAudio } from '../src/slack/voice.js';

const options = { url: 'http://ai/v1/chat/completions', models: ['a', 'b'], apiKey: 'k' };
const reply = (content: string) => Response.json({ choices: [{ message: { content } }] });

describe('transcribeAudio', () => {
  it('sends the audio as input_audio and returns the transcript', async () => {
    const calls: RequestInit[] = [];
    const text = await transcribeAudio(Buffer.from('abc'), 'm4a', options, async (_url, init) => {
      calls.push(init as RequestInit);
      return reply(' Hi, how are you? ');
    });
    expect(text).toBe('Hi, how are you?');
    const body = JSON.parse(calls[0]?.body as string);
    expect(body.model).toBe('a');
    expect(body.messages[0].content[1]).toEqual({
      type: 'input_audio',
      input_audio: { data: Buffer.from('abc').toString('base64'), format: 'm4a' },
    });
    expect((calls[0]?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer k');
  });

  it('falls through to the next model on an error or empty answer', async () => {
    const models: string[] = [];
    const text = await transcribeAudio(
      Buffer.from('x'),
      'm4a',
      { ...options, models: ['a', 'b', 'c'] },
      async (_u, init) => {
        const { model } = JSON.parse((init as RequestInit).body as string);
        models.push(model);
        if (model === 'a') return new Response('quota', { status: 429 });
        if (model === 'b') return reply('');
        return reply('hello');
      },
    );
    expect(text).toBe('hello');
    expect(models).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined when every model fails', async () => {
    const text = await transcribeAudio(Buffer.from('x'), 'm4a', options, async () => {
      throw new Error('down');
    });
    expect(text).toBeUndefined();
  });
});
