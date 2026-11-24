import { createHmac } from 'node:crypto';
import { loadQueues } from '../config/load.js';
import type { Project } from '../config/schema.js';
import type { Privileged, PrivilegedResult } from '../privileged/privileged.js';
import { buildDecisionPrompt, type DecidedCard } from '../scheduler/prompt.js';
import { openRunThread } from '../scheduler/slack-trigger.js';
import {
  type ChatPort,
  type IncomingMessage,
  type Logger,
  type SlackBlock,
  threadKey,
} from '../sessions/manager.js';
import { hasTable, MARKDOWN_MAX, postMarkdown, textBlock, toSlackMrkdwn } from '../slack/format.js';
import type { Item, ItemCheck, ItemField, ItemMedia, SessionMode, Store } from '../store/store.js';
import { isWebChannel, webChannel } from '../web/chat.js';
import { sealItem } from './seal.js';
import { choiceLine, type SessionChoice, sessionChoice } from './session-choice.js';

/**
 * Approval items: the cards on the Approvals page (and, for a paused run, in its Slack thread).
 *   resume  a run stopped for a decision (`request_approval`). The answer either continues that run's
 *           session or (with handoff notes) starts a fresh one in a new `Run` thread (the job's, or a
 *           chat's): the card advises one (session-choice.ts) and a person can pick the other. A project
 *           server can ask too (`ask`): the answer then starts the agent in the card's thread
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
/** How much of a message typed on the dashboard Slack shows (Slack stays short; the dashboard has it all). */
const SAID_MAX = 500;

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
  /** Ranking, higher first: the Approvals page lists the kind's drafts by it and the queue runs higher ones first. */
  priority?: number;
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
   * Where the decision is acted on, when the person picked it (the card's other option, or its advice
   * as shown). Unset: the advice the card shows. One the card can't use is ignored.
   */
  session?: SessionMode;
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
  /** How long a message posted as the person may wait for Slack to deliver it before it goes directly. */
  pickupTimeoutMs?: number;
  /** A thread's link: a Slack thread's once Slack is connected, a dashboard thread's page. */
  threadUrl?: (channel: string, ts: string) => string | undefined;
  /**
   * Where a card's own `Run <Kind>` thread opens (a chat acting on it): a dashboard thread (host
   * `delivery: summary`, its result posted in Slack) or the project's Slack channel (unset).
   */
  runChannel?: (project: Project) => string;
}

/** A message `toThread` posted as the person, until Slack delivers it (`delivered`). */
export interface Awaiting {
  /** The full text for Jarvis (Slack shows a shorter one). */
  text: string;
  /** Who the answer mentions (`IncomingMessage.mentionWhenDone`). */
  mention?: string;
  /** Its ts, once the post has returned. */
  ts?: string;
}

export class Approvals {
  /** Continues a chat thread with a decision (SessionManager.handle). */
  onChat?: (msg: IncomingMessage) => Promise<void>;
  /** Continues a job's run with a decision, as that job (Scheduler.resume). */
  onJob?: (
    project: string,
    jobId: string,
    r: { channel?: string; threadTs: string; text: string; by: string; card?: DecidedCard },
  ) => Promise<unknown>;
  /** Acts on a decision in a fresh session of the job, in a new `Run` thread (Scheduler.decided). */
  onJobDecision?: (
    project: string,
    jobId: string,
    r: { by: string; text: string; card: DecidedCard; from: { channel: string; threadTs: string } },
  ) => Promise<unknown>;

  private readonly now: () => number;
  /** Decisions still being handed to their run or chat (see `handOff`). */
  private readonly handing = new Set<Promise<void>>();
  /**
   * Messages posted as the person that Slack hasn't delivered yet, oldest first, per thread
   * (`toThread`): the full text for Jarvis, who the answer should mention, and the message ts once the
   * post has returned.
   */
  private readonly awaiting = new Map<string, Awaiting[]>();

  constructor(private readonly deps: ApprovalsDeps) {
    this.now = deps.now ?? Date.now;
    // A run or turn ended in a thread: its waiting cards' advice may have changed (bigger context, more turns).
    deps.store.onRun((key) => {
      void this.refreshAdvice(key).catch((err: Error) =>
        deps.log.warn(`${key}: card advice not refreshed: ${err.message}`),
      );
    });
  }

  /**
   * A waiting card's advice on where its decision is acted on (a new session or the same one), from
   * the session of its thread as it is now. Undefined for cards without that choice.
   */
  choiceFor(item: Item): SessionChoice | undefined {
    const { store } = this.deps;
    const key = item.threadTs ? threadKey(item.channel ?? '', item.threadTs) : undefined;
    return sessionChoice(
      item,
      key ? store.getSession(key) : undefined,
      key ? store.threadState(key) : undefined,
      this.now(),
      { rootAction: item.kind === PRIVILEGED_KIND },
    );
  }

  /**
   * Recomputes the advice of the waiting cards in a thread once a run there has ended, and edits the
   * cards (the dashboard message and its Slack copy) when it changed, so both show the same.
   */
  async refreshAdvice(key: string): Promise<void> {
    const { store } = this.deps;
    const at = key.indexOf(':');
    if (at < 1) return;
    const cards = store
      .itemsInThread(key.slice(0, at), key.slice(at + 1), 200)
      .filter((i) => i.status === 'pending' && i.mode === 'resume');
    for (const item of cards) await this.syncAdvice(item).done;
  }

  /**
   * A waiting card's advice as it is now (the Approvals page shows this). When it differs from what the
   * card's message says (the session went idle since, say), the message and its Slack copy are edited
   * too (`done`), so the page and Slack always offer the same default.
   */
  syncAdvice(item: Item): { choice: SessionChoice | undefined; done: Promise<void> } {
    const { store, chat, log } = this.deps;
    const choice = this.choiceFor(item);
    if (item.status !== 'pending' || choice?.mode === item.session)
      return { choice, done: Promise.resolve() };
    store.setItemSession(item.id, choice?.mode);
    if (!item.channel || !item.messageTs || item.kind === PRIVILEGED_KIND)
      return { choice, done: Promise.resolve() };
    const blocks = this.cardBlocks({ ...item, session: choice?.mode }, cardDetails(item.body ?? ''), choice);
    const done = chat
      .update(item.channel, item.messageTs, `Approval needed: ${item.title}`, blocks)
      .catch((err: Error) => log.warn(`could not update card ${item.id}: ${err.message}`));
    return { choice, done };
  }

  /**
   * A waiting card's Block Kit message, the same on the dashboard and in Slack: its text, one button
   * per option (each carrying where it is acted on), the card's other session as one more button
   * ("Approve · new session"), and a line with the advice and why.
   */
  private cardBlocks(item: Item, details: string, choice: SessionChoice | undefined): SlackBlock[] {
    const mode = choice?.mode;
    const buttons = item.options.map((option, i) => ({
      type: 'button',
      text: { type: 'plain_text', text: option },
      action_id: `tara:approval:${i}${mode ? `:${mode}` : ''}`,
      value: item.id,
      ...(i === 0 ? { style: 'primary' } : NEGATIVE.test(option) ? { style: 'danger' } : {}),
    }));
    const other = choice?.alternative;
    const first = item.options[0];
    if (other && first && !NEGATIVE.test(first))
      buttons.splice(1, 0, {
        type: 'button',
        text: {
          type: 'plain_text',
          text: `${first.slice(0, 40)} · ${other === 'new' ? 'new session' : 'same session'}`,
        },
        action_id: `tara:approval:0:${other}`,
        value: item.id,
      });
    const where = choice ? choiceLine(choice) : 'A decision continues the conversation that asked.';
    return [
      textBlock(`**🟡 Approval needed: ${item.title}**\n${details}`, SECTION_MAX + 200),
      { type: 'actions', elements: buttons },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `${where}. Or decide on the Approvals page, or reply in this thread.` },
        ],
      },
    ];
  }

  project(name: string): Project {
    const project = this.deps.projects.find((p) => p.config.name === name);
    if (!project) throw new ApprovalError(404, `Unknown project "${name}"`);
    return project;
  }

  /**
   * A paused run's decision: stored as a card and posted with buttons in the run's Slack thread. A
   * pending card with the same `key` is updated in place (page and Slack message) instead.
   */
  async requestDecision(
    ctx: { project: Project; channel: string; threadTs: string; jobId?: string },
    input: {
      title: string;
      details: string;
      options?: string[];
      kind?: string;
      key?: string;
      fields?: ItemField[];
      /** Notes for a fresh session that may act on the decision in a new thread (`session: 'new'`). */
      handoff?: string;
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
      handoff: input.handoff,
      fields: input.fields?.map(cleanField),
      options,
      source: ctx.jobId,
      jobId: ctx.jobId,
      channel: ctx.channel,
      threadTs: ctx.threadTs,
    });

    const refresh =
      item.messageTs && item.channel ? { channel: item.channel, ts: item.messageTs } : undefined;
    let details = input.details.trim();
    const max = hasTable(details) ? MARKDOWN_MAX : SECTION_MAX;
    if (details.length > max && refresh) {
      // An update edits the one message: the full text stays on the Approvals page.
      details = `${details.slice(0, max - 200)}…\n_Full text on the Approvals page._`;
    } else if (details.length > max) {
      // Too long for one block: post it in full first, then the buttons under it. A dashboard run's card
      // is also copied to Slack, where "above" would point at nothing.
      await postMarkdown(this.deps.chat, ctx.channel, ctx.threadTs, details);
      details = isWebChannel(ctx.channel)
        ? `${details.slice(0, max - 200)}…\n_Full text on the Approvals page._`
        : '_Full proposal above._';
    }
    const choice = this.choiceFor(item);
    this.deps.store.setItemSession(item.id, choice?.mode);
    const blocks = this.cardBlocks({ ...item, session: choice?.mode }, details, choice);
    if (refresh) {
      await this.deps.chat
        .update(refresh.channel, refresh.ts, `Approval needed: ${title}`, blocks)
        .catch((err: Error) =>
          this.deps.log.warn(`could not update card ${item.id} in Slack: ${err.message}`),
        );
      return { id: item.id, options };
    }
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
   * A card a project server raises (a login that expired, a send that bounced). For a run or chat
   * (`thread`) it goes with its buttons in that thread; outside any it waits on the Approvals page
   * only, never as a loose Slack post, and a decision opens the `Run <Kind>` thread Jarvis acts in
   * (`openCardThread`). A pending card with the same `key` is updated in place (a project keeps one
   * live card, e.g. one a day, and adds to it); unchanged, it is returned as is.
   */
  async ask(
    project: Project,
    input: { title: string; details: string; options?: string[]; kind?: string; key?: string },
    /** The run or chat thread the card belongs to (`runThread`); without one, the Approvals page only. */
    thread?: { channel: string; threadTs: string },
  ): Promise<Item> {
    const { store } = this.deps;
    const title = input.title.trim().slice(0, 150);
    if (!title) throw new ApprovalError(400, 'Need a title');
    const pending = input.key
      ? store
          .items({ project: project.config.name, statuses: ['pending'], limit: 500 })
          .find((i) => i.key === input.key)
      : undefined;
    if (pending) {
      const options = cleanOptions(input.options);
      const same =
        pending.title === title &&
        (pending.body ?? '') === input.details.trim() &&
        JSON.stringify(pending.options) === JSON.stringify(options);
      if (same) return pending;
      if (!pending.channel || !pending.threadTs)
        return this.pageCard(project, { ...input, title, kind: input.kind || pending.kind });
      await this.requestDecision(
        { project, channel: pending.channel, threadTs: pending.threadTs },
        { ...input, title, kind: input.kind || pending.kind },
      );
      return this.deps.store.getItem(pending.id) as Item;
    }
    if (!thread) return this.pageCard(project, { ...input, title });
    const { channel, threadTs } = thread;
    const { id } = await this.requestDecision({ project, channel, threadTs }, { ...input, title });
    return store.getItem(id) as Item;
  }

  /** A card no run or chat raised: stored for the Approvals page, with nothing posted in Slack. */
  private pageCard(
    project: Project,
    input: { title: string; details: string; options?: string[]; kind?: string; key?: string },
  ): Item {
    const options = cleanOptions(input.options);
    if (options.length < 2) throw new ApprovalError(400, 'Need a title and at least 2 options');
    return this.deps.store.proposeItem({
      id: this.deps.newId?.(),
      project: project.config.name,
      kind: input.kind || 'decision',
      key: input.key,
      mode: 'resume',
      title: input.title,
      body: input.details.trim(),
      options,
    });
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
      priority: input.priority,
    });
    const options = proposed.options;
    // Asked again here, with no await since: another proposal of the same key may have been approved
    // while this one waited for its checks and the project's answer, and it must not go out twice.
    const item =
      auto &&
      !NEGATIVE.test(options[0] as string) &&
      !this.deps.store.hasDecidedKey(project.config.name, input.key as string)
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
   * A `slack` queue's card. Proposed by a run, the whole card goes in that run's thread. Proposed
   * outside any run, it waits on the Approvals page only: nothing loose goes in the channel. (Cards
   * posted before that keep their own channel message, edited on a refresh.) The decision shows on the
   * message, and a Revise and the run that executes the card reply in its thread. Decisions stay on the
   * Approvals page: the message has no buttons. A Slack failure never loses the card: it still waits on
   * the Approvals page.
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
        return `**${f.label}**\n${value
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}`;
      });
    const checks = item.checks.map((c) => `${c.blocking ? '⛔' : '⚠️'} ${c.text}`);
    const text = [item.body ?? '', ...fields, ...checks].filter(Boolean).join('\n\n');
    const card = (body: string): SlackBlock[] => [
      textBlock(`**📝 ${item.title}**${body}`, SECTION_MAX),
      { type: 'context', elements: [{ type: 'mrkdwn', text: status }] },
    ];
    const detail: SlackBlock[] = [textBlock(text, SECTION_MAX)];
    // Its own channel message: only cards posted before channels held only `Run` threads.
    const ownMessage = !!item.messageTs && item.threadTs === item.messageTs;
    try {
      // No run proposed it: the Approvals page only. A revise opens a `Run` thread then (`openCardThread`).
      if (!item.threadTs) return;
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
      const before = item;
      const fields = item.fields.map((f) =>
        f.readOnly || !(f.key in (d.fields as object))
          ? f
          : cleanField({ ...f, value: (d.fields as Record<string, string | string[]>)[f.key] as string }),
      );
      // The edit is checked again; only the old checks of the fields are dropped. What the proposer said
      // (⛔ "recipient opted out", say) stays: editing a typo doesn't clear it.
      const [stale, fresh] = await Promise.all([
        this.checks(project, item.kind, item.key, item.fields),
        this.checks(project, item.kind, item.key, fields),
      ]);
      const kept = item.checks.filter((c) => !stale.some((s) => s.text === c.text));
      // The checks took a moment: a run may have re-proposed this card meanwhile (new title or body).
      // The edits were made on what the person saw, so they only go on that version.
      const current = store.getItem(id);
      if (current?.status !== 'pending' || current.updatedAt !== before.updatedAt)
        throw new ApprovalError(409, 'This card changed since you opened it. Reload and check it again.');
      item = store.updateItemFields(id, fields, [...kept, ...fresh]) ?? item;
    }

    const when = this.clock();
    if (revise && item.mode === 'queue') {
      store.noteRevision(id, (d.reply as string).trim());
      this.handOff(
        item,
        this.continueConversation(project, item, d.by, reviseText(item, (d.reply as string).trim()), {
          fromPage: d.via !== 'slack',
          visible: (who) =>
            `*From ${who} on the Approvals page:* ✏️ Revise "${item.title}"\n${(d.reply as string).trim()}`,
        }),
      );
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
    // Where it is acted on: what the person picked, else the advice the card showed them, else today's.
    const choice = this.choiceFor(item);
    const usable = (m?: SessionMode) =>
      m && (m === choice?.mode || m === choice?.alternative) ? m : undefined;
    const session = usable(d.session) ?? usable(item.session) ?? choice?.mode;
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
    if (session !== decided.session) {
      store.setItemSession(id, session);
      decided.session = session;
    }

    if (decided.channel && decided.messageTs) {
      const who = d.via === 'slack' ? `by <@${d.by}>` : 'on the Approvals page';
      await this.deps.chat
        .update(decided.channel, decided.messageTs, `${decided.title}: ${d.option}`, [
          { type: 'section', text: { type: 'mrkdwn', text: `*${decided.title}*` } },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${negative ? '❌' : '✅'} *${d.option}*, chosen ${who} at ${when}${
                  session && (!negative || d.reply?.trim())
                    ? session === 'new'
                      ? ' · acted on in a new session'
                      : ' · continues in the same session'
                    : ''
                }`,
              },
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
      const card = {
        title: decided.title,
        body: decided.body ?? '',
        declined: negative,
        handoff: decided.handoff,
      };
      const visible = (who: string) =>
        `*From ${who} on the Approvals page:* ${negative ? '❌' : '✅'} ${d.option} on "${decided.title}"${d.reply?.trim() ? `\n${d.reply.trim()}` : ''}`;
      // A new session acts on it in a new thread (from the handoff notes). A plain "no" needs no run: the
      // card shows it, and later runs see it in the project memory's recent decisions.
      if (session === 'new' && !action) {
        if (!negative || d.reply?.trim())
          this.handOff(
            decided,
            this.actInNewThread(project, decided, d.by, text, card, { fromPage: d.via !== 'slack', visible }),
          );
      } else
        this.handOff(
          decided,
          this.continueConversation(project, decided, d.by, text, {
            card,
            fromPage: d.via !== 'slack',
            visible,
          }),
        );
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

  /**
   * A person settles an `uncertain` item (its run never said whether it went out): `sent` (done),
   * `retry` (back in its queue) or `drop` (failed).
   */
  resolve(id: string, outcome: 'sent' | 'retry' | 'drop', by: string): Item {
    const item = this.deps.store.resolveUncertain(id, outcome, by);
    if (!item) throw new ApprovalError(409, 'Only an item marked uncertain can be settled this way');
    this.closeMessage(
      item,
      { sent: '✅ Marked as sent', retry: '🔁 Queued again', drop: '➖ Dropped, not sent' }[outcome],
    );
    this.notify(item, 'decided');
    return item;
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
   * the card's thread as the owner's reply and goes to Jarvis there, who answers in that session (the
   * page then opens it, live); the card keeps waiting. (A note typed before picking an option still goes with that decision.)
   * See `toThread` for when it is posted as the person and Slack starts the chat.
   */
  /**
   * A message typed on a session's dashboard page, for a session Slack shows too: a Slack thread's, or a
   * dashboard run's Slack summary thread (`at`). It is posted there as the person (SLACK_USER_TOKEN),
   * your words, cut only past `SAID_MAX` with a pointer to the dashboard, and Slack hands it to Jarvis
   * like a reply typed there (the full text). Without a user token, or if Slack doesn't deliver it in
   * time, a bot line shows it and it goes to Jarvis directly. Either way Slack has the question and the
   * answer, never the answer alone.
   */
  async sayFromDashboard(
    at: { channel: string; threadTs: string },
    text: string,
    user: string,
  ): Promise<void> {
    const shown =
      text.length > SAID_MAX ? `${text.slice(0, SAID_MAX).trimEnd()}… _(the rest on the dashboard)_` : text;
    await this.toThread({ channel: at.channel, threadTs: at.threadTs, ts: at.threadTs, user }, text, {
      fromPage: true,
      always: true,
      background: true,
      visible: (who) => `*From ${who} on the dashboard:* ${shown}`,
      shown: `💬 *From the dashboard:* ${shown}`,
    });
  }

  async note(id: string, text: string, by: string): Promise<Item> {
    const item = this.deps.store.getItem(id);
    if (!item) throw new ApprovalError(404, 'No such item');
    if (item.status !== 'pending') throw new ApprovalError(409, `Already ${item.status}`);
    if (!this.onChat) throw new ApprovalError(503, 'Chat is not running, so the note has nowhere to go');
    const project = this.project(item.project);
    const user = /^[UW][A-Z0-9]+$/.test(by) ? by : (project.config.owner ?? by);
    // A card no run proposed has no thread yet: Jarvis answers in a new `Run <Kind>` one.
    const { channel, threadTs } = item.threadTs
      ? { channel: item.channel ?? project.config.slackChannel, threadTs: item.threadTs }
      : await this.openCardThread(project, item);
    await this.toThread(
      { channel, threadTs, ts: threadTs, user, summary: `*${item.title}*` },
      `About the waiting card "${item.title}" (item ${id}), sent from the Approvals page without a decision. The card is still waiting: answer in this thread, and change or withdraw the card only if the note asks for that.\n\n${text}`,
      {
        fromPage: true,
        always: true,
        mention: true,
        visible: (who) => `*From ${who} on the Approvals page:* ${text}`,
        shown: `📝 Note from ${/^[UW][A-Z0-9]+$/.test(user) ? `<@${user}>` : 'the owner'} on the Approvals page: ${text}`,
        background: true,
      },
    );
    // With the thread it went to (a card no run raised has one now): the page opens its session.
    return this.deps.store.getItem(id) ?? item;
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
   * The thread of a run or chat a project server is working for: `TARA_THREAD` (`<channel>:<ts>`) of
   * that run, passed on by the server so its card lands in that thread like one the run proposed itself.
   * Only a thread tara-agent has a session for, in this project's channel; anything else is undefined
   * (the card then waits on the Approvals page only, so it is never lost).
   */
  runThread(project: Project, value: string | undefined): { channel: string; threadTs: string } | undefined {
    if (!value) return undefined;
    const at = value.indexOf(':');
    const channel = value.slice(0, at);
    const threadTs = value.slice(at + 1);
    if (
      at < 1 ||
      !threadTs ||
      (channel !== project.config.slackChannel && channel !== webChannel(project.config.name))
    )
      return undefined;
    const session = this.deps.store.getSession(value);
    return session?.project === project.config.name ? { channel, threadTs } : undefined;
  }

  /**
   * The thread Jarvis acts in on a card no run or chat raised, once a person decides it, asks for a
   * revise or sends a note: a `Run <Kind>` message (the only kind tara starts in a channel) with the
   * card's title as its first reply. Kept on the card, so its outcome and later notes go there too.
   */
  private async openCardThread(
    project: Project,
    item: Item,
  ): Promise<{ channel: string; threadTs: string; ts: string }> {
    const channel = this.deps.runChannel?.(project) ?? project.config.slackChannel;
    const threadTs = await openRunThread(
      this.deps.chat,
      channel,
      item.queue ?? item.kind,
      project.config.words,
    );
    const ts = await this.deps.chat.post(channel, threadTs, `📝 *${item.title}*`);
    this.deps.store.setItemThread(item.id, channel, threadTs, ts);
    return { channel, threadTs, ts };
  }

  /** Puts a decision (or a revise request) into the conversation that asked: the job's run, or a chat. */
  private async continueConversation(
    project: Project,
    item: Item,
    by: string,
    text: string,
    opts: { card?: DecidedCard; fromPage?: boolean; visible?: (who: string) => string } = {},
  ): Promise<void> {
    const user = /^[UW][A-Z0-9]+$/.test(by) ? by : (project.config.owner ?? by);
    if (item.jobId && item.threadTs && item.mode === 'resume' && this.onJob) {
      const status = await this.onJob(project.config.name, item.jobId, {
        channel: item.channel,
        threadTs: item.threadTs,
        text,
        by: user,
        card: opts.card,
      });
      if (status !== 'unknown') return;
      // The job was renamed or removed after it asked (e.g. merged into another job): without this the
      // decision would be dropped. A chat in the card's thread acts on it instead.
      this.deps.log.warn(
        `[${project.config.name}] item ${item.id}: job ${item.jobId} no longer exists, continuing as a chat`,
      );
    }
    // Proposed by a project server, not a run: Jarvis acts on it in a new `Run <Kind>` thread.
    const where = item.threadTs
      ? { channel: item.channel ?? project.config.slackChannel, threadTs: item.threadTs, ts: item.messageTs }
      : await this.openCardThread(project, item);
    const { channel, threadTs } = where;
    await this.toThread(
      { channel, threadTs, ts: where.ts ?? threadTs, user, summary: `*${item.title}*` },
      text,
      {
        fromPage: opts.fromPage,
        visible: opts.visible,
      },
    );
  }

  /**
   * A decision on a card with handoff notes: a fresh session acts on it in a new `Run` thread, from the
   * card, its notes and the project memory, instead of resuming the run that raised it. A job's card
   * runs as that job (its slot, locks and timeout); a chat's card, or one whose job is gone, as a chat.
   * Each thread links to the other.
   */
  private async actInNewThread(
    project: Project,
    item: Item,
    by: string,
    text: string,
    card: DecidedCard,
    opts: { fromPage?: boolean; visible?: (who: string) => string },
  ): Promise<void> {
    const user = /^[UW][A-Z0-9]+$/.test(by) ? by : (project.config.owner ?? by);
    const from =
      item.channel && item.threadTs ? { channel: item.channel, threadTs: item.threadTs } : undefined;
    if (item.jobId && from && this.onJobDecision) {
      const status = await this.onJobDecision(project.config.name, item.jobId, {
        by: user,
        text,
        card,
        from,
      });
      if (status !== 'unknown') return;
      this.deps.log.warn(
        `[${project.config.name}] item ${item.id}: job ${item.jobId} no longer exists, acting on it as a chat`,
      );
    }
    const { chat, store, threadUrl } = this.deps;
    const channel = this.deps.runChannel?.(project) ?? project.config.slackChannel;
    const threadTs = await openRunThread(chat, channel, item.kind, project.config.words);
    const here = threadUrl?.(channel, threadTs);
    const there = from && threadUrl?.(from.channel, from.threadTs);
    await chat.post(channel, threadTs, `📝 *${item.title}*${there ? ` · <${there}|earlier thread>` : ''}`);
    if (from)
      await chat
        .post(
          from.channel,
          from.threadTs,
          `➡️ Your decision on "${item.title}" continues in ${here ? `<${here}|a new thread>` : 'a new thread'}`,
        )
        .catch((err: Error) => this.deps.log.warn(`could not link the new thread: ${err.message}`));
    const earlier = from && store.getSession(threadKey(from.channel, from.threadTs));
    const prompt = buildDecisionPrompt(card, text, {
      earlier: from && { url: there, sessionId: earlier?.sessionId, harness: earlier?.harness },
    });
    await this.toThread({ channel, threadTs, ts: threadTs, user, summary: `*${item.title}*` }, prompt, opts);
  }

  /**
   * Hands Jarvis a message in a card's thread. From the Approvals page it is posted there as the person
   * (SLACK_USER_TOKEN) and Slack hands it on like any reply, so the thread shows exactly what Jarvis
   * was asked: always for a note (`always`, a chat either way), and for a decision only when the thread
   * has no session yet (a job's decision resumes the job, which a Slack reply can't). Everything else
   * goes directly, as does everything when there is no user token or that post fails. If Slack doesn't
   * deliver the posted message in time (see `delivered`), it goes directly then. With `mention`, the
   * person who sent it (`msg.user`: the project owner from the page) is mentioned once Jarvis has
   * answered (`IncomingMessage.mentionWhenDone`), so they get a notification: Slack doesn't notify on a
   * streamed answer, and the user token may be another account (e.g. a brand account) than theirs.
   * Slack shows `visible` (who sent it, mentioned so they are notified at once, and what they said) and
   * Jarvis still gets `text` (`delivered` swaps it back), since the user token's account isn't theirs.
   */
  private async toThread(
    msg: Omit<IncomingMessage, 'text'>,
    text: string,
    /** `background`: resolve once posted, without waiting for Jarvis's turn. */
    opts: {
      fromPage?: boolean;
      always?: boolean;
      mention?: boolean;
      /** What Slack shows when it is posted as the person, given the sender (a mention). */
      visible?: (who: string) => string;
      shown?: string;
      background?: boolean;
    },
  ): Promise<void> {
    const { chat, store, log } = this.deps;
    const key = threadKey(msg.channel, msg.threadTs);
    const mention = opts.mention && /^[UW][A-Z0-9]+$/.test(msg.user) ? msg.user : undefined;
    // A dashboard thread has no Slack delivery to wait for: it goes to Jarvis directly.
    const asPerson =
      opts.fromPage && !isWebChannel(msg.channel) && (opts.always || !store.getSession(key))
        ? chat.postAsUser?.bind(chat)
        : undefined;
    if (asPerson) {
      // A mention, so the sender is notified at once (the post is the user token's account, not theirs).
      const who = /^[UW][A-Z0-9]+$/.test(msg.user) ? `<@${msg.user}>` : msg.user;
      const shownText = opts.visible ? opts.visible(who) : text;
      // Registered before posting: Slack can deliver the message before the post call returns.
      const entry: Awaiting = { text, mention };
      this.awaiting.set(key, [...(this.awaiting.get(key) ?? []), entry]);
      const drop = () => {
        const left = (this.awaiting.get(key) ?? []).filter((a) => a !== entry);
        if (left.length) this.awaiting.set(key, left);
        else this.awaiting.delete(key);
      };
      try {
        const ts = await asPerson(msg.channel, shownText, msg.threadTs);
        entry.ts = ts;
        const timer = setTimeout(() => {
          if (!this.awaiting.get(key)?.includes(entry)) return; // Slack delivered it
          drop();
          log.warn(
            `${key}: message from the Approvals page not picked up from Slack in time; sending it directly`,
          );
          this.onChat?.({ ...msg, ts, text, mentionWhenDone: mention }).catch((err: Error) =>
            log.error(`${key}: ${err.message}`),
          );
        }, this.deps.pickupTimeoutMs ?? 120_000);
        timer.unref();
        return;
      } catch (err) {
        drop();
        log.warn(`${key}: not posted as the user (${(err as Error).message}); sending it directly`);
      }
    }
    // The line that shows it is the message Jarvis answers (its ts), like a reply typed there: in a
    // dashboard run's Slack summary thread that is what leads to the run's session.
    const shownTs = opts.shown ? await chat.post(msg.channel, msg.threadTs, opts.shown) : undefined;
    // In a dashboard thread nobody watches the answer come in: it is posted in Slack when it ends.
    const summary = isWebChannel(msg.channel) ? (msg.summary ?? this.cardTitle(msg)) : undefined;
    const turn = this.onChat?.({ ...msg, ts: shownTs ?? msg.ts, text, mentionWhenDone: mention, summary });
    if (!opts.background) return turn;
    turn?.catch((err: Error) => log.error(`${key}: ${err.message}`));
  }

  /** The title of the card a dashboard thread is about (its first `📝` line), for its Slack summary. */
  private cardTitle(msg: Pick<IncomingMessage, 'channel' | 'threadTs'>): string {
    const card = this.deps.store.itemsInThread(msg.channel, msg.threadTs)[0];
    return card ? `*${card.title.slice(0, 120)}*` : '*Card*';
  }

  /**
   * Slack delivered a message. One `toThread` posted as the person (same ts, or one still being posted
   * in that thread, since Slack can deliver it before the post returns) is no longer sent directly, and
   * its full text for Jarvis and who to mention are returned; undefined for any other message.
   */
  delivered(msg: Pick<IncomingMessage, 'channel' | 'threadTs' | 'ts'>): Awaiting | undefined {
    if (msg.threadTs === msg.ts) return undefined;
    const key = threadKey(msg.channel, msg.threadTs);
    const waiting = this.awaiting.get(key) ?? [];
    const mine = waiting.find((a) => a.ts === msg.ts) ?? waiting.find((a) => a.ts === undefined);
    if (!mine) return undefined;
    const left = waiting.filter((a) => a !== mine);
    if (left.length) this.awaiting.set(key, left);
    else this.awaiting.delete(key);
    return mine;
  }

  /**
   * The run or chat a decision continues can take minutes (and waits for its job to be free first), so
   * `decide` does not wait for it: the card is decided and its Slack message updated at once.
   */
  private handOff(item: Item, work: Promise<void>): void {
    const p = work
      .catch((err: Error) =>
        this.deps.log.error(
          `[${item.project}] item ${item.id}: could not continue with the decision: ${err.message}`,
        ),
      )
      .finally(() => this.handing.delete(p));
    this.handing.add(p);
  }

  /** Resolves once every decision handed off so far has reached its run or chat and that has ended. */
  async settled(): Promise<void> {
    while (this.handing.size) await Promise.all([...this.handing]);
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
/** A card's text as its message shows it: in full when it fits, else cut with a pointer to the page. */
function cardDetails(body: string): string {
  const max = hasTable(body) ? MARKDOWN_MAX : SECTION_MAX;
  return body.length > max ? `${body.slice(0, max - 200)}…\n_Full text on the Approvals page._` : body;
}

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
