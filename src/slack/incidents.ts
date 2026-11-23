import type { ChatPort, Logger } from '../sessions/manager.js';

/**
 * Trouble that fails every run at once (a usage limit, an expired login): one Slack message per channel
 * and incident, edited as more runs hit it, instead of one failure post per run. It closes (its message
 * says so) once a run on the same CLI works again, or after `OPEN_MS` without a new hit; the next hit
 * then starts a new message.
 */
export type IncidentKind = 'limit' | 'login';

export interface Incident {
  kind: IncidentKind;
  /** The CLI it hit: `claude` or `agy`. */
  harness: string;
  /** What the CLI said, e.g. "You've hit your weekly limit · resets Nov 22, 3:30pm". */
  detail: string;
}

/** Errors that mean the CLI isn't logged in (or its login ran out), not that the run went wrong. */
const LOGIN_ERROR =
  /failed to authenticate|oauth (?:session|token)[^.]*expired|not logged in|please run \/login|invalid api key|authentication_error/i;
/** An incident with no new hit for this long is over. */
export const OPEN_MS = 12 * 3_600_000;
/** Runs named in the message; the rest are counted. */
const NAMES_SHOWN = 12;

/** The host-wide trouble a finished run hit, if any. */
export function incidentOf(
  outcome: { status: string; error?: string },
  harness: string,
): Incident | undefined {
  const detail = (outcome.error ?? '').split('\n')[0]?.trim().slice(0, 200) ?? '';
  if (outcome.status === 'limit') return { kind: 'limit', harness, detail };
  if (outcome.status === 'error' && LOGIN_ERROR.test(outcome.error ?? ''))
    return { kind: 'login', harness, detail };
  return undefined;
}

interface Open {
  channel: string;
  /** The message's ts; a promise, so runs failing at the same moment share one message. */
  ts: Promise<string | undefined>;
  incident: Incident;
  runs: string[];
  lastAt: number;
}

export interface IncidentsDeps {
  chat: Pick<ChatPort, 'post' | 'update'>;
  log: Logger;
  /** The machine to log in on, as `ssh` reaches it (e.g. "jarvis"). */
  host: string;
  /** The user the runs' CLI is logged in as (`claude.runAs`). */
  runAs?: string;
  now?: () => number;
}

export class Incidents {
  private readonly open = new Map<string, Open>();
  private readonly now: () => number;

  constructor(private readonly deps: IncidentsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Adds a run (by its name) to the channel's open incident of this kind, or opens one. */
  async report(channel: string, incident: Incident, run: string): Promise<void> {
    const key = `${channel}:${incident.kind}:${incident.harness}`;
    const at = this.now();
    let open = this.open.get(key);
    if (open && at - open.lastAt > OPEN_MS) {
      this.open.delete(key);
      open = undefined;
    }
    if (!open) {
      const fresh: Open = { channel, ts: Promise.resolve(undefined), incident, runs: [run], lastAt: at };
      fresh.ts = this.deps.chat.post(channel, undefined, this.text(fresh)).catch((err: Error) => {
        this.deps.log.warn(`incident not posted in Slack: ${err.message}`);
        return undefined;
      });
      this.open.set(key, fresh);
      // Not posted (Slack down): forget it, so the next failed run tries again instead of editing nothing.
      if (!(await fresh.ts) && this.open.get(key) === fresh) this.open.delete(key);
      return;
    }
    if (!open.runs.includes(run)) open.runs.push(run);
    open.lastAt = at;
    if (incident.detail) open.incident = incident;
    await this.edit(open, this.text(open));
  }

  /** A run on this CLI worked: its open incidents are over, and their messages say so. */
  async resolve(harness: string): Promise<void> {
    for (const [key, open] of this.open) {
      if (open.incident.harness !== harness) continue;
      this.open.delete(key);
      await this.edit(open, `${this.text(open)}\n✅ _Over: runs work again._`);
    }
  }

  private async edit(open: Open, text: string): Promise<void> {
    const ts = await open.ts;
    if (!ts) return;
    await this.deps.chat
      .update(open.channel, ts, text)
      .catch((err: Error) => this.deps.log.warn(`incident message not updated: ${err.message}`));
  }

  /** The message: what happened, what it said, what to do, and the runs it hit. */
  text(open: Pick<Open, 'incident' | 'runs'>): string {
    const { incident, runs } = open;
    const cli = incident.harness === 'agy' ? 'agy (Google)' : 'Claude';
    const user = this.deps.runAs ?? 'tara';
    const lines =
      incident.kind === 'limit'
        ? [`⏸ *${cli} usage limit reached*: runs are skipped until it resets.`]
        : [
            `🔑 *${cli} login failed*: runs can't start until it is logged in again.`,
            incident.harness === 'agy'
              ? `Fix: sign in to agy again as \`${user}\` on ${this.deps.host}.`
              : `Fix: \`ssh -t ${this.deps.host} sudo -u ${user} -i claude auth login\`, then open the link it prints.`,
          ];
    if (incident.detail) lines.push(`> ${incident.detail}`);
    const shown = runs.slice(0, NAMES_SHOWN).join(', ');
    const more = runs.length > NAMES_SHOWN ? ` and ${runs.length - NAMES_SHOWN} more` : '';
    lines.push(`_${incident.kind === 'limit' ? 'Skipped' : 'Failed'} (${runs.length}):_ ${shown}${more}`);
    return lines.join('\n');
  }
}
