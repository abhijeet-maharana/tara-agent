#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { WebSocket } from 'ws';
import { Approvals } from './approvals/approvals.js';
import { Bridge } from './bridge/bridge.js';
import { codeReaders } from './code/repo.js';
import { DEFAULT_HOST_CONFIG, expandHome, loadHostConfig, loadJobs, loadProjects } from './config/load.js';
import { jobState } from './http/dashboard.js';
import { startHttpServer } from './http/server.js';
import { convertHermesJobs } from './import-hermes.js';
import { Activity } from './live/activity.js';
import { Alerts } from './live/alerts.js';
import { askProject } from './live/ask.js';
import { gatherAttention, githubPullRequests } from './live/attention.js';
import { LiveSession } from './live/session.js';
import type { JobSummary, LiveDeps, LiveState } from './live/tools.js';
import { Privileged } from './privileged/privileged.js';
import { resolveRunAs } from './runner/as-user.js';
import { type Runner, runClaude } from './runner/run.js';
import { sweepScratch } from './runner/workspace.js';
import { QueueWorker } from './scheduler/queues.js';
import { Scheduler } from './scheduler/scheduler.js';
import { runScript } from './scheduler/script.js';
import { type Logger, SessionManager } from './sessions/manager.js';
import { Threads } from './sessions/threads.js';
import { createSlackGateway } from './slack/app.js';
import { Store } from './store/store.js';

const log: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

const USAGE = `Usage:
  tara-agent [--config <file>]               run the gateway
  tara-agent validate [--config <file>]      check host, project and job config, then exit
  tara-agent import-hermes --from <hermes jobs json> --out <repo>/.tara/jobs.json
      [--scripts-dir .agents/hermes/cron/scripts] [--default-model haiku] [--tz UTC]
      [--env KEY=VALUE ...] [--force]`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

/** Checks the CLI starts, as the user runs will use (`claude.runAs`, through sudo). */
function claudeVersion(bin: string, runAs?: string): string {
  const [cmd, args] = runAs ? ['sudo', ['-n', '-u', runAs, '--', bin, '--version']] : [bin, ['--version']];
  try {
    return execFileSync(cmd as string, args as string[], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    throw new Error(
      `Cannot run "${bin} --version"${runAs ? ` as ${runAs} (check the sudoers rule)` : ''}. Install Claude Code and log in as ${runAs ?? 'this user'}.`,
    );
  }
}

function loadAll(configFlag: string | undefined) {
  const host = loadHostConfig(path.resolve(expandHome(configFlag ?? DEFAULT_HOST_CONFIG)));
  const projects = loadProjects(host);
  return { host, projects };
}

function validate(configFlag: string | undefined): void {
  const { host, projects } = loadAll(configFlag);
  for (const p of projects) {
    const jobs = loadJobs(p);
    const enabled = jobs.filter((j) => j.job.enabled).length;
    log.info(`✓ ${p.config.name} (${p.dir}): ${enabled}/${jobs.length} jobs enabled`);
  }
  log.info(`✓ config OK (timezone ${host.timezone}, jobConcurrency ${host.jobConcurrency})`);
}

function importHermes(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: 'string' },
      out: { type: 'string' },
      'scripts-dir': { type: 'string', default: '.agents/hermes/cron/scripts' },
      'default-model': { type: 'string', default: 'haiku' },
      tz: { type: 'string', default: 'UTC' },
      env: { type: 'string', multiple: true, default: [] },
      force: { type: 'boolean', default: false },
    },
  });
  if (!values.from || !values.out) throw new Error(USAGE);
  const out = path.resolve(expandHome(values.out));
  if (existsSync(out) && !values.force) throw new Error(`${out} exists; pass --force to overwrite it`);
  const env = Object.fromEntries(
    (values.env ?? []).map((pair) => {
      const i = pair.indexOf('=');
      if (i < 1) throw new Error(`--env expects KEY=VALUE, got "${pair}"`);
      return [pair.slice(0, i), pair.slice(i + 1)];
    }),
  );
  const result = convertHermesJobs(JSON.parse(readFileSync(path.resolve(expandHome(values.from)), 'utf8')), {
    scriptsDir: values['scripts-dir'] as string,
    defaultModel: values['default-model'] as string,
    tz: values.tz as string,
    env,
  });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  log.info(`Wrote ${result.jobs.length} jobs to ${out}`);
}

async function serve(configFlag: string | undefined) {
  const { host, projects } = loadAll(configFlag);
  log.info(`Claude Code: ${claudeVersion(host.claude.bin, host.claude.runAs)}`);
  for (const p of projects) {
    const { name, slackChannel, permissionMode, chatModel, billing } = p.config;
    log.info(`Project ${name}: ${p.dir} → ${slackChannel} (${permissionMode}, ${chatModel}, ${billing})`);
    if (permissionMode === 'bypassPermissions') {
      log.warn(
        `⚠️  ${name} runs with bypassPermissions: anyone who can post in its channel can run any command.`,
      );
    }
  }

  const store = new Store(path.join(host.stateDir as string, 'tara.db'));
  const runAs = host.claude.runAs ? resolveRunAs(host.claude.runAs) : undefined;
  if (runAs) log.info(`Claude runs as ${runAs.user} (${runAs.home})`);
  const threadUrl = (channel: string, ts: string) => {
    const base = slack.workspaceUrl();
    return base && `${base}archives/${channel}/p${ts.replace('.', '')}`;
  };
  // Every labelled run, live, for Command's Live tasks (and its Stop).
  const activity = new Activity({ threadUrl });
  const run: Runner = activity.wrap(runAs ? (o) => runClaude({ ...o, runAs }) : runClaude);
  let manager: SessionManager | undefined;
  let bridge: Bridge | undefined;
  const slack = createSlackGateway({
    botToken: requireEnv('SLACK_BOT_TOKEN'),
    appToken: requireEnv('SLACK_APP_TOKEN'),
    log,
    onMessage: (msg) => manager?.handle(msg) ?? Promise.resolve(),
    onButton: (tap) =>
      tap.actionId.startsWith('tara:runjob:')
        ? (manager?.runButton(tap) ?? Promise.resolve())
        : (bridge?.handleButton(tap) ?? Promise.resolve()),
    streaming: host.streaming,
    voice: host.voice && { ...host.voice, apiKey: process.env.TARA_VOICE_API_KEY || undefined },
  });
  // Root actions: the helper's allowlist is the source of truth; without it runs can only ask a person.
  const privileged = host.privileged ? new Privileged(host.privileged.command) : undefined;
  await privileged
    ?.load()
    .then((actions) => log.info(`Root actions: ${actions.map((a) => a.id).join(', ') || 'none'}`))
    .catch((err: Error) => log.warn(`Root actions are unavailable: ${err.message}`));
  const approvals = new Approvals({
    store,
    chat: slack.chat,
    log,
    projects,
    timeZone: host.timezone,
    sealKey: process.env.APPROVAL_SEAL_KEY || undefined,
    privileged,
  });
  if (!process.env.APPROVAL_SEAL_KEY) log.warn('APPROVAL_SEAL_KEY is not set: approved items are not sealed');
  // tara's MCP tools reach tara-agent through the local API, so they need it.
  if (host.http.enabled) {
    bridge = new Bridge({
      apiUrl: `http://${host.http.bind === '0.0.0.0' ? '127.0.0.1' : host.http.bind}:${host.http.port}`,
      chat: slack.chat,
      store,
      approvals,
      privileged,
      log,
      projects,
      timeZone: host.timezone,
      shareGid: runAs?.gid,
    });
  } else {
    log.warn('http is disabled: approval buttons, permission prompts and send_file are off');
  }
  // Chat turns and job runs share threads: one Claude session at a time per Slack thread.
  const threads = new Threads();
  const scheduler = new Scheduler({
    projects,
    host,
    store,
    chat: slack.chat,
    run,
    runScript: runAs ? (s, cwd, env, ms, signal) => runScript(s, cwd, env, ms, signal, runAs) : undefined,
    bridge,
    threads,
    log,
  });
  manager = new SessionManager({
    projects,
    host,
    store,
    chat: slack.chat,
    run,
    jobs: scheduler,
    threads,
    bridge,
    log,
  });
  if (bridge) {
    bridge.onDecision = (msg) => (manager as SessionManager).handle(msg);
    bridge.jobs = scheduler;
  }
  approvals.onChat = (msg) => (manager as SessionManager).handle(msg);
  approvals.onJob = (project, jobId, r) => scheduler.resume(project, jobId, r);
  const queues = new QueueWorker({
    projects,
    store,
    log,
    jobs: scheduler,
    timeZone: host.timezone,
    onFinished: (item) => approvals.finished(item),
  });
  /** A new thread in the project's channel, as if its owner had asked there; returns its link. */
  const startThread = async (name: string | undefined, title: string, prompt: string) => {
    const project = projects.find((p) => p.config.name === name);
    if (!project) throw new Error(`No project "${name}" to ask in`);
    const channel = project.config.slackChannel;
    const ts = await slack.chat.post(channel, undefined, title);
    const user = project.config.owner ?? project.config.allowedUsers[0] ?? 'dashboard';
    void (manager as SessionManager).handle({ channel, threadTs: ts, ts, user, text: prompt });
    return { url: threadUrl(channel, ts), thread: { channel, ts } };
  };
  const readers = codeReaders(host, projects);
  const pullRequests = host.attention.github ? githubPullRequests() : undefined;
  const attention = () =>
    gatherAttention({
      approvals: () => store.items({ statuses: ['pending'], limit: 500 }),
      permissions: () => bridge?.pendingPermissions() ?? [],
      jobs: () =>
        projects.flatMap(({ config: { name } }) =>
          scheduler
            .list(name)
            .map((job) => ({ ...job, project: name, recent: store.jobRuns(name, job.id, 10) })),
        ),
      repos: readers,
      pullRequests,
      urgent: host.attention.urgent,
    });
  const liveState: LiveState = { focusUntil: 0 };
  // The urgent tier: one alert watcher for every Command tab.
  const alerts =
    host.live &&
    new Alerts({
      attention,
      state: liveState,
      gapMinutes: host.live.urgentGapMinutes,
      alwaysInterrupt: host.live.alwaysInterrupt,
    });
  if (alerts) {
    alerts.start();
    // A job that ended may have made something urgent.
    activity.subscribe((e) => {
      if (e.type === 'task' && e.task.kind === 'job' && e.task.status !== 'running') alerts.poke();
    });
  }
  const liveEndpoint = (cfg: NonNullable<typeof host.live>) => {
    const apiKey = requireEnv('TARA_LIVE_API_KEY');
    const askDeps = {
      run,
      bin: host.claude.bin,
      agentName: host.agentName,
      model: cfg.askModel,
      timeoutMs: cfg.askTimeoutSeconds * 1000,
      store,
    };
    const jobs = (): JobSummary[] =>
      projects.flatMap(({ config: { name } }) =>
        scheduler.list(name).map((j) => ({
          project: name,
          id: j.id,
          name: j.name,
          state: jobState(j),
          cron: j.cron,
          nextRun: j.nextRun?.getTime(),
          lastRunAt: j.lastRunAt?.getTime(),
          lastError: j.lastError,
          recent: store
            .jobRuns(name, j.id, 12)
            .map((r) => ({ status: r.status, at: r.startedAt, ms: r.endedAt - r.startedAt })),
        })),
      );
    const pending = () => store.items({ statuses: ['pending'], limit: 500 });
    const reader = (name: string) => readers.find((r) => r.repo.name === name);
    const deps: LiveDeps = {
      agentName: host.agentName,
      projects: projects.map((p) => p.config.name),
      repos: readers.map((r) => r.repo.name),
      overview: async () => {
        const all = jobs();
        const waiting = pending();
        return Promise.all(
          projects.map(async ({ config }) => {
            const own = all.filter((j) => j.project === config.name);
            const r = reader(config.name);
            const status = r && (await r.status().catch((e: Error) => ({ changes: [], error: e.message })));
            return {
              name: config.name,
              title: config.title ?? config.name,
              jobs: {
                total: own.length,
                running: own.filter((j) => j.state === 'running').map((j) => j.name),
                failing: own.filter((j) => j.state === 'failing').map((j) => j.name),
                paused: own.filter((j) => j.state === 'paused').length,
              },
              approvals: waiting.filter((i) => i.project === config.name).length,
              repo: status && {
                branch: 'branch' in status ? status.branch : undefined,
                changes: status.changes.length,
                error: status.error,
              },
              dashboardUrl: config.dashboardUrl,
            };
          }),
        );
      },
      attention,
      ask: async (name, question, signal) => {
        const project = projects.find((p) => p.config.name === name);
        if (!project) throw new Error(`No project "${name}"`);
        return askProject(askDeps, project, question, signal);
      },
      activity,
      alerts: alerts || undefined,
      dispatch: (name, task) => startThread(name, `🎙️ ${task.split('\n')[0]?.slice(0, 120)}`, task),
      jobs,
      runJob: (project, id) => scheduler.trigger(project, id, 'command'),
      setJobEnabled: (project, id, enabled) => scheduler.setEnabled(project, id, enabled),
      repo: async (name) => {
        const r = reader(name);
        if (!r) throw new Error(`No repo "${name}"`);
        return r.status();
      },
      diff: async (name, file) => {
        const r = reader(name);
        if (!r) throw new Error(`No repo "${name}"`);
        return r.diff(file);
      },
      approvals: () =>
        pending().map((i) => ({
          id: i.id,
          project: i.project,
          title: i.title,
          kind: i.kind,
          options: i.options,
          body: i.body?.slice(0, 600),
          createdAt: i.createdAt,
        })),
      decide: async (id, option) => {
        const item = store.getItem(id);
        const owner = projects.find((p) => p.config.name === item?.project)?.config.owner;
        const decided = await approvals.decide(id, { option, by: owner ?? 'dashboard', via: 'dashboard' });
        return { status: decided.status };
      },
    };
    return {
      connect: (ws: WebSocket) => new LiveSession(ws, { ...cfg, apiKey }, deps, liveState, log),
    };
  };
  // HTTP first: when tara-agent takes over a port, the hand-over gap is as short as possible.
  const http = host.http.enabled
    ? await startHttpServer({
        ...host.http,
        token: process.env.TARA_HTTP_TOKEN || undefined,
        scheduler,
        store,
        bridge,
        approvals,
        adminToken: process.env.TARA_ADMIN_TOKEN || undefined,
        readAs: runAs?.user,
        continueThread: (msg) => (manager as SessionManager).handle(msg),
        attention,
        live: host.live && liveEndpoint(host.live),
        code: readers.length
          ? {
              readers,
              // A new thread in the project's channel, as if its owner had asked there.
              ask: (repo, title, prompt) => startThread(repo.askIn, title, prompt),
            }
          : undefined,
        projects: projects.map((p) => p.config.name),
        dashboard: {
          projects,
          timeZone: host.timezone,
          agentName: host.agentName,
          slackUrl: slack.workspaceUrl,
          hostName: hostname(),
        },
        log,
      })
    : undefined;
  await slack.start();
  scheduler.start();
  queues.start();

  // Scratch folders of sessions not used for `scratchDays` (runner/workspace.ts).
  const sweep = () => {
    const removed = sweepScratch(projects, host.stateDir as string, host.scratchDays);
    if (removed) log.info(`Deleted ${removed} unused scratch ${removed === 1 ? 'folder' : 'folders'}`);
  };
  sweep();
  setInterval(sweep, 3_600_000).unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: stopping`);
    manager?.stopAll();
    http?.close();
    await slack.stop().catch(() => {});
    // Give stopped turns and jobs a moment to post their "Stopped" status before the DB closes.
    const exit = setTimeout(() => {
      store.close();
      process.exit(0);
    }, 8_000);
    queues.stop();
    await scheduler.stop().catch(() => {});
    clearTimeout(exit);
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 1_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // A crash kills every running turn and job, so a stray error is logged instead.
  process.on('uncaughtException', (err) => log.error(`Uncaught: ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) =>
    log.error(
      `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    ),
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'import-hermes') return importHermes(rest);
  if (command === '--help' || command === 'help') return void log.info(USAGE);
  const args = command === 'validate' ? rest : process.argv.slice(2);
  const { values } = parseArgs({ args, options: { config: { type: 'string', short: 'c' } } });
  if (command === 'validate') return validate(values.config);
  await serve(values.config);
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
