import type { ChatPort, Logger } from '../sessions/manager.js';
import type { Store } from '../store/store.js';
import type { ClaudeLogin } from './claude-login.js';
import { ago } from './monitor.js';

const DAY = 86_400_000;
/** The reminder starts this long before the login ends. */
export const REMIND_BEFORE_MS = 3 * DAY;
/** The day's reminder goes out from this hour (host timezone), not in the night. */
const FROM_HOUR = 9;

export interface LoginReminderDeps {
  login: () => Promise<ClaudeLogin | undefined>;
  store: Pick<Store, 'dayThread' | 'saveDayThread'>;
  chat: Pick<ChatPort, 'post'>;
  /** Where it goes: a project's Slack channel and who to mention. */
  target: () => { channel: string; owner?: string } | undefined;
  /** The machine to log in on, as `ssh` reaches it (e.g. "jarvis"). */
  host: string;
  timeZone: string;
  log: Logger;
  now?: () => number;
}

/**
 * Reminds the owner in Slack to log the runs' Claude in again: once a day (from 09:00) from 3 days
 * before the login ends, and every day after it ended or while it is logged out, with the steps. Stops
 * by itself once the login is renewed. One top-level message a day, so it notifies.
 */
export class LoginReminder {
  private readonly now: () => number;

  constructor(private readonly deps: LoginReminderDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Posts today's reminder if one is due and not posted yet; returns whether it posted. */
  async tick(): Promise<boolean> {
    const { deps } = this;
    const at = this.now();
    const login = await deps.login().catch(() => undefined);
    if (!login || login.error) return false;
    const left = login.loggedIn ? (login.endsAt === undefined ? Infinity : login.endsAt - at) : 0;
    if (left > REMIND_BEFORE_MS) return false;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: deps.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
    // Not in the night, unless it ends before the morning.
    if (Number(parts.hour) < FROM_HOUR && left > 12 * 3_600_000) return false;
    const key = `claude-login-reminder:${parts.year}-${parts.month}-${parts.day}`;
    if (deps.store.dayThread(key)) return false;
    const target = deps.target();
    if (!target) return false;
    try {
      const ts = await deps.chat.post(target.channel, undefined, this.text(login, left, target.owner));
      deps.store.saveDayThread(key, target.channel, ts);
      return true;
    } catch (err) {
      deps.log.warn(`Claude login reminder not posted: ${(err as Error).message}`);
      return false;
    }
  }

  text(login: ClaudeLogin, left: number, owner?: string): string {
    const user = login.user ?? 'tara';
    const when =
      login.endsAt &&
      new Intl.DateTimeFormat('en-GB', {
        timeZone: this.deps.timeZone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(login.endsAt);
    const head = !login.loggedIn
      ? `🔑 *Claude is logged out on ${this.deps.host}*: every job and chat fails until you log in.`
      : left <= 0
        ? `🔑 *Claude login on ${this.deps.host} ended ${ago(-left)} ago* (${when}): every job and chat fails until you log in.`
        : `🔑 *Claude login on ${this.deps.host} ends in ${ago(left)}* (${when}). After that every job and chat fails.`;
    return [
      `${owner ? `<@${owner}> ` : ''}${head}`,
      '',
      '*Steps* (about a minute):',
      `1. In a terminal on your Mac: \`ssh -t ${this.deps.host} sudo -u ${user} -i claude auth login\``,
      '2. Open the link it prints and sign in with the Claude account.',
      '3. Paste the code back into the terminal if it asks for one.',
      '',
      '_I remind you once a day until it is renewed; nothing to do here after that._',
    ].join('\n');
  }
}
