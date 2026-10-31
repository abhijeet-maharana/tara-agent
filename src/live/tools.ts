import type { Attention } from './attention.js';
import type { FunctionDeclaration } from './gemini.js';

/** What Live's tools reach in the rest of tara-agent. */
export interface LiveDeps {
  agentName: string;
  /** Project names. */
  projects: string[];
  attention(): Promise<Attention>;
  /** A read-only Claude turn in the project; resolves with its answer. */
  ask(project: string, question: string, signal: AbortSignal): Promise<string>;
  /** Starts a Slack conversation in the project's channel; resolves with the thread's link. */
  dispatch(project: string, task: string): Promise<{ url?: string }>;
  /** Jobs running now. */
  running(): Array<{ project: string; name: string }>;
  now?: () => number;
}

/** Shared by every Live tab: focus mode mutes the urgent tier (docs/live.md). */
export interface LiveState {
  focusUntil: number;
}

export const ASK_RESULT = 'ASK RESULT';

export const LIVE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'attention',
    description:
      'What needs the user now: approvals, permission prompts, failing jobs, uncommitted work, pull requests. Call it for "what needs me", "what\'s up", "anything urgent".',
  },
  {
    name: 'ask',
    description: `Ask Claude a question about one project's code or files (read-only). Takes 5–30 seconds: say in a few words that you're checking, then stop talking. The answer arrives later as a message starting with "${ASK_RESULT}".`,
    parameters: {
      type: 'OBJECT',
      properties: {
        project: { type: 'STRING', description: 'Project name, from the list in your instructions.' },
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
        project: { type: 'STRING', description: 'Project name, from the list in your instructions.' },
        task: { type: 'STRING', description: 'What to do, with every detail the user gave.' },
      },
      required: ['project', 'task'],
    },
  },
  {
    name: 'status',
    description:
      'What is running right now: scheduled jobs, and questions you asked that have not been answered yet.',
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
export function systemInstruction(deps: Pick<LiveDeps, 'agentName' | 'projects'>, language?: string): string {
  return `You are ${deps.agentName}, a voice assistant for the user's software projects. The user is working; don't distract them.
${language ? `\nLanguage and accent: ${language}\n` : ''}
- Speak briefly: one or two sentences. Details go on their screen, not in your voice.
- Never start a topic yourself, and no small talk.
- Only state facts about projects, code, jobs or pull requests that a tool gave you in this conversation. Otherwise call a tool, or say you don't know.
- Don't read out URLs, IDs or code.
- "What needs me?", "what's up?": call attention. Mention the urgent and waiting items; mention "later" items only if asked.
- Questions about code or files: call ask. When a message starting with "${ASK_RESULT}" arrives, tell the user the answer in a sentence or two.
- Anything that changes something: call dispatch. If the request is vague, confirm it in one sentence first. Afterwards say it will be posted in Slack.

Projects: ${deps.projects.join(', ')}.`;
}

/** The project the model meant: exact, then ignoring case and separators. */
export function matchProject(projects: string[], said: unknown): string | undefined {
  if (typeof said !== 'string') return undefined;
  if (projects.includes(said)) return said;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return projects.find((p) => norm(p) === norm(said));
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
