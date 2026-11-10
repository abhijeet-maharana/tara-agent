import type { DiffView, RepoStatus } from '../code/repo.js';
import type { JobState } from '../http/dashboard.js';
import type { Activity, Task } from './activity.js';
import type { Alerts } from './alerts.js';
import type { Attention } from './attention.js';
import type { FunctionDeclaration } from './gemini.js';

/** One connected project at a glance: the Systems column of the Command page, and the `projects` tool. */
export interface ProjectOverview {
  name: string;
  title: string;
  jobs: { total: number; running: string[]; failing: string[]; paused: number };
  /** Approval cards waiting for a decision. */
  approvals: number;
  /** Absent when the Code page doesn't read this project's repo. */
  repo?: { branch?: string; changes: number; error?: string };
  /** The project's own dashboard: its tabs here (`/p/<name>`), else its `dashboardUrl`. */
  dashboardUrl?: string;
}

export interface JobSummary {
  project: string;
  id: string;
  name: string;
  state: JobState;
  cron?: string;
  nextRun?: number;
  lastRunAt?: number;
  lastError?: string;
  /** The latest runs, newest first: the jobs panel draws them as a row of bars. */
  recent?: Array<{ status: string; at: number; ms: number }>;
}

export interface ApprovalSummary {
  id: string;
  project: string;
  title: string;
  kind: string;
  options: string[];
  /** The start of the card's text. */
  body?: string;
  createdAt: number;
}

/** What Command's tools reach in the rest of tara-agent. */
export interface LiveDeps {
  agentName: string;
  /** Project names. */
  projects: string[];
  /** Repos the Code page reads: project names, and folder names for extra repos. */
  repos: string[];
  overview(): Promise<ProjectOverview[]>;
  attention(): Promise<Attention>;
  /** A read-only Claude turn in the project; resolves with its answer. */
  ask(project: string, question: string, signal: AbortSignal): Promise<string>;
  /** Starts a Slack conversation in the project's channel; resolves with the thread and its link. */
  dispatch(
    project: string,
    task: string,
  ): Promise<{ url?: string; thread?: { channel: string; ts: string } }>;
  /** Every labelled Claude run, live. */
  activity: Pick<Activity, 'subscribe' | 'tasks' | 'usage' | 'stop'>;
  /** Urgent alerts, for every tab. */
  alerts?: Pick<Alerts, 'subscribe'>;
  /** Every project's scheduled jobs. */
  jobs(): JobSummary[];
  runJob(project: string, id: string): 'started' | 'unknown' | 'running';
  setJobEnabled(project: string, id: string, enabled: boolean): 'ok' | 'unknown';
  repo(name: string): Promise<RepoStatus>;
  /** One file's uncommitted change. */
  diff(name: string, file: string): Promise<DiffView>;
  /** Approval cards waiting for a decision. */
  approvals(): ApprovalSummary[];
  /** Decides a card as its project's owner would on the Approvals page. */
  decide(id: string, option: string): Promise<{ status: string }>;
  now?: () => number;
}

/** Shared by every Command tab: focus mode mutes the urgent tier (docs/command.md). */
export interface LiveState {
  focusUntil: number;
}

export const ASK_RESULT = 'ASK RESULT';
export const TASK_DONE = 'TASK DONE';
export const URGENT = 'URGENT';

const PROJECT = { type: 'STRING', description: 'Project name, from the list in your instructions.' } as const;

export const LIVE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'attention',
    description:
      'What needs the user now: approvals, permission prompts, failing jobs, uncommitted work, pull requests. Call it for "what needs me", "what\'s up", "anything urgent".',
  },
  {
    name: 'brief',
    description:
      'Everything for a short briefing: what needs the user, each project, what is running, and what finished in the last hours. Call it for "brief me", "catch me up", "good morning".',
  },
  {
    name: 'projects',
    description:
      'Every connected project at a glance: running and failing jobs, waiting approvals, uncommitted files, branch. Call it for "how is everything", "status of my projects".',
  },
  {
    name: 'jobs',
    description: "Scheduled jobs and their state (running, failing, paused, ok), shown on the user's screen.",
    parameters: {
      type: 'OBJECT',
      properties: { project: { ...PROJECT, description: 'Only this project. Leave out for every project.' } },
    },
  },
  {
    name: 'job',
    description:
      'Run a scheduled job now, or pause or resume it. Running one starts real work: if the user did not name the job clearly, confirm first.',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: 'What to do.', enum: ['run', 'pause', 'resume'] },
        project: PROJECT,
        job: { type: 'STRING', description: 'The job, by name or id.' },
      },
      required: ['action', 'project', 'job'],
    },
  },
  {
    name: 'repo',
    description:
      "A repo's branch, last commit and uncommitted changes, shown on the user's screen. With file, that file's diff instead.",
    parameters: {
      type: 'OBJECT',
      properties: {
        repo: { type: 'STRING', description: 'Repo name, from the list in your instructions.' },
        file: {
          type: 'STRING',
          description: "A changed file's path, as repo listed it. Leave out for the list.",
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'approvals',
    description:
      "Approval cards waiting for a decision, shown on the user's screen with their buttons. Gives each card's id and options for decide.",
    parameters: {
      type: 'OBJECT',
      properties: { project: { ...PROJECT, description: 'Only this project. Leave out for every project.' } },
    },
  },
  {
    name: 'decide',
    description:
      'Decide one approval card with one of its options. Only after the user named the card and the option, you repeated both back, and they said yes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: 'The card id, from approvals.' },
        option: { type: 'STRING', description: "One of the card's options, as approvals gave it." },
      },
      required: ['id', 'option'],
    },
  },
  {
    name: 'ask',
    description: `Ask Claude a question about one project's code or files (read-only). Takes 5–30 seconds: say in a few words that you're checking, then stop talking. The answer arrives later as a message starting with "${ASK_RESULT}".`,
    parameters: {
      type: 'OBJECT',
      properties: {
        project: PROJECT,
        question: { type: 'STRING', description: 'The question, complete enough to answer on its own.' },
      },
      required: ['project', 'question'],
    },
  },
  {
    name: 'dispatch',
    description:
      "Hand a task that changes something (fix, write, run, send) to Claude in the project's Slack channel. It works there and posts the result; you don't get it back.",
    parameters: {
      type: 'OBJECT',
      properties: {
        project: PROJECT,
        task: { type: 'STRING', description: 'What to do, with every detail the user gave.' },
      },
      required: ['project', 'task'],
    },
  },
  {
    name: 'status',
    description:
      'What is running right now: Claude tasks (chats, jobs, questions) with their current step, and questions you asked that have not been answered yet.',
  },
  {
    name: 'stop',
    description:
      'Stop a running Claude task. Its work so far stays; the thread says it was stopped. If more than one task could be meant, ask which first.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task: {
          type: 'STRING',
          description: "Which task: words from its title, or its project's name when only one runs there.",
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'watch',
    description:
      'Put one running or recent Claude task in the middle of the screen, with every step as it happens. Call it for "show me", "let me watch".',
    parameters: {
      type: 'OBJECT',
      properties: {
        task: {
          type: 'STRING',
          description: "Which task: words from its title, or its project's name when only one runs there.",
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'focus',
    description: 'Focus mode: no interruptions for this many minutes. 0 ends it.',
    parameters: {
      type: 'OBJECT',
      properties: { minutes: { type: 'INTEGER', description: 'Minutes; 0 turns focus mode off.' } },
      required: ['minutes'],
    },
  },
];

/** `language`: how to speak (host `live.language`), e.g. "Indian English; Hindi when spoken to in Hindi". */
export function systemInstruction(
  deps: Pick<LiveDeps, 'agentName' | 'projects'> & { repos?: string[] },
  language?: string,
): string {
  const extraRepos = (deps.repos ?? []).filter((r) => !deps.projects.includes(r));
  return `You are ${deps.agentName}, the voice of the user's command center for their software projects. The user is working; don't distract them. Their screen shows what your tools return: lists, diffs and cards appear there as you call them.
${language ? `\nLanguage and accent: ${language}\n` : ''}
- Speak briefly: one or two sentences. Details are on screen: say "it's on your screen" rather than reading out a list.
- Never start a topic yourself, and no small talk.
- Only state facts about projects, code, jobs or pull requests that a tool gave you in this conversation. Otherwise call a tool, or say you don't know.
- Don't read out URLs, IDs or code.
- "What needs me?", "what's up?": call attention. Mention the urgent and waiting items; mention "later" items only if asked.
- "How is everything?", one project's health: call projects.
- Jobs: jobs lists them; job runs, pauses or resumes one.
- Branch and uncommitted changes: call repo. Questions about code or files: call ask. When a message starting with "${ASK_RESULT}" arrives, tell the user the answer in a sentence or two.
- Approvals: call approvals to put them on screen. Call decide only after the user said which card and which option, you repeated both back, and they said yes.
- Anything else that changes something: call dispatch. If the request is vague, confirm it in one sentence first. Afterwards say it's started and they can watch it on screen.
- "What's running?", "how is the fix going?": call status. "Show me", "let me watch": call watch. "Stop it": call stop.
- When a message starting with "${TASK_DONE}" arrives, tell the user in one sentence how that task ended.
- When a message starting with "${URGENT}" arrives, say it in one sentence, then stop.
- "Brief me", "catch me up": call brief, then say the most important things in two or three sentences: what needs them first, then what is running or just finished. Skip what is quiet.

Projects: ${deps.projects.join(', ')}.${extraRepos.length ? `\nOther repos: ${extraRepos.join(', ')}.` : ''}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The name the model meant: exact, then ignoring case and separators. */
export function matchProject(projects: string[], said: unknown): string | undefined {
  if (typeof said !== 'string') return undefined;
  if (projects.includes(said)) return said;
  return projects.find((p) => norm(p) === norm(said));
}

/** The job the model meant: by id or name, exact, then ignoring case and separators, then the one name containing it. */
export function matchJob<T extends { id: string; name: string }>(jobs: T[], said: unknown): T | undefined {
  if (typeof said !== 'string' || !norm(said)) return undefined;
  const exact = jobs.find((j) => j.id === said || j.name === said);
  if (exact) return exact;
  const loose = jobs.find((j) => norm(j.id) === norm(said) || norm(j.name) === norm(said));
  if (loose) return loose;
  const partial = jobs.filter((j) => norm(j.name).includes(norm(said)) || norm(j.id).includes(norm(said)));
  return partial.length === 1 ? partial[0] : undefined;
}

/** Attention, trimmed for a spoken answer: every urgent and waiting item, and a count of the rest. */
export function attentionForModel(a: Attention): Record<string, unknown> {
  const now = a.items.filter((i) => i.tier !== 'later');
  const later = a.items.filter((i) => i.tier === 'later');
  return {
    urgent: now.filter((i) => i.tier === 'urgent').map((i) => i.title),
    waiting: now.filter((i) => i.tier === 'waiting').map((i) => i.title),
    later: { count: later.length, first: later.slice(0, 5).map((i) => i.title) },
    ...(a.notes.length ? { couldNotCheck: a.notes } : {}),
  };
}

/** The overview, trimmed for a spoken answer: only what isn't zero. */
export function overviewForModel(projects: ProjectOverview[]): Array<Record<string, unknown>> {
  return projects.map((p) => {
    const out: Record<string, unknown> = { project: p.name };
    if (p.jobs.running.length) out.runningJobs = p.jobs.running;
    if (p.jobs.failing.length) out.failingJobs = p.jobs.failing;
    if (p.jobs.paused) out.pausedJobs = p.jobs.paused;
    if (p.approvals) out.waitingApprovals = p.approvals;
    if (p.repo?.changes) out.uncommittedFiles = p.repo.changes;
    if (p.repo?.branch) out.branch = p.repo.branch;
    if (p.repo?.error) out.repoError = p.repo.error;
    return out;
  });
}

/**
 * The running task the model meant: by id, by project when only one runs there, else the one whose
 * title has every word said. `candidates` lists what it could have been when it isn't clear.
 */
export function matchTask(running: Task[], said: unknown): { task?: Task; candidates: Task[] } {
  if (typeof said !== 'string' || !said.trim()) return { candidates: running };
  const byId = running.find((t) => t.id === said);
  if (byId) return { task: byId, candidates: [byId] };
  const project = matchProject([...new Set(running.map((t) => t.project))], said);
  const inProject = running.filter((t) => t.project === project);
  if (inProject.length)
    return inProject.length === 1 ? { task: inProject[0], candidates: inProject } : { candidates: inProject };
  const words = said
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const hits = running.filter(
    (t) => words.length && words.every((w) => `${t.title} ${t.project}`.toLowerCase().includes(w)),
  );
  return hits.length === 1
    ? { task: hits[0], candidates: hits }
    : { candidates: hits.length ? hits : running };
}
