import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import { allowList } from '../src/http/access.js';
import { cronText } from '../src/http/cron-text.js';
import {
  type DashboardContext,
  esc,
  headline,
  homePage,
  type JobView,
  md,
  sessionPage,
} from '../src/http/dashboard.js';
import { startHttpServer } from '../src/http/server.js';
import { firstPrompt, parseTranscript, transcriptPath } from '../src/http/transcript.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { type Item, Store, type StoredRun } from '../src/store/store.js';

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

  it('renders card Markdown: lists, quotes, headings, links, Slack-style bold', () => {
    expect(md('Intro:\n- one\n- **two**\n\nAfter')).toBe(
      'Intro:<ul class="md"><li>one</li><li><b>two</b></li></ul>After',
    );
    expect(md('> Hi,\n>\n> Thanks')).toBe('<blockquote class="md">Hi,<br><br>Thanks</blockquote>');
    expect(md('## Plan\n*Proposal:* _soon_')).toBe('<b>Plan</b><br><b>Proposal:</b> <i>soon</i>');
    expect(md('[Docs](https://x.dev/a_b_c) <https://y.dev/q?a=1&b=2|Y>')).toBe(
      '<a href="https://x.dev/a_b_c">Docs</a> <a href="https://y.dev/q?a=1&amp;b=2">Y</a>',
    );
    // Not formatting: cron text, snake_case, code spans.
    expect(md('*/5 * * * * my_var_name `*x* _y_`')).toBe('*/5 * * * * my_var_name <code>*x* _y_</code>');
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
      title: 'Shop',
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
      plannedRuns: (_p: string, _from: number, to: number) =>
        to > Date.parse('2026-10-26T05:00:00Z')
          ? [{ id: 'sla', starts: [Date.parse('2026-10-26T05:00:00Z')] }]
          : [],
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

  it('puts failing jobs first on the home page, with the dashboard switcher', async () => {
    const r = await html('/');
    expect(r.body).toContain('Needs attention');
    expect(r.body).not.toContain('href="/inbox"');
    expect(r.body).toMatch(/SLA Report<\/a> failed/);
    expect(r.body).toContain('data-action="run" data-job="shop/sla"');
    expect(r.body).toContain('class="switch" href="https://shop.example/board"');
    expect(r.body).toContain('<span>Shop</span>'); // project title, not its name
    expect(r.body).toContain('href="/runs/2"'); // "Just ran"
    expect(r.body).not.toContain('prefers-color-scheme');
  });

  it('shows the schedule and an HTML 404 for unknown pages', async () => {
    const r = await html('/schedule');
    expect(r.body).toContain('Timeline');
    expect(r.body).toContain('href="/schedule?day=');
    const missing = await html('/nope');
    expect(missing.status).toBe(404);
    expect(missing.type).toContain('text/html');
    expect(missing.body).toContain('Not found');
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
    const { jobs } = (await r.json()) as { jobs: Array<{ id: string; upcoming?: string[] }> };
    expect(jobs[0]?.id).toBe('sla');
    expect(jobs[0]?.upcoming).toBeUndefined();
    const planned = (await fetch(`${base}/jobs?project=shop&upcoming=7`).then((x) => x.json())) as {
      jobs: Array<{ upcoming?: string[] }>;
    };
    expect(planned.jobs[0]?.upcoming).toEqual(['2026-10-26T05:00:00.000Z']);
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

describe('project tabs', () => {
  it('lists project pages in the sidebar, frames them on /p/ and proxies /app/ to the project app', async () => {
    const { createServer } = await import('node:http');
    const seen: { url?: string; prefix?: string; cookie?: string; body: string }[] = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({
          url: req.url,
          prefix: req.headers['x-tara-prefix'] as string | undefined,
          cookie: req.headers.cookie,
          body,
        });
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'board=1; Path=/' });
        res.end('<title>Posted</title>app page');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = (upstream.address() as AddressInfo).port;
    const project = (name: string, extra: Partial<Project['config']>): Project => ({
      dir: `/srv/${name}`,
      config: {
        name,
        slackChannel: 'C1',
        permissionMode: 'default',
        chatModel: 'opus',
        allowedTools: [],
        allowedUsers: [],
        billing: 'subscription',
        selfImprove: true,
        ...extra,
      },
    });
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [] } as unknown as Scheduler,
      store: new Store(':memory:'),
      projects: ['shop', 'blog'],
      log: { info() {}, warn() {}, error() {} },
      dashboard: {
        projects: [
          project('shop', {
            title: 'Shop',
            dashboardUrl: `http://127.0.0.1:${upPort}`,
            tabs: [
              { path: '/posted', label: 'Posted', icon: '📣' },
              { path: '/media', label: 'Media' },
            ],
          }),
          project('blog', { title: 'Blog', dashboardUrl: 'https://blog.example/' }),
        ],
        timeZone: 'UTC',
        agentName: 'Jarvis',
      },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const html = { accept: 'text/html' };

    const landing = await fetch(`${base}/p/shop`, { headers: html, redirect: 'manual' });
    expect(landing.status).toBe(302);
    expect(landing.headers.get('location')).toBe('/p/shop/posted');

    const page = await (await fetch(`${base}/p/shop/media/b-roll?q=1`, { headers: html })).text();
    expect(page).toContain('<iframe class="app-frame" src="/app/shop/media/b-roll?q=1"');
    expect(page).toContain('<div class="nav-group">Shop</div>');
    expect(page).toContain('href="/p/shop/posted" class="nav-item" data-app="shop" data-tab="/posted"');
    // The switcher keeps only dashboards that aren't tabs.
    expect(page).toContain('href="https://blog.example/"');
    expect(page).not.toContain(`127.0.0.1:${upPort}`);

    const proxied = await fetch(`${base}/app/shop/api/media?folder=x`, {
      method: 'POST',
      body: 'hello',
      headers: { cookie: 'tara_token=secret; board=1; tara_admin=key' },
    });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('set-cookie')).toBe('board=1; Path=/');
    expect(seen.at(-1)).toEqual({
      url: '/api/media?folder=x',
      prefix: '/app/shop',
      cookie: 'board=1',
      body: 'hello',
    });
    await fetch(`${base}/app/shop`);
    expect(seen.at(-1)?.url).toBe('/');

    // Unknown projects and projects without tabs aren't proxied.
    expect((await fetch(`${base}/app/blog/x`)).status).toBe(404);
    expect((await fetch(`${base}/app/nope/x`)).status).toBe(404);

    upstream.close();
    server.close();
  });
});

describe('home page', () => {
  const NOW = Date.parse('2026-11-10T05:00:00Z');
  const ctx: DashboardContext = {
    projects: [
      { dir: '/r/shop', config: { name: 'shop', title: 'Shop' } },
      { dir: '/r/jobs', config: { name: 'jobs', title: 'Job Search' } },
    ] as unknown as Project[],
    timeZone: 'UTC',
    agentName: 'Jarvis',
  };
  const run = (id: number, jobId: string, status: string, extra: Partial<StoredRun> = {}): StoredRun => ({
    id,
    kind: 'job',
    project: 'shop',
    jobId,
    startedAt: NOW - id * 60_000,
    endedAt: NOW - id * 60_000 + 5000,
    status,
    ...extra,
  });
  const job = (id: string, extra: Partial<JobView> = {}): JobView => ({
    id,
    name: id.toUpperCase(),
    enabled: true,
    running: false,
    tz: 'UTC',
    skills: [],
    model: 'opus',
    project: 'shop',
    recent: [],
    nextRun: new Date(NOW + 10 * 60_000),
    ...extra,
  });
  const item = (id: string, project: string, kind: string, mode: 'queue' | 'resume', age: number): Item =>
    ({ id, project, kind, mode, title: `Card ${id}`, createdAt: NOW - age * 60_000 }) as Item;

  const page = homePage(ctx, {
    jobs: [
      job('ga4', { running: true, liveSessionId: 'live-1' }),
      job('watch', { everyMs: 10 * 60_000 }),
      job('daily'),
    ],
    latest: [
      run(1, 'ga4', 'ok', { sessionId: 'sess-1', output: '📊 *GA4 weekly:* 841 sessions\n• more' }),
      run(2, 'sla', 'failed', { error: 'login expired\nstack', output: 'Portal down' }),
    ],
    quietRuns: 12,
    pending: [
      item('a', 'jobs', 'application', 'queue', 600),
      item('b', 'jobs', 'application', 'queue', 30),
      item('c', 'jobs', 'email', 'queue', 20),
      item('d', 'shop', 'decision', 'resume', 5),
    ],
    usage: { share: 0.22, window: 'five_hour' },
    uptimeSeconds: 600,
    now: NOW,
  });

  it('links runs to their transcript, with the first line of what happened', () => {
    expect(page).toContain(
      'href="/sessions/sess-1">GA4</a><span class="line" title="📊 GA4 weekly: 841 sessions"',
    );
    expect(page).toContain('href="/runs/2">sla</a><span class="line" title="login expired"'); // no session: the run page
    expect(page).toContain('12 more runs in the last 24 hours found nothing to do');
    expect(page).toContain('● Running now: <a href="/sessions/live-1">GA4</a>');
  });

  it('keeps frequent jobs out of "Coming up" and shows usage', () => {
    expect(page).toContain('Also every 10m</span><span><a href="/jobs#job-shop-watch">WATCH</a>');
    expect(page).toContain('<a href="/jobs#job-shop-daily">DAILY</a><span class="tag dim">Shop</span></li>');
    expect(page).not.toMatch(/<a href="\/jobs#job-shop-watch">WATCH<\/a><span class="tag/);
    expect(page).toContain('<b>22%</b><span>Claude usage · 5h window</span>');
  });

  it('breaks waiting approvals down by project and kind, and lists the cards to start with', () => {
    expect(page).toContain(
      'Job Search: 3 waiting</b><span class="meta"><span>2 applications · 1 email</span><span>oldest 10h</span>',
    );
    expect(page.indexOf('Job Search: 3 waiting')).toBeLessThan(page.indexOf('Shop: 1 waiting'));
    // A card a run waits on comes first, then the oldest.
    const first = page.slice(page.indexOf('Start with these'));
    expect(first.indexOf('#item-d')).toBeLessThan(first.indexOf('#item-a'));
    expect(first).toContain('a run is waiting');
    expect(first).not.toContain('#item-c');
  });

  it('reads a headline out of Slack-style Markdown', () => {
    expect(
      headline(run(3, 'x', 'ok', { output: '\n## *Done* with <https://a.b|the page> and _all_ of `it`' })),
    ).toBe('Done with the page and all of it');
    expect(headline(run(3, 'x', 'silent'))).toBe('');
  });

  it('shows a session without a transcript as its run, and a running one live', () => {
    const r = run(4, 'ga4', 'failed', { sessionId: 's', error: 'timed out', output: 'Half **done**' });
    const old = sessionPage(ctx, undefined, 's', undefined, { jobName: 'GA4', run: r });
    expect(old).toContain('<a href="/runs/4">Run details</a>');
    expect(old).toContain('<pre>timed out</pre>');
    expect(old).toContain('Half <b>done</b>');
    const live = sessionPage(ctx, undefined, 's', undefined, { run: { ...r, status: 'ok' }, running: true });
    expect(live).toContain('● running');
    expect(live).toContain('data-refresh="1"');
  });
});
