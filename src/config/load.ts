import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  type HostConfig,
  hostConfigSchema,
  jobsFileSchemaFor,
  PINNED_PROJECT_KEYS,
  type Project,
  projectConfigSchema,
  type QueueConfig,
  queuesFileSchema,
  type ScheduledJob,
} from './schema.js';

export const DEFAULT_HOST_CONFIG = path.join(homedir(), '.config', 'tara-agent', 'config.yaml');
export const PROJECT_CONFIG = path.join('.tara', 'config.json');
export const JOBS_FILE = path.join('.tara', 'jobs.json');
export const QUEUES_FILE = path.join('.tara', 'queues.json');

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

function parseWith<S extends z.ZodType>(schema: S, data: unknown, source: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid config in ${source}:\n${issues.join('\n')}`);
  }
  return result.data;
}

function readText(file: string, what: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${what} at ${file}: ${(err as Error).message}`);
  }
}

export function loadHostConfig(file = DEFAULT_HOST_CONFIG): HostConfig {
  const config = parseWith(hostConfigSchema, parseYaml(readText(file, 'host config')), file);
  return {
    ...config,
    projects: config.projects.map((p) => path.resolve(expandHome(p))),
    code: {
      ...config.code,
      repos: config.code.repos?.map((r) => ({
        ...r,
        path: path.resolve(expandHome(r.path)),
        gitDir: r.gitDir && path.resolve(expandHome(r.gitDir)),
      })),
    },
    stateDir: path.resolve(expandHome(config.stateDir ?? '~/.local/state/tara-agent')),
  };
}

export function loadProject(dir: string, trusted?: HostConfig['trusted'][string]): Project {
  const file = path.join(dir, PROJECT_CONFIG);
  let json: unknown;
  try {
    json = JSON.parse(readText(file, 'project config'));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}: ${err.message}`);
    throw err;
  }
  // Pinned by the host: those keys come from the host config only, whatever the repo says.
  const pinDrift: string[] = [];
  if (trusted && json && typeof json === 'object') {
    const repo = json as Record<string, unknown>;
    for (const key of PINNED_PROJECT_KEYS) {
      if (key in repo && JSON.stringify(repo[key]) !== JSON.stringify(trusted[key])) pinDrift.push(key);
      delete repo[key];
      if (trusted[key] !== undefined) repo[key] = trusted[key];
    }
  }
  const config = parseWith(projectConfigSchema, json, trusted ? `${file} (with host trusted)` : file);
  const systemPrompt = config.systemPromptFile
    ? readText(insideRepo(dir, config.systemPromptFile, 'systemPromptFile'), 'system prompt file')
    : undefined;
  return {
    dir,
    config,
    systemPrompt,
    ...(trusted && { trusted: { executorUrls: trusted.executorUrls } }),
    ...(pinDrift.length && { pinDrift }),
  };
}

/**
 * A file the repo's config names, resolved (symlinks too) and required to be a regular file inside the
 * repo. Runs can edit `.tara/config.json`, and tara-agent reads the file with its own rights: without
 * this, `"../../proc/self/environ"` would put tara-agent's secrets into every system prompt.
 */
function insideRepo(dir: string, relative: string, key: string): string {
  const wanted = path.resolve(dir, relative);
  let real: string;
  let root: string;
  try {
    real = realpathSync(wanted);
    root = realpathSync(dir);
  } catch {
    return wanted; // missing: readText says so
  }
  if (!real.startsWith(root + path.sep) || !statSync(real).isFile())
    throw new Error(`${key} "${relative}" must be a file inside ${dir}`);
  return real;
}

/**
 * Loads every project. With `onBroken`, a project whose config doesn't load is left out and reported
 * there, so one bad `.tara/config.json` (runs can edit it) doesn't stop the other projects; without it
 * (`validate`) the first error throws.
 */
export function loadProjects(host: HostConfig, onBroken?: (dir: string, err: Error) => void): Project[] {
  const projects = host.projects.flatMap((dir) => {
    const trusted = host.trusted[dir] ?? host.trusted[dir.replace(/\/+$/, '')];
    if (!onBroken) return [loadProject(dir, trusted)];
    try {
      return [loadProject(dir, trusted)];
    } catch (err) {
      onBroken(dir, err as Error);
      return [];
    }
  });
  for (const key of ['name', 'slackChannel'] as const) {
    const seen = new Map<string, string>();
    for (const p of projects) {
      const other = seen.get(p.config[key]);
      if (other) throw new Error(`Projects ${other} and ${p.dir} share the same ${key} "${p.config[key]}"`);
      seen.set(p.config[key], p.dir);
    }
  }
  return projects;
}

/** Jobs of one project, or none when it has no `.tara/jobs.json`. Throws on an invalid file. */
export function loadJobs(project: Project): ScheduledJob[] {
  const file = path.join(project.dir, JOBS_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const jobsFile = parseWith(jobsFileSchemaFor(project.config.words), json, file);
  const expand = (env: Record<string, string>) =>
    Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandHome(v)]));
  return jobsFile.jobs.map((job) => ({
    project,
    job: { ...job, tz: job.tz ?? jobsFile.tz },
    env: { ...expand(jobsFile.env), ...expand(job.env) },
  }));
}

/** Queues of one project, or none when it has no `.tara/queues.json`. Throws on an invalid file. */
export function loadQueues(project: Project): Record<string, QueueConfig> {
  const file = path.join(project.dir, QUEUES_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const queues = parseWith(queuesFileSchema, json, file).queues;
  // A pinned project's queues send approved items only to the URLs the host lists; any other URL
  // executor is turned off (its items wait) rather than trusted.
  if (project.trusted)
    for (const [name, queue] of Object.entries(queues))
      if ('url' in queue.executor && !project.trusted.executorUrls.includes(queue.executor.url))
        throw new Error(
          `Queue "${name}" in ${file} sends to ${queue.executor.url}, which host trusted.executorUrls doesn't list`,
        );
  return queues;
}
