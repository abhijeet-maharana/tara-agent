/**
 * Scheduled runs go through Slack: at cron time the scheduler posts a trigger message in the
 * project channel, and the bot, seeing its own message arrive, starts the job in that message's
 * thread. The message then becomes the run's status line, and its thread holds the run and its
 * session, so the whole history is in Slack and any run can be asked about later.
 */

import { skillJobName } from '../config/schema.js';

/** The `by` the bot passes when it starts a job from its own trigger message. */
export const SCHEDULE_BY = 'schedule';

export type ScheduledKind = 'schedule' | 'catch-up';

/**
 * "Run Weekly GA4 Audit": the job's name, the words a person would type, so the channel reads like
 * someone asking for the job. The run streams into the message's thread. Catch-ups read the same; the
 * slot knows which. A kebab-case or snake_case id is never shown raw: `jobs-reload` reads "Jobs Reload".
 */
export function scheduledRunText(name: string, words?: Record<string, string>): string {
  return `Run ${titleName(name, words)}`;
}

/**
 * A name as the channel shows it: a bare id (`weekly-ga4-audit`, `pnl_2`, `pnl`) in title case
 * ("Weekly Ga4 Audit", or as the project's `words` write a word), anything else (a name a person
 * wrote, with spaces or capitals) as it is.
 */
export function titleName(name: string, words: Record<string, string> = {}): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(trimmed)) return trimmed;
  return skillJobName(trimmed.replace(/_/g, '-'), words);
}

/**
 * The name a job's Run message uses: its name, or (when another job of the project has that name)
 * its id in title case, so `findRunJob` still tells them apart.
 */
export function runName(
  job: { id: string; name: string },
  jobs: Array<{ id: string; name: string }>,
  words?: Record<string, string>,
): string {
  const key = nameKey(titleName(job.name, words));
  return jobs.some((j) => j.id !== job.id && nameKey(titleName(j.name, words)) === key)
    ? titleName(job.id, words)
    : titleName(job.name, words);
}

const nameKey = (s: string) =>
  s
    .trim()
    .replace(/[\s_-]+/g, ' ')
    .toLowerCase();

/**
 * The job a Run message names: by its exact name (any case and spacing), its id, or its id in title
 * case (what `runName` posts when two jobs share a name).
 */
export function findRunJob<J extends { id: string; name: string }>(jobs: J[], said: string): J | undefined {
  const key = nameKey(said);
  const exact = jobs.find((j) => j.id === said.trim());
  if (exact) return exact;
  const byName = jobs.filter((j) => nameKey(j.name) === key);
  if (byName.length === 1) return byName[0];
  return jobs.find((j) => nameKey(j.id) === key) ?? byName[0];
}

/**
 * The one kind of message tara starts in a project channel: a top-level "Run <name>". Everything
 * else (status, the answer, cards, notes) goes in its thread, so the channel is a list of runs.
 * `name` is a job's name (`runName`), or what runs when it isn't a job (a card's kind).
 */
export function openRunThread(
  chat: { post(channel: string, threadTs: string | undefined, text: string): Promise<string> },
  channel: string,
  name: string,
  words?: Record<string, string>,
): Promise<string> {
  return chat.post(channel, undefined, scheduledRunText(name, words));
}

const RUN = /^run\s+`?([^`\n]{1,150}?)`?$/i;

/**
 * What a trigger message names (a job's name or id; `findRunJob` finds the job), or undefined when the
 * text isn't one. "Run <name>" is also what a person may type: it runs a scheduled slot only when one
 * is waiting for that job (see the manager).
 */
export function parseScheduledRun(text: string): string | undefined {
  return RUN.exec(text.trim())?.[1]?.trim();
}
