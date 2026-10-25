import path from 'node:path';
import type { JobsFile } from './config/schema.js';

/** The fields tara-agent reads from a Hermes Agent cron job definition. */
interface HermesJob {
  name: string;
  schedule: string | { expr?: string };
  prompt?: string;
  skills?: string[] | string | null;
  skill?: string | null;
  script?: string | null;
  model?: string | null;
  enabled?: boolean;
  enabled_toolsets?: string[] | null;
}

export interface ImportOptions {
  /** Where the Hermes pre-run scripts live, relative to the repo root. */
  scriptsDir: string;
  /** Model for jobs that used Hermes' cron default (no pinned model). */
  defaultModel: string;
  /** Timezone the Hermes cron expressions are written in (Hermes runs in UTC by default). */
  tz: string;
  env: Record<string, string>;
}

type ImportedJob = JobsFile['jobs'][number];

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'job'
  );
}

function model(hermes: string | null | undefined, fallback: string): string {
  if (!hermes) return fallback;
  for (const family of ['opus', 'sonnet', 'haiku']) if (hermes.includes(family)) return family;
  return hermes;
}

/** No toolset list means every tool, including the browser; an explicit list may leave it out. */
function usesBrowser(toolsets: string[] | null | undefined): boolean {
  return !toolsets || toolsets.some((t) => /chrome|browser/.test(t));
}

/** Converts Hermes `jobs.json` / `jobs.definitions.json` content into a tara-agent jobs file. */
export function convertHermesJobs(source: unknown, options: ImportOptions): JobsFile {
  const list = (Array.isArray(source) ? source : (source as { jobs?: unknown })?.jobs) as
    | HermesJob[]
    | undefined;
  if (!Array.isArray(list))
    throw new Error('Expected a list of Hermes jobs (or an object with a "jobs" list)');

  const ids = new Set<string>();
  const jobs = list.map((h): ImportedJob => {
    let id = slug(h.name);
    for (let n = 2; ids.has(id); n++) id = `${slug(h.name)}-${n}`;
    ids.add(id);
    const cron = typeof h.schedule === 'string' ? h.schedule : h.schedule?.expr;
    if (!cron) throw new Error(`Hermes job "${h.name}" has no cron expression`);
    const skills = Array.isArray(h.skills) ? h.skills : h.skills ? [h.skills] : h.skill ? [h.skill] : [];
    const browser = usesBrowser(h.enabled_toolsets);
    return {
      id,
      name: h.name,
      cron,
      tz: options.tz,
      prompt: h.prompt ?? '',
      skills: skills.filter(Boolean),
      ...(h.script ? { preScript: path.posix.join(options.scriptsDir, h.script) } : {}),
      agent: true,
      model: model(h.model, options.defaultModel),
      locks: browser ? ['chrome'] : [],
      timeoutMinutes: browser ? 40 : 30,
      catchUp: true,
      env: {},
      enabled: h.enabled !== false,
    };
  });
  return { env: options.env, jobs };
}
