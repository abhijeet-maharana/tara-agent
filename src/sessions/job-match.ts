/** The bits of a job the matcher needs. */
export interface JobRef {
  id: string;
  name: string;
}

export type JobMatch<J extends JobRef> = { job: J } | { choices: J[] };

/** "run …", "please start the …", "trigger … now". Anything else is left to Claude. */
const REQUEST = /^\s*(?:please\s+|pls\s+)?(?:run|start|trigger)\s+(.+?)\s*[.!?]*\s*$/i;
const FILLER = new Set(['the', 'a', 'an', 'job', 'cron', 'now', 'please', 'pls', 'again', 'for', 'me']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !FILLER.has(w));
}

/**
 * Matches a plain-language "run <job name>" message against a channel's jobs, without a model:
 * an exact name or id wins; otherwise every word of the request must start a word of the job's
 * name or id ("run amazon sla" → "Amazon Order SLA Report"). Returns null when the message isn't a
 * run request or no job fits, so it can go to Claude as a normal message.
 */
export function matchJob<J extends JobRef>(text: string, jobs: J[]): JobMatch<J> | null {
  const request = REQUEST.exec(text);
  if (!request?.[1]) return null;
  const wanted = words(request[1]);
  if (wanted.length === 0) return null;
  const phrase = wanted.join(' ');

  const exact = jobs.filter((j) => words(j.name).join(' ') === phrase || j.id === wanted.join('-'));
  if (exact.length === 1) return { job: exact[0] as J };

  const fits = jobs.filter((j) => {
    const own = new Set([...words(j.name), ...j.id.split('-')]);
    return wanted.every((w) => [...own].some((o) => o === w || (w.length >= 3 && o.startsWith(w))));
  });
  if (fits.length === 1) return { job: fits[0] as J };
  if (fits.length > 1) return { choices: fits.slice(0, 8) };
  return null;
}
