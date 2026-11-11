import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project, QueueConfig } from '../src/config/schema.js';
import { allowList } from '../src/http/access.js';
import { approvalsPage, kindLabel, mediaHtml, safeMediaUrl } from '../src/http/approvals.js';
import { cronText } from '../src/http/cron-text.js';
import {
  type DashboardContext,
  esc,
  headline,
  homePage,
  type JobView,
  jobsPage,
  jobWeeks,
  lengthOff,
  md,
  modelUses,
  sessionPage,
  sessionsPage,
} from '../src/http/dashboard.js';
import { queuePage } from '../src/http/queue.js';
import { crossSite, startHttpServer } from '../src/http/server.js';
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
    expect(cronText('*/10 * * * *')).toBe('Every 10 min');
    expect(cronText('0 * * * *')).toBe('Hourly');
    expect(cronText('5 * * * *')).toBe('Hourly at :05');
    expect(cronText('15 */2 * * *')).toBe('Every 2 hours at :15');
    expect(cronText('*/5 9-18 * * 1-5')).toBe('*/5 9-18 * * 1-5');
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
      selfImprove: 'trouble',
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

describe('crossSite', () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, headers }) as never;
  it('refuses writes from other sites and rebound Host names on a loopback server', () => {
    expect(crossSite(req('POST', { host: '127.0.0.1:4100' }), '127.0.0.1')).toBeUndefined(); // curl
    expect(
      crossSite(req('POST', { host: '127.0.0.1:4100', origin: 'http://127.0.0.1:4100' }), '127.0.0.1'),
    ).toBeUndefined();
    expect(
      crossSite(req('POST', { host: '127.0.0.1:4100', origin: 'https://evil.example' }), '127.0.0.1'),
    ).toMatch(/cross-site POST/);
    expect(crossSite(req('POST', { host: 'x:1', origin: 'null' }), '0.0.0.0')).toMatch(/cross-site/);
    expect(crossSite(req('GET', { host: 'evil.example:4100' }), '127.0.0.1')).toMatch(/unexpected Host/);
    expect(crossSite(req('GET', { host: 'localhost:4100' }), '127.0.0.1')).toBeUndefined();
    // Bound to every interface: any Host (a LAN or tailnet name), still no cross-site writes.
    expect(crossSite(req('GET', { host: 'box.tailnet:4100' }), '0.0.0.0')).toBeUndefined();
  });
});

describe('card media', () => {
  it('links only web and same-site URLs', () => {
    expect(safeMediaUrl('https://cdn.example/a.png')).toBe(true);
    expect(safeMediaUrl('/files/a.pdf')).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,x',
      '//evil.example/a',
      '/\\evil',
    ])
      expect(safeMediaUrl(bad)).toBe(false);
    const html = mediaHtml({
      media: [
        { type: 'file', url: 'javascript:fetch("/items/x/decide")' },
        { type: 'image', url: 'https://cdn.example/a.png' },
      ],
    } as Item);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('https://cdn.example/a.png');
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
        if (req.headers['x-tara-admin']) throw new Error('admin header leaked to the app');
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
        selfImprove: 'trouble',
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

    // A path that would resolve to another host stays on the app's own origin.
    await fetch(`${base}/app/shop//evil.example/x`, { headers: { 'x-tara-admin': 'key' } });
    expect(seen.at(-1)?.url).toBe('//evil.example/x');

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
      { ...item('d', 'shop', 'decision', 'resume', 5), jobId: 'daily' },
      item('n1', 'jobs', 'notice', 'resume', 2),
      item('n2', 'jobs', 'notice', 'resume', 3),
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
    // Notices: one line, out of the counts and the cards to start with.
    expect(page).toContain('2 notices to glance at');
    expect(first).not.toContain('#item-n1');
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
    expect(live).toContain('id="live" data-session="s"');
    expect(live).not.toContain('data-refresh="1"'); // the live card polls instead
  });
});

describe('models section', () => {
  const projects = [
    { dir: '/r/shop', config: { name: 'shop', title: 'Shop', chatModel: 'sonnet', selfImprove: 'always' } },
    { dir: '/r/blog', config: { name: 'blog', chatModel: 'sonnet', selfImprove: 'off' } },
  ] as unknown as Project[];
  const job = (name: string, extra: Partial<JobView> = {}) =>
    ({
      id: name,
      name,
      enabled: true,
      running: false,
      tz: 'UTC',
      skills: [],
      model: 'sonnet',
      ...extra,
    }) as JobView;
  const jobs = [
    job('SLA', { stepModels: ['haiku'] }),
    job('Audit', { harness: 'agy', model: 'gemini-3-pro', handoff: { harness: 'claude', model: 'opus' } }),
    job('GA4'),
  ];

  it('lists each purpose with its model, most-used first', () => {
    const uses = modelUses(projects, jobs, {
      voice: ['gemini-a', 'gemini-b'],
    });
    expect(uses).toEqual([
      { purpose: 'Chat', model: 'sonnet', used: 'Shop, blog' },
      { purpose: 'Jobs', model: 'sonnet', used: '2 jobs: SLA, GA4' },
      { purpose: 'Jobs', model: 'agy · gemini-3-pro', used: '1 job: Audit' },
      { purpose: 'Job steps', model: 'haiku', used: '1 job: SLA' },
      { purpose: 'After approval', model: 'opus', used: '1 job: Audit' },
      {
        purpose: 'Learning',
        model: 'same as the run',
        used: 'a turn after a chat or job run, in its session',
      },
      {
        purpose: 'Voice notes',
        model: 'gemini-a → gemini-b',
        used: "speech-to-text when Slack didn't transcribe, tried in order",
      },
    ]);
  });

  it('shows on the home page with the effort', () => {
    const page = homePage(
      { projects, timeZone: 'UTC', agentName: 'Jarvis' },
      {
        jobs: [],
        latest: [],
        quietRuns: 0,
        pending: [],
        uptimeSeconds: 1,
        now: 0,
        models: modelUses(projects, jobs),
        effort: 'high',
      },
    );
    expect(page).toContain('<h2>Models</h2><span>effort high</span>');
    expect(page).toContain('<span class="when">Job steps</span>');
    expect(page).toContain('<code>agy · gemini-3-pro</code>');
    expect(page).not.toContain('Voice notes');
  });
});

describe('a running session', () => {
  const store = new Store(':memory:');
  const SESSION = '22222222-2222-4333-8444-555555555555';
  const task = {
    id: 't1',
    project: 'shop',
    kind: 'job' as const,
    title: 'SLA Report',
    thread: { channel: 'C1', ts: '200.1' },
    jobId: 'sla',
    startedAt: Date.now() - 65_000,
    status: 'running' as 'running' | 'aborted',
    steps: [
      {
        id: 's1',
        text: 'Reading <b>notes</b>',
        state: 'ok' as const,
        depth: 0 as const,
        at: Date.now() - 60_000,
      },
    ],
    stepCount: 1,
    text: 'Checking the portal',
  };
  const stopped: string[] = [];
  let base = '';
  let close = () => {};

  beforeAll(async () => {
    store.saveSession({
      threadKey: 'C1:200.1',
      project: 'shop',
      sessionId: SESSION,
      model: 'opus',
      started: true,
    });
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [], plannedRuns: () => [] } as unknown as Scheduler,
      store,
      projects: ['shop'],
      log: { info() {}, warn() {}, error() {} },
      adminToken: 'key',
      decisionsFromLocal: true,
      activity: {
        tasks: () => [task],
        usage: () => undefined,
        stop: (id: string) => {
          stopped.push(id);
          return true;
        },
      },
      dashboard: {
        projects: [{ dir: '/srv/repos/shop', config: { name: 'shop', title: 'Shop' } } as unknown as Project],
        timeZone: 'UTC',
        agentName: 'Jarvis',
      },
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it('shows its steps live, and only an unlocked browser can stop it', async () => {
    const page = await fetch(`${base}/sessions/${SESSION}`, { headers: { accept: 'text/html' } }).then((r) =>
      r.text(),
    );
    expect(page).toContain(`id="live" data-session="${SESSION}"`);
    expect(page).toContain('Unlock to stop');
    const unlocked = await fetch(`${base}/sessions/${SESSION}`, {
      headers: { accept: 'text/html', cookie: 'tara_admin=key' },
    }).then((r) => r.text());
    expect(unlocked).toContain('id="live-stop"');

    const live = (await fetch(`${base}/sessions/${SESSION}/live`).then((r) => r.json())) as {
      running: boolean;
      task: { steps: { text: string }[] };
    };
    expect(live.running).toBe(true);
    expect(live.task.steps[0]?.text).toBe('Reading <b>notes</b>');

    expect((await fetch(`${base}/sessions/${SESSION}/stop`, { method: 'POST' })).status).toBe(403);
    const ok = await fetch(`${base}/sessions/${SESSION}/stop`, {
      method: 'POST',
      headers: { cookie: 'tara_admin=key' },
    });
    expect(ok.status).toBe(200);
    expect(stopped).toEqual(['t1']);

    task.status = 'aborted';
    const ended = (await fetch(`${base}/sessions/${SESSION}/live`).then((r) => r.json())) as {
      running: boolean;
    };
    expect(ended.running).toBe(false);
    const after = await fetch(`${base}/sessions/${SESSION}/stop`, {
      method: 'POST',
      headers: { cookie: 'tara_admin=key' },
    });
    expect(after.status).toBe(409);
  });
});

describe('approvals page', () => {
  const NOW = Date.parse('2026-11-10T05:00:00Z');
  const ctx: DashboardContext = {
    projects: [
      { dir: '/r/shop', config: { name: 'shop', title: 'Shop', approvals: { expireDays: 7 } } },
      { dir: '/r/jobs', config: { name: 'jobs', title: 'Job Search' } },
    ] as unknown as Project[],
    timeZone: 'UTC',
    agentName: 'Jarvis',
  };
  const card = (
    id: string,
    kind: string,
    mode: 'queue' | 'resume',
    hours: number,
    extra: Partial<Item> = {},
  ): Item =>
    ({
      id,
      project: 'shop',
      kind,
      mode,
      title: `Card ${id}`,
      body: 'Details',
      media: [],
      fields: [],
      checks: [],
      options: kind === 'notice' ? ['Seen', 'Something is wrong'] : ['Approve', 'Skip'],
      runNow: false,
      status: 'pending',
      createdAt: NOW - hours * 3_600_000,
      updatedAt: NOW,
      ...extra,
    }) as Item;
  const items = [
    card('q-new', 'decision', 'resume', 1),
    card('q-run', 'login', 'resume', 2, { jobId: 'scout', source: 'scout' }),
    card('q-old', 'decision', 'resume', 150),
    card('d1', 'application', 'queue', 5),
    card('d2', 'application', 'queue', 6),
    card('d3', 'seo-code-change', 'queue', 7),
    card('n1', 'notice', 'resume', 3),
    card('n2', 'notice', 'resume', 4),
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => card(`k${i}`, `kind-${k}`, 'queue', 8)),
  ];
  const page = approvalsPage(ctx, {
    tab: 'waiting',
    items,
    counts: { waiting: 14, done: 500 },
    queues: () => ({}),
    canDecide: true,
    now: NOW,
    jobNames: new Map([['shop:scout', 'Morning Scout']]),
  });
  const at = (text: string) => page.indexOf(text);

  it('puts questions first (paused runs, then the oldest), then drafts by kind, then notices', () => {
    expect(at('Needs your answer')).toBeLessThan(at('Drafts to send'));
    expect(at('Drafts to send')).toBeLessThan(at('For your information'));
    expect(at('id="item-q-run"')).toBeLessThan(at('id="item-q-old"'));
    expect(at('id="item-q-old"')).toBeLessThan(at('id="item-q-new"'));
    expect(page).toContain(
      '<h3>Application</h3><span>2</span><button type="button" class="btn ghost more" data-bulk="Approve"',
    );
    expect(page).toContain('data-bulk="Seen" data-notice data-label="Mark all seen"');
  });

  it('merges several drafts of one kind into one card, and says why an option is off', () => {
    expect(page).toContain(
      '<div data-group class="card merged"><div class="sec-head sub-head"><h3>Application</h3>',
    );
    // One draft of a kind stays a card of its own.
    expect(page).not.toContain('class="card merged"><div class="sec-head sub-head"><h3>SEO code change</h3>');
    const stuck = approvalsPage(ctx, {
      tab: 'waiting',
      items: [
        card('b1', 'application', 'queue', 1, {
          checks: [{ text: 'Role closed', blocking: true }],
          reply: 'Use the new link',
        }),
        card('b2', 'application', 'queue', 2),
      ],
      counts: { waiting: 2, done: 0 },
      queues: () => ({}),
      canDecide: true,
      now: NOW,
    });
    expect(stuck).toContain('<span>2 · 1 need a fix</span>');
    expect(stuck).toContain('disabled title="Can&#39;t approve yet: Role closed"');
    expect(stuck).toContain('<div class="why">⛔ Approve is off: Role closed.');
    expect(stuck).toContain('data-open-note>Fix it…</button>');
    expect(stuck).toContain('✏️ Revising: Use the new link. Jarvis is on it');
  });

  it('folds cards, names the job, warns before expiry and caps the Done count', () => {
    expect(page).toContain('class="card item" id="item-q-new"');
    expect(page).toContain('data-fold aria-expanded="false"');
    expect(page).toContain('<span>Morning Scout</span><span class="tag warn">a run is waiting</span>');
    expect(page.slice(at('id="item-q-old"'), at('id="item-q-new"'))).toContain('expires in 18h');
    expect(page.slice(at('id="item-q-new"'), at('id="item-d1"'))).not.toContain('expires'); // 1h old: no warning
    expect(page).toContain('Done<small>500+</small>');
  });

  it('shows the six biggest kinds and folds the rest under More, with readable names', () => {
    expect(kindLabel('seo-code-change')).toBe('SEO code change');
    expect(kindLabel('ga4-admin')).toBe('GA4 admin');
    expect(kindLabel('client-x-reply')).toBe('Client X reply');
    const more = page.slice(at('class="kinds-more"'));
    expect(more).toContain('More<small>');
    expect(page.slice(0, at('class="kinds-more"'))).toContain('Application<small>2</small>');
  });
});

describe('queue page', () => {
  const NOW = Date.parse('2026-11-10T05:00:00Z'); // 10:30 IST
  const ctx: DashboardContext = {
    projects: [{ dir: '/r/shop', config: { name: 'shop', title: 'Shop' } }] as unknown as Project[],
    timeZone: 'Asia/Kolkata',
    agentName: 'Jarvis',
  };
  const QUEUES = {
    content: {
      executor: { job: 'publish' },
      batch: 1,
      slots: '30 18 * * *',
      caps: {},
      gapMinutes: 0,
      reorder: true,
    },
    channel: {
      executor: { job: 'publish' },
      batch: 1,
      fills: 'content',
      caps: {},
      gapMinutes: 0,
      reorder: true,
    },
    linkedin: {
      executor: { external: true },
      batch: 1,
      windows: { EU: { tz: 'Europe/London', days: 'tue-thu', from: '09:00', to: '11:00' } },
      caps: {},
      gapMinutes: 0,
    },
  } as unknown as Record<string, QueueConfig>;
  const draft = (id: string, queue: string, days: number, extra: Partial<Item> = {}): Item =>
    ({
      id,
      project: 'shop',
      kind: 'reel',
      mode: 'queue',
      queue,
      title: `Reel ${id}`,
      body: `Caption of **${id}**`,
      media: [],
      fields: [{ key: 'title', label: 'YouTube title', type: 'text', value: `Title ${id}` }],
      checks: [],
      options: ['Approve'],
      runNow: false,
      status: 'approved',
      decidedAt: NOW - days * 86_400_000,
      createdAt: NOW - days * 86_400_000,
      updatedAt: NOW,
      ...extra,
    }) as Item;
  const data = (approved: Item[], finished: Item[] = []) =>
    queuePage(ctx, {
      approved,
      running: [],
      pending: [],
      finished,
      queues: () => QUEUES,
      canDecide: false,
      now: NOW,
    });

  it('gives every row its slot, and a filling queue waits for the queue it fills', () => {
    const page = data(
      [draft('a', 'content', 7), draft('b', 'content', 4), draft('c', 'channel', 10)],
      [draft('old', 'content', 9, { status: 'done', finishedAt: NOW - 16 * 3_600_000 })],
    );
    expect(page).toContain('goes out Tue 10 Nov, 6:30 pm');
    expect(page).toContain('~ Wed 11 Nov, 6:30 pm');
    expect(page).toContain("after content's 2 items");
    expect(page).toContain('waits while content has 2');
    expect(page).toContain('<span>last out 16h ago</span>');
    // Waiting more than 3 days: amber.
    expect(page).toContain('<span class="tag warn">approved 7d ago</span>');
  });

  it('opens a row to show the approved draft, and opens "Other queues" when something there is old', () => {
    const page = data([draft('a', 'content', 1), draft('l', 'linkedin', 15)]);
    expect(page).toContain(
      '<button type="button" class="fold-btn" data-fold aria-expanded="false"><span class="title">Reel a</span>',
    );
    expect(page).toContain('<div class="fold">Caption of <b>a</b>');
    expect(page).toContain('<b>YouTube title</b><div>Title a</div>');
    expect(page).toContain('<span>approved 1d ago</span>');
    expect(page).toContain('<details class="others" open>');
    expect(data([draft('a', 'content', 1), draft('l', 'linkedin', 1)])).toContain('<details class="others">');
  });
});

describe('jobs page', () => {
  const NOW = Date.parse('2026-11-10T05:00:00Z');
  const ctx: DashboardContext = {
    projects: [
      { dir: '/r/shop', config: { name: 'shop', title: 'Shop' } },
      { dir: '/r/empty', config: { name: 'empty', title: 'Empty' } },
    ] as unknown as Project[],
    timeZone: 'UTC',
    agentName: 'Jarvis',
  };
  const run = (jobId: string, minutes: number, cost: number, status = 'ok'): StoredRun => ({
    id: 1,
    kind: 'job',
    project: 'shop',
    jobId,
    startedAt: NOW - 3_600_000,
    endedAt: NOW - 3_600_000 + minutes * 60_000,
    status,
    costUsd: cost,
  });
  const weeks = jobWeeks([
    ...[3, 4, 4, 5].map((m, i) => ({ ...run('review', m, 10), id: i + 1, threadKey: `C1:${i}` })),
    run('review', 0, 0, 'silent'),
    run('watch', 1, 2),
    // A long UI test, continued twice after cards in the same thread: only its first run counts.
    ...[170, 2, 1].map((m, i) => ({
      ...run('ui', m, 1),
      id: 10 + i,
      threadKey: 'C1:ui',
      startedAt: NOW - 9e6 + i * 2e5,
    })),
    ...[160, 180].map((m, i) => ({ ...run('ui', m, 1), id: 20 + i, threadKey: `C1:ui${i}` })),
  ]);
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
    cron: '0 10 * * 6',
    week: weeks.get(`shop:${id}`),
    ...extra,
  });
  const page = jobsPage(
    ctx,
    [
      job('review', { durationMinutes: 45 }),
      job('watch', { cron: '*/10 * * * *' }),
      job('sender', { cron: undefined, queues: ['outbox'] }),
      job('filer', { cron: undefined }),
    ],
    NOW,
  );

  it("works out each job's week: runs, cost and how long a run that worked takes", () => {
    expect(weeks.get('shop:review')).toEqual({ runs: 5, costUsd: 40, typicalMinutes: 4 });
    expect(weeks.get('shop:watch')?.typicalMinutes).toBeUndefined(); // fewer than 3 runs that worked
    expect(weeks.get('shop:ui')?.typicalMinutes).toBe(180); // not 2: continuations don't count
    expect(lengthOff(45, 4)).toBe(true);
    expect(lengthOff(15, 20)).toBe(false);
  });

  it('shows usage, a far-off planned length with its fix, plain schedules, and folds queue jobs', () => {
    expect(page).toContain('≈$42 of usage at API prices; the top 3 jobs used 100%');
    expect(page).toContain('≈95% of job usage · 5 runs · $40 this week');
    expect(page).toContain(
      'takes ~4 min (planned 45)</span><button type="button" class="btn quiet" data-duration="shop/review" data-minutes="4"',
    );
    expect(page).toContain('<span>Every 10 min</span>');
    expect(page).toContain('<details class="queue-jobs" data-group-box><summary>Run by a queue · 1 job');
    expect(page.indexOf('id="job-shop-sender"')).toBeGreaterThan(page.indexOf('class="queue-jobs"'));
    expect(page).toContain('none (executor of the outbox queue)');
  });

  it('keeps on-demand jobs out of List and shows them in the On demand view', () => {
    expect(page).not.toContain('data-value="empty"');
    expect(page).toContain('data-filter="sort" data-value="usage"');
    expect(page).toContain('data-view="timeline">Timeline</a>');
    expect(page).toContain('data-length="shop/review" data-name="REVIEW" data-minutes="45"');
    expect(page).not.toContain('id="job-shop-filer"');
    expect(page).toContain('<a class="chip" href="/jobs?view=on-demand" data-view="ondemand">On demand</a>');
    const onDemand = jobsPage(
      ctx,
      [
        job('review'),
        job('sender', { cron: undefined, queues: ['outbox'] }),
        job('filer', { cron: undefined }),
      ],
      NOW,
      'ondemand',
    );
    expect(onDemand).toContain('id="job-shop-filer"');
    expect(onDemand).not.toContain('id="job-shop-review"');
    expect(onDemand).not.toContain('id="job-shop-sender"');
    expect(onDemand).toContain('data-view="ondemand" aria-current="page">On demand</a>');
    expect(onDemand).not.toContain('data-action="pause"');
    expect(onDemand).toContain('class="btn " data-action="run" data-job="shop/filer"');
    expect(onDemand).toContain('none (on demand: Run now, or ask in chat)');
    expect(onDemand).not.toContain('data-filter="sort"');
    expect(onDemand).toContain('id="q"');
  });
});

describe('sessions page', () => {
  const NOW = Date.parse('2026-11-10T05:00:00Z');
  const ctx: DashboardContext = {
    projects: [{ dir: '/r/shop', config: { name: 'shop', title: 'Shop' } }] as unknown as Project[],
    timeZone: 'UTC',
    agentName: 'Jarvis',
  };
  const session = (id: string, at: number, run?: Partial<StoredRun>) => ({
    threadKey: `C1:${id}`,
    project: 'shop',
    sessionId: id,
    model: 'opus',
    started: true,
    createdAt: at,
    updatedAt: at,
    turns: 1,
    lastRun: run
      ? ({
          id: 1,
          kind: 'job',
          project: 'shop',
          startedAt: at,
          endedAt: at + 60_000,
          status: 'ok',
          ...run,
        } as StoredRun)
      : undefined,
  });
  const page = sessionsPage(
    ctx,
    [
      session('chat-1', NOW - 3_600_000, { kind: 'chat' }),
      // A job whose last turn was a learning turn: still a job.
      session('job-1', NOW - 7_200_000, {
        kind: 'learn',
        jobId: 'prep',
        output: '🧾 *Prep:* 12 drafts ready\nmore',
      }),
      session('job-2', NOW - 20 * 3_600_000, {
        kind: 'job',
        jobId: 'audit',
        status: 'failed',
        error: 'login expired',
      }),
      // A reply in a job's thread: the last run is a chat turn, the thread is still the job's.
      { ...session('job-3', NOW - 21 * 3_600_000, { kind: 'chat' }), jobId: 'audit' },
      // No run recorded (a restart stopped it), but a job's prompt.
      { ...session('lost', NOW - 22 * 3_600_000), turns: 0 },
    ],
    new Map([['shop:prep', 'Form Prep']]),
    {},
    {
      preview: (_p, id) =>
        id === 'chat-1'
          ? 'check the redis health\n\nYour folders:\n- Scratch'
          : id === 'lost'
            ? '## Script Output\nThe following data'
            : undefined,
      runningThreads: new Set(['C1:chat-1']),
      now: NOW,
    },
  );

  it('titles chats by their first message and jobs by name, with what happened', () => {
    expect(page).toContain('💬 check the redis health');
    expect(page).toContain('⏱ Form Prep</span><span class="line">🧾 Prep: 12 drafts ready</span>');
    expect(page).toContain('<span class="line">login expired</span>');
    expect(page).toContain('💬 check the redis health</span>');
    expect(page).not.toContain('Your folders');
    expect(page).toContain('⏱ A job run with no record');
    expect(page).toContain('⏱ audit</span><span class="line">Last: a reply in its Slack thread</span>');
  });

  it('groups by day, marks running sessions and can be searched', () => {
    expect(page.indexOf('>Today</h3>')).toBeLessThan(page.indexOf('chat-1'));
    expect(page.indexOf('>Yesterday</h3>')).toBeGreaterThan(page.indexOf('job-1'));
    expect(page).toContain('<span class="tag">● running</span>');
    expect(page).toContain('id="sq"');
    expect(page).toContain('data-q="form prep 🧾 prep: 12 drafts ready prep shop"'); // title, what happened, job id, project
  });
});

describe('page scripts', () => {
  // A quote or backslash lost in a page's inline script stops every button on that page.
  const scripts = (html: string) =>
    [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
  const parses = (html: string) => {
    for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
    return scripts(html).length;
  };
  const NOW = Date.parse('2026-11-10T05:00:00Z');
  const ctx = {
    projects: [{ dir: '/r', config: { name: 'shop', title: 'Shop' } }],
    timeZone: 'UTC',
    agentName: 'Jarvis',
  } as unknown as DashboardContext;
  const item = {
    id: 'i1',
    project: 'shop',
    kind: 'decision',
    mode: 'resume',
    title: "It's a card",
    body: 'x',
    media: [],
    fields: [],
    checks: [],
    options: ['Approve', 'Skip'],
    runNow: false,
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Item;

  it('every page script is valid JavaScript', () => {
    expect(
      parses(
        approvalsPage(ctx, {
          tab: 'waiting',
          items: [item],
          counts: { waiting: 1, done: 0 },
          queues: () => ({}),
          canDecide: true,
          now: NOW,
        }),
      ),
    ).toBeGreaterThan(0);
    expect(
      parses(
        queuePage(ctx, {
          approved: [],
          running: [],
          pending: [],
          queues: () => ({}),
          canDecide: true,
          now: NOW,
        }),
      ),
    ).toBeGreaterThan(0);
    expect(parses(jobsPage(ctx, [], NOW))).toBeGreaterThan(0);
    expect(parses(sessionsPage(ctx, [], new Map(), {}, { now: NOW }))).toBeGreaterThan(0);
    expect(parses(sessionPage(ctx, undefined, 's', undefined, { running: true }))).toBeGreaterThan(0);
    expect(
      parses(homePage(ctx, { jobs: [], latest: [], quietRuns: 0, pending: [], uptimeSeconds: 0, now: NOW })),
    ).toBeGreaterThan(0);
  });
});
