import type { JobConfig } from '../config/schema.js';
import type { ScriptResult } from './script.js';

/**
 * The cron conventions below match Hermes Agent's, so jobs and gate scripts written for Hermes run
 * unchanged: the wake gate, the "Script Output" block, `[SILENT]` and `[CRON_FAILURE]`.
 */
export const JOB_SYSTEM_PROMPT = `You are running a scheduled job unattended, through tara-agent. Nobody is watching live.
- Do the whole job now. Never wait for input mid-turn.
- If the job needs a human decision (an approval), finish with the exact proposal and ask for a reply of approve or reject. Replies in the job's Slack thread resume this session.
- If there is nothing worth reporting, reply with exactly [SILENT] and nothing will be posted.
- If the job failed, start your reply with a line containing only [CRON_FAILURE], then the evidence.
- Reply format: a headline of 1–6 lines (shown in the channel), then a line containing only ---, then the full details (posted in the thread). Use Slack mrkdwn and keep it phone-friendly.`;

/** First line of every run's system prompt, so Claude knows the name people call it by. */
export const identityPrompt = (agentName: string) => `Your name is ${agentName}.`;

/** False only when the script's last non-empty line is JSON `{"wakeAgent": false}`. */
export function parseWakeGate(output: string): boolean {
  const lines = output.split('\n').filter((l) => l.trim());
  const last = lines.at(-1);
  if (!last) return true;
  try {
    const gate: unknown = JSON.parse(last.trim());
    return !(
      typeof gate === 'object' &&
      gate !== null &&
      (gate as { wakeAgent?: unknown }).wakeAgent === false
    );
  } catch {
    return true;
  }
}

/** The user prompt for one run: script data first (as Hermes does), then the job prompt and its skills. */
export function buildJobPrompt(job: JobConfig, script?: ScriptResult): string {
  const parts: string[] = [];
  if (script) {
    const [heading, intro] = script.ok
      ? [
          'Script Output',
          'The following data was collected by a pre-run script. Use it as context for your analysis.',
        ]
      : ['Script Error', 'The data-collection script failed. Report this to the user.'];
    parts.push(`## ${heading}\n${intro}\n\n\`\`\`\n${script.output}\n\`\`\``);
  }
  parts.push(job.prompt ?? '');
  if (job.skills.length > 0) {
    parts.push(
      `Skills for this job: ${job.skills.map((s) => `\`${s}\``).join(', ')}. ` +
        'Load each one before you start (the Skill tool, or its SKILL.md) and follow it.',
    );
  }
  return parts.join('\n\n');
}

const SILENT = /^\s*(\[SILENT\]|SILENT|NO[_ ]REPLY)\s*$/i;

/** `[SILENT]` (or SILENT / NO_REPLY / NO REPLY) as the whole reply or as its own first or last line. */
export function isSilentReply(text: string): boolean {
  const lines = text
    .trim()
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length === 0) return true;
  return SILENT.test(lines[0] as string) || SILENT.test(lines.at(-1) as string);
}

/** Evidence when the reply's first line is exactly `[CRON_FAILURE]`, else undefined. */
export function cronFailure(text: string): string | undefined {
  const lines = text.trim().split('\n');
  if (lines[0]?.trimEnd() !== '[CRON_FAILURE]') return undefined;
  return lines.slice(1).join('\n').trim() || 'The job reported a failure.';
}

const HEADLINE_MAX = 600;

/** Splits a reply into the channel headline and the thread details (at a line containing only `---`). */
export function splitHeadline(text: string): { headline: string; details: string } {
  const trimmed = text.trim();
  const match = /^\s*-{3,}\s*$/m.exec(trimmed);
  if (match) {
    return {
      headline: trimmed.slice(0, match.index).trim(),
      details: trimmed.slice(match.index + match[0].length).trim(),
    };
  }
  if (trimmed.length <= HEADLINE_MAX) return { headline: trimmed, details: '' };
  const firstBreak = trimmed.indexOf('\n\n');
  const cut =
    firstBreak > 0 && firstBreak <= HEADLINE_MAX ? firstBreak : trimmed.lastIndexOf('\n', HEADLINE_MAX);
  const at = cut > 0 ? cut : HEADLINE_MAX;
  return { headline: trimmed.slice(0, at).trim(), details: trimmed.slice(at).trim() };
}
