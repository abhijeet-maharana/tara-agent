/** Speech-to-text for voice notes Slack has no transcript for. */
export interface VoiceOptions {
  /** An OpenAI-compatible chat completions URL whose models take `input_audio` (e.g. Gemini). */
  url: string;
  /** Tried in order until one answers. */
  models: string[];
  apiKey?: string;
}

const PROMPT = 'Transcribe this voice note exactly, in the language spoken. Reply with the transcript only.';

/** The words in an audio file (`format` is its extension, e.g. m4a), or undefined if no model managed. */
export async function transcribeAudio(
  audio: Buffer,
  format: string,
  options: VoiceOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const data = audio.toString('base64');
  for (const model of options.models) {
    try {
      const res = await fetchImpl(options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: PROMPT },
                { type: 'input_audio', input_audio: { data, format } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch {
      // Next model.
    }
  }
  return undefined;
}
