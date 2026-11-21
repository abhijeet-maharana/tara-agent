import type { Task } from '../runner/activity.js';
import type { Attention } from './attention.js';
import type { GlanceState } from './phone-events.js';

/**
 * The desk phone's voice (docs/jarvis-phone.md, Phase 4). The phone does the listening and the talking
 * with Android's own speech recognition and text to speech; this module gets the words and decides
 * the answer:
 *
 *   1. Rules for the everyday questions ("what's running?", "what needs me?", "brief me", "quiet for
 *      an hour", "run the blog job"): answered from memory in milliseconds, no model involved.
 *   2. Anything else goes to a fast text model (host `voice`: an OpenAI-compatible endpoint, e.g.
 *      Gemini Flash Lite through OmniRoute) with the glance as context. It answers, or names one of
 *      the same actions the rules use. A question about a project's code goes to Claude (`ask`,
 *      read-only); its answer arrives later as a `voice` event.
 *
 * Actions (run, pause or resume a job, stop a run, hand work to Slack) need the phone unlocked and a
 * spoken yes: voice can't tell who is speaking. A locked phone gets `unlock`: the shell asks for the
 * unlock, then sends the same words again. Approval cards are read out but never decided by voice.
 */

export interface VoiceJob {
  project: string;
  /** How the screen names the project. */
  projectTitle: string;
  id: string;
  name: string;
  enabled: boolean;
  running: boolean;
  /** Busy but not started yet: what it waits for ('slot', 'lock' or 'thread'). */
  waitingFor?: string;
  nextRun?: number;
  lastStatus?: string;
  lastRunAt?: number;
  lastError?: string;
}

export interface PanelLine {
  text: string;
  sub?: string;
  tone?: 'red' | 'amber' | 'blue' | 'green';
}

/** Shown on the phone with the spoken line: the details the voice leaves out. */
export interface VoicePanel {
  title: string;
  lines: PanelLine[];
}

export interface VoiceReply {
  /** One or two short sentences, said out loud. */
  say: string;
  panel?: VoicePanel;
  /** Switch the screen. */
  show?: 'home' | 'night';
  /** Open the Run view of this task. */
  watch?: string;
  /** A yes/no question: the shell listens again as soon as it has said it. */
  expect?: 'confirm';
  /** Needs the phone unlocked: the shell asks for the unlock, then sends the same words again. */
  unlock?: boolean;
  /** The answer comes later as a `voice` event with this id (a question for Claude). */
  pending?: string;
  /** How it was understood: a rule, the model, an answer to a question asked, or not at all. */
  via: 'rule' | 'model' | 'confirm' | 'none';
}

export interface VoiceDeps {
  agentName: string;
  projects: Array<{ name: string; title: string }>;
  timeZone: string;
  glance(): GlanceState;
  /** A fresh read of what needs the owner. */
  attention(): Promise<Attention>;
  jobs(): VoiceJob[];
  tasks(): Task[];
  runJob(project: string, id: string): 'started' | 'unknown' | 'running';
  setJobEnabled(project: string, id: string, enabled: boolean): 'ok' | 'unknown';
  stopTask(id: string): boolean;
  quiet: { until(): number | undefined; set(until: number | undefined): void };
  /** A fast text model: system and user text in, its reply text out. */
  model?: (system: string, user: string) => Promise<string>;
  /** A read-only Claude turn in the project; resolves with a short answer. */
  ask?: (project: string, question: string) => Promise<string>;
  /** Starts a Claude conversation in the project's Slack channel. */
  dispatch?: (project: string, task: string) => Promise<{ url?: string }>;
  /** Sends an answer that came later to the phone (PhoneHub.announce). */
  announce: (data: { id: string; say: string; heard?: string; panel?: VoicePanel }) => void;
  now?: () => number;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

interface Pending {
  /** Said back when asking for the yes, e.g. "Run Blog writer in Abtara now?" */
  question: string;
  act: () => Promise<VoiceReply> | VoiceReply;
  expires: number;
}

/** A question waits this long for its yes. */
const CONFIRM_MS = 90_000;
const DEFAULT_QUIET_MIN = 60;
const MAX_QUIET_MIN = 24 * 60;

const YES =
  /^(yes|yeah|yep|yup|ya|haan?|han|ji|sure|ok(ay)?|do it|go ahead|go for it|confirm(ed)?|please do|correct|right|affirmative)\b/;
const NO = /^(no|nope|nah|nahi|na|cancel|don'?t|do not|never ?mind|forget it|stop|leave it|abort)\b/;

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  'forty five': 45,
  half: 0.5,
};

/** Lower case, plain apostrophes, no punctuation, no "hey Jarvis" in front or "please" behind. */
export function normalise(text: string, agentName: string): string {
  const name = agentName.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(new RegExp(`^((hey|hi|ok|okay|hello|yo) )?${name}\\b ?`), '')
    .replace(/^(can you |could you |please |will you |would you )+/, '')
    .replace(/ please$/, '')
    .trim();
}

/** Minutes in "for two hours", "45 minutes", "an hour and a half", "half an hour"; undefined when none. */
export function parseMinutes(text: string): number | undefined {
  if (/\bhalf an hour\b/.test(text)) return 30;
  const m =
    /\b(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty five|forty|half)\s*(minutes?|mins?|hours?|hrs?|h)\b/.exec(
      text,
    );
  if (!m) return undefined;
  const n = Number(m[1]) || WORD_NUMBERS[m[1] as string] || 0;
  let minutes = /^h/.test(m[2] as string) ? n * 60 : n;
  if (/^h/.test(m[2] as string) && /\band a half\b/.test(text)) minutes += 30;
  return Math.round(minutes) || undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
const STOP = new Set([
  'the',
  'job',
  'run',
  'task',
  'in',
  'of',
  'for',
  'my',
  'now',
  'project',
  'one',
  'a',
  'an',
  'please',
]);

/**
 * The job meant by `said` among every project's jobs: exact id or name, then ignoring case and
 * separators, then the jobs whose name or id holds every word said. `candidates` when it isn't one.
 */
export function findJob(jobs: VoiceJob[], said: string): { job?: VoiceJob; candidates: VoiceJob[] } {
  const s = said.trim();
  if (!s) return { candidates: [] };
  const exact = jobs.filter((j) => j.id === s || j.name.toLowerCase() === s.toLowerCase());
  if (exact.length === 1) return { job: exact[0], candidates: exact };
  const loose = jobs.filter((j) => norm(j.id) === norm(s) || norm(j.name) === norm(s));
  if (loose.length === 1) return { job: loose[0], candidates: loose };
  // "the blog job in abtara": a project named in the words narrows the list.
  const named = jobs.filter((j) => {
    const t = ` ${s.toLowerCase()} `;
    return t.includes(` ${j.project.toLowerCase()} `) || t.includes(` ${j.projectTitle.toLowerCase()} `);
  });
  const pool = named.length ? named : jobs;
  const projectWords = new Set(named.flatMap((j) => [...words(j.project), ...words(j.projectTitle)]));
  const said_ = words(s).filter((w) => !projectWords.has(w));
  if (!said_.length) return { candidates: named };
  const hits = pool.filter((j) => {
    const hay = `${j.name} ${j.id}`.toLowerCase();
    return said_.every((w) => hay.includes(w) || hay.includes(w.replace(/s$/, '')));
  });
  return hits.length === 1 ? { job: hits[0], candidates: hits } : { candidates: hits };
}

/** The running (or just finished) task meant by `said`: words from its title or its project. */
export function findTask(tasks: Task[], said: string, projectTitle: (p: string) => string): Task[] {
  const w = words(said);
  if (!w.length) return tasks;
  return tasks.filter((t) => {
    const hay = `${t.title} ${t.project} ${projectTitle(t.project)} ${t.jobId ?? ''}`.toLowerCase();
    return w.every((x) => hay.includes(x));
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
/** "3 minutes", "1 hour 20 minutes". */
function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'under a minute';
  if (m < 60) return plural(m, 'minute');
  if (m >= 48 * 60) return plural(Math.round(m / 1440), 'day');
  const h = Math.floor(m / 60);
  if (h >= 10) return plural(h, 'hour');
  return m % 60 ? `${plural(h, 'hour')} ${plural(m % 60, 'minute')}` : plural(h, 'hour');
}
const statusWord = (s: string) =>
  s === 'ok' ? 'done' : s === 'silent' ? 'nothing to do' : s === 'aborted' ? 'stopped' : s;

export class PhoneVoice {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private asked = 0;
  private readonly clock: Intl.DateTimeFormat;

  constructor(private readonly deps: VoiceDeps) {
    this.now = deps.now ?? Date.now;
    this.clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: deps.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }

  hm(at: number): string {
    return this.clock.format(at);
  }

  title(project: string): string {
    return this.deps.projects.find((p) => p.name === project)?.title ?? project;
  }

  /** One spoken turn from a phone (`device`) that is `locked` or not. */
  async turn(device: string, text: string, locked: boolean): Promise<VoiceReply> {
    const said = normalise(text, this.deps.agentName);
    if (!said) return { say: "I didn't catch that.", via: 'none' };
    const waiting = this.pending.get(device);
    if (waiting && waiting.expires > this.now()) {
      if (YES.test(said)) {
        if (locked) return { say: 'Unlock the phone first.', unlock: true, via: 'confirm' };
        this.pending.delete(device);
        try {
          return await waiting.act();
        } catch (err) {
          return { say: `That didn't work: ${(err as Error).message}`, via: 'confirm' };
        }
      }
      if (NO.test(said)) {
        this.pending.delete(device);
        return { say: 'Okay, I won’t.', via: 'confirm' };
      }
    }
    this.pending.delete(device);
    const ruled = await this.rules(device, said, locked);
    if (ruled) return ruled;
    return this.model(device, text, locked);
  }

  /** Asks for the yes first, after making sure the phone is unlocked. */
  private confirm(device: string, locked: boolean, question: string, act: Pending['act']): VoiceReply {
    if (locked) return { say: 'Unlock the phone first.', unlock: true, via: 'rule' };
    this.pending.set(device, { question, act, expires: this.now() + CONFIRM_MS });
    return { say: question, expect: 'confirm', via: 'rule' };
  }

  // --- Rules: the everyday questions, answered at once ---

  private async rules(device: string, s: string, locked: boolean): Promise<VoiceReply | undefined> {
    if (/^(no|nope|nah|nahi|na|cancel|stop|never ?mind|forget it|leave it)( thanks| thank you)?$/.test(s))
      return { say: 'Okay.', via: 'rule' };
    if (/\b(quiet|silent|silence|do not disturb|dnd|mute|focus)\b/.test(s) && !/\bwhat\b/.test(s)) {
      const off = /\b(off|end|stop|over|unmute|cancel|no more|done)\b/.test(s);
      return this.quiet(off ? 0 : (parseMinutes(s) ?? DEFAULT_QUIET_MIN));
    }
    if (/\b(you can talk|talk again|unmute)\b/.test(s)) return this.quiet(0);
    if (/^(what'?s|what is) the time\b|^what time is it\b|^time$/.test(s))
      return { say: `It's ${this.hm(this.now())}.`, via: 'rule' };
    // Sentences that start with a verb act on a job or run, when one fits the words ("run the
    // approvals cleanup job" is a job, not a question about approvals); otherwise the keywords below.
    const watch = /^(show me|watch|let me (see|watch)|open) (the )?(.+?)( run| job| task)?$/.exec(s);
    if (watch) {
      const r = this.watch(watch[4] as string);
      if (r) return r;
    }
    const stop = /^(stop|cancel|abort|kill) (the )?(.+?)( run| job| task)?$/.exec(s);
    if (stop) {
      const r = this.stop(device, locked, stop[3] as string);
      if (r) return r;
    }
    const job =
      /^(run|start|kick off|trigger|launch|pause|disable|resume|unpause|enable) (the )?(.+?)( job)?( now| again)?$/.exec(
        s,
      );
    if (job) {
      const verb = job[1] as string;
      const action = /^(pause|disable)$/.test(verb)
        ? 'pause'
        : /^(resume|unpause|enable)$/.test(verb)
          ? 'resume'
          : 'run';
      const r = this.jobAction(device, locked, action, job[3] as string);
      if (r) return r;
    }
    if (
      /\b(brief me|briefing|catch me up|good morning|what did i miss|summary|summari[sz]e|update me)\b/.test(
        s,
      )
    )
      return this.brief();
    if (
      /\b(what'?s|what is|anything|is anything|is something|what are) (running|going on|happening|in progress|working)\b|^(status|running)$|^what are you (doing|working on)\b|\bhow (is|are) (the )?(jobs?|runs?|things) going\b/.test(
        s,
      )
    )
      return this.running();
    if (/\b(approve|reject|decline|decide)\b/.test(s)) {
      const n = this.deps.glance().approvals.total;
      return {
        say: `I can't decide cards by voice. ${n ? `${plural(n, 'card')} waiting: decide them on the Approvals page or in Slack.` : 'None are waiting.'}`,
        via: 'rule',
      };
    }
    if (/\b(approvals?|cards?)\b/.test(s)) return this.approvals();
    if (
      /\b(needs? (me|my attention|attention)|what'?s up|whats up|anything (urgent|failing|broken|wrong|new)|attention|what happened|any (alerts?|problems?|issues?|failures?|errors?)|what failed|anything for me)\b/.test(
        s,
      )
    )
      return this.needs();
    if (/\b(what'?s next|next up|coming up|upcoming|scheduled|later today|what runs next)\b/.test(s))
      return this.nextUp();
    if (/\b(usage|quota|rate limit|how much claude)\b/.test(s)) return this.usage();
    if (/^(go |show |open )?(the )?(home|home screen|back)$/.test(s))
      return { say: 'Home.', show: 'home', via: 'rule' };
    if (/^(go to |show )?(the )?night( mode| screen)?$/.test(s))
      return { say: 'Good night.', show: 'night', via: 'rule' };
    return undefined;
  }

  quiet(minutes: number): VoiceReply {
    if (minutes <= 0) {
      const was = this.deps.quiet.until();
      this.deps.quiet.set(undefined);
      return { say: was ? 'Quiet mode is off.' : "Quiet mode wasn't on.", via: 'rule' };
    }
    const m = Math.min(MAX_QUIET_MIN, minutes);
    const until = this.now() + m * 60_000;
    this.deps.quiet.set(until);
    return { say: `Quiet until ${this.hm(until)}. Alerts will wait.`, via: 'rule' };
  }

  running(): VoiceReply {
    const g = this.deps.glance();
    if (!g.running.length) {
      const last = g.recent[0];
      return {
        say: last
          ? `Nothing is running. Last was ${last.title}, ${statusWord(last.status)} ${span(this.now() - (last.endedAt ?? last.startedAt))} ago.`
          : 'Nothing is running.',
        via: 'rule',
      };
    }
    const lines = g.running.map((t) => ({
      text: t.title,
      sub: [t.project, span(this.now() - t.startedAt), t.step].filter(Boolean).join(' · '),
      tone: 'blue' as const,
    }));
    const one = g.running[0] as GlanceState['running'][number];
    return {
      say:
        g.running.length === 1
          ? `${one.title}, in ${one.project}, for ${span(this.now() - one.startedAt)}.`
          : `${g.running.length} running: ${list(g.running.slice(0, 3).map((t) => t.title))}${g.running.length > 3 ? ', and more' : ''}.`,
      panel: { title: 'Running', lines },
      via: 'rule',
    };
  }

  async needs(): Promise<VoiceReply> {
    const a = await this.deps.attention().catch(() => undefined);
    const items = (a?.items ?? []).filter((i) => i.tier !== 'later' && i.kind !== 'approval');
    const cards = this.deps.glance().approvals.total;
    const urgent = items.filter((i) => i.tier === 'urgent');
    const waiting = items.filter((i) => i.tier === 'waiting');
    const parts: string[] = [];
    if (urgent.length)
      parts.push(
        `Urgent: ${list(urgent.slice(0, 2).map((i) => i.title))}${urgent.length > 2 ? `, and ${urgent.length - 2} more` : ''}.`,
      );
    if (waiting.length)
      parts.push(
        `${plural(waiting.length, 'thing')} waiting${urgent.length ? '' : `, first: ${waiting[0]?.title}`}.`,
      );
    if (cards)
      parts.push(`${parts.length ? '' : 'Nothing urgent. '}${plural(cards, 'approval card')} waiting.`);
    const lines: PanelLine[] = items.slice(0, 6).map((i) => ({
      text: i.title,
      ...(i.project && { sub: this.title(i.project) }),
      tone: i.tier === 'urgent' ? ('red' as const) : ('amber' as const),
    }));
    if (cards)
      lines.push({ text: `${plural(cards, 'approval card')} waiting`, sub: 'Approvals page or Slack' });
    return {
      say: parts.length ? parts.join(' ') : 'Nothing needs you.',
      ...(lines.length && { panel: { title: 'Needs you', lines } }),
      via: 'rule',
    };
  }

  approvals(): VoiceReply {
    const a = this.deps.glance().approvals;
    if (!a.total) return { say: 'No approvals waiting.', via: 'rule' };
    const oldest = a.projects[0];
    return {
      say: `${plural(a.total, 'card')} waiting${a.projects.length > 1 ? ` across ${plural(a.projects.length, 'project')}` : ` in ${oldest?.project}`}. The oldest is ${span(this.now() - (oldest?.oldestAt ?? this.now()))} old${a.projects.length > 1 ? `, in ${oldest?.project}` : ''}.`,
      panel: {
        title: 'Approvals',
        lines: a.projects.map((p) => ({
          text: `${p.project} · ${plural(p.count, 'card')}`,
          sub: `oldest ${span(this.now() - p.oldestAt)} · ${p.title}`,
          tone: 'amber' as const,
        })),
      },
      via: 'rule',
    };
  }

  nextUp(): VoiceReply {
    const next = this.deps.glance().next;
    if (!next.length) return { say: 'Nothing else is scheduled today.', via: 'rule' };
    const first = next[0] as GlanceState['next'][number];
    return {
      say: `Next: ${first.name} at ${this.hm(first.at)}${next[1] ? `, then ${next[1].name} at ${this.hm(next[1].at)}` : ''}.`,
      panel: {
        title: 'Next up',
        lines: next.map((n) => ({ text: `${this.hm(n.at)} · ${n.name}`, sub: n.project })),
      },
      via: 'rule',
    };
  }

  usage(): VoiceReply {
    const u = this.deps.glance().usage;
    if (!u) return { say: "I don't have a usage figure yet.", via: 'rule' };
    const pc = Math.round(u.share * 100);
    return {
      say: `Claude usage is at ${pc} percent${u.resetsAt ? `, resetting at ${this.hm(u.resetsAt)}` : ''}.`,
      via: 'rule',
    };
  }

  async brief(): Promise<VoiceReply> {
    const needs = await this.needs();
    const g = this.deps.glance();
    const parts = [needs.say];
    if (g.running.length) parts.push(this.running().say);
    const ended = g.recent.filter((t) => t.endedAt && this.now() - t.endedAt < 3 * 3_600_000);
    const failed = ended.filter((t) => !['ok', 'silent'].includes(t.status));
    if (failed.length) parts.push(`${list(failed.slice(0, 2).map((t) => t.title))} ended badly.`);
    if (g.next[0]) parts.push(`Next is ${g.next[0].name} at ${this.hm(g.next[0].at)}.`);
    return { say: parts.join(' '), ...(needs.panel && { panel: needs.panel }), via: 'rule' };
  }

  private watch(said: string): VoiceReply | undefined {
    const tasks = this.deps.tasks();
    const running = tasks.filter((t) => t.status === 'running');
    const hits = findTask(running.length ? running : tasks, said, (p) => this.title(p));
    if (!hits.length) return undefined;
    const t = hits[0] as Task;
    return { say: `Showing ${t.title}.`, watch: t.id, via: 'rule' };
  }

  private stop(device: string, locked: boolean, said: string | Task): VoiceReply | undefined {
    const running = this.deps.tasks().filter((t) => t.status === 'running');
    const hits = typeof said === 'string' ? findTask(running, said, (p) => this.title(p)) : [said];
    if (!hits.length) return undefined;
    if (hits.length > 1)
      return { say: `Which one? ${list(hits.slice(0, 3).map((t) => t.title))}.`, via: 'rule' };
    const t = hits[0] as Task;
    return this.confirm(device, locked, `Stop ${t.title}, in ${this.title(t.project)}?`, () =>
      this.deps.stopTask(t.id)
        ? { say: `Stopping ${t.title}.`, via: 'confirm' }
        : { say: `${t.title} isn't running any more.`, via: 'confirm' },
    );
  }

  private jobAction(
    device: string,
    locked: boolean,
    action: 'run' | 'pause' | 'resume',
    said: string | VoiceJob,
  ): VoiceReply | undefined {
    const { job, candidates } =
      typeof said === 'string' ? findJob(this.deps.jobs(), said) : { job: said, candidates: [said] };
    if (!job) {
      if (candidates.length > 1)
        return {
          say: `Which one? ${list(candidates.slice(0, 3).map((j) => `${j.name} in ${j.projectTitle}`))}${candidates.length > 3 ? ', or more' : ''}.`,
          via: 'rule',
        };
      return undefined;
    }
    if (action === 'run' && job.running) return { say: `${job.name} is already running.`, via: 'rule' };
    if (action === 'pause' && !job.enabled) return { say: `${job.name} is already paused.`, via: 'rule' };
    if (action === 'resume' && job.enabled) return { say: `${job.name} isn't paused.`, via: 'rule' };
    const verb = action === 'run' ? 'Run' : action === 'pause' ? 'Pause' : 'Resume';
    return this.confirm(
      device,
      locked,
      `${verb} ${job.name}, in ${job.projectTitle}${action === 'run' ? ', now' : ''}?`,
      () => {
        if (action === 'run') {
          const r = this.deps.runJob(job.project, job.id);
          return {
            say:
              r === 'started'
                ? `Started ${job.name}.`
                : r === 'running'
                  ? `${job.name} is already running.`
                  : `I couldn't find ${job.name} any more.`,
            via: 'confirm',
          };
        }
        const r = this.deps.setJobEnabled(job.project, job.id, action === 'resume');
        return {
          say:
            r === 'ok'
              ? `${job.name} ${action === 'pause' ? 'paused' : 'resumed'}.`
              : `I couldn't find ${job.name} any more.`,
          via: 'confirm',
        };
      },
    );
  }

  // --- The model: anything the rules don't know ---

  /** The glance and jobs, trimmed for the model. */
  context(): Record<string, unknown> {
    const g = this.deps.glance();
    const at = this.now();
    const quiet = this.deps.quiet.until();
    return {
      now: this.hm(at),
      quietModeUntil: quiet ? this.hm(quiet) : null,
      quietHours: `${g.quiet.from}-${g.quiet.to}`,
      needsYou: g.needs.top.map((i) => ({ tier: i.tier, title: i.title, project: i.project })),
      needsCounts: { urgent: g.needs.urgent, waiting: g.needs.waiting },
      approvalCards: g.approvals.projects.map((p) => ({
        project: p.project,
        count: p.count,
        oldest: p.title,
      })),
      running: g.running.map((t) => ({
        task: t.id,
        title: t.title,
        project: t.project,
        minutes: Math.round((at - t.startedAt) / 60_000),
        step: t.step,
      })),
      recentlyEnded: g.recent.map((t) => ({
        task: t.id,
        title: t.title,
        project: t.project,
        status: statusWord(t.status),
        endedAt: t.endedAt && this.hm(t.endedAt),
        error: t.error?.slice(0, 160),
      })),
      nextUp: g.next.map((n) => ({ job: n.name, project: n.project, at: this.hm(n.at) })),
      claudeUsagePercent: g.usage ? Math.round(g.usage.share * 100) : null,
      jobs: this.deps.jobs().map((j) => ({
        project: j.project,
        id: j.id,
        name: j.name,
        ...(j.enabled ? {} : { paused: true }),
        ...(j.running && { running: true }),
        ...(j.nextRun && { next: this.hm(j.nextRun) }),
        ...(j.lastStatus && { last: statusWord(j.lastStatus) }),
        ...(j.lastRunAt && { lastAt: new Date(j.lastRunAt).toISOString().slice(0, 16) }),
        ...(j.lastError && j.lastStatus !== 'ok' && { error: j.lastError.slice(0, 160) }),
      })),
      projects: this.deps.projects.map((p) => ({ name: p.name, title: p.title })),
    };
  }

  systemPrompt(): string {
    return `You are ${this.deps.agentName}, the voice of a desk phone that watches the user's software projects run by tara-agent (Claude runs, scheduled jobs, approval cards). The user spoke to you; your words are read out by text to speech, and an optional panel is shown on the phone.

Reply with one JSON object and nothing else:
{"say": "<one or two short spoken sentences>", "panel"?: {"title": "<few words>", "lines": ["<line>", ...]}, "action"?: <one action>}

Actions (the server checks them; for run_job, pause_job, resume_job, stop and dispatch it asks the user to confirm, so then keep "say" empty):
{"type":"run_job"|"pause_job"|"resume_job","project":"<project name>","job":"<job id>"}
{"type":"stop","task":"<task id from running>"}
{"type":"watch","task":"<task id>"}  shows a run's live steps
{"type":"show","page":"home"|"night"}
{"type":"quiet","minutes":<n>}  holds alerts; 0 ends quiet mode
{"type":"ask","project":"<project name>","question":"<complete question>"}  for questions about a project's code, files or why something failed when the context below can't answer; Claude answers later (say you're checking)
{"type":"dispatch","project":"<project name>","task":"<every detail the user gave>"}  hands work that changes something (fix, write, send) to Claude in the project's Slack channel

Rules:
- Facts only from the context below. If it isn't there and isn't a code question, say you don't know.
- Why something failed: answer from the "error" and "last" fields of jobs and recentlyEnded. Use ask only for questions about code or files, or when no error is given.
- Speak like a calm assistant: short, no lists read out, no URLs, ids, code or markdown. Put lists in the panel.
- Approval cards can't be decided by voice: point to the Approvals page or Slack.
- If the user speaks Hindi or Hinglish, answer in simple Hinglish in Latin script.
- Small talk: one short friendly line, no action.`;
  }

  private async model(device: string, text: string, locked: boolean): Promise<VoiceReply> {
    if (!this.deps.model)
      return {
        say: "Sorry, I only know a few questions: what's running, what needs me, brief me, quiet mode.",
        via: 'none',
      };
    let raw: string;
    try {
      raw = await this.deps.model(
        this.systemPrompt(),
        `Context:\n${JSON.stringify(this.context())}\n\nThe user said: ${JSON.stringify(text)}`,
      );
    } catch (err) {
      this.deps.log?.warn(`phone voice: the model failed: ${(err as Error).message}`);
      return {
        say: "I can't think right now: the model didn't answer. Try what's running, or what needs me.",
        via: 'none',
      };
    }
    const out = parseModelReply(raw);
    const panel = out.panel;
    const base = (r: Omit<VoiceReply, 'via'>): VoiceReply => ({
      ...(panel && { panel }),
      ...r,
      via: 'model',
    });
    const a = out.action;
    const say = out.say || 'Okay.';
    if (!a) return base({ say });
    const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
    switch (a.type) {
      case 'run_job':
      case 'pause_job':
      case 'resume_job': {
        const action = a.type === 'run_job' ? 'run' : a.type === 'pause_job' ? 'pause' : 'resume';
        // The model names the job by id; one project's job with that id is the one.
        const exact = this.deps
          .jobs()
          .filter((j) => j.id === str('job') && (!str('project') || j.project === str('project')));
        const r = this.jobAction(
          device,
          locked,
          action,
          exact.length === 1 ? (exact[0] as VoiceJob) : str('job'),
        );
        return r ? { ...r, via: 'model' } : base({ say: "I couldn't find that job." });
      }
      case 'stop': {
        const t = this.deps.tasks().find((x) => x.id === str('task') && x.status === 'running');
        if (!t) return base({ say: "That isn't running." });
        return { ...(this.stop(device, locked, t) ?? { say: "That isn't running." }), via: 'model' };
      }
      case 'watch': {
        const t = this.deps.tasks().find((x) => x.id === str('task'));
        return t ? base({ say: out.say || `Showing ${t.title}.`, watch: t.id }) : base({ say });
      }
      case 'show':
        return base({ say, show: str('page') === 'night' ? 'night' : 'home' });
      case 'quiet': {
        const m = Number(a.minutes);
        return { ...this.quiet(Number.isFinite(m) ? m : DEFAULT_QUIET_MIN), via: 'model' };
      }
      case 'ask':
        return this.ask(str('project'), str('question') || text, say);
      case 'dispatch': {
        const project = this.deps.projects.find((p) => p.name === str('project'));
        const task = str('task');
        if (!this.deps.dispatch || !project || !task) return base({ say });
        const dispatch = this.deps.dispatch;
        const r = this.confirm(
          device,
          locked,
          `Hand this to Claude in ${project.title}: ${task.slice(0, 140)}?`,
          async () => {
            await dispatch(project.name, task);
            return { say: `Sent to ${project.title}. The answer will be in Slack.`, via: 'confirm' };
          },
        );
        return { ...r, via: 'model' };
      }
      default:
        return base({ say });
    }
  }

  /** Starts a read-only Claude question; the answer comes as a `voice` event. */
  private ask(projectName: string, question: string, said: string): VoiceReply {
    const project =
      this.deps.projects.find((p) => p.name === projectName) ??
      (this.deps.projects.length === 1 ? this.deps.projects[0] : undefined);
    if (!this.deps.ask || !project) return { say: said || "I don't know.", via: 'model' };
    const id = `ask-${this.now()}-${++this.asked}`;
    const ask = this.deps.ask;
    // Claude sees the repo, not tara-agent's run history: give it the project's jobs as they stand.
    const jobs = this.deps
      .jobs()
      .filter((j) => j.project === project.name && (j.lastError || j.lastStatus))
      .map(
        (j) =>
          `- ${j.name} (${j.id}): last ${statusWord(j.lastStatus ?? '?')}${j.lastRunAt ? ` at ${new Date(j.lastRunAt).toISOString().slice(0, 16)}Z` : ''}${j.lastError ? `: ${j.lastError.slice(0, 300)}` : ''}`,
      );
    const full = jobs.length
      ? `${question}\n\nScheduled jobs of this project, from tara-agent:\n${jobs.join('\n')}`
      : question;
    const started = this.now();
    const heard = `${project.title}: ${question.slice(0, 120)}`;
    void ask(project.name, full)
      .then((answer) => {
        this.deps.log?.info(`phone voice: ask in ${project.name} answered in ${this.now() - started} ms`);
        this.deps.announce({ id, say: answer, heard });
      })
      .catch((err: Error) => this.deps.announce({ id, say: `I couldn't find out: ${err.message}`, heard }));
    return {
      say: said && !/^okay\.?$/i.test(said) ? said : `Checking ${project.title}.`,
      pending: id,
      via: 'model',
    };
  }
}

/** The model's JSON reply; plain text (or broken JSON) becomes the spoken line. */
export function parseModelReply(raw: string): {
  say: string;
  panel?: VoicePanel;
  action?: Record<string, unknown> & { type?: string };
} {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { say: text.slice(0, 400) };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { say: text.replace(/[{}"]/g, '').slice(0, 400) };
  }
  const say = typeof j.say === 'string' ? j.say.slice(0, 400) : '';
  const p = j.panel as { title?: unknown; lines?: unknown } | undefined;
  const panel =
    p && Array.isArray(p.lines) && p.lines.length
      ? {
          title: typeof p.title === 'string' ? p.title.slice(0, 80) : '',
          lines: p.lines.slice(0, 8).map((l) => ({
            text: String(typeof l === 'object' && l ? ((l as { text?: unknown }).text ?? '') : l).slice(
              0,
              200,
            ),
          })),
        }
      : undefined;
  const action = j.action && typeof j.action === 'object' ? (j.action as Record<string, unknown>) : undefined;
  return { say, ...(panel && { panel }), ...(action && { action }) };
}

/**
 * A text model behind an OpenAI-compatible chat completions URL (host `voice`), trying `models` in
 * order. JSON output is asked for; each model gets `timeoutMs`.
 */
export function chatModel(
  opts: { url: string; models: string[]; apiKey?: string; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
): (system: string, user: string) => Promise<string> {
  return async (system, user) => {
    let last = 'no model answered';
    for (const model of opts.models) {
      try {
        const res = await fetchImpl(opts.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
        });
        if (!res.ok) {
          last = `${model}: HTTP ${res.status}`;
          continue;
        }
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const text = body.choices?.[0]?.message?.content?.trim();
        if (text) return text;
        last = `${model}: empty answer`;
      } catch (err) {
        last = `${model}: ${(err as Error).message}`;
      }
    }
    throw new Error(last);
  };
}
