import { createHmac } from 'node:crypto';
import { loadQueues } from '../config/load.js';
import type { Project } from '../config/schema.js';
import type { Privileged, PrivilegedResult } from '../privileged/privileged.js';
import type { DecidedCard } from '../scheduler/prompt.js';
import { openRunThread } from '../scheduler/slack-trigger.js';
import type { ChatPort, IncomingMessage, Logger, SlackBlock } from '../sessions/manager.js';
import { splitMessage, toSlackMrkdwn } from '../slack/format.js';
import type { Item, ItemCheck, ItemField, ItemMedia, Store } from '../store/store.js';
import { sealItem } from './seal.js';

/**
 * Approval items: the cards on the Approvals page (and, for a paused run, in its Slack thread).
 *   resume  a run stopped for a decision (`request_approval`); the answer continues that run. A
 *           project server can ask too (`ask`): the answer then starts the agent in the card's thread
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
/** Cards that tell rather than ask (`POST /items/ask` with this kind): the first option only acknowledges. */
export const NOTICE_KIND = 'notice';
/** Cards for root actions (`request_privileged`): approving one runs its action, then the run continues. */
export const PRIVILEGED_KIND = 'privileged';
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
  /** Ask the host's `autoApprove` entry for this kind to approve it (project servers only). */
  autoApprove?: boolean;
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
  /**
   * The card's `updatedAt` as the person saw it. A run can re-propose a pending card with the same key
   * and new content; if it changed since, the decision is refused instead of approving unseen content.
   */
  seen?: number;
}

export interface ApprovalsDeps {
  store: Store;
  chat: ChatPort;
  log: Logger;
  projects: Project[];
  timeZone: string;
  /** APPROVAL_SEAL_KEY. */
  sealKey?: string;
  /** Runs the action of an approved privileged card (host `privileged`). */
  privileged?: Privileged;
  /** Host `autoApprove`: kinds a project's server may approve itself, and where to ask. */
  autoApprove?: { project: string; kind: string; url: string }[];
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
    r: { threadTs: string; text: string; by: string; card?: DecidedCard },
  ) => Promise<unknown>;

  private readonly now: () => number;
  /** Day threads being opened, so two cards at once share one `Run` message. */
  private readonly opening = new Map<string, Promise<string>>();

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
    input: {
      title: string;
      details: string;
      options?: string[];
      kind?: string;
      key?: string;
      fields?: ItemField[];
    },
  ): Promise<{ id: string; options: string[] }> {
    const title = input.title.trim().slice(0, 150);
    const options = cleanOptions(input.options);
    if (!title || options.length < 2) throw new ApprovalError(400, 'Need a title and at least 2 options');
    const item = this.deps.store.proposeItem({
      id: this.deps.newId?.(),
      project: ctx.project.config.name,
      kind: input.kind || 'decision',
      key: input.key,
      mode: 'resume',
      title,
      body: input.details.trim(),
      fields: input.fields?.map(cleanField),
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

  /**
   * A card a project server raises outside any run (a login that expired, a send that bounced): posted
   * with its buttons in the day's `Run <kind>` thread and on the Approvals page, and the decision goes
   * to the agent in that thread like a reply. A pending card with the same `key` is returned instead.
   */
  async ask(
    project: Project,
    input: { title: string; details: string; options?: string[]; kind?: string; key?: string },
  ): Promise<Item> {
    const { store } = this.deps;
    const title = input.title.trim().slice(0, 150);
    if (!title) throw new ApprovalError(400, 'Need a title');
    const pending = input.key
      ? store
          .items({ project: project.config.name, statuses: ['pending'], limit: 500 })
          .find((i) => i.key === input.key)
      : undefined;
    if (pending) return pending;
    const { channel, ts } = await this.dayThread(project, input.kind || 'decision');
    const { id } = await this.requestDecision({ project, channel, threadTs: ts }, { ...input, title });
    return store.getItem(id) as Item;
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
    // Decided before the card is stored: only a key's first card can be approved without a person,
    // also when it is refreshed or revised while still pending; never once a card for it was decided.
    const auto =
      input.autoApprove &&
      input.key &&
      !checks.length &&
      !this.deps.store.hasDecidedKey(project.config.name, input.key)
        ? await this.askAutoApprove(project, input.kind, input.key, fields)
        : undefined;
    const proposed = this.deps.store.proposeItem({
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
    const options = proposed.options;
    const item =
      auto && !NEGATIVE.test(options[0] as string)
        ? (this.deps.store.decideItem(proposed.id, {
            status: 'approved',
            decision: options[0] as string,
            by: 'auto',
            reply: auto,
            seal: sealItem(proposed, this.deps.sealKey),
          }) ?? proposed)
        : proposed;
    if (queue.slack) await this.postCard(project, item);
    if (item.status === 'approved') {
      this.deps.log.info(`[${item.project}] ${item.kind} ${item.id} auto-approved: ${auto}`);
      this.notify(item, 'decided');
    }
    return this.deps.store.getItem(item.id) as Item;
  }

  /**
   * Host `autoApprove`: asks the project's server whether this card needs a person. The reason when it
   * says no person is needed, else undefined (no entry, a no, or no answer).
   */
  private async askAutoApprove(
    project: Project,
    kind: string,
    key: string,
    fields: ItemField[],
  ): Promise<string | undefined> {
    const rule = this.deps.autoApprove?.find((r) => r.project === project.config.name && r.kind === kind);
    if (!rule) return undefined;
    try {
      const res = await (this.deps.fetch ?? fetch)(rule.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, key, fields: Object.fromEntries(fields.map((f) => [f.key, f.value])) }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { approve?: unknown; reason?: unknown };
      if (json.approve !== true) return undefined;
      return `Auto-approved: ${typeof json.reason === 'string' && json.reason.trim() ? json.reason.trim().slice(0, 300) : 'nothing needed a person'}`;
    } catch (err) {
      this.deps.log.warn(
        `[${project.config.name}] auto-approve check failed for ${key}: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * A `slack` queue's card. Proposed by a run, the whole card goes in that run's thread. Otherwise it
   * gets its own channel message, kept to one line (title and status) so the channel stays scannable,
   * with the full draft as the first reply in its thread; a refresh edits both. The decision shows on
   * the message, and a Revise and the run that executes the card reply in its thread. Decisions stay
   * on the Approvals page: the message has no buttons. A Slack failure never loses the card: it still
   * waits on the Approvals page.
   */
  private async postCard(project: Project, item: Item): Promise<void> {
    const channel = item.channel ?? project.config.slackChannel;
    if (!channel) return;
    const status =
      item.status === 'approved' && item.decidedBy === 'auto'
        ? `✅ ${item.reply ?? 'Auto-approved'}. Goes out with the ${item.queue} queue; what happens next shows in this thread.`
        : `Waiting on the Approvals page (${item.options.join(' · ')} · Revise). What happens next shows in this thread.`;
    const shown = (v: string | string[]) => (Array.isArray(v) ? v.join('\n') : v).trim();
    const fields = item.fields
      .filter((f) => shown(f.value))
      .map((f) => {
        const value = shown(f.value).slice(0, 1_200);
        return `*${f.label}*\n${value
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}`;
      });
    const checks = item.checks.map((c) => `${c.blocking ? '⛔' : '⚠️'} ${c.text}`);
    const text = [toSlackMrkdwn(item.body ?? ''), ...fields, ...checks].filter(Boolean).join('\n\n');
    const card = (body: string): SlackBlock[] => [
      { type: 'section', text: { type: 'mrkdwn', text: `*📝 ${item.title}*${body}`.slice(0, SECTION_MAX) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: status }] },
    ];
    const detail: SlackBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, SECTION_MAX) } },
    ];
    // Its own channel message: only cards posted before channels held only `Run` threads.
    const ownMessage = !!item.messageTs && item.threadTs === item.messageTs;
    try {
      if (!item.threadTs) {
        // No run proposed it: it goes in the day's `Run <queue>` thread, where its outcome, a revise and
        // the run that sends it follow, like a card a run proposed.
        const day = await this.dayThread(project, item.queue ?? item.kind);
        const ts = await this.deps.chat.postBlocks(
          day.channel,
          day.ts,
          item.title,
          card(text ? `\n${text}` : ''),
        );
        this.deps.store.setItemThread(item.id, day.channel, day.ts, ts);
        return;
      }
      if (!ownMessage) {
        // Proposed by a run: the whole card goes in that run's thread, which stays the card's thread.
        const blocks = card(text ? `\n${text}` : '');
        if (item.messageTs) await this.deps.chat.update(channel, item.messageTs, item.title, blocks);
        else
          this.deps.store.setItemMessage(
            item.id,
            await this.deps.chat.postBlocks(channel, item.threadTs, item.title, blocks),
          );
        return;
      }
      let ts = item.messageTs;
      if (ts) await this.deps.chat.update(channel, ts, item.title, card(''));
      else {
        ts = await this.deps.chat.postBlocks(channel, undefined, item.title, card(''));
        this.deps.store.setItemSlack(item.id, channel, ts);
      }
      if (!text) return;
      if (item.detailTs) await this.deps.chat.update(channel, item.detailTs, item.title, detail);
      else
        this.deps.store.setItemDetail(
          item.id,
          await this.deps.chat.postBlocks(channel, ts, item.title, detail),
        );
    } catch (err) {
      this.deps.log.warn(
        `[${item.project}] could not post card ${item.id} to Slack: ${(err as Error).message}`,
      );
    }
  }

  /**
   * An item finished (any executor: a job's finish_item, a URL executor's answer, an external
   * project's report, or a run that ended without reporting): say how it went in the card's Slack
   * thread, unless the run that reported it is already posting in that thread. Then tell the hook.
   */
  finished(item: Item, runThread?: string): void {
    if (item.channel && item.messageTs && item.threadTs && item.threadTs !== runThread)
      this.postInThread(
        item,
        `${item.status === 'done' ? '✅ Done' : '❌ Failed'}${item.result ? `: ${item.result}` : ''}`,
      );
    this.notify(item, 'finished');
  }

  private postInThread(item: Item, text: string): void {
    void this.deps.chat
      .post(item.channel as string, item.threadTs, toSlackMrkdwn(text).slice(0, 2_000))
      .catch((err: Error) => this.deps.log.warn(`could not post to the card's thread: ${err.message}`));
  }

  /** A card's Slack message once it closed without a decision there (withdrawn, cancelled). */
  private closeMessage(item: Item, note: string): void {
    if (!item.channel || !item.messageTs) return;
    void this.deps.chat
      .update(item.channel, item.messageTs, `${item.title}: ${note}`, [
        { type: 'section', text: { type: 'mrkdwn', text: `*${item.title}*` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: note }] },
      ])
      .catch((err: Error) => this.deps.log.warn(`could not update approval message: ${err.message}`));
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
    if (d.seen !== undefined && d.seen !== item.updatedAt)
      throw new ApprovalError(409, 'This card changed since you opened it. Reload and check it again.');
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
    // An approved root action runs first (approved → running → done/failed), then its run continues.
    const action = runs && item.mode === 'resume' ? privilegedAction(item) : undefined;
    // A paused run's card is finished once decided (the run gets the answer); a draft waits in its queue.
    const decided = store.decideItem(id, {
      status: negative
        ? 'rejected'
        : action
          ? 'approved'
          : item.mode === 'resume' || !runs
            ? 'done'
            : 'approved',
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
    const ran = action ? `\n${privilegedNote(await this.runPrivileged(decided.id, action))}` : '';
    // A notice's first option ("Seen") just closes it; any other option goes to the agent as usual.
    const acknowledged = decided.kind === NOTICE_KIND && d.option === decided.options[0];
    if (decided.mode === 'resume' && !acknowledged) {
      const edits =
        d.fields && Object.keys(d.fields).length ? `\nEdited values: ${JSON.stringify(d.fields)}` : '';
      const note = d.reply?.trim() ? `\nNote: ${d.reply.trim()}` : '';
      const text = `USER DECISION on "${decided.title}": ${d.option}${note}${edits} (${d.via === 'slack' ? 'tapped' : 'chosen on the Approvals page'} at ${when})${ran}`;
      await this.continueConversation(project, decided, d.by, text, {
        title: decided.title,
        body: decided.body ?? '',
        declined: negative,
      });
    }
    const final = action ? (store.getItem(id) as Item) : decided;
    this.notify(final, 'decided');
    return final;
  }

  /**
   * A root action that needs no approval (`auto`): it runs at once and is kept as a finished card,
   * so the Approvals page still shows what ran as root and when.
   */
  async runAutoPrivileged(
    ctx: { project: Project; channel: string; threadTs: string; jobId?: string; kind?: string },
    input: { title: string; details: string; fields: ItemField[] },
  ): Promise<PrivilegedResult> {
    const { store } = this.deps;
    const item = store.proposeItem({
      id: this.deps.newId?.(),
      project: ctx.project.config.name,
      kind: PRIVILEGED_KIND,
      mode: 'resume',
      title: input.title.trim().slice(0, 150),
      body: input.details.trim(),
      fields: input.fields.map(cleanField),
      options: ['Run it'],
      source: ctx.jobId ?? (ctx.kind === 'chat' ? 'chat' : undefined),
      jobId: ctx.jobId,
      channel: ctx.channel,
      threadTs: ctx.threadTs,
    });
    store.decideItem(item.id, { status: 'approved', decision: 'Run it', by: 'auto' });
    const action = privilegedAction(item);
    if (!action) throw new ApprovalError(400, 'No action to run');
    return this.runPrivileged(item.id, action);
  }

  /** Runs an approved privileged card's action and records how it went on the card. */
  private async runPrivileged(id: string, action: { id: string; args: Record<string, string> }) {
    const { store, privileged } = this.deps;
    store.startItems([id]);
    const result: PrivilegedResult = privileged
      ? await privileged.run(action.id, action.args).catch((err: Error) => ({
          ok: false,
          exitCode: -1,
          command: action.id,
          output: err.message,
        }))
      : { ok: false, exitCode: -1, command: action.id, output: 'Privileged actions are off on this host' };
    store.finishItem(
      id,
      result.ok ? 'done' : 'failed',
      `${result.command}: exit ${result.exitCode}${result.output ? `\n${result.output}` : ''}`,
    );
    this.deps.log.info(`privileged ${action.id} (${id}) exited ${result.exitCode}`);
    return result;
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
    this.closeMessage(item, '➖ Cancelled on the Approvals page');
    this.notify(item, 'decided'); // a project that runs it itself must stop now
    return item;
  }

  /**
   * A person moves an approved item within its queue (Queue page), for a queue with `reorder`. A
   * queue that alternates kinds takes turns by kind, so the item moves among the items of its kind.
   */
  move(id: string, to: 'up' | 'down' | 'top' | 'bottom' | number): Item {
    const { store } = this.deps;
    const item = store.getItem(id);
    if (!item) throw new ApprovalError(404, 'No such item');
    const queue = item.queue ? loadQueues(this.project(item.project))[item.queue] : undefined;
    if (item.queue && !queue?.reorder)
      throw new ApprovalError(
        409,
        `Queue "${item.queue}" runs in approval order (no "reorder" in queues.json)`,
      );
    const moved = store.moveItem(id, to, Boolean(queue?.alternate?.length));
    if (!moved) throw new ApprovalError(409, 'Only approved items waiting in a queue can be moved');
    return moved;
  }

  /**
   * A project server, or the run that raised it, takes back a card still waiting for a decision (the
   * thing was done or posted by hand, or deleted). It ends as cancelled, and the hook is told.
   * Harmless if misused: a project that still has the draft proposes it again.
   */
  withdraw(id: string, reason?: string, by = 'project'): Item {
    const { store } = this.deps;
    const item = store.getItem(id);
    if (!item) throw new ApprovalError(404, 'No such item');
    if (item.status !== 'pending') throw new ApprovalError(409, `Already ${item.status}`);
    const cancelled = store.cancelItem(id, by) as Item;
    store.noteItem(id, reason);
    this.closeMessage(cancelled, `➖ Withdrawn${reason ? `: ${reason}` : ''}`);
    this.notify(cancelled, 'decided');
    return store.getItem(id) as Item;
  }

  /**
   * A note or question about a waiting card, from the Approvals page, without deciding it. It shows in
   * the card's Slack thread as the owner's reply and goes to Jarvis there, who answers in the thread;
   * the card keeps waiting. (A note typed before picking an option still goes with that decision.)
   */
  async note(id: string, text: string, by: string): Promise<Item> {
    const item = this.deps.store.getItem(id);
    if (!item) throw new ApprovalError(404, 'No such item');
    if (item.status !== 'pending') throw new ApprovalError(409, `Already ${item.status}`);
    if (!this.onChat) throw new ApprovalError(503, 'Chat is not running, so the note has nowhere to go');
    const project = this.project(item.project);
    const user = /^[UW][A-Z0-9]+$/.test(by) ? by : (project.config.owner ?? by);
    let channel = item.channel ?? project.config.slackChannel;
    let threadTs = item.threadTs;
    if (!threadTs) {
      channel = project.config.slackChannel;
      // A card no run proposed has no thread: open a "Run <kind>" one, naming the card.
      threadTs = await openRunThread(this.deps.chat, channel, item.kind);
      await this.deps.chat.post(channel, threadTs, `📝 *${item.title}*`);
    }
    await this.deps.chat.post(channel, threadTs, `📝 Note from the Approvals page: ${text}`);
    this.onChat({
      channel,
      threadTs,
      ts: threadTs,
      user,
      text: `About the waiting card "${item.title}" (item ${id}), sent from the Approvals page without a decision. The card is still waiting: answer in this thread, and change or withdraw the card only if the note asks for that.\n\n${text}`,
    }).catch((err) => this.deps.log.error(`[${item.project}] note on item ${id}: ${(err as Error).message}`));
    return item;
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
    if (status === 'waiting') {
      if (result && result !== item.result && item.messageTs) this.postInThread(item, `⏳ ${result}`);
      return store.noteItem(id, result) as Item;
    }
    store.startItems([id]);
    const finished = store.finishItem(id, status, result) as Item;
    this.finished(finished);
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

  /**
   * The day's `Run <name>` thread in the project's channel (host timezone), opened on first use and
   * shared by every card of that name that day, so a channel holds one line per queue a day.
   */
  private async dayThread(project: Project, name: string): Promise<{ channel: string; ts: string }> {
    const channel = project.config.slackChannel;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.deps.timeZone }).format(this.now());
    const key = `${project.config.name}:${name}:${day}`;
    const known = this.deps.store.dayThread(key);
    if (known) return known;
    let opening = this.opening.get(key);
    if (!opening) {
      opening = openRunThread(this.deps.chat, channel, name)
        .then((ts) => {
          this.deps.store.saveDayThread(key, channel, ts);
          return ts;
        })
        .finally(() => this.opening.delete(key));
      this.opening.set(key, opening);
    }
    return { channel, ts: await opening };
  }

  /** Puts a decision (or a revise request) into the conversation that asked: the job's run, or a chat. */
  private async continueConversation(
    project: Project,
    item: Item,
    by: string,
    text: string,
    card?: DecidedCard,
  ): Promise<void> {
    const user = /^[UW][A-Z0-9]+$/.test(by) ? by : (project.config.owner ?? by);
    if (item.jobId && item.threadTs && item.mode === 'resume' && this.onJob) {
      await this.onJob(project.config.name, item.jobId, { threadTs: item.threadTs, text, by: user, card });
      return;
    }
    let channel = item.channel ?? project.config.slackChannel;
    let threadTs = item.threadTs;
    if (!threadTs) {
      // Proposed by a project server, not a run: open a "Run <kind>" thread for it, naming the card.
      channel = project.config.slackChannel;
      threadTs = await openRunThread(this.deps.chat, channel, item.kind);
      await this.deps.chat.post(channel, threadTs, `📝 *${item.title}*`);
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

/** The action a privileged card runs when approved (none for "run this yourself" cards). */
function privilegedAction(item: Item): { id: string; args: Record<string, string> } | undefined {
  if (item.kind !== PRIVILEGED_KIND) return undefined;
  const value = (key: string) => {
    const v = item.fields.find((f) => f.key === key)?.value;
    return typeof v === 'string' ? v : undefined;
  };
  const id = value('action');
  if (!id) return undefined;
  try {
    const args = JSON.parse(value('args') || '{}') as unknown;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
    return { id, args: args as Record<string, string> };
  } catch {
    return undefined;
  }
}

/** How a root action went, for the run that asked for it. */
export function privilegedNote(r: PrivilegedResult): string {
  const head = r.ok
    ? `Ran \`${r.command}\` as root: exit 0.`
    : `\`${r.command}\` FAILED as root (exit ${r.exitCode}).`;
  return r.output ? `${head}\nOutput:\n\`\`\`\n${r.output}\n\`\`\`` : head;
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
