/**
 * Scheduled runs go through Slack: at cron time the scheduler posts a trigger message in the
 * project channel, and the bot, seeing its own message arrive, starts the job in that message's
 * thread. The message then becomes the run's status line, and its thread holds the run and its
 * session, so the whole history is in Slack and any run can be asked about later.
 */

/** The `by` the bot passes when it starts a job from its own trigger message. */
export const SCHEDULE_BY = 'schedule';

export type ScheduledKind = 'schedule' | 'catch-up';

/** "⏰ Scheduled: *Find jobs* (`find-jobs`)". The id in backticks is what the bot reads back. */
export function scheduledRunText(name: string, id: string, kind: ScheduledKind): string {
  return `⏰ ${kind === 'catch-up' ? 'Catch-up' : 'Scheduled'}: *${name}* (\`${id}\`)`;
}

// Slack stores the emoji as its name, so the message comes back as ":alarm_clock: Scheduled: …".
const TRIGGER = /^(?:⏰|:alarm_clock:) (?:Scheduled|Catch-up): .* \(`([a-z0-9][a-z0-9-]*)`\)$/s;

/** Starts like a trigger message, whether or not the rest parses. */
export function looksLikeTrigger(text: string): boolean {
  return /^(?:⏰|:alarm_clock:) (?:Scheduled|Catch-up): /.test(text.trim());
}

/** The job id in a trigger message, or undefined when the text isn't one. */
export function parseScheduledRun(text: string): string | undefined {
  return TRIGGER.exec(text.trim())?.[1];
}
