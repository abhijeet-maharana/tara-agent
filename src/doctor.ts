import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HostConfig, Project } from './config/schema.js';
import { missingServices } from './scheduler/gate.js';

/**
 * `tara-agent doctor`: one look at everything, for a person at a terminal. Offline: the config, each
 * job's skill and its `## Job` section, and the services jobs `require`. Then the running tara-agent's
 * own Health checks (`GET /health/checks`), so problems only the live process sees are listed too.
 */

export type Mark = 'ok' | 'warn' | 'bad';
export interface DoctorLine {
  mark: Mark;
  area: string;
  text: string;
}

export interface DoctorDeps {
  host: HostConfig;
  projects: Project[];
  /** Each project's jobs as loaded (`loadJobs`), or the error that stopped them loading. */
  jobs: (
    p: Project,
  ) => Array<{ job: { id: string; skills: string[]; enabled: boolean; requires?: string[] } }>;
  probe?: (url: string) => Promise<boolean>;
  fetch?: typeof fetch;
}

/** The first skill's `## Job` section is where a job's instructions live. */
function skillProblem(dir: string, skill: string, first: boolean): string | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(dir, '.claude', 'skills', skill, 'SKILL.md'), 'utf8');
  } catch {
    return `skill "${skill}" not found (.claude/skills/${skill}/SKILL.md)`;
  }
  if (first && !/^## Job\b/m.test(text)) return `skill "${skill}" has no "## Job" section`;
  return undefined;
}

/** Every file under `dir` (relative paths), leaving out caches. */
function filesUnder(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    if (e.name === '__pycache__' || e.name === '.DS_Store' || e.name === 'node_modules') return [];
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, child) : [child];
  });
}

/**
 * Shared skills: a skill folder with a `SHARED` file is vendored into several projects and must be the
 * same in each. Lines of `SHARED` that name a file or folder in the skill are that project's own (e.g.
 * its voice samples) and are not compared. Returns one line per shared skill.
 */
export function sharedSkills(projects: Project[]): DoctorLine[] {
  const copies = new Map<string, Array<{ project: string; dir: string; own: Set<string> }>>();
  for (const p of projects) {
    const root = path.join(p.dir, '.claude', 'skills');
    if (!existsSync(root)) continue;
    for (const skill of readdirSync(root)) {
      const dir = path.join(root, skill);
      let marker: string;
      try {
        marker = readFileSync(path.join(dir, 'SHARED'), 'utf8');
      } catch {
        continue;
      }
      const own = new Set(
        marker
          .split('\n')
          .map((l) => l.trim().replace(/\/+$/, ''))
          .filter((l) => l && !/\s/.test(l) && existsSync(path.join(dir, l))),
      );
      copies.set(skill, [...(copies.get(skill) ?? []), { project: p.config.name, dir, own }]);
    }
  }
  const out: DoctorLine[] = [];
  for (const [skill, list] of copies) {
    if (list.length < 2) {
      out.push({
        mark: 'ok',
        area: 'skills',
        text: `shared skill "${skill}" is only in ${list[0]?.project}`,
      });
      continue;
    }
    const shared = (c: (typeof list)[number]) =>
      filesUnder(c.dir).filter((f) => ![...c.own].some((o) => f === o || f.startsWith(`${o}/`)));
    const [first, ...rest] = list as [(typeof list)[number], ...typeof list];
    const base = new Map(shared(first).map((f) => [f, readFileSync(path.join(first.dir, f))]));
    const differs = new Set<string>();
    for (const c of rest) {
      const files = shared(c);
      for (const f of new Set([...files, ...base.keys()])) {
        const mine = files.includes(f) ? readFileSync(path.join(c.dir, f)) : undefined;
        const theirs = base.get(f);
        if (!mine || !theirs || !mine.equals(theirs)) differs.add(f);
      }
    }
    const who = list.map((c) => c.project).join(', ');
    out.push(
      differs.size
        ? {
            mark: 'warn',
            area: 'skills',
            text: `shared skill "${skill}" differs between ${who}: ${[...differs].sort().slice(0, 5).join(', ')}${differs.size > 5 ? ', …' : ''}. Port the change to every copy`,
          }
        : { mark: 'ok', area: 'skills', text: `shared skill "${skill}" is the same in ${who}` },
    );
  }
  return out;
}

export async function doctor(d: DoctorDeps): Promise<DoctorLine[]> {
  const out: DoctorLine[] = [];
  const add = (mark: Mark, area: string, text: string) => out.push({ mark, area, text });

  add('ok', 'config', `host config OK (timezone ${d.host.timezone}, ${d.projects.length} projects)`);
  const urls = new Map<string, string[]>();
  for (const p of d.projects) {
    const name = p.config.name;
    let jobs: ReturnType<DoctorDeps['jobs']>;
    try {
      jobs = d.jobs(p);
    } catch (err) {
      add('bad', name, `jobs file: ${(err as Error).message}`);
      continue;
    }
    const enabled = jobs.filter((j) => j.job.enabled);
    const problems: string[] = [];
    for (const { job } of enabled) {
      job.skills.forEach((s, i) => {
        const why = skillProblem(p.dir, s, i === 0);
        if (why) problems.push(`${job.id}: ${why}`);
      });
      for (const u of job.requires ?? []) urls.set(u, [...(urls.get(u) ?? []), `${name}/${job.id}`]);
    }
    if (problems.length) for (const pr of problems) add('bad', name, pr);
    else add('ok', name, `${enabled.length}/${jobs.length} jobs enabled, every skill found`);
  }

  out.push(...sharedSkills(d.projects));

  if (urls.size) {
    const down = new Set(await missingServices([...urls.keys()], d.probe));
    for (const [u, users] of urls)
      add(
        down.has(u) ? 'bad' : 'ok',
        'services',
        `${u} ${down.has(u) ? 'NOT answering' : 'answers'} (${users.join(', ')})`,
      );
  }

  if (d.host.http.enabled) {
    const base = `http://${d.host.http.bind === '0.0.0.0' ? '127.0.0.1' : d.host.http.bind}:${d.host.http.port}`;
    try {
      const res = await (d.fetch ?? fetch)(`${base}/health/checks`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { checks } = (await res.json()) as {
        checks: Array<{ status: 'ok' | 'warn' | 'bad'; group: string; name: string; detail: string }>;
      };
      const notOk = checks.filter((c) => c.status !== 'ok');
      add(
        'ok',
        'running',
        `tara-agent answers at ${base}: ${checks.length - notOk.length} of ${checks.length} health checks fine`,
      );
      for (const c of notOk.sort((a, b) => (a.status === b.status ? 0 : a.status === 'bad' ? -1 : 1)))
        add(c.status, c.group, `${c.name}: ${c.detail}`);
    } catch (err) {
      add('bad', 'running', `tara-agent is not answering at ${base} (${(err as Error).message})`);
    }
  }
  return out;
}

const ICON: Record<Mark, string> = { ok: '✓', warn: '⚠', bad: '✗' };

/** Lines for a terminal, and the exit code: 1 when anything is red. */
export function formatDoctor(lines: DoctorLine[]): { text: string; code: number } {
  const bad = lines.filter((l) => l.mark === 'bad').length;
  const warn = lines.filter((l) => l.mark === 'warn').length;
  const text = [
    ...lines.map((l) => `${ICON[l.mark]} ${l.area}: ${l.text}`),
    '',
    bad || warn ? `${bad} problem${bad === 1 ? '' : 's'}, ${warn} to look at` : 'All fine.',
  ].join('\n');
  return { text, code: bad ? 1 : 0 };
}
