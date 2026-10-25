import { createHmac } from 'node:crypto';
import { loadQueues } from '../config/load.js';
import type { Project } from '../config/schema.js';
import type { ChatPort, IncomingMessage, Logger, SlackBlock } from '../sessions/manager.js';
import { splitMessage, toSlackMrkdwn } from '../slack/format.js';
import type { Item, ItemCheck, ItemField, ItemMedia, Store } from '../store/store.js';
import { sealItem } from './seal.js';

/**
 * Approval items: the cards on the Approvals page (and, for a paused run, in its Slack thread).
 *   resume  a run stopped for a decision (`request_approval`); the answer continues that run
 *   queue   a draft (`propose_item`) that, once approved, runs later through one of the project's
 *           queues (scheduler/queues.ts)
 * Decisions come from Slack taps and from the dashboard (human-only, see http/server.ts) and both
 * go through `decide`, so an item is decided once whichever comes first.
 */

export class ApprovalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_OPTIONS = ['Approve', 'Reject'];
/** Options that turn an item down. */
export const NEGATIVE = /^(reject|deny|no|cancel|stop|decline|skip)/i;
/** The option that asks for a new draft instead of deciding. */
export const REVISE = 'Revise';
const SECTION_MAX = 2_800;

/** What a run proposes for later (`propose_item`). */
export interface ProposeInput {
  kind: string;
  key?: string;
  title: string;
  body?: string;
  fields?: ItemField[];
  checks?: ItemCheck[];
  media?: ItemMedia[];
  options?: string[];
  queue: string;
  window?: string;
  /** Not before this time (epoch ms). */
  runAfter?: number;
}

/** Where a proposal came from, when a run made it. */
export interface Origin {
  channel?: string;
  threadTs?: string;
  jobId?: string;
  source?: string;
}

export interface Decision {
  option: string;
  /** Slack user id, or the project owner for the dashboard. */
  by: string;
  via: 'slack' | 'dashboard';
  /** New values for editable fields. */
  fields?: Record<string, string | string[]>;
  reply?: string;
  /** Run as soon as the queue is free, ignoring its windows and slots. */
  runNow?: boolean;
}

export interface ApprovalsDeps {
  store: Store;
  chat: ChatPort;
  log: Logger;
  projects: Project[];
  timeZone: string;
  /** APPROVAL_SEAL_KEY. */
  sealKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
  newId?: () => string;
}

export class Approvals {
  /** Continues a chat thread with a decision (SessionManager.handle). */
  onChat?: (msg: IncomingMessage) => Promise<void>;
  /** Continues a job's run with a decision, as that job (Scheduler.resume). */
  onJob?: (
    project: string,
    jobId: string,
    r: { threadTs: string; text: string; by: string },
  ) => Promise<unknown>;

  private readonly now: () => number;

  constructor(private readonly deps: ApprovalsDeps) {
    this.now = deps.now ?? Date.now;
  }

  project(name: string): Project {
    const project = this.deps.projects.find((p) => p.config.name === name);
    if (!project) throw new ApprovalError(404, `Unknown project "${name}"`);
    return project;
  }

  /** A paused run's decision: stored as a card and posted with buttons in the run's Slack thread. */
  async requestDecision(
    ctx: { project: Project; channel: string; threadTs: string; jobId?: string },
    input: { title: string; details: string; options?: string[]; kind?: string },
  ): Promise<{ id: string; options: string[] }> {
    const title = input.title.trim().slice(0, 150);
    const options = cleanOptions(input.options);
    if (!title || options.length < 2) throw new ApprovalError(400, 'Need a title and at least 2 options');
    const item = this.deps.store.proposeItem({
      id: this.deps.newId?.(),
      project: ctx.project.config.name,
      kind: input.kind || 'decision',
      mode: 'resume',
      title,
      body: input.details.trim(),
      options,
      source: ctx.jobId,
      jobId: ctx.jobId,
      channel: ctx.channel,
      threadTs: ctx.threadTs,
    });

    let details = toSlackMrkdwn(input.details.trim());
    if (details.length > SECTION_MAX) {
      // Too long for one block: post it in full first, then the buttons under it.
      for (const chunk of splitMessage(details)) await this.deps.chat.post(ctx.channel, ctx.threadTs, chunk);
      details = '_Full proposal above._';
    }
    const blocks: SlackBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `*🟡 Approval needed: ${title}*\n${details}` } },
      {
        type: 'actions',
        elements: options.map((option, i) => ({
          type: 'button',
          text: { type: 'plain_text', text: option },
          action_id: `tara:approval:${i}`,
          value: item.id,
          ...(i === 0 ? { style: 'primary' } : NEGATIVE.test(option) ? { style: 'danger' } : {}),
        })),
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Or decide on the Approvals page, or reply in this thread.' }],
      },
    ];
    const ts = await this.deps.chat.postBlocks(
      ctx.channel,
      ctx.threadTs,
      `Approval needed: ${title}`,
      blocks,
    );
    this.deps.store.setItemMessage(item.id, ts);
    return { id: item.id, options };
  }

  /** A draft for later: checked, then waits on the Approvals page. Same key = update the pending one. */
  async propose(project: Project, input: ProposeInput, origin: Origin = {}): Promise<Item> {
    const queues = loadQueues(project);
    const queue = queues[input.queue];
    if (!queue) {
      const known = Object.keys(queues);
      throw new ApprovalError(
        400,
        `No queue "${input.queue}" in ${project.config.name}/.tara/queues.json${known.length ? ` (queues: ${known.join(', ')})` : ''}`,
      );
    }
    if (input.window && !queue.windows?.[input.window])
      throw new ApprovalError(400, `Queue "${input.queue}" has no window "${input.window}"`);
    const fields = (input.fields ?? []).map(cleanField);
    const checks = [...(input.checks ?? []), ...(await this.checks(project, input.kind, input.key, fields))];
    return this.deps.store.proposeItem({
      id: this.deps.newId?.(),
      project: project.config.name,
      kind: input.kind,
      key: input.key,
      mode: 'queue',
      title: input.title.trim().slice(0, 200),
      body: input.body,
      fields,
      checks,
      media: input.media,
      options: cleanOptions(input.options),
      source: origin.source,
      jobId: origin.jobId,
      channel: origin.channel,
      threadTs: origin.threadTs,
      queue: input.queue,
      window: input.window,
      runAfter: input.runAfter,
    });
  }

  /**
   * One decision on a pending item. Approving seals what was approved; a paused run continues;
   * Revise on a draft asks Jarvis for a new version and leaves the card waiting for it.
   */
  async decide(id: string, d: Decision): Promise<Item> {
    const { store } = this.deps;
    let item = store.getItem(id);
    if (!item) throw new ApprovalError(404, 'No such item');
    if (item.status !== 'pending') throw new ApprovalError(409, `Already ${item.status}`);
    const project = this.project(item.project);
    const revise = d.option === REVISE;
    if (!revise && !item.options.includes(d.option))
      throw new ApprovalError(400, `Unknown option "${d.option}"`);
    if (revise && !d.reply?.trim()) throw new ApprovalError(400, 'Say what to change');

    if (d.fields && Object.keys(d.fields).length) {
      const fields = item.fields.map((f) =>
        f.readOnly || !(f.key in (d.fields as object))
          ? f
          : cleanField({ ...f, value: (d.fields as Record<string, string | string[]>)[f.key] as string }),
      );
      const kept = item.checks.filter((c) => c.text.startsWith('Note:'));
      item =
        store.updateItemFields(id, fields, [
          ...kept,
          ...(await this.checks(project, item.kind, item.key, fields)),
        ]) ?? item;
    }

    const when = this.clock();
    if (revise && item.mode === 'queue') {
      store.noteRevision(id, (d.reply as string).trim());
      await this.continueConversation(project, item, d.by, reviseText(item, (d.reply as string).trim()));
      return store.getItem(id) as Item;
    }

    const negative = revise || NEGATIVE.test(d.option);
    // On a draft only the first option runs it; the others close it (Skip, "Applied by hand").
    const runs = !negative && (item.mode === 'resume' || d.option === item.options[0]);
    const blocking = item.checks.filter((c) => c.blocking);
    if (runs && blocking.length)
      throw new ApprovalError(409, `Fix this first: ${blocking.map((c) => c.text).join('; ')}`);
    // A paused run's card is finished once decided (the run gets the answer); a draft waits in its queue.
    const decided = store.decideItem(id, {
      status: negative ? 'rejected' : item.mode === 'resume' || !runs ? 'done' : 'approved',
      decision: d.option,
      by: d.by,
      reply: d.reply?.trim() || undefined,
      seal: runs ? sealItem(item, this.deps.sealKey) : undefined,
      runNow: d.runNow && runs,
    });
    if (!decided) throw new ApprovalError(409, 'Already decided');

    if (decided.channel && decided.messageTs) {
      const who = d.via === 'slack' ? `by <@${d.by}>` : 'on the Approvals page';
      await this.deps.chat
        .update(decided.channel, decided.messageTs, `${decided.title}: ${d.option}`, [
          { type: 'section', text: { type: 'mrkdwn', text: `*${decided.title}*` } },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `${negative ? '❌' : '✅'} *${d.option}*, chosen ${who} at ${when}` },
            ],
          },
        ])
        .catch((err: Error) => this.deps.log.warn(`could not update approval message: ${err.message}`));
    }
    if (decided.mode === 'resume') {
      const edits =
        d.fields && Object.keys(d.fields).length ? `\nEdited values: ${JSON.stringify(d.fields)}` : '';
      const note = d.reply?.trim() ? `\nNote: ${d.reply.trim()}` : '';
      const text = `USER DECISION on "${decided.title}": ${d.option}${note}${edits} (${d.via === 'slack' ? 'tapped' : 'chosen on the Approvals page'} at ${when})`;
      await this.continueConversation(project, decided, d.by, text);
    }
    this.notify(decided, 'decided');
    return decided;
  }

  /**
   * Tells the project's own server (`approvals.hookUrl`) that an item was decided or finished, so it
   * can do its side of it (log a send, drop a draft). Signed with the seal key, so nobody else can
   * fake one. Never throws: a project server that is down only misses the note.
   */
  notify(item: Item, event: 'decided' | 'finished'): void {
    const project = this.deps.projects.find((p) => p.config.name === item.project);
    const url = project?.config.approvals?.hookUrl;
    if (!url) return;
    const body = JSON.stringify({ event, item });
    const signature = this.deps.sealKey
      ? createHmac('sha256', this.deps.sealKey).update(body).digest('hex')
      : '';
    void (this.deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tara-signature': signature },
      body,
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        if (!res.ok)
          this.deps.log.warn(`[${item.project}] approvals hook answered ${res.status} for ${item.id}`);
      })
      .catch((err: Error) =>
        this.deps.log.warn(`[${item.project}] approvals hook failed for ${item.id}: ${err.message}`),
      );
  }

  cancel(id: string, by: string): Item {
    const item = this.deps.store.cancelItem(id, by);
    if (!item) throw new ApprovalError(409, 'Only waiting or scheduled items can be cancelled');
    this.notify(item, 'decided'); // a project that runs it itself must stop now
    return item;
  }

  /**
   * A project server takes back a card still waiting for a decision (the thing was posted by hand, or
   * deleted). It ends as cancelled, and the hook is told. Harmless if misused: a project that still
   * has the draft proposes it again.
   */
  withdraw(id: string, reason?: string): Item {
    const { store } = this.deps;
    const item = store.getItem(id);
    if (!item) throw new ApprovalError(404, 'No such item');
    if (item.status !== 'pending') throw new ApprovalError(409, `Already ${item.status}`);
    const cancelled = store.cancelItem(id, 'project') as Item;
    store.noteItem(id, reason);
    this.notify(cancelled, 'decided');
    return store.getItem(id) as Item;
  }

  /**
   * A project server's report on an item of one of its `external` queues: done or failed (finished,
   * and the hook is told), or `waiting` with a status line for the Scheduled tab.
   */
  report(id: string, status: 'done' | 'failed' | 'waiting', result?: string): Item {
    const { store } = this.deps;
    const item = store.getItem(id);
    if (!item) throw new ApprovalError(404, 'No such item');
    const queue = loadQueues(this.project(item.project))[item.queue ?? ''];
    if (!queue || !('external' in queue.executor))
      throw new ApprovalError(409, 'Only items of an external queue are reported by their project');
    if (item.status !== 'approved' && item.status !== 'running')
      throw new ApprovalError(409, `Already ${item.status}`);
    if (status === 'waiting') return store.noteItem(id, result) as Item;
    store.startItems([id]);
    const finished = store.finishItem(id, status, result) as Item;
    this.notify(finished, 'finished');
    return finished;
  }

  /** The project's own checks plus the field rules (required, maxLength). */
  async checks(
    project: Project,
    kind: string,
    key: string | undefined,
    fields: ItemField[],
  ): Promise<ItemCheck[]> {
    const checks: ItemCheck[] = [];
    for (const f of fields) {
      const value = Array.isArray(f.value) ? f.value.join('\n') : f.value;
      if (f.required && !value.trim()) checks.push({ text: `${f.label} is empty`, blocking: true });
      if (f.maxLength && value.length > f.maxLength)
        checks.push({ text: `${f.label}: ${value.length}/${f.maxLength} characters`, blocking: true });
    }
    const url = project.config.approvals?.validateUrl;
    if (url) {
      try {
        const res = await (this.deps.fetch ?? fetch)(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind,
            key,
            fields: Object.fromEntries(fields.map((f) => [f.key, f.value])),
          }),
          signal: AbortSignal.timeout(5_000),
        });
        const json = (await res.json()) as { checks?: ItemCheck[] };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const c of json.checks ?? [])
          checks.push({ text: String(c.text), blocking: Boolean(c.blocking) });
      } catch (err) {
        checks.push({
          text: `Note: the project's checks could not run (${(err as Error).message})`,
          blocking: false,
        });
      }
    }
    return checks;
  }

  /** Puts a decision (or a revise request) into the conversation that asked: the job's run, or a chat. */
  private async continueConversation(project: Project, item: Item, by: string, text: string): Promise<void> {
    const user = /^[UW][A-Z0-9]+$/.test(by) ? by : (project.config.owner ?? by);
    if (item.jobId && item.threadTs && item.mode === 'resume' && this.onJob) {
      await this.onJob(project.config.name, item.jobId, { threadTs: item.threadTs, text, by: user });
      return;
    }
    let channel = item.channel ?? project.config.slackChannel;
    let threadTs = item.threadTs;
    if (!threadTs) {
      // Proposed by a project server, not a run: start a thread for it.
      channel = project.config.slackChannel;
      threadTs = await this.deps.chat.post(channel, undefined, `✏️ Revise *${item.title}*`);
    }
    await this.onChat?.({ channel, threadTs, ts: item.messageTs ?? threadTs, user, text });
  }

  private clock(): string {
    return new Date(this.now()).toLocaleTimeString('en-GB', {
      timeZone: this.deps.timeZone,
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

function cleanOptions(options: string[] | undefined): string[] {
  return (options?.length ? options : DEFAULT_OPTIONS)
    .map((o) => o.trim().slice(0, 75))
    .filter((o) => o && o !== REVISE)
    .slice(0, 5);
}

function cleanField(f: ItemField): ItemField {
  const value =
    f.type === 'list'
      ? Array.isArray(f.value)
        ? f.value
        : String(f.value).split('\n')
      : String(f.value ?? '');
  return { ...f, key: String(f.key).slice(0, 60), label: String(f.label ?? f.key).slice(0, 80), value };
}

const reviseText = (item: Item, reply: string) =>
  `USER REVISE REQUEST for ${item.kind} "${item.title}"${item.key ? ` (key ${item.key})` : ''}, item ${item.id}: ${reply}
Make the change. If your skill says the project's server makes these cards, change it through the project and the card refreshes; otherwise call propose_item again with the same key and queue. Either way the new version replaces this card.`;
