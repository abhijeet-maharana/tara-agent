import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A job's instructions live in its skill: the `## Job: <id>` section of the job's first skill, with a
 * `### Step: <name>` part per step. This moves the `prompt` / `promptFile` text of an older jobs file
 * there (`tara-agent move-prompts`, and `import-hermes`).
 */

type RawStep = Record<string, unknown> & { name?: string; prompt?: string; promptFile?: string };
type RawJob = Record<string, unknown> & {
  id: string;
  name: string;
  prompt?: string;
  skills?: string[];
  steps?: RawStep[];
  agent?: boolean;
  harness?: string;
};
export type RawJobsFile = Record<string, unknown> & { jobs: RawJob[] };

export interface PromptMove {
  /** The jobs file without `prompt` / `promptFile`, and with each job's skill first in `skills`. */
  jobsFile: RawJobsFile;
  /** Skill files to write: absolute path → full content (new, or with sections appended). */
  skillFiles: Map<string, string>;
  /** Step prompt files whose text now sits in a skill; nothing reads them any more. */
  unusedPromptFiles: string[];
  /** One line per job: `id → .claude/skills/x/SKILL.md`. */
  moved: string[];
}

const SKILL_DIRS = ['.claude/skills', '.agents/skills'];

/** The heading of a job's section in its skill. */
export const jobSection = (id: string) => `## Job: \`${id}\``;

/** The skill's SKILL.md in the repo, if it has one. */
export function findSkillFile(repo: string, skill: string): string | undefined {
  return SKILL_DIRS.map((d) => path.join(repo, d, skill, 'SKILL.md')).find((f) => existsSync(f));
}

/** Where a new skill goes: where the job's CLI looks (agy: `.agents/skills`), else `.claude/skills`. */
function newSkillFile(repo: string, skill: string, harness: string | undefined): string {
  const dirs = harness === 'agy' ? [...SKILL_DIRS].reverse() : SKILL_DIRS;
  const dir = dirs.find((d) => existsSync(path.join(repo, d))) ?? (dirs[0] as string);
  return path.join(repo, dir, skill, 'SKILL.md');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Drops what no longer fits inside the skill: a restated schedule (it's in `cron`) and "the X skill" for itself. */
function tidy(text: string, skill: string): string {
  let t = text.trim().replace(/^(?:Every|On the) [^.]*? IST\)?(?: \([^)]*\))?[,:] */, '');
  t = t.replace(
    new RegExp(`\\b(?:the )?(?:attached )?[\`'"]?${escapeRe(skill)}[\`'"]? skill\\b`, 'gi'),
    'this skill',
  );
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function bumpVersion(md: string): string {
  return md.replace(
    /^(---\n[\s\S]*?\nversion:\s*["']?)(\d+)\.(\d+)\.(\d+)/,
    (_, pre: string, a: string, b: string, c: string) => `${pre}${a}.${b}.${Number(c) + 1}`,
  );
}

function newSkill(skill: string, job: RawJob): string {
  const description = `Instructions for the tara job "${job.name}" (${job.id}). Use when running that job.`;
  return `---\nname: ${skill}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${job.name}\n`;
}

const OLD_INTRO = '"Above" means the run\'s prompt: the pre-run script\'s output and any approved items.';
const PLAIN_INTRO = '"Above" means the run\'s prompt: its approved items and step output.';
const intro = (job: RawJob, script: boolean) =>
  `Instructions for the tara job \`${job.id}\` (${job.name}). ${
    script
      ? '"Above", "the script output" and "the gate output" mean what the script under "Before you start" printed; approved items and step output are in the run\'s prompt.'
      : PLAIN_INTRO
  }`;

/** The job section's own words for the old pre-run script, now the script under "Before you start". */
function renameScript(section: string): string {
  return section
    .replace(
      /A pre-run script has already run (this job|it) in/g,
      'The script under "Before you start" runs $1 in',
    )
    .replace(
      /(^|\. )(?:Every [^.\n]*? IST )?the pre-run script/gim,
      (_, lead: string) => `${lead}The script under "Before you start"`,
    )
    .replace(/the pre-run (?:script|gate)/gi, 'the script under "Before you start"');
}

/** How the model runs a job script from the repo root (as tara ran `preScript`). */
function scriptCommand(script: string): string {
  if (script.endsWith('.py')) return `python3 ${script}`;
  if (script.endsWith('.sh')) return `bash ${script}`;
  return script.startsWith('/') || script.startsWith('./') ? script : `./${script}`;
}

/** The `### Before you start` part that replaces `preScript` (and, for a script-only job, `agent: false`). */
function beforeYouStart(script: string, scriptOnly: boolean): string {
  const run = `Run \`${scriptCommand(script)}\` from the repo root with the Bash tool, with a timeout as long as the job's (it can take minutes). It gets the job's environment: \`$TARA_JOB_DATA\` and the job's env are set.`;
  const failed =
    'If it exits with an error, read the error and fix the script when the bug is in it. Run it again only when it failed before changing anything: never repeat a part that may already have sent, posted or changed something. If the job still could not be done, start your reply with `[CRON_FAILURE]`, then the error and what you found.';
  if (scriptOnly)
    return `### Before you start\n\n${run}\n\nThis job is the script: reply with a one-line headline of what it did (from its output), then a line with only \`---\`, then everything it printed in a code block. If it printed nothing, reply with exactly \`[SILENT]\`. ${failed}`;
  return `### Before you start\n\n${run} Skip it when the run's prompt has \`## Approved items\` (a queue already chose the work).\n\n- It prints nothing, or its last line is \`{"wakeAgent": false}\`: there is nothing to do. Reply with exactly \`[SILENT]\` and stop.\n- ${failed}\n- Otherwise what it printed is the input for the rest of this section.`;
}

/**
 * Works out the move without writing anything: `prompt`, step `prompt` / `promptFile`, `preScript` and
 * `agent` leave the jobs file for the job's skill. Throws when a job's text can't be placed.
 */
export function planPromptMove(repo: string, source: RawJobsFile): PromptMove {
  const jobsFile = structuredClone(source);
  const skillFiles = new Map<string, string>();
  const promptFiles = new Set<string>();
  const moved: string[] = [];
  const current = (file: string) =>
    skillFiles.get(file) ?? (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

  for (const job of jobsFile.jobs) {
    const steps = job.steps ?? [];
    const stepText = steps.some((s) => s.prompt || s.promptFile);
    const script = typeof job.preScript === 'string' ? job.preScript : undefined;
    const scriptOnly = job.agent === false;
    const instructions = Boolean(job.prompt?.trim()) || stepText;
    const skills = job.skills ?? [];
    const first = skills[0] ? findSkillFile(repo, skills[0]) : undefined;
    const hasSection = Boolean(first && current(first)?.includes(jobSection(job.id)));
    delete job.agent;
    delete job.preScript;
    if (!job.prompt && !stepText && !script) {
      // Only a stale line to update in a section moved earlier.
      if (first && hasSection && current(first)?.includes(OLD_INTRO))
        skillFiles.set(first, (current(first) as string).replace(OLD_INTRO, PLAIN_INTRO));
      continue;
    }

    // The section goes in the job's own skill: the one that has it already, its only skill, else a
    // skill named after the job.
    const only = skills.length === 1 && first ? skills[0] : undefined;
    const home = hasSection ? (skills[0] as string) : (only ?? job.id);
    job.skills = [home, ...skills.filter((s) => s !== home)];
    const file = findSkillFile(repo, home) ?? newSkillFile(repo, home, job.harness);
    const isNew = !existsSync(file);
    let md = skillFiles.get(file);
    if (md === undefined) md = isNew ? newSkill(home, job) : bumpVersion(readFileSync(file, 'utf8'));

    if (hasSection) {
      if (job.prompt || stepText)
        throw new Error(`${path.relative(repo, file)} already has a "${jobSection(job.id)}" section`);
      // Only the script to add: right after the section's first paragraph, with the intro updated.
      const at = md.indexOf(jobSection(job.id));
      const introStart = md.indexOf('\n\n', at) + 2;
      const introEnd = md.indexOf('\n\n', introStart);
      const end = introEnd < 0 ? md.length : introEnd;
      const rest = md.slice(end);
      const next = rest.indexOf('\n## ', 1);
      const [body, after] = next < 0 ? [rest, ''] : [rest.slice(0, next), rest.slice(next)];
      md = `${md.slice(0, introStart)}${intro(job, true)}\n\n${beforeYouStart(script as string, scriptOnly)}${renameScript(body)}${after}`;
      skillFiles.set(file, md);
      moved.push(`${job.id}: script → ${path.relative(repo, file)}`);
      continue;
    }

    const parts = [jobSection(job.id), intro(job, Boolean(script))];
    if (script) parts.push(beforeYouStart(script, scriptOnly));
    if (job.prompt?.trim() && !scriptOnly)
      parts.push(script ? renameScript(tidy(job.prompt, home)) : tidy(job.prompt, home));
    const read = (f: string) => {
      promptFiles.add(f);
      return readFileSync(path.join(repo, f), 'utf8').trim();
    };
    const files = new Set(steps.map((s) => s.promptFile));
    const shared = files.size === 1 && steps[0]?.promptFile ? steps[0].promptFile : undefined;
    if (shared) parts.push(`### Every step\n\n${read(shared)}`);
    for (const step of steps) {
      const own = step.promptFile && step.promptFile !== shared ? read(step.promptFile) : '';
      const text = [own, step.prompt ? tidy(step.prompt, home) : ''].filter(Boolean).join('\n\n');
      parts.push(`### Step: ${step.name}${text ? `\n\n${text}` : ''}`);
      delete step.prompt;
      delete step.promptFile;
    }
    delete job.prompt;

    skillFiles.set(file, `${md.replace(/\s*$/, '\n')}\n${parts.join('\n\n')}\n`);
    const what = [instructions && !scriptOnly ? 'instructions' : '', script ? 'script' : '']
      .filter(Boolean)
      .join(' + ');
    moved.push(
      `${job.id}: ${what || 'instructions'} → ${path.relative(repo, file)}${isNew ? ' (new skill)' : ''}`,
    );
  }
  return { jobsFile, skillFiles, unusedPromptFiles: [...promptFiles], moved };
}

/** Writes the skills, then the jobs file (so a reload never sees a job without its section). */
export function applyPromptMove(move: PromptMove, jobsPath: string): void {
  for (const [file, content] of move.skillFiles) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  writeFileSync(jobsPath, `${JSON.stringify(move.jobsFile, null, 2)}\n`);
}
