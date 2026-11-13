/**
 * Tidies the shared browsers. Jobs and chats share a Chrome without locks: each run opens its own tab
 * and closes it (the tab-ownership hook keeps it off the others'), and `TabSweeper` closes what is left
 * behind. Uses Chrome's DevTools HTTP endpoints (`/json/list`, `/json/close`, `/json/new`); never rejects.
 */

interface Target {
  id: string;
  type: string;
  url: string;
}

/** The page tabs open now (id → url), or undefined when the browser doesn't answer. */
export type Tabs = Map<string, string>;

const TIMEOUT_MS = 3_000;

async function call(url: string, method = 'GET'): Promise<Response> {
  return fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

export async function openTabs(cdpUrl: string): Promise<Tabs | undefined> {
  try {
    const res = await call(`${cdpUrl}/json/list`);
    if (!res.ok) return undefined;
    const targets = (await res.json()) as Target[];
    return new Map(targets.filter((t) => t.type === 'page').map((t) => [t.id, t.url]));
  } catch {
    return undefined;
  }
}

/** A page's address without query or fragment, so `?x=1` or `#top` added by a page still matches. */
function pageKey(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * The tab addresses a project asks to keep open (`keepTabsUrl`): GET → a JSON list of `{url}` or
 * strings, bare or under `result`. Undefined when it doesn't answer: then nothing is closed, since a
 * tab someone is waiting on may be among them.
 */
export async function keptTabUrls(url: string): Promise<string[] | undefined> {
  try {
    const res = await call(url);
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    const list = Array.isArray(body) ? body : (body as { result?: unknown })?.result;
    if (!Array.isArray(list)) return undefined;
    return list
      .map((e) => (typeof e === 'string' ? e : (e as { url?: unknown })?.url))
      .filter((u): u is string => typeof u === 'string');
  } catch {
    return undefined;
  }
}

/** Blank pages: one is kept so Chrome never loses its last window. */
const BLANK = /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank)$/;

export interface SweptBrowser {
  cdpUrl: string;
  /** Tabs older than this are stale, unless a run that is still going may own them. */
  staleMs: number;
  /** The projects whose runs drive it (their `.mcp.json` points at `cdpUrl`). */
  projects: string[];
  /** Their `keepTabsUrl`s: tabs at these addresses are never closed. */
  keepUrls: string[];
}

export interface TabSweeperDeps {
  browsers: () => SweptBrowser[];
  /** When the oldest run (job or chat) of these projects that is still going started, if any. */
  oldestRun: (projects: string[]) => number | undefined;
  now?: () => number;
  log: (message: string) => void;
}

/**
 * Closes stale tabs: open for longer than `staleMs` and since before every run still going in that
 * browser started (so no live run can own them), except kept ones (`keepTabsUrl`). Tab ages are counted
 * from when the sweeper first saw them, so a restart starts every tab's clock again.
 */
export class TabSweeper {
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(private readonly deps: TabSweeperDeps) {}

  async sweep(): Promise<number> {
    let closed = 0;
    for (const b of this.deps.browsers()) closed += await this.sweepOne(b);
    return closed;
  }

  private async sweepOne(b: SweptBrowser): Promise<number> {
    const now = (this.deps.now ?? Date.now)();
    const tabs = await openTabs(b.cdpUrl);
    if (!tabs) return 0;
    const before = this.seen.get(b.cdpUrl) ?? new Map<string, number>();
    const seen = new Map([...tabs.keys()].map((id) => [id, before.get(id) ?? now]));
    this.seen.set(b.cdpUrl, seen);
    const oldest = this.deps.oldestRun(b.projects);
    const stale = [...tabs].filter(([id]) => {
      const first = seen.get(id) as number;
      return now - first >= b.staleMs && (oldest === undefined || first < oldest);
    });
    if (stale.length === 0) return 0;
    const keep: string[] = [];
    for (const url of b.keepUrls) {
      const list = await keptTabUrls(url);
      if (!list) {
        this.deps.log(`Browser ${b.cdpUrl}: ${url} did not answer, so no tab was closed`);
        return 0;
      }
      keep.push(...list);
    }
    const kept = new Set(keep.map(pageKey).filter(Boolean));
    let close = stale.filter(([, url]) => !kept.has(pageKey(url)));
    if (close.length === tabs.size) {
      // Chrome quits with its last window: leave one blank page, or open one.
      const blank = close.find(([, url]) => BLANK.test(url));
      if (blank) close = close.filter((t) => t !== blank);
      else
        try {
          await call(`${b.cdpUrl}/json/new?chrome://newtab/`, 'PUT');
        } catch (err) {
          this.deps.log(`Browser ${b.cdpUrl}: could not open a blank tab (${(err as Error).message})`);
          return 0;
        }
    }
    let closed = 0;
    for (const [id, url] of close) {
      try {
        if ((await call(`${b.cdpUrl}/json/close/${id}`)).ok) {
          closed++;
          seen.delete(id);
          this.deps.log(`Browser ${b.cdpUrl}: closed a stale tab (${url.slice(0, 120)})`);
        }
      } catch (err) {
        this.deps.log(`Browser ${b.cdpUrl}: could not close tab ${id} (${(err as Error).message})`);
      }
    }
    return closed;
  }
}
