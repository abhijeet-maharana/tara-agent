#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadAll, startAgent } from './agent.js';
import { DEFAULT_HOST_CONFIG, expandHome, loadHostConfig, loadJobs } from './config/load.js';
import { doctor, formatDoctor } from './doctor.js';
import { redact } from './runner/activity.js';
import type { Logger } from './sessions/manager.js';
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
  tara-agent doctor [--config <file>]        check everything: config, skills, required services and the
                                             running tara-agent's health checks (exit 1 when any is red)
  tara-agent rename-jobs <project> <map.json> [--config <file>]
                                             move run history, cards and slot claims from old job ids
                                             to new ones ({"old-id": "new-id"}); stop the service first`;

function validate(configFlag: string | undefined): void {
  const { host, projects } = loadAll(configFlag);
  for (const p of projects) {
    const jobs = loadJobs(p);
    const enabled = jobs.filter((j) => j.job.enabled).length;
    log.info(`✓ ${p.config.name} (${p.dir}): ${enabled}/${jobs.length} jobs enabled`);
  }
  log.info(`✓ config OK (timezone ${host.timezone}, jobConcurrency ${host.jobConcurrency})`);
}

async function runDoctor(configFlag: string | undefined): Promise<void> {
  const { host, projects } = loadAll(configFlag);
  const { text, code } = formatDoctor(await doctor({ host, projects, jobs: loadJobs }));
  console.log(text);
  process.exitCode = code;
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
  const agent = await startAgent({
    configFile: configFlag,
    log,
    onStore: (store) => {
      logSink = (level, message) => store.addLog({ at: Date.now(), level, message: redact(message) });
    },
  });
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: stopping`);
    const exit = () => {
      agent.store.close();
      process.exit(0);
    };
    // Give stopped turns and jobs a moment to post their "Stopped" status before the DB closes.
    const cap = setTimeout(exit, 8_000);
    await agent.stop();
    clearTimeout(cap);
    setTimeout(exit, 1_000).unref();
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
  const args = ['validate', 'doctor', 'rename-jobs'].includes(command ?? '') ? rest : process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string', short: 'c' } },
    allowPositionals: command === 'rename-jobs',
  });
  if (command === 'validate') return validate(values.config);
  if (command === 'doctor') return runDoctor(values.config);
  if (command === 'rename-jobs') return renameJobs(values.config, positionals);
  await serve(values.config);
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
