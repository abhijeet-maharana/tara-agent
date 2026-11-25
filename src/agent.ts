import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { Approvals } from './approvals/approvals.js';
import { Bridge } from './bridge/bridge.js';
import { codeReaders } from './code/repo.js';
import { DEFAULT_HOST_CONFIG, expandHome, loadHostConfig, loadProjects } from './config/load.js';
import { CiJobs } from './github/actions.js';
import { PullRequests } from './github/pull-requests.js';
import { agentChecks, healthSources, jobChecks, machine, oversizedSkills } from './health/checks.js';
import { claudeLoginReader } from './health/claude-login.js';
import { LoginReminder } from './health/login-reminder.js';
import { HealthMonitor } from './health/monitor.js';
import { Observability } from './health/observability.js';
import { readOffsiteStatus } from './health/offsite.js';
import { gatherAttention, githubPullRequests } from './http/attention.js';
import { probeBrowser, projectBrowser } from './http/browser-usage.js';
import { startHttpServer } from './http/server.js';
import { oversizedMemory } from './memory/memory.js';
import { Privileged } from './privileged/privileged.js';
import { Reminders } from './reminders/reminders.js';
import { Activity } from './runner/activity.js';
import { runAgy } from './runner/agy.js';
import { resolveRunAs } from './runner/as-user.js';
import { Conversations, TabSweeper } from './runner/browser-tabs.js';
import { type Runner, runClaude } from './runner/run.js';
import { sweepScratch } from './runner/workspace.js';
import { gateRunner } from './scheduler/gate.js';
import { QueueWorker } from './scheduler/queues.js';
import { Scheduler } from './scheduler/scheduler.js';
import { openRunThread } from './scheduler/slack-trigger.js';
import { type Logger, SessionManager } from './sessions/manager.js';
import { Threads } from './sessions/threads.js';
import { createSlackGateway, type SlackGateway, type SlackOptions } from './slack/app.js';
import { backupDaily } from './store/backup.js';
import { Store } from './store/store.js';
import { zonedClock } from './util/time.js';
import { Vault } from './vault/vault.js';
import { deliveryOf, isWebChannel, RoutedChat, WebChat, webChannel, webProject } from './web/chat.js';

export interface AgentOptions {
  /** The host config file (default `DEFAULT_HOST_CONFIG`). */
  configFile?: string;
  log: Logger;
  /** Where secrets and settings are read from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Makes the Slack connection (tests pass a fake). */
  slack?: (options: SlackOptions) => SlackGateway;
  /** Called once the state database is open (index.ts keeps warnings and errors in it). */
  onStore?: (store: Store) => void;
}

/** A running agent. `stop` ends runs and listeners; the caller closes `store` and exits. */
export interface Agent {
  store: Store;
  http?: Server;
  stop(): Promise<void>;
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

export function loadAll(configFlag: string | undefined, onBroken?: (dir: string, err: Error) => void) {
  const host = loadHostConfig(path.resolve(expandHome(configFlag ?? DEFAULT_HOST_CONFIG)));
  const projects = loadProjects(host, onBroken);
  return { host, projects };
}

/**
 * Starts everything `tara-agent` runs: Slack, the HTTP server and dashboard, the scheduler, queues,
 * reminders, health checks and the housekeeping timers.
 */
export async function startAgent(opts: AgentOptions): Promise<Agent> {
  const { log } = opts;
  const env = opts.env ?? process.env;
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set (see .env.example)`);
    return value;
  };
  // Housekeeping timers, cleared by `stop`.
  const timers: NodeJS.Timeout[] = [];
  const every = (fn: () => void, ms: number) => void timers.push(setInterval(fn, ms).unref());
  // A project whose config doesn't load is left out (and shown on the Health page); the rest run.
  const skipped: Array<{ dir: string; message: string }> = [];
  // The latest daily copy of the database (set further down), for the Health page.
  let backupState: { day?: string; error?: string } = {};
  const { host, projects } = loadAll(opts.configFile, (dir, err) => {
    skipped.push({ dir, message: err.message });
    log.error(`Project ${dir} left out: ${err.message}`);
  });
  if (!projects.length) throw new Error('No project config loaded; see the errors above');
  for (const p of projects)
    if (p.pinDrift)
      log.warn(
        `Project ${p.config.name}: .tara/config.json changes pinned ${p.pinDrift.join(', ')}; host trusted wins`,
      );
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
  opts.onStore?.(store);
  const runAs = host.claude.runAs ? resolveRunAs(host.claude.runAs) : undefined;
  if (runAs) log.info(`Claude runs as ${runAs.user} (${runAs.home})`);
  // The dashboard as you open it: host `dashboardUrl`, else this machine's name and port (e.g.
  // http://jarvis:4000, which Tailscale's MagicDNS resolves on every device of the tailnet).
  const dashboardUrl = (
    host.dashboardUrl ?? (host.http.enabled ? `http://${hostname()}:${host.http.port}` : '')
  ).replace(/\/$/, '');
  // A thread's link: a dashboard thread's page, or the Slack thread.
  const threadUrl = (channel: string, ts: string) => {
    if (isWebChannel(channel)) return dashboardUrl ? `${dashboardUrl}/t/${channel}/${ts}` : undefined;
    const base = slack.workspaceUrl();
    return base && `${base}archives/${channel}/p${ts.replace('.', '')}`;
  };
  /** Where a project's unattended runs happen: its dashboard channel (`delivery: summary`) or Slack. */
  const runChannel = (p: (typeof projects)[number]) =>
    deliveryOf(host, p) === 'summary' ? webChannel(p.config.name) : p.config.slackChannel;
  // Every labelled run, live, for a running session's page (its steps and Stop).
  const activity = new Activity({ threadUrl });
  // Each run goes through the CLI it names (`harness`): Claude Code, or agy for agy jobs.
  // CLI processes alive now, of every kind (chat turns, jobs, steps, learning turns): `/health` is idle at 0.
  let liveRuns = 0;
  const run: Runner = activity.wrap(async (o) => {
    liveRuns++;
    try {
      return await (o.harness === 'agy' ? runAgy : runClaude)(runAs ? { ...o, runAs } : o);
    } finally {
      liveRuns--;
    }
  });
  let manager: SessionManager | undefined;
  let bridge: Bridge | undefined;
  const slack = (opts.slack ?? createSlackGateway)({
    botToken: need('SLACK_BOT_TOKEN'),
    appToken: need('SLACK_APP_TOKEN'),
    userToken: env.SLACK_USER_TOKEN || undefined,
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
    voice: host.voice && { ...host.voice, apiKey: env.TARA_VOICE_API_KEY || undefined },
  });
  // Everything posts through this: Slack channels to Slack, dashboard threads (`web-<project>`) to the
  // dashboard, with cards copied to Slack (src/web/chat.ts).
  const web = new WebChat(store, host.stateDir as string);
  const chat = new RoutedChat(slack.chat, web, {
    store,
    log,
    slackChannelFor: (channel) =>
      projects.find((p) => p.config.name === webProject(channel))?.config.slackChannel,
    link: threadUrl,
  });
  // Root actions: the helper's allowlist is the source of truth; without it runs can only ask a person.
  const privileged = host.privileged ? new Privileged(host.privileged.command) : undefined;
  await privileged
    ?.load()
    .then((actions) => log.info(`Root actions: ${actions.map((a) => a.id).join(', ') || 'none'}`))
    .catch((err: Error) => log.warn(`Root actions are unavailable: ${err.message}`));
  const approvals = new Approvals({
    store,
    chat,
    runChannel,
    log,
    projects,
    timeZone: host.timezone,
    sealKey: env.APPROVAL_SEAL_KEY || undefined,
    privileged,
    autoApprove: host.autoApprove,
    threadUrl,
  });
  if (!env.APPROVAL_SEAL_KEY) log.warn('APPROVAL_SEAL_KEY is not set: approved items are not sealed');
  // Saved website logins: runs sign in through tara-agent and never see a secret.
  const vault = new Vault({ store, key: env.TARA_VAULT_KEY || undefined, log });
  if (vault.on) log.info(`Vault: ${vault.list().length} saved logins`);
  else if (env.TARA_VAULT_KEY) log.error(`Vault: ${vault.problem}`);
  // Pull requests: the token stays here, runs only get the tools.
  const githubToken = env.TARA_GITHUB_TOKEN || undefined;
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
      chat,
      store,
      approvals,
      privileged,
      pullRequests: prRaiser,
      ciJobs,
      vault,
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
    chat,
    run,
    bridge,
    threads,
    log,
    threadUrl,
    approvalsUrl: dashboardUrl ? `${dashboardUrl}/approvals` : undefined,
    gate: gateRunner(runAs),
    unfinished: (u) => approvals.unfinished(u),
  });
  manager = new SessionManager({
    projects,
    host,
    store,
    chat,
    run,
    jobs: scheduler,
    threads,
    bridge,
    log,
    threadUrl,
    approvalsUrl: dashboardUrl ? `${dashboardUrl}/approvals` : undefined,
  });
  const reminders = new Reminders({
    store,
    chat,
    runChannel,
    projects,
    timeZone: host.timezone,
    log,
    startRun: (msg) => (manager as SessionManager).handle(msg),
    catchUpMs: host.catchUpHours * 3_600_000,
  });
  if (bridge) {
    bridge.onDecision = (msg) => (manager as SessionManager).handle(msg);
    bridge.jobs = scheduler;
    bridge.reminders = reminders;
  }
  approvals.onChat = (msg) => (manager as SessionManager).handle(msg);
  approvals.onJob = (project, jobId, r) => scheduler.resume(project, jobId, r);
  approvals.onJobDecision = (project, jobId, r) => scheduler.decided(project, jobId, r);
  const queues = new QueueWorker({
    projects,
    store,
    log,
    jobs: scheduler,
    timeZone: host.timezone,
    onFinished: (item) => approvals.finished(item),
  });
  /**
   * A new "Run <what>" thread, as if the project's owner had asked: on the dashboard with the answer
   * posted in Slack (`delivery: summary`), or in the project's channel. Returns its link. The title is
   * the thread's first reply.
   */
  const startThread = async (name: string | undefined, what: string, title: string, prompt: string) => {
    const project = projects.find((p) => p.config.name === name);
    if (!project) throw new Error(`No project "${name}" to ask in`);
    const channel = runChannel(project);
    const ts = await openRunThread(chat, channel, what, project.config.words);
    await chat.post(channel, ts, title);
    const user = project.config.owner ?? project.config.allowedUsers[0] ?? 'dashboard';
    void (manager as SessionManager).handle({
      channel,
      threadTs: ts,
      ts,
      user,
      text: prompt,
      summary: `*${title.slice(0, 120)}*`,
    });
    return { url: threadUrl(channel, ts), thread: { channel, ts } };
  };
  const readers = codeReaders(host, projects);
  const pullRequests = host.attention.github ? githubPullRequests() : undefined;
  const attention = () =>
    gatherAttention({
      approvals: () => store.items({ statuses: ['pending', 'uncertain'], limit: 500 }),
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
    configDir: env.CLAUDE_CONFIG_DIR ?? path.join(runAs?.home ?? homedir(), '.claude'),
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
                vmHost: () => store.lastVmHostSample(),
                claudeLogin,
                skippedProjects: () => skipped,
                dbWrite: () => store.checkWrite(),
                pinDrift: () =>
                  projects.flatMap((p) => (p.pinDrift ? [{ project: p.config.name, keys: p.pinDrift }] : [])),
                backup: () => backupState,
                offsite: host.backup.offsite
                  ? () => {
                      const o = host.backup.offsite as NonNullable<typeof host.backup.offsite>;
                      return { status: readOffsiteStatus(o.statusFile), options: o };
                    }
                  : undefined,
                timeZone: host.timezone,
                now: Date.now,
              }),
            projects,
            jobs: (p) => {
              const name = p.config.name;
              return jobChecks({
                project: p,
                skills: () => oversizedSkills(p.dir),
                memory: () => oversizedMemory(p.dir),
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
        drain: {
          set: (on) => {
            scheduler.draining = on;
            queues.draining = on;
            log.info(on ? 'Draining for a restart: no new scheduled or queue runs' : 'Drain ended');
          },
          state: () => ({ draining: scheduler.draining, liveRuns, queueBatches: queues.busy }),
        },
        // The name the dashboard is opened by is always a good Host.
        hosts: [
          ...host.http.hosts,
          URL.canParse(dashboardUrl) ? new URL(dashboardUrl).hostname : 'localhost',
        ],
        token: env.TARA_HTTP_TOKEN || undefined,
        scheduler,
        store,
        bridge,
        approvals,
        reminders,
        vault,
        adminToken: env.TARA_ADMIN_TOKEN || undefined,
        readAs: runAs?.user,
        continueThread: (msg) => (manager as SessionManager).handle(msg),
        web,
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
  reminders.start();
  // Chat messages a crash left unanswered: answered now, or their thread is told (SessionManager.recover).
  void manager.recover().catch((err: Error) => log.error(`recovering chat messages: ${err.message}`));
  // The runs' Claude login: a Slack reminder with the steps, daily from 3 days before it ends.
  const loginReminder = new LoginReminder({
    login: claudeLogin,
    store,
    chat: slack.chat,
    target: () => {
      const p = projects.find((x) => x.config.name === host.health.alertProject) ?? projects[0];
      return p && { channel: p.config.slackChannel, owner: p.config.owner };
    },
    host: hostname(),
    timeZone: host.timezone,
    log,
  });
  const remindLogin = () =>
    void loginReminder.tick().catch((err: Error) => log.warn(`Login reminder: ${err.message}`));
  remindLogin();
  every(remindLogin, 15 * 60_000);
  // The machine every 5 minutes, for the Trends view's charts.
  const sample = () => {
    try {
      const m = machine(host.stateDir, dbFile);
      store.addHostSample({
        at: Date.now(),
        load: m.load,
        memUsed: 1 - m.memFree,
        diskUsed: m.diskUsed,
        swapUsed: m.swapUsed,
      });
    } catch (err) {
      log.warn(`Machine sample not stored: ${(err as Error).message}`);
    }
  };
  if (host.health.enabled) {
    sample();
    every(sample, 300_000);
  }

  // Scratch folders of sessions not used for `scratchDays` (runner/workspace.ts).
  const sweep = () => {
    const removed = sweepScratch(projects, host.stateDir as string, host.scratchDays);
    if (removed) log.info(`Deleted ${removed} unused scratch ${removed === 1 ? 'folder' : 'folders'}`);
  };
  sweep();
  every(sweep, 3_600_000);

  // Run history and slot claims older than `retentionDays`, once at start and then daily.
  const prune = () => {
    try {
      const before = Date.now() - host.retentionDays * 86_400_000;
      const { runs, claims, sessions } = store.prune(before);
      web.sweep(before);
      if (runs || claims || sessions)
        log.info(
          `Deleted ${runs} runs, ${claims} slot claims and ${sessions} sessions older than ${host.retentionDays} days`,
        );
    } catch (err) {
      log.error(`Pruning the state database failed: ${(err as Error).message}`);
    }
  };
  prune();
  every(prune, 86_400_000);

  // A checked copy of the database each day (store/backup.ts): at start when today's is missing, then
  // hourly so a day is never skipped. A failed copy is an error on the Logs page.
  const backupDir = path.resolve(
    expandHome(host.backup.dir ?? path.join(host.stateDir as string, 'backups')),
  );
  const backup = () => {
    try {
      const day = zonedClock(Date.now(), host.timezone).day;
      const { file, removed } = backupDaily(store, backupDir, host.backup.keep, day);
      if (file)
        log.info(`Backed up the state database to ${file}${removed ? `, deleted ${removed} old` : ''}`);
      backupState = { day };
    } catch (err) {
      backupState = { error: (err as Error).message };
      log.error(`Backing up the state database failed: ${(err as Error).message}`);
    }
  };
  backup();
  every(backup, 3_600_000);
  // After Slack, the scheduler and the first backup, so the first checks see them (not "No copy yet").
  health?.start();

  // Stale browser tabs: runs share each Chrome without locks and close their own tabs; this closes
  // what is left (runner/browser-tabs.ts), never a tab a conversation still going may own or a kept one.
  const sameUrl = (a: string, b: string) =>
    a.replace(/^ws:/, 'http:').replace(/\/$/, '').replace('localhost', '127.0.0.1') ===
    b.replace(/^ws:/, 'http:').replace(/\/$/, '').replace('localhost', '127.0.0.1');
  // A chat's tabs stay its own across turns and between them, until it is idle for staleMinutes.
  const conversations = new Conversations(Math.max(0, ...host.browsers.map((b) => b.staleMinutes)) * 60_000);
  for (const t of activity.tasks()) conversations.update(t);
  activity.subscribe((e) => {
    if (e.type === 'task') conversations.update(e.task);
  });
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
    oldestRun: (names) => conversations.oldest(names, Date.now()),
    log: (m) => log.info(m),
  });
  const sweepTabs = () =>
    void tabSweeper.sweep().catch((err) => log.warn(`Tab sweep: ${(err as Error).message}`));
  every(sweepTabs, 300_000);

  return {
    store,
    http,
    stop: async () => {
      for (const t of timers) clearInterval(t);
      manager?.stopAll();
      health?.stop();
      http?.close();
      await slack.stop().catch(() => {});
      queues.stop();
      reminders.stop();
      await scheduler.stop().catch(() => {});
    },
  };
}
