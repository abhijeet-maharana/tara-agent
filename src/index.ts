#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST_CONFIG, expandHome, loadHostConfig, loadProjects } from './config/load.js';
import { runClaude } from './runner/run.js';
import { type Logger, SessionManager } from './sessions/manager.js';
import { createSlackGateway } from './slack/app.js';
import { Store } from './store/store.js';

const log: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

function claudeVersion(bin: string): string {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    throw new Error(`Cannot run "${bin} --version". Install Claude Code and log in as this user.`);
  }
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string', short: 'c' } } });
  const configPath = path.resolve(expandHome(values.config ?? DEFAULT_HOST_CONFIG));

  const host = loadHostConfig(configPath);
  const projects = loadProjects(host);
  log.info(`Claude Code: ${claudeVersion(host.claude.bin)}`);
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
  let manager: SessionManager | undefined;
  const slack = createSlackGateway({
    botToken: requireEnv('SLACK_BOT_TOKEN'),
    appToken: requireEnv('SLACK_APP_TOKEN'),
    log,
    onMessage: (msg) => manager?.handle(msg) ?? Promise.resolve(),
  });
  manager = new SessionManager({ projects, host, store, chat: slack.chat, run: runClaude, log });
  await slack.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: stopping`);
    manager?.stopAll();
    await slack.stop().catch(() => {});
    // Give stopped turns a moment to post their "Stopped" status before the DB closes.
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 3_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
