import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { gateRunner, gateSaysSkip, keepHead } from '../src/scheduler/gate.js';

describe('gate output', () => {
  it('keeps the start of stdout and counts the rest', () => {
    const kept = { text: '', cut: 0 };
    keepHead(kept, 'abcdef', 4);
    keepHead(kept, 'ghij', 4);
    expect(kept).toEqual({ text: 'abcd', cut: 6 });
  });

  it('a long briefing keeps its first line and says it was cut', async () => {
    const run = gateRunner();
    // Header line, then ~200k characters: more than the gate keeps.
    const result = await run({
      command: `echo HEADER; head -c 200000 /dev/zero | tr '\\0' x; echo`,
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('HEADER\n')).toBe(true);
    expect(result.stdout).toMatch(/tara-agent cut the rest of the gate output here: \d+ more characters\]$/);
    expect(gateSaysSkip(result)).toBe(false);
  });

  it('a short Skipping line still skips', async () => {
    const result = await gateRunner()({
      command: 'echo "Skipping demo: nothing new"',
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 10_000,
    });
    expect(result.stdout.trim()).toBe('Skipping demo: nothing new');
    expect(gateSaysSkip(result)).toBe(true);
  });
});
