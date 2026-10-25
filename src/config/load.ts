import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  type HostConfig,
  hostConfigSchema,
  jobsFileSchema,
  type Project,
  projectConfigSchema,
  type ScheduledJob,
} from './schema.js';

export const DEFAULT_HOST_CONFIG = path.join(homedir(), '.config', 'tara-agent', 'config.yaml');
export const PROJECT_CONFIG = path.join('.tara', 'config.json');
export const JOBS_FILE = path.join('.tara', 'jobs.json');

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
    stateDir: path.resolve(expandHome(config.stateDir ?? '~/.local/state/tara-agent')),
  };
}

export function loadProject(dir: string): Project {
  const file = path.join(dir, PROJECT_CONFIG);
  let json: unknown;
  try {
    json = JSON.parse(readText(file, 'project config'));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}: ${err.message}`);
    throw err;
  }
  const config = parseWith(projectConfigSchema, json, file);
  const systemPrompt = config.systemPromptFile
    ? readText(path.join(dir, config.systemPromptFile), 'system prompt file')
    : undefined;
  return { dir, config, systemPrompt };
}

export function loadProjects(host: HostConfig): Project[] {
  const projects = host.projects.map(loadProject);
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
  const jobsFile = parseWith(jobsFileSchema, json, file);
  const expand = (env: Record<string, string>) =>
    Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandHome(v)]));
  return jobsFile.jobs.map((job) => ({ project, job, env: { ...expand(jobsFile.env), ...expand(job.env) } }));
}
