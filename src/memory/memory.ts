import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../config/schema.js';
import type { Item, ItemStatus, Store } from '../store/store.js';

/**
 * Project memory: what runs need to know that no skill or file in the repo says (what was decided or
 * done and when, the person's preferences, work still in progress). Two sources, both given to every
 * fresh session in its first prompt (`memoryBlock`), so a run in a new thread (a decision on a card,
 * the next scheduled run) starts from them instead of an earlier conversation:
 *   - `.tara/memory.md` in the project, written by learning turns after runs (see `MEMORY_LEARN_NOTE`)
 *   - recent decisions on cards, straight from the store, so a rejection is never proposed again
 * Only fresh sessions get it: a resumed session already has it, and repeating it would only grow its
 * context.
 */

export const MEMORY_FILE = path.join('.tara', 'memory.md');
/** More than this many characters of the file are left for the session to read itself. */
export const MEMORY_MAX = 12_000;
/** Learning turns are asked to keep the file under about this many lines (`MEMORY_LEARN_NOTE`). */
export const MEMORY_MAX_LINES = 150;
const DECISION_DAYS = 14;
const DECISION_MAX = 15;
const DECIDED: ItemStatus[] = ['done', 'rejected', 'approved', 'running', 'failed', 'cancelled'];

/** The project's memory file, trimmed; undefined when there is none or it is empty. */
export function readMemory(project: Project): string | undefined {
  try {
    const text = readFileSync(path.join(project.dir, MEMORY_FILE), 'utf8').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Decisions a person made on the project's cards in the last two weeks, newest first, one line each. */
export function recentDecisions(store: Store, project: string, now: number, timeZone: string): string[] {
  const since = now - DECISION_DAYS * 86_400_000;
  const day = (t: number) =>
    new Date(t).toLocaleDateString('en-GB', { timeZone, day: 'numeric', month: 'short' });
  return store
    .items({ project, statuses: DECIDED, since, limit: 200 })
    .filter((i): i is Item & { decidedAt: number; decision: string } =>
      Boolean(
        i.decidedAt &&
          i.decision &&
          i.decidedBy &&
          i.decidedBy !== 'auto' &&
          i.decidedAt >= since &&
          // A notice only tells; seeing it is no decision.
          i.kind !== 'notice',
      ),
    )
    .sort((a, b) => b.decidedAt - a.decidedAt)
    .slice(0, DECISION_MAX)
    .map((i) => {
      const note = i.reply?.trim() ? ` (note: ${oneLine(i.reply, 200)})` : '';
      return `- ${day(i.decidedAt)} · ${i.kind}${i.jobId ? ` · ${i.jobId}` : ''} · "${oneLine(i.title, 150)}": ${i.decision}${note}`;
    });
}

/**
 * The `## Project memory` section of a fresh session's first prompt, or '' when there is nothing in
 * it yet.
 */
export function memoryBlock(
  project: Project,
  store: Store | undefined,
  opts: { now: number; timeZone: string },
): string {
  const file = readMemory(project);
  const decisions = store ? recentDecisions(store, project.config.name, opts.now, opts.timeZone) : [];
  if (!file && !decisions.length) return '';
  const parts = ['## Project memory'];
  if (file) {
    const cut = file.length > MEMORY_MAX;
    parts.push(
      `From \`${MEMORY_FILE}\`, kept by earlier runs. Trust it, but check anything that may have changed since:\n\n${
        cut
          ? `${file.slice(0, MEMORY_MAX)}\n\n… (the file is longer: read the rest of \`${MEMORY_FILE}\` if it matters here)`
          : file
      }`,
    );
  }
  if (decisions.length)
    parts.push(
      `### Recent decisions on cards\nWhat a person chose on this project's approval cards lately. Don't raise again what was turned down unless something changed.\n${decisions.join('\n')}`,
    );
  return parts.join('\n\n');
}

/** What a learning turn is told about the memory file (see `learnPrompt`). */
export const MEMORY_LEARN_NOTE = `Separately, facts worth keeping for later runs go in the project memory file \`${MEMORY_FILE}\` (create it if missing). Every new session starts with it, including the one that acts on an approval card in a new thread, so it is how the next run knows what this one learned. Worth keeping: what was decided or done and when, the person's preferences, the state of work still in progress (with ids and links), and facts about this project that turned out to be true. Not how to do a task (that goes in the skill), and not what the repo or a skill already says. One short line per fact, under a \`## \` heading per topic, with the date for anything that changes. Replace a fact that is no longer true instead of adding to it, and keep the file under about ${MEMORY_MAX_LINES} lines and ${MEMORY_MAX / 1000}k characters: only that much reaches the next session.`;

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The memory file's size when it is over what a session gets (`MEMORY_MAX`) or the line limit; else undefined. */
export function oversizedMemory(dir: string): { lines: number; chars: number } | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(dir, MEMORY_FILE), 'utf8').trim();
  } catch {
    return undefined;
  }
  const lines = text ? text.split('\n').length : 0;
  return text.length > MEMORY_MAX || lines > MEMORY_MAX_LINES ? { lines, chars: text.length } : undefined;
}
