import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import type { VoiceJob } from '../http/phone-voice.js';
import { redact, type Task } from '../runner/activity.js';
import type { StoredRun } from '../store/store.js';
import type { FunctionCall, FunctionDeclaration } from './gemini.js';
import type { Card, LiveToolKit, ToolContext, ToolOutcome } from './phone-live.js';

/**
 * Voice v2's lanes beyond the quick rules (docs/jarvis-phone.md):
 *
 *   ask_claude   Claude through the API (Sonnet 5.5; Opus 5.5 for hard ones) with tara's read-only tools
 *                (jobs, run history and output, what's running, the service log) and web search. Gemini
 *                says "on it" at once; the answer is spoken when it comes, and shown in full on a card.
 *   claude_code  A full Claude Code run in a project, started as a Slack thread (tara's own runs, all
 *                tools). It acts, so it goes through the unlock and the spoken yes; its end is spoken.
 *   show_titles  Poster cards (films, shows, books) with images from Wikipedia.
 *
 * Each of Claude's own tool calls, web searches included, is a step on the phone's strip.
 */

export interface ClaudeLaneDeps {
  apiKey: string;
  /** Default `claude-sonnet-5-5`. */
  model?: string;
  /** For `hard: true`; default `claude-opus-5-5`. */
  hardModel?: string;
  projects: Array<{ name: string; title: string }>;
  jobs(): VoiceJob[];
  jobRuns(project: string, jobId: string, limit: number): StoredRun[];
  tasks(): Task[];
  /** Starts a Claude Code conversation in the project's Slack channel. */
  dispatch?(
    project: string,
    task: string,
  ): Promise<{ url?: string; thread?: { channel: string; ts: string } }>;
  /** The service's log lines (journalctl); tests replace it. */
  journal?(sinceMinutes: number, grep: string | undefined, max: number): Promise<string[]>;
  timeZone: string;
  log: { info(msg: string): void; warn(msg: string): void };
  /** Tests: a stand-in for the API client. */
  client?: Pick<Anthropic, 'beta'>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
/** Tool rounds before Claude must answer. */
const MAX_ROUNDS = 8;
const ANSWER_CHARS = 1_800;

type Tool = Anthropic.Beta.BetaToolUnion;

const READ_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'jobs',
    description:
      'Every scheduled job: project, id, name, paused, running, next run, last status, last error.',
    input_schema: { type: 'object', properties: { project: { type: 'string' } } },
  },
  {
    name: 'job_runs',
    description:
      "A job's latest runs, newest first: id, start, minutes, status, error, and the start of its output.",
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        job: { type: 'string', description: 'Job id or name.' },
        limit: { type: 'integer', description: 'Default 5, at most 20.' },
      },
      required: ['job'],
    },
  },
  {
    name: 'run_output',
    description: "One job run's full stored output, script output and error (from job_runs' id).",
    input_schema: {
      type: 'object',
      properties: { project: { type: 'string' }, job: { type: 'string' }, run: { type: 'integer' } },
      required: ['job', 'run'],
    },
  },
  {
    name: 'running',
    description:
      'Claude runs in memory (running and the last finished): title, project, status, latest steps, last text, error.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'service_log',
    description:
      "tara-agent's own service log (systemd journal on the host, secrets blanked): scheduler, runs, errors.",
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', description: 'How far back; default 120, at most 2880.' },
        grep: {
          type: 'string',
          description: 'Only lines containing this (case-insensitive), e.g. a job id.',
        },
      },
    },
  },
  {
    name: 'show_titles',
    description:
      "Put titles on the user's phone screen as poster cards (films, series, books, places). Use it whenever you recommend such things.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Card heading, e.g. "Comedies for tonight".' },
        kind: { type: 'string', enum: ['film', 'series', 'book', 'other'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              year: { type: 'string' },
              note: { type: 'string', description: 'A few words: why, where to watch.' },
            },
            required: ['title'],
          },
        },
      },
      required: ['title', 'items'],
    },
  },
];

const WEB_SEARCH: Tool = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 } as Tool;

export class ClaudeLane {
  private readonly client: Pick<Anthropic, 'beta'>;
  private readonly now: () => number;

  constructor(private readonly deps: ClaudeLaneDeps) {
    this.client = deps.client ?? new Anthropic({ apiKey: deps.apiKey, maxRetries: 1, timeout: 120_000 });
    this.now = deps.now ?? Date.now;
  }

  private system(): string {
    const date = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.deps.timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(this.now());
    return `You are the brain behind Jarvis, a voice assistant on the user's desk phone. Jarvis's voice model passed you a request; your answer is read out by it and shown on the phone's screen.

It is ${date} (${this.deps.timeZone}). The user is in India and speaks English and Hinglish.

The user's software projects run on tara-agent (Claude runs, scheduled jobs, approval cards): ${this.deps.projects.map((p) => `${p.title} (${p.name})`).join(', ')}. Your tools read tara-agent: jobs, job_runs, run_output, running, service_log. Use them to find out why something failed: read the run's error and output, then the log around that time. You can't change anything; if a fix is needed, say what it is.

For facts, news, films, prices and anything current, search the web. When you recommend films, series or books, also call show_titles so posters appear on the screen.

Answer in this shape: first one or two plain sentences to be spoken (no lists, no URLs, no markdown); then, after a line with only "---", the details for the screen (short lines, may use "- " bullets). Be direct and specific.`;
  }

  /** One question, with Claude's tools; resolves with the answer (spoken part, then the details). */
  async ask(
    question: string,
    opts: { hard?: boolean; ctx: ToolContext; cardId: string },
  ): Promise<{ answer: string; model: string; ms: number }> {
    const model = opts.hard ? (this.deps.hardModel ?? OPUS) : (this.deps.model ?? SONNET);
    const started = this.now();
    const steps: string[] = [];
    const short = model.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2');
    const card = (c: Partial<Extract<Card, { kind: 'claude' }>>) =>
      opts.ctx.card(opts.cardId, { kind: 'claude', question, model: short, status: 'working', steps, ...c });
    card({});
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: question }];
    const used = { input: 0, output: 0, cacheRead: 0, searches: 0 };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await this.client.beta.messages.create(
        {
          model,
          max_tokens: 8_000,
          system: this.system(),
          tools: [...READ_TOOLS, WEB_SEARCH],
          messages,
          output_config: { effort: opts.hard ? 'high' : 'low' },
          // Each round re-sends the logs and outputs read so far: cache them.
          cache_control: { type: 'ephemeral' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        } as Anthropic.Beta.MessageCreateParamsNonStreaming,
        { signal: opts.ctx.signal },
      );
      used.input += (res.usage?.input_tokens ?? 0) + (res.usage?.cache_creation_input_tokens ?? 0);
      used.cacheRead += res.usage?.cache_read_input_tokens ?? 0;
      used.output += res.usage?.output_tokens ?? 0;
      used.searches += res.usage?.server_tool_use?.web_search_requests ?? 0;
      // Web searches ran on Anthropic's side during the call: show them now.
      for (const b of res.content)
        if (b.type === 'server_tool_use' && b.name === 'web_search') {
          const q = String((b.input as { query?: unknown }).query ?? '');
          opts.ctx.step(`Web: ${q.slice(0, 60)}`, 'ok');
          steps.push(`web: ${q}`);
        }
      if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer that');
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) {
        const answer = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        const ms = this.now() - started;
        card({ status: 'done', answer: details(answer).slice(0, ANSWER_CHARS) });
        // List prices per million tokens (Sonnet 5.5 $2/$10, Opus 5.5 $4/$20) and $10 per 1,000 searches.
        const [pin, pout] = model.includes('opus') ? [4, 20] : [2, 10];
        const usd =
          (used.input * pin + used.cacheRead * pin * 0.1 + used.output * pout) / 1e6 + used.searches * 0.01;
        this.deps.log.info(
          `phone live: ${short} answered in ${ms} ms after ${round + 1} rounds, ${steps.length} tool calls; tokens in ${used.input} (cached ${used.cacheRead}), out ${used.output}, ${used.searches} searches, ~$${usd.toFixed(4)}`,
        );
        return { answer, model: short, ms };
      }
      card({});
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const label = toolLabel(u.name, u.input as Record<string, unknown>);
          const id = opts.ctx.step(label);
          steps.push(label);
          try {
            const out = await this.readTool(u.name, u.input as Record<string, unknown>, opts.ctx);
            opts.ctx.finishStep(id, 'ok');
            return { type: 'tool_result', tool_use_id: u.id, content: out };
          } catch (err) {
            opts.ctx.finishStep(id, 'error', (err as Error).message);
            return {
              type: 'tool_result',
              tool_use_id: u.id,
              content: (err as Error).message,
              is_error: true,
            };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    throw new Error('Claude took too many steps');
  }

  private findJob(project: unknown, job: unknown): VoiceJob {
    const said = String(job ?? '').toLowerCase();
    const p = typeof project === 'string' ? project.toLowerCase() : '';
    const pool = this.deps
      .jobs()
      .filter((j) => !p || j.project.toLowerCase() === p || j.projectTitle.toLowerCase() === p);
    const hit =
      pool.find((j) => j.id.toLowerCase() === said || j.name.toLowerCase() === said) ??
      pool.find((j) => j.id.toLowerCase().includes(said) || j.name.toLowerCase().includes(said));
    if (!hit) throw new Error(`No job "${String(job)}". Call jobs for the list.`);
    return hit;
  }

  private async readTool(name: string, a: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const iso = (t?: number) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : undefined);
    switch (name) {
      case 'jobs': {
        const p = typeof a.project === 'string' ? a.project.toLowerCase() : '';
        return JSON.stringify(
          this.deps
            .jobs()
            .filter((j) => !p || j.project.toLowerCase() === p || j.projectTitle.toLowerCase() === p)
            .map((j) => ({
              project: j.project,
              id: j.id,
              name: j.name,
              ...(j.enabled ? {} : { paused: true }),
              ...(j.running && { running: true }),
              next: iso(j.nextRun),
              last: j.lastStatus,
              lastAt: iso(j.lastRunAt),
              ...(j.lastError && { error: j.lastError.slice(0, 300) }),
            })),
        );
      }
      case 'job_runs': {
        const j = this.findJob(a.project, a.job);
        const limit = Math.min(20, Math.max(1, Number(a.limit) || 5));
        const runs = this.deps.jobRuns(j.project, j.id, limit);
        return JSON.stringify({
          job: `${j.name} (${j.project}/${j.id}), times UTC`,
          runs: runs.map((r) => ({
            run: r.id,
            started: iso(r.startedAt),
            minutes: Math.round((r.endedAt - r.startedAt) / 6_000) / 10,
            status: r.status,
            ...(r.error && { error: redact(r.error).slice(0, 500) }),
            ...(r.output && { output: redact(r.output).slice(0, 300) }),
          })),
        });
      }
      case 'run_output': {
        const j = this.findJob(a.project, a.job);
        const r = this.deps.jobRuns(j.project, j.id, 30).find((x) => x.id === Number(a.run));
        if (!r) throw new Error(`No run ${String(a.run)} among ${j.name}'s last 30`);
        const text = [r.error, r.output].filter(Boolean).join('\n').trim();
        if (text)
          ctx.card(`log-${r.id}`, {
            kind: 'log',
            title: `${j.name} · run ${r.id} · ${r.status}`,
            lines: redact(text).split('\n').slice(-12),
          });
        return JSON.stringify({
          run: r.id,
          status: r.status,
          error: r.error && redact(r.error).slice(0, 2_000),
          output: r.output && redact(r.output).slice(-4_000),
          scriptOutput: r.scriptOutput && redact(r.scriptOutput).slice(-2_000),
        });
      }
      case 'running':
        return JSON.stringify(
          this.deps.tasks().map((t) => ({
            title: t.title,
            project: t.project,
            kind: t.kind,
            status: t.status,
            started: iso(t.startedAt),
            ended: iso(t.endedAt),
            steps: t.steps.slice(-8).map((s) => `${s.state}: ${s.text}`),
            text: t.text.slice(-400),
            ...(t.error && { error: t.error }),
          })),
        );
      case 'service_log': {
        const minutes = Math.min(2_880, Math.max(1, Number(a.minutes) || 120));
        const grep = typeof a.grep === 'string' && a.grep.trim() ? a.grep.trim() : undefined;
        const lines = await (this.deps.journal ?? journal)(minutes, grep, 120);
        if (lines.length)
          ctx.card(`log-svc-${grep ?? 'all'}`, {
            kind: 'log',
            title: `tara-agent log${grep ? ` · ${grep}` : ''}`,
            lines: lines.slice(-12),
          });
        return lines.length ? lines.join('\n') : 'No matching lines.';
      }
      case 'show_titles': {
        const card = await titlesCard(a, this.deps.fetchImpl ?? fetch);
        ctx.card(`titles-${this.now()}`, card);
        return `Shown on the screen: ${card.items.map((i) => i.title).join(', ')}`;
      }
      default:
        throw new Error(`No tool ${name}`);
    }
  }

  /** The tools Gemini gets for these lanes. */
  kit(): LiveToolKit {
    const declarations: FunctionDeclaration[] = [
      {
        name: 'ask_claude',
        description:
          'Ask Claude: anything that needs checking or thinking. Why a job failed, reading logs and run output, looking things up on the web (facts, news, films to watch, prices), comparisons, advice. Read only. Takes 5-60 s: say a few words like "on it" or "ek second", then stop; the answer arrives later as a RESULT message.',
        parameters: {
          type: 'OBJECT',
          properties: {
            question: {
              type: 'STRING',
              description:
                'The full request in English, with every detail the user gave and any context from this conversation.',
            },
            hard: {
              type: 'BOOLEAN',
              description:
                'True for hard reasoning (a tricky failure, planning, careful comparison): uses the strongest model, slower.',
            },
          },
          required: ['question'],
        },
      },
      {
        name: 'show_titles',
        description: 'Put films, series or books on the screen as poster cards, when you name some yourself.',
        parameters: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'Card heading.' },
            kind: {
              type: 'STRING',
              description: 'What they are.',
              enum: ['film', 'series', 'book', 'other'],
            },
            titles: {
              type: 'STRING',
              description: 'The titles, separated by "|", each optionally with "(year)".',
            },
          },
          required: ['title', 'titles'],
        },
      },
    ];
    if (this.deps.dispatch)
      declarations.push({
        name: 'claude_code',
        description:
          "Hand real work to a full Claude Code run in a project: fix something, change code or files, run a job's task by hand, write or send something. It acts, so the server checks the unlock and asks the user to confirm. It runs for minutes; when it ends you get a TASK DONE message.",
        parameters: {
          type: 'OBJECT',
          properties: {
            project: {
              type: 'STRING',
              description: `The project: ${this.deps.projects.map((p) => p.name).join(', ')}.`,
            },
            task: { type: 'STRING', description: 'What to do, with every detail the user gave.' },
          },
          required: ['project', 'task'],
        },
      });
    return {
      declarations,
      labels: { ask_claude: 'Asking Claude', show_titles: 'Posters', claude_code: 'Claude Code' },
      gated: ['claude_code'],
      question: (call) => {
        const project = this.project(call.args.project);
        return `Start Claude in ${project.title} to ${String(call.args.task ?? '')
          .slice(0, 140)
          .replace(/[.?!]+$/, '')}?`;
      },
      run: (call, ctx) => this.runKit(call, ctx),
      instructions: `- Anything that needs checking, reading logs, thinking or looking up (facts, films, news, prices): call ask_claude straight away (Claude reads jobs, runs and logs itself; don't call jobs first), say "on it" in two or three words, then stop. When the RESULT comes, say its first sentences; the details are on the screen.
- Claude puts posters on the screen itself when it recommends titles: don't call show_titles for titles that came in a RESULT.
- Real work (fix, change, run by hand, write, send): claude_code. Use hard: true on ask_claude only for genuinely hard questions.`,
    };
  }

  private project(said: unknown): { name: string; title: string } {
    const s = String(said ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const p = this.deps.projects.find(
      (x) =>
        x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === s ||
        x.title.toLowerCase().replace(/[^a-z0-9]/g, '') === s,
    );
    if (!p)
      throw new Error(
        `Unknown project "${String(said)}". Projects: ${this.deps.projects.map((x) => x.name).join(', ')}`,
      );
    return p;
  }

  private async runKit(call: FunctionCall, ctx: ToolContext): Promise<ToolOutcome | undefined> {
    const a = call.args;
    if (call.name === 'ask_claude') {
      const question = String(a.question ?? '').trim();
      if (!question) throw new Error('"question" is required');
      const cardId = `claude-${call.id}`;
      const done = this.ask(question, { hard: a.hard === true, ctx, cardId }).then((r) => {
        const spoken = r.answer.split(/\n-{3,}\n/)[0]?.trim() ?? r.answer;
        return `(${r.model}, ${Math.round(r.ms / 100) / 10} s) ${spoken.slice(0, 600)}`;
      });
      return {
        response: {
          status: 'working',
          note: 'Say "on it" in a few words and stop. The answer comes as a RESULT message.',
        },
        background: { id: call.id, label: `the question "${question.slice(0, 80)}"`, done },
        label: a.hard === true ? 'Asking Claude (Opus)' : 'Asking Claude',
      };
    }
    if (call.name === 'show_titles') {
      const items = String(a.titles ?? '')
        .split('|')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => {
          const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(t);
          return m ? { title: m[1] as string, year: m[2] } : { title: t };
        });
      const card = await titlesCard({ title: a.title, kind: a.kind, items }, this.deps.fetchImpl ?? fetch);
      return { response: { shown: card.items.map((i) => i.title) }, card };
    }
    if (call.name === 'claude_code') {
      const dispatch = this.deps.dispatch;
      if (!dispatch) throw new Error('No Slack here to start Claude Code in');
      const project = this.project(a.project);
      const task = String(a.task ?? '').trim();
      if (!task) throw new Error('"task" is required');
      const { thread } = await dispatch(project.name, task);
      if (thread)
        ctx.watchRun(
          (t) => t.thread?.channel === thread.channel && t.thread?.ts === thread.ts,
          `Claude Code in ${project.title} ("${task.slice(0, 60)}")`,
        );
      return {
        response: {
          status: 'started',
          where: `a new thread in ${project.title}'s Slack channel; it is on the screen`,
        },
        card: {
          kind: 'list',
          title: 'Claude Code started',
          lines: [{ text: task.slice(0, 120), sub: `${project.title} · Slack`, tone: 'blue' }],
        },
      };
    }
    return undefined;
  }
}

/** The part of an answer for the screen: after the "---" line, or all of it. */
export function details(answer: string): string {
  const parts = answer.split(/\n-{3,}\n/);
  return plain((parts.length > 1 ? parts.slice(1).join('\n') : answer).trim());
}

/** Markdown the phone's cards don't render: bold, headings, links, code ticks. */
export const plain = (text: string) =>
  text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');

function toolLabel(name: string, a: Record<string, unknown>): string {
  switch (name) {
    case 'jobs':
      return 'Jobs';
    case 'job_runs':
      return `Runs: ${String(a.job ?? '')}`;
    case 'run_output':
      return `Run ${String(a.run ?? '')} output`;
    case 'running':
      return 'Runs in memory';
    case 'service_log':
      return `Log${a.grep ? `: ${String(a.grep)}` : ''}`;
    case 'show_titles':
      return 'Posters';
    default:
      return name;
  }
}

const UA = 'tara-agent/0.1 (desk phone poster lookup)';

/** A poster card: each title's Wikipedia thumbnail, when there is one. */
export async function titlesCard(
  a: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Extract<Card, { kind: 'titles' }>> {
  const kind = typeof a.kind === 'string' ? a.kind : 'other';
  const raw = Array.isArray(a.items) ? (a.items as Array<Record<string, unknown>>) : [];
  const items = await Promise.all(
    raw.slice(0, 6).map(async (i) => {
      const title = String(i.title ?? '').slice(0, 80);
      const year = i.year ? String(i.year).slice(0, 4) : undefined;
      const image = await wikiImage(title, year, kind, fetchImpl).catch(() => undefined);
      return {
        title,
        ...(year && { sub: year }),
        ...(typeof i.note === 'string' && i.note && { note: i.note.slice(0, 60) }),
        ...(image && { image }),
      };
    }),
  );
  return { kind: 'titles', title: String(a.title ?? 'Titles').slice(0, 60), items };
}

async function wikiImage(
  title: string,
  year: string | undefined,
  kind: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const tries =
    kind === 'film'
      ? [year && `${title} (${year} film)`, `${title} (film)`, title]
      : kind === 'series'
        ? [year && `${title} (${year} TV series)`, `${title} (TV series)`, title]
        : kind === 'book'
          ? [`${title} (novel)`, title]
          : [title];
  for (const t of tries.filter(Boolean) as string[]) {
    const res = await fetchImpl(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`,
      { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) continue;
    const j = (await res.json()) as {
      type?: string;
      thumbnail?: { source?: string };
      originalimage?: { source?: string };
    };
    if (j.type === 'disambiguation') continue;
    const src = j.thumbnail?.source ?? j.originalimage?.source;
    if (src?.startsWith('https://')) return src;
  }
  return undefined;
}

const exec = promisify(execFile);

/** tara-agent's own journal lines, newest last, secrets blanked. */
async function journal(sinceMinutes: number, grep: string | undefined, max: number): Promise<string[]> {
  const { stdout } = await exec(
    'journalctl',
    [
      '--no-pager',
      '--quiet',
      '-o',
      'short-iso',
      '-u',
      'tara-agent.service',
      `--since=-${sinceMinutes}min`,
      '--lines=20000',
    ],
    { timeout: 15_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
  );
  const g = grep?.toLowerCase();
  return stdout
    .split('\n')
    .filter((l) => l.trim() && (!g || l.toLowerCase().includes(g)))
    .map((l) => redact(l.replace(/^(\S+) \S+ [^:]+: /, '$1 ')).slice(0, 400))
    .slice(-max);
}
