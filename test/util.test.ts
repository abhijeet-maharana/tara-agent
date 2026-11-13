import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defuseBroadcasts,
  formatDuration,
  postMarkdown,
  sendWithFallback,
  splitMessage,
  textBlock,
  toSlackMrkdwn,
} from '../src/slack/format.js';
import { KeyedQueue, Semaphore, Throttle } from '../src/util/concurrency.js';
import { FakeChat } from './fakes.js';

describe('defuseBroadcasts', () => {
  it('turns channel-wide mentions into text and keeps person mentions', () => {
    const out = toSlackMrkdwn('Hey <!channel> and <!here|here>, <!subteam^S123|@devs> — ask <@U42>');
    expect(out).not.toMatch(/<!/);
    expect(out).toContain('<@U42>');
    expect(defuseBroadcasts('<!everyone>')).toBe('@\u200beveryone');
  });
});

describe('toSlackMrkdwn', () => {
  it.each([
    ['**bold** and *italic*', '*bold* and _italic_'],
    ['## Heading', '*Heading*'],
    ['- item\n  * nested', '• item\n  • nested'],
    ['see [docs](https://example.com/x)', 'see <https://example.com/x|docs>'],
    ['~~old~~', '~old~'],
    ['a `**not bold**` b', 'a `**not bold**` b'],
    ['2 * 3 * 4', '2 * 3 * 4'],
  ])('%j', (input, expected) => {
    expect(toSlackMrkdwn(input)).toBe(expected);
  });

  it('leaves code blocks alone and drops the language tag', () => {
    expect(toSlackMrkdwn('```ts\nconst a = **b**;\n```\n**x**')).toBe('```\nconst a = **b**;\n```\n*x*');
  });
});

describe('textBlock', () => {
  it('is a markdown block for a table and a mrkdwn section otherwise', () => {
    expect(textBlock('| a | b |\n| --- | --- |\n| 1 | 2 |', 100).type).toBe('markdown');
    expect(textBlock('**Done**', 100)).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '*Done*' } });
  });
});

describe('sendWithFallback', () => {
  const table = { type: 'markdown', text: '**Card**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |' };

  it('resends markdown blocks as mrkdwn sections when Slack refuses them', async () => {
    const sent: unknown[] = [];
    const ts = await sendWithFallback([table, { type: 'actions' }], async (blocks) => {
      sent.push(blocks);
      if (sent.length === 1) throw new Error('invalid_blocks');
      return 'ts1';
    });
    expect(ts).toBe('ts1');
    expect(sent[1]).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '*Card*\n\n| a | b |\n| --- | --- |\n| 1 | 2 |' } },
      { type: 'actions' },
    ]);
  });

  it('rethrows when there was no markdown block to fall back from', async () => {
    await expect(
      sendWithFallback([{ type: 'section' }], async () => {
        throw new Error('channel_not_found');
      }),
    ).rejects.toThrow('channel_not_found');
  });
});

describe('postMarkdown', () => {
  const table = '**Stock**\n\n| SKU | Left |\n| --- | ---: |\n| car-v2 | 12 |';

  it('posts plain markdown as mrkdwn text', async () => {
    const chat = new FakeChat();
    await postMarkdown(chat, 'C1', 't1', '**Done** with [log](https://x.io)');
    expect(chat.posts.map((p) => p.text)).toEqual(['*Done* with <https://x.io|log>']);
    expect(chat.blockPosts).toEqual([]);
  });

  it('posts a chunk holding a table as a markdown block, with mrkdwn as the fallback text', async () => {
    const chat = new FakeChat();
    await postMarkdown(chat, 'C1', 't1', `${table}\n<!channel>`);
    expect(chat.posts).toEqual([]);
    const [post] = chat.blockPosts;
    expect(post?.blocks).toEqual([{ type: 'markdown', text: `${table}\n@\u200bchannel` }]);
    expect(post?.text).toContain('*Stock*');
  });

  it('falls back to mrkdwn text when Slack refuses the markdown block', async () => {
    const chat = new FakeChat();
    chat.postBlocks = async () => {
      throw new Error('invalid_blocks');
    };
    await postMarkdown(chat, 'C1', 't1', table);
    expect(chat.posts).toHaveLength(1);
    expect(chat.posts[0]?.text).toContain('| car-v2 | 12 |');
  });
});

describe('splitMessage', () => {
  it('keeps short text in one chunk', () => {
    expect(splitMessage('hello\nworld')).toEqual(['hello\nworld']);
  });

  it('splits on lines and respects the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
    const chunks = splitMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join('\n')).toBe(text);
  });

  it('closes and reopens code fences across chunks', () => {
    const code = Array.from({ length: 20 }, (_, i) => `code line ${i}`).join('\n');
    const chunks = splitMessage(`intro\n\`\`\`\n${code}\n\`\`\`\noutro`, 120);
    for (const c of chunks) expect((c.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('hard-splits a single very long line', () => {
    const chunks = splitMessage('y'.repeat(450), 200);
    expect(chunks.join('')).toBe('y'.repeat(450));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });
});

describe('formatDuration', () => {
  it.each([
    [4_200, '4s'],
    [125_000, '2m 5s'],
    [3_780_000, '1h 3m'],
  ])('%d ms', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('Semaphore', () => {
  it('limits concurrency and hands slots over in order', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const releaseA = await sem.acquire();
    expect(sem.busy).toBe(true);
    const b = sem.acquire().then((release) => {
      order.push('b');
      release();
    });
    const c = sem.acquire().then((release) => {
      order.push('c');
      release();
    });
    order.push('a');
    releaseA();
    releaseA(); // double release is a no-op
    await Promise.all([b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(sem.busy).toBe(false);
  });
});

describe('KeyedQueue', () => {
  it('serialises per key and keeps going after a failure', async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    const task =
      (name: string, ms: number, fail = false) =>
      async () => {
        await new Promise((r) => setTimeout(r, ms));
        log.push(name);
        if (fail) throw new Error(name);
      };
    const a1 = q.run('a', task('a1', 30, true));
    const a2 = q.run('a', task('a2', 1));
    const b1 = q.run('b', task('b1', 5));
    expect(q.size('a')).toBe(2);
    await expect(a1).rejects.toThrow('a1');
    await Promise.all([a2, b1]);
    expect(log).toEqual(['b1', 'a1', 'a2']);
    expect(q.size('a')).toBe(0);
  });
});

describe('Throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the latest value at most once per interval and flushes on demand', async () => {
    const sent: number[] = [];
    const t = new Throttle<number>(
      1000,
      async (v) => void sent.push(v),
      () => Date.now(),
    );
    t.push(1);
    await vi.advanceTimersByTimeAsync(0);
    t.push(2);
    t.push(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual([1]);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual([1, 3]);
    t.push(4);
    await t.flush();
    expect(sent).toEqual([1, 3, 4]);
    t.push(5);
    t.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([1, 3, 4]);
  });
});
