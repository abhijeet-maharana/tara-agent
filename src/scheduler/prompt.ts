import type { JobConfig } from '../config/schema.js';
import type { Item } from '../store/store.js';
import type { ScriptResult } from './script.js';

/**
 * The cron conventions below match Hermes Agent's, so jobs and gate scripts written for Hermes run
 * unchanged: the wake gate, the "Script Output" block, `[SILENT]` and `[CRON_FAILURE]`.
 */
export const JOB_SYSTEM_PROMPT = `You are running a scheduled job unattended, through tara-agent. Nobody is watching live.
- Do the whole job now. Never wait for input mid-turn.
- Finish first, ask at the end: do every part that needs no decision, all the way through, and never stop midway for an approval you can do without. Then raise one \`request_approval\` card per thing that needs a person (a decision, a suggestion, a login or a failure you could not fix) and end your turn; each decision continues this run later. Drafts that go out later go through \`propose_item\`.
- If there is nothing worth reporting, reply with exactly [SILENT] and nothing will be posted.
- If the job failed, start your reply with a line containing only [CRON_FAILURE], then the evidence.
- Reply format: a headline of 1–6 lines (shown in the channel), then a line containing only ---, then the full details (posted in the thread). Use Slack mrkdwn and keep it phone-friendly.
- Temporary files (helper scripts, request bodies, downloads) go in $TARA_SCRATCH, never in the repo; it is deleted automatically later. Data this job needs on its next run goes in $TARA_JOB_DATA. A script that would make every run faster is code: propose it in your reply instead of saving it.`;

/** The follow-up turn after a job run that had trouble (`selfImprove`); `reasons` say what went wrong. */
export function learnPrompt(reasons: string[]): string {
  return `This run had trouble: ${reasons.join('; ')}.

Before you stop: if a change to the instructions you followed would prevent this next time, make it now with the edit tools. That means the skill (its SKILL.md) or another instruction (.md) file this run used, not code. Keep it small and specific: a corrected selector or URL, a missing step, a known trap and how to get past it. If the skill has a version in its front matter, bump it.

Do not repeat the task, open the browser or call other services. Do not create new skills or files.

Reply with exactly NONE if nothing should change. Otherwise reply with one line per file you changed: \`<path>: <what changed>\`.`;
}

/** True when the learning turn changed nothing. */
export const isNoLesson = (text: string | undefined) => !text?.trim() || /^\s*NONE\b/i.test(text);

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

/** Absolute paths of a run's folders (runner/workspace.ts). */
export interface RunFolders {
  scratch: string;
  jobData?: string;
}

/** Tells Claude where its folders are, since the Write tool needs absolute paths. */
export function foldersNote(folders: RunFolders): string {
  const lines = [
    `- Scratch folder (\`$TARA_SCRATCH\`): ${folders.scratch}. Temporary files only; deleted automatically a few days after this session's last use.`,
  ];
  if (folders.jobData)
    lines.push(
      `- Job data folder (\`$TARA_JOB_DATA\`): ${folders.jobData}. Kept between runs, for data this job needs next time.`,
    );
  return `Your folders:\n${lines.join('\n')}`;
}

/** The user prompt for one run: script data first (as Hermes does), then the job prompt, its skills and folders. */
export function buildJobPrompt(
  job: JobConfig,
  script?: ScriptResult,
  folders?: RunFolders,
  items?: Item[],
): string {
  const parts: string[] = [];
  if (items?.length) parts.push(approvedItemsBlock(items));
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
  if (folders) parts.push(foldersNote(folders));
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

/** What a queue hands its executor job: exactly these approved items, as a person approved them. */
export function approvedItemsBlock(items: Item[]): string {
  const list = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    key: i.key,
    title: i.title,
    window: i.window,
    fields: Object.fromEntries(i.fields.map((f) => [f.key, f.value])),
    // What each field is, when its key doesn't say (e.g. a form question behind `q3`).
    labels: Object.fromEntries(i.fields.filter((f) => f.label !== f.key).map((f) => [f.key, f.label])),
    note: i.reply,
  }));
  return `## Approved items
A person approved exactly these ${items.length === 1 ? 'item' : `${items.length} items`} (with any edits). Handle them in order and nothing else. Report each one with \`finish_item\` as soon as it is done (done with the result, or failed with why); an item you don't report is marked failed and never runs again.

\`\`\`json
${JSON.stringify(list, null, 2)}
\`\`\``;
}
