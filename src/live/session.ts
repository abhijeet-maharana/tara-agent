import type WebSocket from 'ws';
import type { DiffView, RepoStatus } from '../code/repo.js';
import type { RateLimit } from '../runner/stream.js';
import type { Logger } from '../sessions/manager.js';
import type { ActivityEvent, Task } from './activity.js';
import type { Alert } from './alerts.js';
import type { AttentionItem } from './attention.js';
import { type FunctionCall, GeminiLive, type LiveConnectOptions } from './gemini.js';
import {
  type ApprovalSummary,
  ASK_RESULT,
  attentionForModel,
  type JobSummary,
  LIVE_TOOLS,
  type LiveDeps,
  type LiveState,
  matchJob,
  matchProject,
  matchTask,
  overviewForModel,
  type ProjectOverview,
  systemInstruction,
  TASK_DONE,
  URGENT,
} from './tools.js';

/**
 * One Command tab talking to one Gemini Live session.
 *
 * Browser → tara: binary frames are microphone audio (16 kHz, 16-bit LE, mono), accepted only after
 * `{"type":"talk"}`; `{"type":"mute"}` ends talking. tara → browser: binary frames are speech (24 kHz),
 * and JSON `ServerEvent`s. The upstream session opens on "talk" and closes after `idleSeconds` with
 * nothing said by either side and no question still being answered, so the model can't speak unasked.
 * Every tool call also puts its result on the tab as a panel, and the tab's buttons (Run now, an
 * approval's options, Stop) go through the same code as the voice. Every labelled Claude run is
 * streamed to the tab as a live task, and when one this tab started ends, the model is told so it
 * can say how it went (if the user is still talking to it).
 */

export type LiveStateName = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export type ServerEvent =
  | { type: 'state'; state: LiveStateName }
  | { type: 'transcript'; who: 'user' | 'model'; text: string }
  | { type: 'interrupted' }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  /** Shows a panel, or replaces the one with the same id. */
  | { type: 'panel'; id: string; panel: Panel }
  /** Every project, what needs the user (counts per tier, and pull requests), and until when focus mode lasts. */
  | { type: 'overview'; projects: ProjectOverview[]; focusUntil: number; needs?: Needs }
  /** Put this task in the middle of the screen. */
  | { type: 'watch'; id: string }
  /** Live tasks: every one on connect, then each as it changes. */
  | { type: 'tasks'; tasks: Task[]; usage?: RateLimit }
  | { type: 'task'; task: Task }
  | { type: 'usage'; usage: RateLimit }
  /** An urgent alert. \`voice\`: the voice model says it, so the tab doesn't. */
  | { type: 'alert'; alert: Alert; voice: boolean }
  /** One line for the tab to say in the browser's voice (work it started ended while the voice session was closed). \`quiet\`: show it only (focus mode). */
  | { type: 'notify'; text: string; ok: boolean; quiet: boolean }
  /** Settings the tab needs, on connect. */
  | { type: 'config'; alertLang?: string }
  | { type: 'error'; message: string };

export type Panel =
  | {
      kind: 'attention';
      items: Array<Pick<AttentionItem, 'tier' | 'title' | 'project' | 'url'>>;
      notes: string[];
    }
  | { kind: 'jobs'; project?: string; jobs: JobSummary[] }
  | { kind: 'repo'; repo: string; status: RepoStatus }
  | { kind: 'diff'; repo: string; file: string; diff: DiffView }
  | { kind: 'approvals'; project?: string; items: ApprovalSummary[] }
  | { kind: 'ask'; project: string; question: string; answer?: string; error?: string }
  | { kind: 'dispatch'; project: string; task: string; url?: string; error?: string }
  /** Something done: a job started or paused, a card decided. */
  | { kind: 'action'; project?: string; text: string; ok: boolean };

export type ClientMessage =
  | { type: 'talk' }
  | { type: 'mute' }
  | { type: 'text'; text: string }
  /** A job panel's button. */
  | { type: 'job'; action: 'run' | 'pause' | 'resume'; project: string; id: string }
  /** An approval panel's button. */
  | { type: 'decide'; id: string; option: string }
  /** A live task's Stop button. */
  | { type: 'stop'; id: string }
  /** A Systems button: a panel without asking the voice model. */
  | { type: 'show'; what: (typeof SHOWABLE)[number]; project?: string; file?: string };

export interface Needs {
  urgent: number;
  waiting: number;
  later: number;
  /** Pull requests waiting on the user: reviews asked, red checks, changes asked. */
  prs: number;
}

/** Tools a tab may run itself to get their panel. */
const SHOWABLE = ['attention', 'jobs', 'repo', 'approvals'] as const;

export interface LiveSessionConfig {
  url: string;
  apiKey: string;
  model: string;
  voice: string;
  idleSeconds: number;
  /** How to speak, added to the model's instructions (Live models take no language code). */
  language?: string;
  /** The browser voice for alerts said without the voice session (a language tag). */
  alertLang?: string;
}

/** Transcripts carry markers such as `<no speech>` and `{pause}`; they aren't words. */
export const cleanTranscript = (text: string) => text.replace(/<[^>\n]*>|\{[^}\n]*\}/g, '');

/** Audio kept while the upstream session opens: 5 s. */
const MAX_EARLY_AUDIO = 16_000 * 2 * 5;
/** How often the Systems column is refreshed while the tab is open. */
const OVERVIEW_MS = 30_000;
/** Changed files sent in a repo panel. */
const MAX_CHANGES = 200;

export class LiveSession {
  private upstream?: GeminiLive;
  private opening = false;
  private state: LiveStateName = 'idle';
  private talking = false;
  private early: Buffer[] = [];
  private earlyBytes = 0;
  private modelTalking = false;
  /** Results to tell the model once it has finished its current turn. */
  private later: string[] = [];
  private readonly asks = new Map<
    string,
    { project: string; question: string; controller: AbortController }
  >();
  private idleTimer?: NodeJS.Timeout;
  private readonly overviewTimer: NodeJS.Timeout;
  /** Approval cards this tab has shown: only those can be decided by voice. */
  private readonly shown = new Set<string>();
  /** The project the jobs and approvals panels are narrowed to, so an action can refresh them. */
  private jobsFilter?: string;
  private approvalsFilter?: string;
  private actions = 0;
  /** Work this tab started (dispatched threads, jobs run), told to the model when it ends. */
  private readonly watching = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeAlerts?: () => void;
  private ended = false;
  /** What one upstream session carried, for the log line when it closes. */
  private stats = { opened: 0, micBytes: 0, speechBytes: 0, tools: 0 };

  constructor(
    private readonly client: WebSocket,
    private readonly cfg: LiveSessionConfig,
    private readonly deps: LiveDeps,
    private readonly shared: LiveState,
    private readonly log: Logger,
    private readonly connect: (o: LiveConnectOptions) => Promise<GeminiLive> = GeminiLive.connect,
  ) {
    client.on('message', (data, isBinary) => {
      if (isBinary) this.audio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      else this.control(data.toString());
    });
    client.on('close', () => this.end());
    client.on('error', () => this.end());
    this.emit({ type: 'state', state: 'idle' });
    void this.refreshOverview();
    this.overviewTimer = setInterval(() => void this.refreshOverview(), OVERVIEW_MS);
    this.overviewTimer.unref();
    this.emit({ type: 'tasks', tasks: deps.activity.tasks(), usage: deps.activity.usage() });
    this.unsubscribe = deps.activity.subscribe((e) => this.onActivity(e));
    this.unsubscribeAlerts = deps.alerts?.subscribe((a) => this.onAlert(a));
    this.emit({ type: 'config', alertLang: cfg.alertLang });
  }

  private onActivity(e: ActivityEvent): void {
    this.emit(e);
    if (e.type !== 'task') return;
    const { task } = e;
    if (task.status === 'running') return;
    const key = watchKey(task);
    const what = key && this.watching.get(key);
    if (!key || !what) return;
    this.watching.delete(key);
    void this.refreshOverview();
    const minutes = Math.max(1, Math.round(((task.endedAt ?? 0) - task.startedAt) / 60_000));
    const how =
      task.status === 'ok' ? 'finished' : task.status === 'aborted' ? 'was stopped' : `ended: ${task.status}`;
    // While the user is still talking to it, the voice model says how it went; a closed session
    // stays closed, and the tab says one line in the browser's voice instead (not in focus mode).
    if (!this.upstream) {
      const ok = task.status === 'ok';
      const plain = ok ? 'is done' : task.status === 'aborted' ? 'was stopped' : 'failed';
      this.emit({
        type: 'notify',
        text: `${what.replace(/^"|"$/g, '')}, in ${task.project}, ${plain}.`,
        ok,
        quiet: this.shared.focusUntil > (this.deps.now ?? Date.now)(),
      });
      return;
    }
    const said = task.error ?? task.text;
    this.later.push(
      `${TASK_DONE}: ${what} (${task.project}) ${how} after ${minutes} min.${said ? ` Its last words: ${said.slice(-400)}` : ''}`,
    );
    if (!this.modelTalking) this.flushLater();
  }

  private onAlert(alert: Alert): void {
    const voice = !alert.quiet && Boolean(this.upstream);
    this.emit({ type: 'alert', alert, voice });
    void this.refreshOverview();
    if (!voice) return;
    this.later.push(`${URGENT}: ${alert.text}`);
    if (!this.modelTalking) this.flushLater();
  }

  private emit(event: ServerEvent): void {
    if (this.client.readyState === this.client.OPEN) this.client.send(JSON.stringify(event));
  }

  private setState(state: LiveStateName): void {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: 'state', state });
  }

  private control(text: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === 'talk') {
      this.talking = true;
      void this.ensureUpstream();
    } else if (msg.type === 'mute') {
      this.talking = false;
      this.upstream?.endAudio();
      this.armIdle();
    } else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
      void this.ensureUpstream().then((up) => up?.sendText(msg.text.slice(0, 4_000)));
    } else if (msg.type === 'job' && typeof msg.project === 'string' && typeof msg.id === 'string') {
      const project = matchProject(this.deps.projects, msg.project);
      try {
        if (!project) throw new Error(`Unknown project "${msg.project}"`);
        this.jobAction(msg.action, project, msg.id);
      } catch (err) {
        this.action(project, (err as Error).message, false);
      }
    } else if (msg.type === 'stop' && typeof msg.id === 'string') {
      try {
        this.stopTask(msg.id);
      } catch (err) {
        this.action(undefined, (err as Error).message, false);
      }
    } else if (msg.type === 'decide' && typeof msg.id === 'string' && typeof msg.option === 'string') {
      void this.decide(msg.id, msg.option).catch((err: Error) => this.action(undefined, err.message, false));
    } else if (msg.type === 'show' && SHOWABLE.includes(msg.what)) {
      const args =
        msg.what === 'repo'
          ? { repo: msg.project, file: typeof msg.file === 'string' ? msg.file : undefined }
          : msg.project
            ? { project: msg.project }
            : {};
      void this.tool({ id: `tab-${++this.actions}`, name: msg.what, args }).catch((err: Error) =>
        this.action(msg.project, err.message, false),
      );
    }
  }

  private audio(pcm: Buffer): void {
    if (!this.talking) return;
    if (this.upstream) {
      this.stats.micBytes += pcm.length;
      this.upstream.sendAudio(pcm);
      return;
    }
    if (this.earlyBytes + pcm.length > MAX_EARLY_AUDIO) return;
    this.early.push(pcm);
    this.earlyBytes += pcm.length;
  }

  private async ensureUpstream(): Promise<GeminiLive | undefined> {
    if (this.upstream) return this.upstream;
    if (this.opening) return undefined;
    this.opening = true;
    this.setState('connecting');
    try {
      const up = await this.connect({
        url: this.cfg.url,
        apiKey: this.cfg.apiKey,
        setup: {
          model: this.cfg.model,
          voice: this.cfg.voice,
          systemInstruction: systemInstruction(this.deps, this.cfg.language),
          tools: LIVE_TOOLS,
        },
        events: {
          onAudio: (pcm) => {
            this.modelTalking = true;
            this.setState('speaking');
            this.stats.speechBytes += pcm.length;
            if (this.client.readyState === this.client.OPEN) this.client.send(pcm);
          },
          onTranscript: (who, raw) => {
            const text = cleanTranscript(raw);
            if (!text.trim()) return;
            if (who === 'model') this.modelTalking = true;
            this.emit({ type: 'transcript', who, text });
            this.armIdle();
          },
          onToolCalls: (calls) => void this.tools(calls),
          onToolCancel: () => {},
          onInterrupted: () => {
            this.modelTalking = false;
            this.emit({ type: 'interrupted' });
            this.setState('listening');
          },
          onTurnComplete: () => {
            this.modelTalking = false;
            this.setState(this.asks.size ? 'thinking' : 'listening');
            this.flushLater();
            this.armIdle();
          },
          onClose: (reason) => {
            this.upstream = undefined;
            this.modelTalking = false;
            const { opened, micBytes, speechBytes, tools } = this.stats;
            // 16 kHz and 24 kHz, 16-bit mono: bytes per second.
            this.log.info(
              `live: voice session closed after ${Math.round((Date.now() - opened) / 1000)} s: heard ${(micBytes / 32_000).toFixed(1)} s, spoke ${(speechBytes / 48_000).toFixed(1)} s, ${tools} tool calls`,
            );
            if (reason) {
              this.log.warn(`live: Gemini session closed: ${reason}`);
              this.emit({ type: 'error', message: `Voice session ended: ${reason}` });
            }
            if (!this.ended) this.setState('idle');
          },
        },
      });
      if (this.ended) {
        up.close();
        return undefined;
      }
      this.upstream = up;
      this.stats = { opened: Date.now(), micBytes: this.earlyBytes, speechBytes: 0, tools: 0 };
      this.log.info(`live: voice session opened (${this.cfg.model})`);
      for (const pcm of this.early.splice(0)) up.sendAudio(pcm);
      this.earlyBytes = 0;
      this.setState('listening');
      this.armIdle();
      return up;
    } catch (err) {
      this.log.warn(`live: could not open a Gemini session: ${(err as Error).message}`);
      this.emit({ type: 'error', message: `Could not start the voice session: ${(err as Error).message}` });
      this.talking = false;
      this.early = [];
      this.earlyBytes = 0;
      this.setState('idle');
      return undefined;
    } finally {
      this.opening = false;
    }
  }

  /** Closes the upstream session after a quiet spell, unless something is still being answered. */
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.upstream) return;
    this.idleTimer = setTimeout(() => {
      if (this.asks.size || this.modelTalking || this.later.length) return this.armIdle();
      this.talking = false;
      this.upstream?.close();
    }, this.cfg.idleSeconds * 1000);
    this.idleTimer.unref();
  }

  private async tools(calls: FunctionCall[]): Promise<void> {
    this.setState('thinking');
    this.stats.tools += calls.length;
    const responses = await Promise.all(
      calls.map(async (call) => {
        this.emit({ type: 'tool', name: call.name, args: call.args });
        try {
          return { id: call.id, name: call.name, response: await this.tool(call) };
        } catch (err) {
          return { id: call.id, name: call.name, response: { error: (err as Error).message } };
        }
      }),
    );
    this.upstream?.sendToolResponses(responses);
    this.armIdle();
  }

  private async tool(call: FunctionCall): Promise<Record<string, unknown>> {
    const { deps } = this;
    const project = () => {
      const name = matchProject(deps.projects, call.args.project);
      if (!name)
        throw new Error(
          `Unknown project "${String(call.args.project)}". Projects: ${deps.projects.join(', ')}`,
        );
      return name;
    };
    const text = (key: string) => {
      const v = call.args[key];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`"${key}" is required`);
      return v.trim();
    };
    switch (call.name) {
      case 'attention': {
        const a = await deps.attention();
        this.panel('attention', {
          kind: 'attention',
          items: a.items.map(({ tier, title, project, url }) => ({ tier, title, project, url })),
          notes: a.notes,
        });
        return attentionForModel(a);
      }
      case 'brief': {
        const [attention, projects] = await Promise.all([deps.attention(), deps.overview()]);
        const now = (deps.now ?? Date.now)();
        const tasks = deps.activity.tasks();
        return {
          needsYou: attentionForModel(attention),
          projects: overviewForModel(projects).filter((p) => Object.keys(p).length > 1),
          quietProjects: overviewForModel(projects)
            .filter((p) => Object.keys(p).length === 1)
            .map((p) => p.project),
          running: running(tasks).map(
            (t) => `${t.title} (${t.project}, ${Math.round((now - t.startedAt) / 60_000)} min)`,
          ),
          finishedRecently: tasks
            .filter((t) => t.status !== 'running' && (t.endedAt ?? 0) > now - 3 * 3_600_000)
            .map((t) => `${t.title} (${t.project}): ${t.status}`),
          ...(this.shared.focusUntil > now
            ? { focusModeUntil: new Date(this.shared.focusUntil).toISOString() }
            : {}),
        };
      }
      case 'projects': {
        const projects = await deps.overview();
        this.emit({ type: 'overview', projects, focusUntil: this.shared.focusUntil });
        return { projects: overviewForModel(projects) };
      }
      case 'jobs': {
        this.jobsFilter = call.args.project ? project() : undefined;
        const jobs = this.showJobs();
        return {
          jobs: jobs.map((j) => ({
            job: j.name,
            project: j.project,
            state: j.state,
            ...(j.lastError ? { lastError: j.lastError.slice(0, 200) } : {}),
          })),
        };
      }
      case 'job':
        return this.jobAction(text('action'), project(), call.args.job);
      case 'repo': {
        const name = matchProject(deps.repos, call.args.repo);
        if (!name)
          throw new Error(
            `Unknown repo "${String(call.args.repo)}". Repos: ${deps.repos.join(', ') || 'none'}`,
          );
        if (typeof call.args.file === 'string' && call.args.file.trim()) {
          const file = call.args.file.trim();
          const diff = await deps.diff(name, file);
          this.panel(`diff:${name}:${file}`, { kind: 'diff', repo: name, file, diff });
          const lines = diff.text.split('\n');
          return {
            file,
            added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
            removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
          };
        }
        const status = await deps.repo(name);
        this.panel(`repo:${name}`, {
          kind: 'repo',
          repo: name,
          status: { ...status, changes: status.changes.slice(0, MAX_CHANGES) },
        });
        if (status.error) throw new Error(status.error);
        return {
          branch: status.branch,
          lastCommit: status.head?.subject,
          uncommittedFiles: status.changes.length,
          files: status.changes.slice(0, 15).map((c) => `${c.path} (${c.state})`),
        };
      }
      case 'approvals': {
        this.approvalsFilter = call.args.project ? project() : undefined;
        const items = this.showApprovals();
        return {
          cards: items.map((i) => ({ id: i.id, project: i.project, title: i.title, options: i.options })),
        };
      }
      case 'decide':
        return this.decide(text('id'), text('option'));
      case 'ask': {
        const p = project();
        const question = text('question');
        this.startAsk(call.id, p, question);
        return {
          status: 'checking',
          note: `The answer will arrive as a message starting with "${ASK_RESULT}".`,
        };
      }
      case 'dispatch': {
        const p = project();
        const task = text('task');
        const id = `dispatch:${call.id}`;
        try {
          const { url, thread } = await deps.dispatch(p, task);
          if (thread) this.watching.set(`thread:${thread.channel}:${thread.ts}`, `"${task.slice(0, 80)}"`);
          this.panel(id, { kind: 'dispatch', project: p, task, url });
          return { status: 'started', where: `the ${p} Slack channel, live on the user's screen` };
        } catch (err) {
          this.panel(id, { kind: 'dispatch', project: p, task, error: (err as Error).message });
          throw err;
        }
      }
      case 'status': {
        const now = (deps.now ?? Date.now)();
        return {
          running: running(deps.activity.tasks()).map((t) => ({
            task: t.title,
            project: t.project,
            kind: t.kind,
            minutes: Math.round((now - t.startedAt) / 60_000),
            now: t.steps.at(-1)?.text,
          })),
          unansweredQuestions: [...this.asks.values()].map((a) => `${a.question} (${a.project})`),
        };
      }
      case 'watch': {
        const { task, candidates } = matchTask(deps.activity.tasks(), call.args.task);
        if (!task)
          throw new Error(
            candidates.length
              ? `Which one? ${candidates.map((t) => `"${t.title}" (${t.project})`).join(', ')}`
              : 'No task to show',
          );
        this.emit({ type: 'watch', id: task.id });
        return { showing: task.title, project: task.project, status: task.status };
      }
      case 'stop': {
        const { task, candidates } = matchTask(running(deps.activity.tasks()), call.args.task);
        if (!task)
          throw new Error(
            candidates.length
              ? `Which one? Running: ${candidates.map((t) => `"${t.title}" (${t.project})`).join(', ')}`
              : 'Nothing is running',
          );
        return this.stopTask(task.id);
      }
      case 'focus': {
        const minutes = Math.max(0, Math.min(8 * 60, Math.round(Number(call.args.minutes) || 0)));
        this.shared.focusUntil = minutes ? (deps.now ?? Date.now)() + minutes * 60_000 : 0;
        void this.refreshOverview();
        return { focus: minutes ? `on for ${minutes} minutes` : 'off' };
      }
      default:
        throw new Error(`No tool "${call.name}"`);
    }
  }

  private panel(id: string, panel: Panel): void {
    this.emit({ type: 'panel', id, panel });
  }

  /** A line in the Operations column for something done (or refused). */
  private action(project: string | undefined, text: string, ok: boolean): void {
    this.panel(`action:${++this.actions}`, { kind: 'action', project, text, ok });
  }

  private async refreshOverview(): Promise<void> {
    try {
      const [projects, attention] = await Promise.all([
        this.deps.overview(),
        this.deps.attention().catch(() => undefined),
      ]);
      const count = (tier: string) => attention?.items.filter((i) => i.tier === tier).length ?? 0;
      const needs = attention && {
        urgent: count('urgent'),
        waiting: count('waiting'),
        later: count('later'),
        prs: attention.items.filter((i) => i.kind.startsWith('pr-')).length,
      };
      if (!this.ended) this.emit({ type: 'overview', projects, focusUntil: this.shared.focusUntil, needs });
    } catch (err) {
      this.log.warn(`live: could not read the projects overview: ${(err as Error).message}`);
    }
  }

  private showJobs(): JobSummary[] {
    const project = this.jobsFilter;
    const jobs = this.deps.jobs().filter((j) => !project || j.project === project);
    this.panel('jobs', { kind: 'jobs', project, jobs });
    return jobs;
  }

  private showApprovals(): ApprovalSummary[] {
    const project = this.approvalsFilter;
    const items = this.deps.approvals().filter((i) => !project || i.project === project);
    for (const i of items) this.shown.add(i.id);
    this.panel('approvals', { kind: 'approvals', project, items });
    return items;
  }

  /** Runs, pauses or resumes a job: from the `job` tool or a jobs panel button. */
  private jobAction(action: string, project: string, said: unknown): Record<string, unknown> {
    const jobs = this.deps.jobs().filter((j) => j.project === project);
    const job = matchJob(jobs, said);
    if (!job)
      throw new Error(
        `No job "${String(said)}" in ${project}. Jobs: ${jobs.map((j) => j.name).join(', ') || 'none'}`,
      );
    let result: string;
    if (action === 'run') {
      const r = this.deps.runJob(project, job.id);
      if (r === 'unknown') throw new Error(`No job "${job.id}" in ${project}`);
      result = r === 'running' ? 'already running' : 'started';
      if (r === 'started') this.watching.set(`job:${project}:${job.id}`, `The job ${job.name}`);
    } else if (action === 'pause' || action === 'resume') {
      if (this.deps.setJobEnabled(project, job.id, action === 'resume') === 'unknown')
        throw new Error(`No job "${job.id}" in ${project}`);
      result = action === 'pause' ? 'paused' : 'resumed';
    } else throw new Error('"action" must be run, pause or resume');
    this.action(project, `${job.name}: ${result}`, true);
    this.showJobs();
    void this.refreshOverview();
    return { job: job.name, project, result };
  }

  /** Stops a running task: from the `stop` tool or a task's Stop button. */
  private stopTask(id: string): Record<string, unknown> {
    const task = running(this.deps.activity.tasks()).find((t) => t.id === id);
    if (!task || !this.deps.activity.stop(id)) throw new Error('That task is no longer running');
    this.action(task.project, `Stopping: ${task.title}`, true);
    return { stopping: task.title, project: task.project };
  }

  /** Decides a card this tab has shown: from the `decide` tool or an approvals panel button. */
  private async decide(id: string, option: string): Promise<Record<string, unknown>> {
    const item = this.deps.approvals().find((i) => i.id === id);
    if (!item) throw new Error(`No card "${id}" is waiting for a decision`);
    if (!this.shown.has(id)) throw new Error('Call approvals first, so the user sees the card');
    const chosen = matchProject(item.options, option);
    if (!chosen) throw new Error(`"${option}" isn't an option. Options: ${item.options.join(', ')}`);
    const { status } = await this.deps.decide(id, chosen);
    this.action(item.project, `${chosen}: ${item.title}`, true);
    this.showApprovals();
    void this.refreshOverview();
    return { card: item.title, decided: chosen, status };
  }

  private startAsk(id: string, project: string, question: string): void {
    const controller = new AbortController();
    this.asks.set(id, { project, question, controller });
    this.panel(`ask:${id}`, { kind: 'ask', project, question });
    void this.deps
      .ask(project, question, controller.signal)
      .then(
        (answer) => {
          this.panel(`ask:${id}`, { kind: 'ask', project, question, answer });
          return `${ASK_RESULT} for "${question}" (${project}): ${answer}`;
        },
        (err: Error) => {
          this.panel(`ask:${id}`, { kind: 'ask', project, question, error: err.message });
          return `${ASK_RESULT} for "${question}" (${project}): it failed: ${err.message}`;
        },
      )
      .then((result) => {
        this.asks.delete(id);
        if (this.ended) return;
        this.later.push(result);
        if (!this.modelTalking) this.flushLater();
      });
  }

  private flushLater(): void {
    if (!this.later.length || !this.upstream) return;
    this.upstream.sendText(
      `${this.later.splice(0).join('\n\n')}\n\nTell the user now, in one or two sentences.`,
    );
    this.setState('thinking');
  }

  /** The tab went away: stop everything it started that only it was waiting for. */
  private end(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    clearInterval(this.overviewTimer);
    this.unsubscribe();
    this.unsubscribeAlerts?.();
    for (const a of this.asks.values()) a.controller.abort();
    this.asks.clear();
    this.upstream?.close();
  }
}

const running = (tasks: Task[]) => tasks.filter((t) => t.status === 'running');

/** How a task is matched to the work this tab started. */
const watchKey = (t: Task) =>
  t.kind === 'job' && t.jobId
    ? `job:${t.project}:${t.jobId}`
    : t.thread
      ? `thread:${t.thread.channel}:${t.thread.ts}`
      : undefined;
