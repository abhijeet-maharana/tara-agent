import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import { allowList } from '../src/http/access.js';
import { cronText } from '../src/http/cron-text.js';
import { esc, md } from '../src/http/dashboard.js';
import { startHttpServer } from '../src/http/server.js';
import { firstPrompt, parseTranscript, transcriptPath } from '../src/http/transcript.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';

const SID = '11111111-2222-4333-8444-555555555555';
const lines = [
  { type: 'queue-operation', operation: 'enqueue' },
  {
    type: 'user',
    timestamp: '2026-10-25T08:00:00Z',
    message: { role: 'user', content: '<@U1>: check the <b>redis</b> health' },
  },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl /health' } }] },
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok: true', is_error: false }] },
  },
  { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'meta noise' }] } },
  {
    type: 'assistant',
    isSidechain: true,
    message: { content: [{ type: 'text', text: 'sub-agent chatter' }] },
  },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Redis is **healthy**.' }] } },
];
const jsonl = `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`;

describe('transcripts', () => {
  it('keeps prompts, replies and tool calls with their results, and nothing else', () => {
    const entries = parseTranscript(jsonl);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(entries[1]).toMatchObject({ summary: 'Bash: curl /health', result: 'ok: true', isError: false });
    expect(firstPrompt(entries)).toBe('check the <b>redis</b> health');
  });

  it('finds the file the way Claude Code names it', () => {
    expect(transcriptPath('/home/me/Projects/my.repo', SID, '/cfg')).toBe(
      `/cfg/projects/-home-me-Projects-my-repo/${SID}.jsonl`,
    );
  });
});

describe('access and rendering', () => {
  it('allows only the listed networks, including IPv4-mapped addresses', () => {
    const ok = allowList(['127.0.0.0/8', '100.64.0.0/10', 'fd7a:115c:a1e0::/48']);
    expect(ok('127.0.0.1')).toBe(true);
    expect(ok('::ffff:100.126.35.115')).toBe(true);
    expect(ok('fd7a:115c:a1e0::1')).toBe(true);
    expect(ok('192.168.1.20')).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(() => allowList(['nope/8'])).toThrow(/Not an IP range/);
  });

  it('reads common cron expressions as plain English', () => {
    expect(cronText('0 18 * * *', 'UTC', 'UTC')).toBe('Daily 6:00 PM');
    expect(cronText('50 12,19 * * *')).toBe('Daily 12:50 PM & 7:50 PM');
    expect(cronText('5 15 * * 1-5')).toBe('Mon–Fri 3:05 PM');
    expect(cronText('30 18 * * 1,3,5')).toBe('Mon, Wed, Fri 6:30 PM');
    expect(cronText('0 9 * * 1')).toBe('Every Mon 9:00 AM');
    expect(cronText('0 0 * * 0')).toBe('Every Sun 12:00 AM');
    expect(cronText('30 5 1 * *')).toBe('1st of the month, 5:30 AM');
    expect(cronText('0 22 8-10 * *')).toBe('8th–10th of the month, 10:00 PM');
    expect(cronText('0 9 * * *', 'Asia/Kolkata', 'UTC')).toBe('Daily 9:00 AM (Asia/Kolkata)');
    expect(cronText('0 9 * * *', 'Asia/Kolkata', 'Asia/Calcutta')).toBe('Daily 9:00 AM');
    expect(cronText('0 9 * * *', 'Europe/London', 'UTC')).toBe('Daily 9:00 AM (Europe/London)');
    expect(cronText('*/5 * * * *')).toBe('*/5 * * * *');
  });

  it('escapes everything and renders a little Markdown', () => {
    expect(esc('<script>"x"</script>')).toBe('&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
    expect(md('**b** `c` <i>\n```\n<x>\n```')).toBe(
      '<b>b</b> <code>c</code> &lt;i&gt;<br><pre>&lt;x&gt;\n</pre>',
    );
  });
});

describe('dashboard pages', () => {
  const config = mkdtempSync(path.join(tmpdir(), 'tara-claude-'));
  const repo = '/srv/repos/shop';
  const project: Project = {
    dir: repo,
    config: {
      name: 'shop',
      slackChannel: 'C1',
      permissionMode: 'default',
      chatModel: 'opus',
      allowedTools: [],
      allowedUsers: [],
      billing: 'subscription',
      selfImprove: true,
      dashboardUrl: 'https://shop.example/board',
    },
  };
  const store = new Store(':memory:');
  let base = '';
  let close = () => {};

  beforeAll(async () => {
    process.env.CLAUDE_CONFIG_DIR = config;
    const file = transcriptPath(repo, SID);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, jsonl);
    store.saveSession({
      threadKey: 'C1:100.1',
      project: 'shop',
      sessionId: SID,
      model: 'opus',
      started: true,
    });
    store.recordRun({
      kind: 'chat',
      project: 'shop',
      threadKey: 'C1:100.1',
      sessionId: SID,
      startedAt: 1,
      endedAt: 3001,
      status: 'ok',
    });
    const runId = store.recordRun({
      kind: 'job',
      project: 'shop',
      jobId: 'sla',
      startedAt: 5,
      endedAt: 9,
      status: 'failed',
      error: 'login expired',
      output: 'Portal **down**',
    });
    expect(runId).toBe(2);
    const scheduler = {
      list: () => [
        {
          id: 'sla',
          name: 'SLA Report',
          enabled: true,
          running: false,
          cron: '0 5 * * *',
          tz: 'UTC',
          skills: [],
          model: 'haiku',
          lastStatus: 'failed',
        },
      ],
      digest: () => null,
    } as unknown as Scheduler;
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler,
      store,
      projects: ['shop'],
      log: { info() {}, warn() {}, error() {} },
      allowFrom: ['127.0.0.0/8'],
      dashboard: {
        projects: [project],
        timeZone: 'UTC',
        agentName: 'Jarvis',
        slackUrl: () => 'https://acme.slack.com/',
      },
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => {
    close();
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  const html = (p: string) =>
    fetch(base + p, { headers: { accept: 'text/html' } }).then(async (r) => ({
      status: r.status,
      type: r.headers.get('content-type'),
      body: await r.text(),
    }));

  it('lists sessions with their first prompt, escaped, and keeps the old /?project= links', async () => {
    const r = await html('/sessions');
    expect(r.type).toContain('text/html');
    expect(r.body).toContain('check the &lt;b&gt;redis&lt;/b&gt; health');
    expect(r.body).toContain(`href="/sessions/${SID}"`);
    expect(r.body).not.toContain('<b>redis</b>');
    expect(r.body).toContain('<span>Jarvis</span>');
    expect((await html('/?project=shop')).body).toContain(`href="/sessions/${SID}"`);
  });

  it('puts failing jobs first on the home page, with the project dashboard link', async () => {
    const r = await html('/');
    expect(r.body).toContain('Needs attention');
    expect(r.body).toMatch(/SLA Report<\/b> failed/);
    expect(r.body).toContain('data-action="run" data-job="shop/sla"');
    expect(r.body).toContain('href="https://shop.example/board"');
    expect(r.body).toContain('href="/runs/2"'); // "Just ran"
  });

  it('shows a transcript with tool calls folded and a Slack thread link', async () => {
    const r = await html(`/sessions/${SID}`);
    expect(r.body).toContain('🔧 Bash: curl /health');
    expect(r.body).toContain('Redis is <b>healthy</b>.');
    expect(r.body).toContain('href="https://acme.slack.com/archives/C1/p1001"');
    expect(r.body).not.toContain('sub-agent chatter');
  });

  it('lists jobs with Run now, Pause and a plain-English schedule, and shows a run', async () => {
    const jobs = (await html('/jobs')).body;
    expect(jobs).toContain('data-action="run" data-job="shop/sla"');
    expect(jobs).toContain('data-action="pause" data-job="shop/sla"');
    expect(jobs).toContain('Daily 5:00 AM');
    expect(jobs).toContain('href="/runs/2"');
    const run = await html('/runs/2');
    expect(run.body).toContain('login expired');
    expect(run.body).toContain('Portal <b>down</b>');
  });

  it('still answers JSON to tools on the same paths', async () => {
    const r = await fetch(`${base}/jobs?project=shop`);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(((await r.json()) as { jobs: Array<{ id: string }> }).jobs[0]?.id).toBe('sla');
  });

  it('refuses clients outside allowFrom', async () => {
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: {} as Scheduler,
      store,
      projects: [],
      log: { info() {}, warn() {}, error() {} },
      allowFrom: ['10.0.0.0/8'],
    });
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
    expect(r.status).toBe(403);
    server.close();
  });
});

describe('fallback pass-through', () => {
  it("serves tara's own paths and passes everything else (method, body, headers) to the fallback", async () => {
    const { createServer } = await import('node:http');
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${body} xff=${req.headers['x-forwarded-for']}`);
        res.writeHead(201, { 'content-type': 'application/json', 'x-up': '1' });
        res.end('{"booked":true}');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = (upstream.address() as AddressInfo).port;
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store: new Store(':memory:'),
      projects: ['shop'],
      log: { info() {}, warn() {}, error() {} },
      fallback: `http://127.0.0.1:${upPort}`,
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const booked = await fetch(`${base}/api/amazon-shipping/book?x=1`, {
      method: 'POST',
      body: '{"order":7}',
    });
    expect(booked.status).toBe(201);
    expect(booked.headers.get('x-up')).toBe('1');
    expect(await booked.json()).toEqual({ booked: true });
    expect(seen).toEqual(['POST /api/amazon-shipping/book?x=1 {"order":7} xff=127.0.0.1']);

    expect((await fetch(`${base}/tasks`)).status).toBe(201); // old dashboard pages too
    expect((await fetch(`${base}/health`)).headers.get('content-type')).toContain('application/json');
    expect(seen).toHaveLength(2); // /health stayed with tara

    upstream.close();
    const down = await fetch(`${base}/api/indiapost/book`, { method: 'POST' });
    expect(down.status).toBe(502);
    server.close();
  });
});
