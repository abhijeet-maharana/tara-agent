#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Approvals } from './approvals/approvals.js';
import { Bridge } from './bridge/bridge.js';
import { codeReaders } from './code/repo.js';
import { DEFAULT_HOST_CONFIG, expandHome, loadHostConfig, loadJobs, loadProjects } from './config/load.js';
import { CiJobs } from './github/actions.js';
import { PullRequests } from './github/pull-requests.js';
import { agentChecks, healthSources, jobChecks, machine } from './health/checks.js';
import { claudeLoginReader } from './health/claude-login.js';
import { HealthMonitor } from './health/monitor.js';
import { Observability } from './health/observability.js';
import { gatherAttention, githubPullRequests } from './http/attention.js';
import { probeBrowser, projectBrowser } from './http/browser-usage.js';
import { startHttpServer } from './http/server.js';
import { Privileged } from './privileged/privileged.js';
import { Activity, redact } from './runner/activity.js';
import { runAgy } from './runner/agy.js';
import { resolveRunAs } from './runner/as-user.js';
import { TabSweeper } from './runner/browser-tabs.js';
import { type Runner, runClaude } from './runner/run.js';
import { sweepScratch } from './runner/workspace.js';
import { QueueWorker } from './scheduler/queues.js';
import { Scheduler } from './scheduler/scheduler.js';
import { openRunThread } from './scheduler/slack-trigger.js';
import { type Logger, SessionManager } from './sessions/manager.js';
import { Threads } from './sessions/threads.js';
import { createSlackGateway } from './slack/app.js';
import { Store } from './store/store.js';

/** Where warnings and errors are also kept (the Health page's Logs view), once the store is open. */
let logSink: ((level: 'warn' | 'error', message: string) => void) | undefined;
const keep = (level: 'warn' | 'error', message: string) => {
  try {
    logSink?.(level, message);
  } catch {
    // A log line that can't be stored is still on the console.
  }
};
const log: Logger = {
  info: (m) => console.log(m),
  warn: (m) => {
    console.warn(m);
    keep('warn', m);
  },
  error: (m) => {
    console.error(m);
    keep('error', m);
  },
};

const USAGE = `Usage:
  tara-agent [--config <file>]               run the gateway
  tara-agent validate [--config <file>]      check host, project and job config, then exit
  tara-agent rename-jobs <project> <map.json> [--config <file>]
                                             move run history, cards and slot claims from old job ids
                                             to new ones ({"old-id": "new-id"}); stop the service first`;

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

function renameJobs(configFlag: string | undefined, [project, mapFile]: string[]): void {
  if (!project || !mapFile) throw new Error(USAGE);
  const host = loadHostConfig(path.resolve(expandHome(configFlag ?? DEFAULT_HOST_CONFIG)));
  const renames = JSON.parse(readFileSync(mapFile, 'utf8')) as Record<string, string>;
  const store = new Store(path.join(host.stateDir as string, 'tara.db'));
  const changed = store.renameJobs(project, renames);
  log.info(`✓ ${project}: ${Object.keys(renames).length} job ids renamed, ${changed} rows changed`);
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
  logSink = (level, message) => store.addLog({ at: Date.now(), level, message: redact(message) });
  const runAs = host.claude.runAs ? resolveRunAs(host.claude.runAs) : undefined;
  if (runAs) log.info(`Claude runs as ${runAs.user} (${runAs.home})`);
  const threadUrl = (channel: string, ts: string) => {
    const base = slack.workspaceUrl();
    return base && `${base}archives/${channel}/p${ts.replace('.', '')}`;
  };
  // Every labelled run, live, for a running session's page (its steps and Stop).
  const activity = new Activity({ threadUrl });
  // Each run goes through the CLI it names (`harness`): Claude Code, or agy for agy jobs.
  const run: Runner = activity.wrap((o) =>
    (o.harness === 'agy' ? runAgy : runClaude)(runAs ? { ...o, runAs } : o),
  );
  let manager: SessionManager | undefined;
  let bridge: Bridge | undefined;
  const slack = createSlackGateway({
    botToken: requireEnv('SLACK_BOT_TOKEN'),
    appToken: requireEnv('SLACK_APP_TOKEN'),
    userToken: process.env.SLACK_USER_TOKEN || undefined,
    log,
    onMessage: (msg) => {
      // A message Approvals posted as the person arrived (see Approvals.toThread); a note's answer mentions them.
      const mine = approvals.delivered(msg);
      if (mine) {
        msg.text = mine.text; // Slack shows a short line; Jarvis gets the full text
        msg.mentionWhenDone = mine.mention;
      }
      return manager?.handle(msg) ?? Promise.resolve();
    },
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
    autoApprove: host.autoApprove,
  });
  if (!process.env.APPROVAL_SEAL_KEY) log.warn('APPROVAL_SEAL_KEY is not set: approved items are not sealed');
  // Pull requests: the token stays here, runs only get the tools.
  const githubToken = process.env.TARA_GITHUB_TOKEN || undefined;
  if (host.github.length && !githubToken)
    log.warn('github is set but TARA_GITHUB_TOKEN is not: pull requests are off');
  const prRaiser =
    host.github.length && githubToken
      ? new PullRequests({
          repos: host.github,
          token: githubToken,
          agentName: host.agentName,
          stateDir: host.stateDir as string,
          log,
          runAs,
          shareGid: runAs?.gid,
        })
      : undefined;
  const ciJobs =
    prRaiser && githubToken ? new CiJobs({ repos: host.github, token: githubToken, log }) : undefined;
  if (prRaiser) log.info(`Pull requests: ${host.github.map((g) => `${g.project} → ${g.repo}`).join(', ')}`);
  // tara's MCP tools reach tara-agent through the local API, so they need it.
  if (host.http.enabled) {
    bridge = new Bridge({
      apiUrl: `http://${host.http.bind === '0.0.0.0' ? '127.0.0.1' : host.http.bind}:${host.http.port}`,
      chat: slack.chat,
      store,
      approvals,
      privileged,
      pullRequests: prRaiser,
      ciJobs,
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
  /**
   * A new "Run <what>" thread in the project's channel, as if its owner had asked there; returns its
   * link. The title is the thread's first reply.
   */
  const startThread = async (name: string | undefined, what: string, title: string, prompt: string) => {
    const project = projects.find((p) => p.config.name === name);
    if (!project) throw new Error(`No project "${name}" to ask in`);
    const channel = project.config.slackChannel;
    const ts = await openRunThread(slack.chat, channel, what);
    await slack.chat.post(channel, ts, title);
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
      health: () =>
        (health?.snapshot()?.checks ?? [])
          .filter((c) => c.status === 'bad' && !c.unconfirmed && !c.key.startsWith('jobs:'))
          .map((c) => ({ key: c.key, project: c.project, name: c.name, detail: c.detail, since: c.since })),
    });
  // The Health page: tara-agent, each project's jobs, each project's own checks (src/health/).
  const dbFile = path.join(host.stateDir as string, 'tara.db');
  // The runs' Claude login, to warn days before it ends (runs inherit this process's CLAUDE_CONFIG_DIR).
  const claudeLogin = claudeLoginReader({
    configDir: process.env.CLAUDE_CONFIG_DIR ?? path.join(runAs?.home ?? homedir(), '.claude'),
    readAs: runAs?.user,
  });
  const health = host.health.enabled
    ? new HealthMonitor({
        sources: () =>
          healthSources({
            agentName: host.agentName,
            agent: () =>
              agentChecks({
                agentName: host.agentName,
                host,
                slack: () => slack.link(),
                tasks: () => activity.tasks(),
                usage: () => activity.usage(),
                runsSince: (since) => store.runStats(since),
                dbFile,
                probeBrowser,
                claudeLogin,
                timeZone: host.timezone,
                now: Date.now,
              }),
            projects,
            jobs: (p) => {
              const name = p.config.name;
              return jobChecks({
                project: p,
                jobs: () => scheduler.list(name),
                recent: (id) => store.jobRuns(name, id, 10),
                latestSlots: (at) => scheduler.latestSlots(name, at),
                slotClaim: (key, slot) => store.slotClaim(key, slot),
                fileError: () => scheduler.jobFileErrors().get(name),
                started: scheduler.started,
                failingAfter: host.health.failingAfter,
                timeZone: host.timezone,
                now: Date.now,
              });
            },
          }),
        store,
        chat: slack.chat,
        target: (name) => {
          const p =
            projects.find((x) => x.config.name === (name ?? host.health.alertProject)) ??
            (name ? undefined : projects[0]);
          return (
            p && {
              name: p.config.name,
              title: p.config.title ?? p.config.name,
              channel: p.config.slackChannel,
              owner: p.config.owner,
            }
          );
        },
        alerts: host.health.alerts,
        timeZone: host.timezone,
        log,
        intervalMs: host.health.intervalMinutes * 60_000,
      })
    : undefined;
  const observe = host.health.enabled
    ? new Observability({
        store,
        projects,
        jobs: (name) => scheduler.list(name),
        monitor: health,
        running: () => activity.tasks().filter((t) => t.status === 'running').length,
        usage: () => activity.usage()?.utilization,
        agentName: host.agentName,
        timeZone: host.timezone,
        logUnits: host.health.logUnits,
        started: Date.now(),
      })
    : undefined;
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
        activity,
        health,
        observe,
        code: readers.length
          ? {
              readers,
              // A new thread in the project's channel, as if its owner had asked there.
              ask: (repo, title, prompt) => startThread(repo.askIn, 'code-question', title, prompt),
            }
          : undefined,
        projects: projects.map((p) => p.config.name),
        browsers: host.browsers,
        dashboard: {
          projects,
          timeZone: host.timezone,
          agentName: host.agentName,
          slackUrl: slack.workspaceUrl,
          hostName: hostname(),
          models: {
            effort: host.claude.effort,
            voice: host.voice?.models,
          },
        },
        log,
      })
    : undefined;
  await slack.start();
  scheduler.start();
  queues.start();
  // After Slack and the scheduler, so the first checks see them running.
  health?.start();
  // The machine every 5 minutes, for the Trends view's charts.
  const sample = () => {
    try {
      const m = machine(host.stateDir, dbFile);
      store.addHostSample({ at: Date.now(), load: m.load, memUsed: 1 - m.memFree, diskUsed: m.diskUsed });
    } catch (err) {
      log.warn(`Machine sample not stored: ${(err as Error).message}`);
    }
  };
  if (host.health.enabled) {
    sample();
    setInterval(sample, 300_000).unref();
  }

  // Scratch folders of sessions not used for `scratchDays` (runner/workspace.ts).
  const sweep = () => {
    const removed = sweepScratch(projects, host.stateDir as string, host.scratchDays);
    if (removed) log.info(`Deleted ${removed} unused scratch ${removed === 1 ? 'folder' : 'folders'}`);
  };
  sweep();
  setInterval(sweep, 3_600_000).unref();

  // Run history and slot claims older than `retentionDays`, once at start and then daily.
  const prune = () => {
    try {
      const { runs, claims, sessions } = store.prune(Date.now() - host.retentionDays * 86_400_000);
      if (runs || claims || sessions)
        log.info(
          `Deleted ${runs} runs, ${claims} slot claims and ${sessions} sessions older than ${host.retentionDays} days`,
        );
    } catch (err) {
      log.error(`Pruning the state database failed: ${(err as Error).message}`);
    }
  };
  prune();
  setInterval(prune, 86_400_000).unref();

  // Stale browser tabs: runs share each Chrome without locks and close their own tabs; this closes
  // what is left (runner/browser-tabs.ts), never a tab a run still going may own or a kept one.
  const sameUrl = (a: string, b: string) =>
    a.replace(/^ws:/, 'http:').replace(/\/$/, '').replace('localhost', '127.0.0.1') ===
    b.replace(/^ws:/, 'http:').replace(/\/$/, '').replace('localhost', '127.0.0.1');
  const tabSweeper = new TabSweeper({
    browsers: () =>
      host.browsers
        .filter((b) => b.closeTabs)
        .map((b) => {
          const using = projects.filter((p) => {
            const url = projectBrowser(p.dir).cdpUrl;
            return url !== undefined && sameUrl(url, b.cdpUrl);
          });
          return {
            cdpUrl: b.cdpUrl,
            staleMs: b.staleMinutes * 60_000,
            projects: using.map((p) => p.config.name),
            keepUrls: using.flatMap((p) => (p.config.keepTabsUrl ? [p.config.keepTabsUrl] : [])),
          };
        }),
    oldestRun: (names) => {
      const starts = activity
        .tasks()
        .filter((t) => t.status === 'running' && names.includes(t.project))
        .map((t) => t.startedAt);
      return starts.length ? Math.min(...starts) : undefined;
    },
    log: (m) => log.info(m),
  });
  const sweepTabs = () =>
    void tabSweeper.sweep().catch((err) => log.warn(`Tab sweep: ${(err as Error).message}`));
  setInterval(sweepTabs, 300_000).unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: stopping`);
    manager?.stopAll();
    health?.stop();
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
  if (command === '--help' || command === 'help') return void log.info(USAGE);
  const args = command === 'validate' || command === 'rename-jobs' ? rest : process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string', short: 'c' } },
    allowPositionals: command === 'rename-jobs',
  });
  if (command === 'validate') return validate(values.config);
  if (command === 'rename-jobs') return renameJobs(values.config, positionals);
  await serve(values.config);
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
