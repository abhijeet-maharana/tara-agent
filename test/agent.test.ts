import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Agent, startAgent } from '../src/agent.js';
import type { SlackGateway, SlackOptions } from '../src/slack/app.js';
import { FakeChat } from './fakes.js';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** A Slack gateway that never connects: records start/stop and what tara-agent passed it. */
function fakeSlack() {
  const state = { started: false, stopped: false, options: undefined as SlackOptions | undefined };
  const make = (options: SlackOptions): SlackGateway => {
    state.options = options;
    return {
      chat: new FakeChat(),
      workspaceUrl: () => 'https://example.slack.com/',
      link: () => ({ state: 'connected', since: Date.now() }),
      start: async () => {
        state.started = true;
      },
      stop: async () => {
        state.stopped = true;
      },
    };
  };
  return { make, state };
}

/** A host with one project, its state in a temp folder, and a stand-in `claude` that only knows --version. */
async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'tara-agent-'));
  const repo = path.join(root, 'shop');
  mkdirSync(path.join(repo, '.tara'), { recursive: true });
  writeFileSync(
    path.join(repo, '.tara', 'config.json'),
    JSON.stringify({ name: 'shop', slackChannel: 'C1' }),
  );
  writeFileSync(
    path.join(repo, '.tara', 'jobs.json'),
    JSON.stringify({ jobs: [{ id: 'sla', name: 'SLA', cron: '0 9 * * *', skills: ['sla'] }] }),
  );
  const claude = path.join(root, 'claude');
  writeFileSync(claude, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
  chmodSync(claude, 0o755);
  const port = await freePort();
  const config = path.join(root, 'config.yaml');
  writeFileSync(
    config,
    [
      `projects: [${repo}]`,
      'timezone: UTC',
      `stateDir: ${path.join(root, 'state')}`,
      `claude: { bin: ${claude} }`,
      `http: { bind: 127.0.0.1, port: ${port} }`,
      // Never touch a real Chrome or GitHub from the suite.
      'browsers: [{ lock: chrome, cdpUrl: "http://127.0.0.1:9", closeTabs: false }]',
      'attention: { github: false }',
    ].join('\n'),
  );
  mkdirSync(path.join(root, 'state'));
  return { root, config, base: `http://127.0.0.1:${port}` };
}

const quiet = { info() {}, warn() {}, error() {} };
const env = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  TARA_ADMIN_TOKEN: 'admin',
  CLAUDE_CONFIG_DIR: '/nonexistent',
};

describe('startAgent', () => {
  it('starts Slack, the API and the dashboard, then stops them all', async () => {
    const { config, base } = await setup();
    const slack = fakeSlack();
    let agent: Agent | undefined;
    try {
      agent = await startAgent({ configFile: config, log: quiet, env, slack: slack.make });
      expect(slack.state.started).toBe(true);
      expect(slack.state.options).toMatchObject({ botToken: 'xoxb-test', appToken: 'xapp-test' });

      const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ ok: true, idle: true, draining: false, projects: ['shop'] });
      expect(health.jobs).toMatchObject({ total: 1, enabled: 1, running: 0, waiting: 0 });

      const jobs = (await (await fetch(`${base}/jobs?project=shop`)).json()) as {
        jobs: Array<{ id: string }>;
      };
      expect(jobs.jobs.map((j) => j.id)).toEqual(['sla']);

      // Every dashboard page renders with the real wiring.
      for (const page of [
        '/',
        '/jobs',
        '/sessions',
        '/approvals',
        '/queue',
        '/schedule',
        '/health',
        '/reminders',
      ]) {
        const res = await fetch(base + page, { headers: { accept: 'text/html' } });
        expect(res.status, page).toBe(200);
        expect(await res.text(), page).toContain('<!doctype html>');
      }

      // Draining needs the admin key, and shows on /health.
      expect((await fetch(`${base}/drain`, { method: 'POST' })).status).toBe(403);
      const drained = await fetch(`${base}/drain`, { method: 'POST', headers: { 'x-tara-admin': 'admin' } });
      expect(await drained.json()).toMatchObject({ draining: true, liveRuns: 0 });
    } finally {
      await agent?.stop();
      agent?.store.close();
    }
    expect(slack.state.stopped).toBe(true);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  }, 30_000);

  it('refuses to start without the Slack tokens', async () => {
    const { config } = await setup();
    await expect(
      startAgent({ configFile: config, log: quiet, env: { SLACK_APP_TOKEN: 'x' }, slack: fakeSlack().make }),
    ).rejects.toThrow('SLACK_BOT_TOKEN is not set');
  });
});
