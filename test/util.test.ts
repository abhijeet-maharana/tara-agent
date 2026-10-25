import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDuration, splitMessage, toSlackMrkdwn } from '../src/slack/format.js';
import { KeyedQueue, Semaphore, Throttle } from '../src/util/concurrency.js';

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
