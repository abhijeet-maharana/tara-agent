import type { Harness, JobConfig } from '../config/schema.js';
import { hasTable } from '../slack/format.js';
import type { Item } from '../store/store.js';

export const JOB_SYSTEM_PROMPT = `You are running a scheduled job unattended, through tara-agent. Nobody is watching live.
- Do the whole job now. Never wait for input mid-turn.
- Finish first, ask at the end: do every part that needs no decision, all the way through, and never stop midway for an approval you can do without. Then raise one \`request_approval\` card per thing that needs a person (a decision, a suggestion, a login or a failure you could not fix) and end your turn; each decision continues this run later. Drafts that go out later go through \`propose_item\`.
- Nothing worth reporting: reply with one ✅ line saying so, e.g. "✅ No new notices".
- If the job itself could not be done (a login, a page or a script broke), start the reply with ❌ and the reason, then the evidence: a first line starting with ❌ marks the run failed. Problems the job found are ⚠️, never ❌.
- Reply format: a headline of 1–6 lines (shown next to the run's status line, at the top of its thread), then a line containing only ---, then the full details (posted below it). Write normal markdown (it is converted for Slack) and use a markdown table whenever the content fits one.
- Keep the reply clean: a one-line headline with the outcome (✅ nothing to do, ⚠️ what needs action), then a table, then only what someone has to act on. No item-by-item lines that just say 0 or OK, no process narration. This beats a report layout in the job's skill: keep its facts, use this layout. WhatsApp messages keep their own format.
- Temporary files (request bodies, downloads, one-off helpers) go in $TARA_SCRATCH, never in the repo; it is deleted automatically later. Data this job needs on its next run goes in $TARA_JOB_DATA.
- A script that would make every run faster or more reliable is worth keeping: save it in the \`scripts/\` folder of the job's skill, run it from there, and add it to the skill (what it does, when to run it, how to read its output). Fix a script the skill runs when it is wrong, instead of working around it.`;

/** For a job's `steps`: sessions that run before the main prompt and only feed it. */
export const STEP_SYSTEM_PROMPT = `You are one step of a scheduled job, running unattended through tara-agent. Nobody is watching live and nobody reads your reply but the job's next session.
- Do only this step, all the way through, then reply with its result in the form the step asks for. Never wait for input or ask questions.
- You have no Slack tools: don't try to post, send files or ask for approval. The job's main session does that with your result.
- Temporary files go in $TARA_SCRATCH (named below); the main session can read them there.`;

/**
 * The follow-up turn after a run (`selfImprove`). `reasons` say what went wrong; empty means the run
 * was clean and only gets a look back for what it had to figure out.
 */
export function learnPrompt(reasons: string[]): string {
  const opening = reasons.length
    ? `This run had trouble: ${reasons.join('; ')}.

Before you stop: if a change to the instructions you followed would prevent this next time, make it now with the edit tools.`
    : `This run is done. Before you stop, look back at it once: did you hit a wrong selector, URL, command or assumption, retry something, find a workaround, take a slow path you would skip next time, or learn a fact about this project the instructions didn't give you?

Only if writing that down would make the next run faster or more reliable, make the change now with the edit tools. Don't rewrite what already worked, and don't add general advice: only what this run actually discovered.`;
  return `${opening} That means the skill this run used (its SKILL.md, or a script in its folder that the skill runs) or another instruction (.md) file it used. Keep it small and specific: a corrected selector or URL, a missing step, a known trap and how to get past it, a fixed bug in a script. A new script goes in the skill's \`scripts/\` folder, with SKILL.md saying when and how to run it. If the skill has a version in its front matter, bump it.

Do not repeat the task, open the browser or call other services. Do not create new skills.

Reply with exactly NONE if nothing should change. Otherwise reply with one line per file you changed: \`<path>: <what changed>\`.`;
}

/** True when the learning turn changed nothing. */
export const isNoLesson = (text: string | undefined) => !text?.trim() || /^\s*NONE\b/i.test(text);

/** First line of every run's system prompt, so Claude knows the name people call it by. */
export const identityPrompt = (agentName: string) => `Your name is ${agentName}.`;

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

/** The card a decision was made on, passed along so a session that never saw it (a handoff) knows it. */
export interface DecidedCard {
  title: string;
  body: string;
  /** Rejected, skipped or otherwise not approved. */
  declined: boolean;
}

const cardSection = (card: DecidedCard) =>
  `## The card\n### ${card.title}\n${card.body.trim() || '(no details)'}`;

/**
 * The first prompt of a session a decision hands the run over to (job `handoff`): it has none of the
 * run's history, so it gets the card, the decision and the job's own instructions.
 */
export function buildHandoffPrompt(
  job: JobConfig,
  from: Harness,
  card: DecidedCard,
  decision: string,
  folders: RunFolders,
): string {
  return [
    `This run of the job "${job.name}" ran on ${from} until now. It continues here, in a new session, after a decision on one of its approval cards. You don't have the earlier conversation: the card below and the job's instructions are what you have. Act on the decision only; the rest of the run is already done.`,
    cardSection(card),
    `## The decision\n${decision}`,
    `## The job's instructions\n${jobInstructions(job)}`,
    foldersNote(folders),
  ].join('\n\n');
}

/** A later decision in a handed-over session: that session never saw this card, so it comes along. */
export const decisionWithCard = (card: DecidedCard, decision: string) =>
  `${cardSection(card)}\n\n${decision}`;

/** What the main session is told to do: the job's section in its first skill. */
export function jobInstructions(job: Pick<JobConfig, 'id' | 'name' | 'skills' | 'steps'>): string {
  const steps =
    job.steps.length > 0
      ? ' Its "### Step" parts were done by the sessions before you (their output is above): do the rest.'
      : '';
  return `Run the job "${job.name}" (\`${job.id}\`): do what the "## Job" section of the \`${job.skills[0]}\` skill says (in an older skill: "## Job: \`${job.id}\`"), with the rest of that skill.${steps}`;
}

/** What one step's session is told to do: its part of the job's section. */
export function stepInstructions(
  job: Pick<JobConfig, 'id' | 'name' | 'skills'>,
  step: Pick<JobConfig['steps'][number], 'name' | 'skill'>,
): string {
  const skill = step.skill ?? job.skills[0];
  return `This is the step "${step.name}" of the job "${job.name}" (\`${job.id}\`). Load the \`${skill}\` skill (the Skill tool, or its SKILL.md). In its "## Job" section (in an older skill: "## Job: \`${job.id}\`"), do only the "### Step: ${step.name}" part (and the "### Every step" part, if there is one); the rest of that section is for the session after the steps.`;
}

/** The user prompt for one run: approved items and step output, then what to do, its skills and folders. */
export function buildJobPrompt(
  job: JobConfig,
  folders?: RunFolders,
  items?: Item[],
  /** The `## Step Output` section from the job's steps. */
  stepOutput?: string,
): string {
  const parts: string[] = [];
  if (items?.length) parts.push(approvedItemsBlock(items));
  if (stepOutput) parts.push(stepOutput);
  parts.push(jobInstructions(job));
  if (job.skills.length > 1) {
    parts.push(
      `Skills for this job: ${job.skills.map((s) => `\`${s}\``).join(', ')}. ` +
        'Load each one before you start (the Skill tool, or its SKILL.md) and follow it.',
    );
  }
  if (folders) parts.push(foldersNote(folders));
  return parts.join('\n\n');
}

/** What went wrong when the job says it could not be done (the reply starts with ❌), else undefined. */
export function failedReply(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.startsWith('❌')
    ? trimmed.slice('❌'.length).trim() || 'The job reported a failure.'
    : undefined;
}

const HEADLINE_MAX = 600;

/** Splits a reply into the channel headline and the thread details (at a line containing only `---`). */
export function splitHeadline(text: string): { headline: string; details: string } {
  const { headline, details } = splitAtSeparator(text);
  if (!hasTable(headline)) return { headline, details };
  // The status line can't show a table: it moves to the details, with what follows it.
  const lines = headline.split('\n');
  const at = lines.findIndex((l) => l.trim().startsWith('|'));
  return {
    headline: lines.slice(0, at).join('\n').trim(),
    details: [lines.slice(at).join('\n').trim(), details].filter(Boolean).join('\n\n'),
  };
}

function splitAtSeparator(text: string): { headline: string; details: string } {
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
