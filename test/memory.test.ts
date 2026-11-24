import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import { memoryBlock, oversizedMemory } from '../src/memory/memory.js';
import { learnPrompt } from '../src/scheduler/prompt.js';
import { Store } from '../src/store/store.js';

const NOW = Date.parse('2026-11-16T10:00:00Z');

function project(memory?: string): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'tara-mem-'));
  mkdirSync(path.join(dir, '.tara'));
  if (memory !== undefined) writeFileSync(path.join(dir, '.tara', 'memory.md'), memory);
  return {
    dir,
    config: {
      name: 'shop',
      slackChannel: 'C1',
      permissionMode: 'bypassPermissions',
      chatModel: 'opus',
      allowedTools: [],
      allowedUsers: [],
      billing: 'subscription',
      selfImprove: 'always',
    },
  };
}

describe('project memory', () => {
  it('is empty with no file and no decisions', () => {
    expect(memoryBlock(project(), new Store(':memory:'), { now: NOW, timeZone: 'UTC' })).toBe('');
    expect(memoryBlock(project('  \n'), undefined, { now: NOW, timeZone: 'UTC' })).toBe('');
  });

  it('holds the memory file and recent decisions by people, newest first, without notices or auto-approvals', () => {
    let t = NOW - 20 * 86_400_000;
    const store = new Store(':memory:', () => t);
    const decide = (title: string, decision: string, by: string, kind = 'decision', reply?: string) => {
      const item = store.proposeItem({
        project: 'shop',
        kind,
        mode: 'resume',
        title,
        options: [decision, 'Reject'],
      });
      store.decideItem(item.id, { status: 'done', decision, by, reply });
    };
    decide('Too old', 'Approve', 'U1');
    t = NOW - 2 * 86_400_000;
    decide('Raise prices', 'Reject', 'U1', 'decision', 'Not before December');
    decide('Login expired', 'Seen', 'U1', 'notice');
    decide('Auto one', 'Approve', 'auto');
    t = NOW - 86_400_000;
    decide('Cut bids', 'Approve', 'U1', 'ads');
    const block = memoryBlock(project('## Ads\n- Bids never above 0.50'), store, {
      now: NOW,
      timeZone: 'UTC',
    });
    expect(block).toContain('## Project memory');
    expect(block).toContain('- Bids never above 0.50');
    expect(block).toContain('- 15 Nov · ads · "Cut bids": Approve');
    expect(block).toContain('- 14 Nov · decision · "Raise prices": Reject (note: Not before December)');
    expect(block.indexOf('Cut bids')).toBeLessThan(block.indexOf('Raise prices'));
    for (const left of ['Too old', 'Login expired', 'Auto one']) expect(block).not.toContain(left);
  });

  it('cuts a long file and says where the rest is', () => {
    const block = memoryBlock(project(`- ${'x'.repeat(20_000)}`), undefined, { now: NOW, timeZone: 'UTC' });
    expect(block.length).toBeLessThan(13_000);
    expect(block).toContain('the file is longer');
  });

  it('is kept by the learning turn of a main session, not of a step', () => {
    expect(learnPrompt([])).toContain('.tara/memory.md');
    // Skills are edited in place, kept short, never given dated notes or a version.
    for (const prompt of [learnPrompt([]), learnPrompt(['boom'], { step: 'fetch' })]) {
      expect(prompt).toContain('Never append a note');
      expect(prompt).toContain('No dates, no who said it');
      expect(prompt).toContain('under 25,000 characters');
      expect(prompt).toContain('references/<topic>.md');
      expect(prompt).not.toContain('bump it');
    }
    expect(learnPrompt([], { step: 'fetch' })).not.toContain('.tara/memory.md');
  });
});

describe('oversizedMemory', () => {
  it('reports a memory file over 150 lines or 12k characters', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tara-mem-'));
    expect(oversizedMemory(dir)).toBeUndefined(); // no file
    mkdirSync(path.join(dir, '.tara'));
    writeFileSync(path.join(dir, '.tara', 'memory.md'), '- fact\n'.repeat(100));
    expect(oversizedMemory(dir)).toBeUndefined();
    writeFileSync(path.join(dir, '.tara', 'memory.md'), '- fact\n'.repeat(151));
    expect(oversizedMemory(dir)).toEqual({ lines: 151, chars: 151 * 7 - 1 });
    writeFileSync(path.join(dir, '.tara', 'memory.md'), `- ${'x'.repeat(12_001)}`);
    expect(oversizedMemory(dir)?.chars).toBe(12_003);
  });
});
