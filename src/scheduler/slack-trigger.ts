/**
 * Scheduled runs go through Slack: at cron time the scheduler posts a trigger message in the
 * project channel, and the bot, seeing its own message arrive, starts the job in that message's
 * thread. The message then becomes the run's status line, and its thread holds the run and its
 * session, so the whole history is in Slack and any run can be asked about later.
 */

/** The `by` the bot passes when it starts a job from its own trigger message. */
export const SCHEDULE_BY = 'schedule';

export type ScheduledKind = 'schedule' | 'catch-up';

/**
 * "Run Weekly GA4 Audit": the job's name, the words a person would type, so the channel reads like
 * someone asking for the job. The run streams into the message's thread. Catch-ups read the same; the
 * slot knows which.
 */
export function scheduledRunText(name: string): string {
  return `Run ${name}`;
}

/** The name a job's Run message uses: its name, or its id when another job of the project has that name. */
export function runName(
  job: { id: string; name: string },
  jobs: Array<{ id: string; name: string }>,
): string {
  const key = nameKey(job.name);
  return jobs.some((j) => j.id !== job.id && nameKey(j.name) === key) ? job.id : job.name;
}

const nameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The job a Run message names: by its exact name (any case and spacing) or its id. */
export function findRunJob<J extends { id: string; name: string }>(jobs: J[], said: string): J | undefined {
  const key = nameKey(said);
  return jobs.find((j) => j.id === key) ?? jobs.find((j) => nameKey(j.name) === key);
}

/**
 * The one kind of message tara starts in a project channel: a top-level "Run <name>". Everything
 * else (status, the answer, cards, notes) goes in its thread, so the channel is a list of runs.
 * `name` is a job's name (`runName`), or what runs when it isn't a job (`health-digest`, a card's kind).
 */
export function openRunThread(
  chat: { post(channel: string, threadTs: string | undefined, text: string): Promise<string> },
  channel: string,
  name: string,
): Promise<string> {
  return chat.post(channel, undefined, scheduledRunText(name));
}

const RUN = /^run\s+`?([^`\n]{1,150}?)`?$/i;
// The older form, still read back so a trigger posted before an upgrade runs. Slack stores the emoji
// as its name, so it comes back as ":alarm_clock: Scheduled: …".
const LEGACY = /^(?:⏰|:alarm_clock:) (?:Scheduled|Catch-up): .* \(`([a-z0-9][a-z0-9-]*)`\)$/s;

/** Starts like an older trigger message, whether or not the rest parses. */
export function looksLikeTrigger(text: string): boolean {
  return /^(?:⏰|:alarm_clock:) (?:Scheduled|Catch-up): /.test(text.trim());
}

/**
 * What a trigger message names (a job's name or id; `findRunJob` finds the job), or undefined when the
 * text isn't one. "Run <name>" is also what a person may type: it runs a scheduled slot only when one
 * is waiting for that job (see the manager).
 */
export function parseScheduledRun(text: string): string | undefined {
  const t = text.trim();
  return LEGACY.exec(t)?.[1] ?? RUN.exec(t)?.[1]?.trim();
}
