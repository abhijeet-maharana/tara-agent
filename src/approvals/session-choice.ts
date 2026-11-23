import type { Item, SessionMode, SessionRow, ThreadState } from '../store/store.js';

/**
 * Where a decision on a card is acted on, and why: the advice the card shows (Approvals page and Slack
 * alike), which a person can override.
 *   new       a fresh session acts on it in a new `Run` thread, from the card's handoff notes and the
 *             project memory
 *   continue  the session that raised the card resumes in its own thread
 */
export interface SessionChoice {
  mode: SessionMode;
  /** The other mode, when this card can use it too (a person can pick it instead). */
  alternative?: SessionMode;
  /** One short line: what the advice rests on ("small session: 34k tokens, 2 turns"). */
  why: string;
}

/** A session's context this large (tokens) is worth leaving behind: a fresh one is cheaper and sharper. */
export const CONTEXT_LARGE = 100_000;
/** A thread with this many turns has moved on from the card's work. */
export const TURNS_MANY = 8;
/** A session idle this long has gone cold: its prompt cache is gone and the world has moved on. */
export const IDLE_LONG_MS = 3 * 86_400_000;

const tokens = (n: number) => (n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n));
const days = (ms: number) => `${Math.round(ms / 86_400_000)} days`;

/**
 * The advice for a waiting card, or undefined when it has no choice to make: drafts (they run in their
 * queue) and cards with nothing to act on. A card can start a fresh session only with handoff notes
 * (without them a fresh session would not know what to do, e.g. an OTP for a login open in the run's
 * browser) and when it is not a root action (its result goes back to the run that asked). It can
 * continue only when it has a thread whose session the CLI has started.
 */
export function sessionChoice(
  item: Pick<Item, 'mode' | 'handoff' | 'threadTs' | 'kind'>,
  session: Pick<SessionRow, 'started'> | undefined,
  state: ThreadState | undefined,
  now: number,
  opts: { rootAction?: boolean } = {},
): SessionChoice | undefined {
  if (item.mode !== 'resume' || item.kind === 'notice') return undefined;
  const canNew = Boolean(item.handoff?.trim()) && !opts.rootAction;
  const canContinue = Boolean(item.threadTs && session?.started);
  if (!canNew && !canContinue) return undefined;
  if (!canContinue) return { mode: 'new', why: 'the run that asked has no session to continue' };
  if (!canNew)
    return {
      mode: 'continue',
      why: opts.rootAction
        ? 'a root action reports back to the run that asked'
        : 'no handoff notes, so only the run that asked knows what to do',
    };
  const size = state?.contextTokens;
  const turns = state?.turns ?? 0;
  const idle = state ? now - state.lastAt : 0;
  const both = (mode: SessionMode, why: string): SessionChoice => ({
    mode,
    alternative: mode === 'new' ? 'continue' : 'new',
    why,
  });
  if (size !== undefined && size >= CONTEXT_LARGE)
    return both('new', `large context (${tokens(size)} tokens)`);
  if (turns >= TURNS_MANY) return both('new', `long thread (${turns} turns)`);
  if (idle >= IDLE_LONG_MS) return both('new', `session idle for ${days(idle)}`);
  if (!state) return both('continue', 'follow-up to the run that asked, still small');
  const facts = [
    size !== undefined ? `${tokens(size)} tokens` : '',
    `${turns} ${turns === 1 ? 'turn' : 'turns'}`,
  ]
    .filter(Boolean)
    .join(', ');
  return both('continue', `follow-up in a small session (${facts})`);
}

/** The card's line about it: "Upon approval, a new session will be created · large context (140k tokens)". */
export function choiceLine(choice: SessionChoice): string {
  const what =
    choice.mode === 'new' ? 'a new session will be created' : 'this will continue in the existing session';
  return `Upon approval, ${what} · ${choice.why}`;
}
