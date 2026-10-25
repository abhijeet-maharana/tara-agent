import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../config/schema.js';

/**
 * Where Claude keeps files, given to each run as environment variables:
 *   - `TARA_SCRATCH`: a scratch folder per session (job run or chat thread) for temporary files.
 *     It is deleted `scratchDays` after the session last used it, so temporary files never pile up.
 *   - `TARA_JOB_DATA`: a folder per scheduled job that is never deleted, for data the job keeps
 *     between runs. Pre-run scripts get it too.
 * Only folders tara-agent created (they hold a marker file) are ever deleted.
 */

const MARKER = '.tara-scratch';
const DAY_MS = 86_400_000;

/** Parent of the project's session folders: `scratchDir` (relative to the repo) or the state dir. */
export function scratchRoot(project: Project, stateDir: string): string {
  const dir = project.config.scratchDir;
  return dir ? path.resolve(project.dir, dir) : path.join(stateDir, 'scratch', project.config.name);
}

function jobDataRoot(project: Project, stateDir: string): string {
  const dir = project.config.jobDataDir;
  return dir ? path.resolve(project.dir, dir) : path.join(stateDir, 'job-data', project.config.name);
}

/**
 * One session's scratch folder, `<root>/<label>-<first 8 of the session id>`: created on first use,
 * and its marker touched on every use, which is what the sweep goes by.
 */
export function sessionScratch(project: Project, stateDir: string, label: string, sessionId: string): string {
  const dir = path.join(scratchRoot(project, stateDir), `${label}-${sessionId.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, MARKER);
  if (existsSync(marker)) {
    const now = new Date();
    utimesSync(marker, now, now);
  } else {
    writeFileSync(
      marker,
      'Scratch folder of one tara-agent session; deleted a few days after its last use.\n',
    );
  }
  return dir;
}

/** A scheduled job's persistent data folder, `<root>/<job id>` (created on first use). */
export function jobDataDir(project: Project, stateDir: string, jobId: string): string {
  const dir = path.join(jobDataRoot(project, stateDir), jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Deletes session folders not used for `days`; returns how many. Never throws. */
export function sweepScratch(projects: Project[], stateDir: string, days: number, now = Date.now()): number {
  let removed = 0;
  for (const project of projects) {
    const root = scratchRoot(project, stateDir);
    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(root, name);
      try {
        // No marker: not ours, leave it alone.
        if (now - statSync(path.join(dir, MARKER)).mtimeMs < days * DAY_MS) continue;
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        // missing marker or a file that couldn't be removed: try again next sweep
      }
    }
  }
  return removed;
}
