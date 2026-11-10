/**
 * Tidies the shared browser after a job that held its lock: every tab the run opened, or moved to
 * another page, is closed, so the next run starts clean and no logged-in page is left open. Uses
 * Chrome's DevTools HTTP endpoints (`/json/list`, `/json/close`, `/json/new`); never rejects.
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

/**
 * Closes the tabs that are new since `before`, or show another page than they did then. Leaves one
 * new-tab page when that would close them all (Chrome quits with its last window). Returns how many
 * it closed; problems go to `warn`.
 */
export async function closeRunTabs(
  cdpUrl: string,
  before: Tabs,
  warn: (message: string) => void,
): Promise<number> {
  const now = await openTabs(cdpUrl);
  if (!now) return 0;
  const used = [...now].filter(([id, url]) => before.get(id) !== url).map(([id]) => id);
  if (used.length === 0) return 0;
  try {
    if (used.length === now.size) await call(`${cdpUrl}/json/new?chrome://newtab/`, 'PUT');
  } catch (err) {
    warn(`Browser: could not open a blank tab before closing the run's tabs (${(err as Error).message})`);
    return 0; // closing every tab would quit Chrome
  }
  let closed = 0;
  for (const id of used) {
    try {
      if ((await call(`${cdpUrl}/json/close/${id}`)).ok) closed++;
    } catch (err) {
      warn(`Browser: could not close tab ${id} (${(err as Error).message})`);
    }
  }
  return closed;
}
