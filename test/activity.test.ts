import { afterEach, describe, expect, it, vi } from 'vitest';
import { Activity, type ActivityEvent, MAX_STEPS, redact } from '../src/runner/activity.js';
import type { Runner, RunOptions, RunOutcome } from '../src/runner/run.js';
import type { StreamEvent } from '../src/runner/stream.js';

const OPTIONS: RunOptions = { bin: 'claude', args: [], cwd: '/p', env: {}, prompt: 'hi', timeoutMs: 1_000 };

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  status: 'ok',
  text: '',
  durationMs: 1,
  toolCalls: 0,
  permissionDenials: [],
  ...over,
});

/** A runner that reports `events`, then waits for `finish` (or its signal) before it ends. */
function fakeRun(events: StreamEvent[]) {
  let finish!: (o: RunOutcome) => void;
  let signal: AbortSignal | undefined;
  const run: Runner = (o) => {
    signal = o.signal;
    for (const e of events) o.onEvent?.(e);
    return new Promise<RunOutcome>((resolve) => {
      finish = resolve;
      o.signal?.addEventListener('abort', () => resolve(outcome({ status: 'aborted', text: '' })));
    });
  };
  return { run, finish: (o: RunOutcome) => finish(o), signal: () => signal };
}

describe('Activity', () => {
  afterEach(() => vi.useRealTimers());

  it('leaves runs without a label alone', async () => {
    const activity = new Activity();
    const seen: ActivityEvent[] = [];
    activity.subscribe((e) => seen.push(e));
    const run = activity.wrap(async () => outcome({ text: 'x' }));
    expect((await run(OPTIONS)).text).toBe('x');
    expect(seen).toEqual([]);
    expect(activity.tasks()).toEqual([]);
  });

  it('streams a labelled run: start, steps, text, then how it ended', async () => {
    vi.useFakeTimers();
    let t = 1_000;
    const activity = new Activity({ threadUrl: (c, ts) => `https://slack/${c}/${ts}`, now: () => t });
    const seen: ActivityEvent[] = [];
    activity.subscribe((e) => seen.push(e));
    const fake = fakeRun([
      { kind: 'tool', id: 't1', name: 'Read', status: 'Reading src/sync.ts' },
      {
        kind: 'tool',
        id: 't2',
        name: 'Bash',
        status: 'Running curl -H "Authorization: Bearer abcdefghijklmnop1234"',
        parent: 'a',
      },
      { kind: 'tool_result', id: 't1', isError: false },
      { kind: 'tool_result', id: 't2', isError: true },
      { kind: 'text', text: 'Fixed it. API_KEY=supersecretvalue' },
    ]);
    const original = vi.fn();
    const done = activity.wrap(fake.run)({
      ...OPTIONS,
      onEvent: original,
      label: {
        project: 'shop',
        kind: 'chat',
        title: 'Fix the retry\nmore lines',
        thread: { channel: 'C1', ts: '1.5' },
      },
    });
    expect(original).toHaveBeenCalledTimes(5);
    expect(seen).toHaveLength(1);
    const start = seen[0];
    expect(start).toMatchObject({
      type: 'task',
      task: {
        project: 'shop',
        kind: 'chat',
        title: 'Fix the retry',
        status: 'running',
        url: 'https://slack/C1/1.5',
        steps: [],
      },
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toHaveLength(2);
    const live = seen[1]?.type === 'task' ? seen[1].task : undefined;
    expect(live?.steps.map((s) => [s.text, s.state, s.depth])).toEqual([
      ['Reading src/sync.ts', 'ok', 0],
      ['Running curl -H "Authorization: Bearer •••"', 'error', 1],
    ]);
    expect(live?.text).toBe('Fixed it. API_KEY=•••');
    expect(activity.tasks()[0]?.status).toBe('running');

    t = 61_000;
    fake.finish(outcome({ text: 'All done.', costUsd: 0.12 }));
    await done;
    const end = seen.at(-1);
    expect(end).toMatchObject({
      type: 'task',
      task: {
        status: 'ok',
        text: 'All done.',
        costUsd: 0.12,
        startedAt: 1_000,
        endedAt: 61_000,
        stepCount: 2,
      },
    });
    expect(activity.tasks().map((x) => x.status)).toEqual(['ok']);
  });

  it("stops a task through its own signal, and keeps the caller's signal working", async () => {
    const activity = new Activity();
    const fake = fakeRun([]);
    const caller = new AbortController();
    const done = activity.wrap(fake.run)({
      ...OPTIONS,
      signal: caller.signal,
      label: { project: 'shop', kind: 'job', title: 'Sync' },
    });
    const [task] = activity.tasks();
    expect(activity.stop('nope')).toBe(false);
    expect(activity.stop(task?.id ?? '')).toBe(true);
    expect((await done).status).toBe('aborted');
    expect(caller.signal.aborted).toBe(false);
    expect(activity.tasks()[0]?.status).toBe('aborted');
    expect(activity.stop(task?.id ?? '')).toBe(false);

    const second = fakeRun([]);
    const other = new AbortController();
    const run2 = activity.wrap(second.run)({
      ...OPTIONS,
      signal: other.signal,
      label: { project: 'shop', kind: 'chat', title: 'x' },
    });
    other.abort();
    expect((await run2).status).toBe('aborted');
  });

  it('keeps the latest steps and passes on usage', async () => {
    const activity = new Activity();
    const seen: ActivityEvent[] = [];
    activity.subscribe((e) => seen.push(e));
    const events: StreamEvent[] = Array.from({ length: MAX_STEPS + 5 }, (_, i) => ({
      kind: 'tool',
      id: `t${i}`,
      name: 'Read',
      status: `step ${i}`,
    }));
    events.push({
      kind: 'rate_limit',
      rateLimit: { status: 'allowed', window: 'five_hour', utilization: 0.38 },
    });
    const fake = fakeRun(events);
    const done = activity.wrap(fake.run)({
      ...OPTIONS,
      label: { project: 'shop', kind: 'ask', title: 'Q?' },
    });
    fake.finish(outcome({ status: 'error', error: 'boom' }));
    await done;
    const [task] = activity.tasks();
    expect(task?.stepCount).toBe(MAX_STEPS + 5);
    expect(task?.steps).toHaveLength(MAX_STEPS);
    expect(task?.steps[0]?.text).toBe('step 5');
    // A run that failed leaves no step spinning.
    expect(task?.steps.every((s) => s.state === 'error')).toBe(true);
    expect(task?.error).toBe('boom');
    expect(activity.usage()?.utilization).toBe(0.38);
    expect(seen.some((e) => e.type === 'usage')).toBe(true);
  });
});

describe('redact', () => {
  it('hides keys, tokens and passwords', () => {
    expect(redact('export SLACK=xoxb-1234567890-abcdef')).toBe('export SLACK=xoxb-•••');
    expect(redact('gh auth ghp_abcdefghijklmnopqrstuvwxyz')).toBe('gh auth ghp_•••');
    expect(redact('key sk-ant-api03-abcdefghijk')).toBe('key sk-ant-•••');
    expect(redact('AKIAABCDEFGHIJKLMNOP')).toBe('AKIA•••');
    expect(redact('git clone https://me:hunter22@github.com/x')).toBe(
      'git clone https://me:•••@github.com/x',
    );
    expect(redact('DB_PASSWORD="p4ss w0rd" next')).toBe('DB_PASSWORD=••• next');
    expect(redact('{"apiKey": "abc123"}')).toBe('{"apiKey": •••}');
    expect(redact('Reading src/token-store.ts')).toBe('Reading src/token-store.ts');
  });
});
