import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../src/config/schema.js';
import {
  browserUrlOf,
  loadLogins,
  loginsFileSchema,
  projectBrowser,
  projectNeeds,
  SiteScanner,
  sitesIn,
} from '../src/http/browser-usage.js';
import { browsersPage } from '../src/http/browsers.js';
import type { DashboardContext } from '../src/http/dashboard.js';
import { transcriptPath } from '../src/http/transcript.js';

const call = (name: string, url: string, at = '2026-11-09T10:00:00Z') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: { content: [{ type: 'tool_use', id: 't', name, input: { url } }] },
  });

describe('sitesIn', () => {
  it('collects the hosts browser tools opened, with the last time', () => {
    const jsonl = [
      call('mcp__chrome__navigate_page', 'https://www.linkedin.com/jobs', '2026-11-09T10:00:00Z'),
      call('mcp__chrome__new_page', 'https://www.linkedin.com/feed', '2026-11-09T11:00:00Z'),
      call('mcp__plugin_playwright_playwright__browser_navigate', 'https://x.com/home'),
      call('mcp__tara__send_file', 'https://not-a-browser.example/'),
      call('mcp__chrome__navigate_page', 'chrome://new-tab-page/'),
      call('mcp__chrome__navigate_page', 'http://127.0.0.1:4000/'),
      call('WebFetch', 'https://docs.example/'),
      'not json "tool_use" mcp__',
    ].join('\n');
    expect([...sitesIn(jsonl)]).toEqual([
      ['www.linkedin.com', Date.parse('2026-11-09T11:00:00Z')],
      ['x.com', Date.parse('2026-11-09T10:00:00Z')],
    ]);
  });
});

describe('browserUrlOf / projectBrowser', () => {
  it('reads the Chrome address from the MCP server arguments', () => {
    expect(browserUrlOf(['-y', 'chrome-devtools-mcp@latest', '--browserUrl=http://127.0.0.1:9222'])).toBe(
      'http://127.0.0.1:9222',
    );
    expect(browserUrlOf(['chrome-devtools-mcp', '--browser-url', 'http://127.0.0.1:9223/'])).toBe(
      'http://127.0.0.1:9223',
    );
    expect(browserUrlOf(['@playwright/mcp', '--cdp-endpoint=http://127.0.0.1:9224'])).toBe(
      'http://127.0.0.1:9224',
    );
    expect(browserUrlOf(['chrome-devtools-mcp', '--isolated'])).toBeUndefined();
  });

  it('tells a shared Chrome from a server that starts its own', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tara-mcp-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          chrome: {
            command: 'npx',
            args: ['-y', 'chrome-devtools-mcp', '--browserUrl=http://127.0.0.1:9222'],
          },
          pw: { command: 'npx', args: ['@playwright/mcp'] },
          db: { command: 'postgres-mcp' },
        },
      }),
    );
    expect(projectBrowser(dir)).toEqual({
      cdpUrl: 'http://127.0.0.1:9222',
      ownBrowser: true,
      servers: ['chrome', 'pw'],
    });
    expect(projectBrowser(path.join(dir, 'missing'))).toEqual({ servers: [] });
  });
});

describe('SiteScanner and projectNeeds', () => {
  const NOW = Date.parse('2026-11-10T00:00:00Z');

  function setupProjects() {
    const root = mkdtempSync(path.join(tmpdir(), 'tara-sites-'));
    const config = path.join(root, 'claude');
    const projects = ['shop', 'jobs'].map((name) => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      return { dir, config: { name, title: name === 'shop' ? 'Shop' : 'Job Search' } } as unknown as Project;
    });
    const write = (p: Project, sid: string, lines: string[], mtime = NOW) => {
      const file = transcriptPath(p.dir, sid, config);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, lines.join('\n'));
      utimesSync(file, mtime / 1000, mtime / 1000);
    };
    return { config, projects, write };
  }

  it('splits each project’s sites by job and chat, and marks shared ones', async () => {
    const { config, projects, write } = setupProjects();
    const [shop, jobs] = projects as [Project, Project];
    const sid = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
    write(shop, sid(1), [call('mcp__chrome__navigate_page', 'https://seller.flipkart.com/')]);
    write(shop, sid(2), [call('mcp__chrome__navigate_page', 'https://seller.flipkart.com/orders')]);
    write(shop, sid(3), [call('mcp__chrome__navigate_page', 'https://x.com/')]);
    write(jobs, sid(4), [call('mcp__chrome__navigate_page', 'https://x.com/search')]);
    // Older than the window: left out.
    write(jobs, sid(5), [call('mcp__chrome__navigate_page', 'https://old.example/')], NOW - 40 * 86_400_000);

    const scanner = new SiteScanner({ configDir: config, days: 30, now: () => NOW });
    await scanner.scan(projects.map((p) => p.dir));
    const jobOf = new Map([
      [sid(1), 'orders'],
      [sid(2), 'orders'],
      [sid(4), 'x-scan'],
    ]);
    const needs = projectNeeds(
      projects,
      (p) => scanner.sessions(p.dir),
      (s) => jobOf.get(s),
      (p) => (p === 'shop' ? [{ id: 'orders', name: 'Orders', locks: ['chrome'] }] : []),
    );
    const [shopNeeds, jobNeeds] = needs;
    expect(shopNeeds?.sessions).toBe(3);
    expect(shopNeeds?.sites.map((s) => [s.host, s.sessions, [...s.jobs], s.chats, s.alsoIn])).toEqual([
      ['seller.flipkart.com', 2, [['orders', 2]], 0, []],
      ['x.com', 1, [], 1, ['jobs']],
    ]);
    expect(shopNeeds?.lockJobs.get('chrome')).toEqual([{ id: 'orders', name: 'Orders', locks: ['chrome'] }]);
    expect(jobNeeds?.sites.map((s) => s.host)).toEqual(['x.com']);

    const ctx: DashboardContext = { projects, timeZone: 'UTC', agentName: 'Jarvis', browsers: true };
    const html = browsersPage(ctx, {
      browsers: [
        { lock: 'chrome', cdpUrl: 'http://127.0.0.1:9222', up: true, version: 'Chrome/142', tabs: 2 },
      ],
      needs,
      jobNames: new Map([['shop:orders', 'Orders']]),
      scanning: false,
      days: 30,
      now: NOW,
    });
    expect(html).toContain('Logins Shop needs');
    expect(html).toContain('Logins Job Search needs');
    expect(html).toContain('seller.flipkart.com');
    expect(html).toContain('Orders ×2');
    expect(html).toContain('also Job Search');
    expect(html).toContain('Shop · 1 job');
    expect(html).toContain('No logins written down');
    expect(html).toContain('href="/browsers"');
  });

  it('matches written-down logins to the sessions that used their sites', async () => {
    const { config, projects, write } = setupProjects();
    const [shop, jobs] = projects as [Project, Project];
    const sid = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
    write(shop, sid(1), [
      call('mcp__chrome__navigate_page', 'https://studio.youtube.com/'),
      call('mcp__chrome__navigate_page', 'https://ads.google.com/'),
    ]);
    write(shop, sid(2), [call('mcp__chrome__navigate_page', 'https://ads.google.com/')]);
    write(shop, sid(3), [call('mcp__chrome__navigate_page', 'https://www.amazon.in/')]);
    write(shop, sid(4), [call('mcp__chrome__navigate_page', 'https://dash.cloudflare.com/')]);
    write(shop, sid(5), [call('mcp__chrome__navigate_page', 'https://dash.cloudflare.com/x')]);
    write(jobs, sid(6), [call('mcp__chrome__navigate_page', 'https://acme.wd5.myworkdayjobs.com/apply')]);
    const scanner = new SiteScanner({ configDir: config, now: () => NOW });
    await scanner.scan(projects.map((p) => p.dir));
    const files: Record<string, unknown> = {
      shop: {
        logins: [
          {
            service: 'Google',
            account: 'brand@example.com',
            sites: ['studio.youtube.com', 'ads.google.com'],
          },
          { service: 'Google', account: 'me@example.dev', sites: ['search.google.com'] },
          { service: 'Meta', sites: ['www.instagram.com'] },
        ],
        public: ['www.amazon.in'],
      },
      jobs: {
        logins: [
          { service: 'Workday', account: 'me@example.dev', sites: ['*.myworkdayjobs.com'] },
          { service: 'google', account: 'ME@example.dev', sites: ['accounts.google.com'] },
          { service: 'Meta', sites: ['www.instagram.com'] },
        ],
      },
    };
    const needs = projectNeeds(
      projects,
      (p) => scanner.sessions(p.dir),
      (s) => (s === sid(1) ? 'publisher' : undefined),
      () => [],
      (p) => loginsFileSchema.parse(files[p.config.name]),
    );
    const [shopNeeds, jobNeeds] = needs;
    const brand = shopNeeds?.logins?.[0];
    // Two sessions used the brand account: one session opening both of its sites counts once.
    expect([brand?.sessions, [...(brand?.jobs ?? [])], brand?.chats]).toEqual([2, [['publisher', 1]], 1]);
    expect(shopNeeds?.logins?.[1]?.sessions).toBe(0);
    expect(shopNeeds?.logins?.[1]?.alsoIn).toEqual(['jobs']); // same service and account, any case
    expect(shopNeeds?.logins?.[2]?.alsoIn).toEqual([]); // no account written down: not the same login
    expect(jobNeeds?.logins?.[0]?.sessions).toBe(1); // *.myworkdayjobs.com
    expect(shopNeeds?.unlisted.map((s) => s.host)).toEqual(['dash.cloudflare.com']);

    const ctx: DashboardContext = { projects, timeZone: 'UTC', agentName: 'Jarvis', browsers: true };
    const html = browsersPage(ctx, {
      browsers: [],
      needs,
      jobNames: new Map(),
      scanning: false,
      days: 30,
      now: NOW,
    });
    expect(html).toContain('brand@example.com');
    expect(html).toContain('1 site opened often with no login listed');
    expect(html).toContain('Logins more than one project needs');
  });

  it('reports a logins file that does not parse', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tara-logins-'));
    mkdirSync(path.join(dir, '.tara'));
    writeFileSync(path.join(dir, '.tara/logins.json'), JSON.stringify({ logins: [{ service: 'X' }] }));
    expect(loadLogins(dir)).toMatchObject({ error: expect.stringContaining('logins.0.sites') });
    expect(loadLogins(path.join(dir, 'none'))).toBeUndefined();
  });

  it('reads a transcript again only when it changed', async () => {
    const { config, projects, write } = setupProjects();
    const shop = projects[0] as Project;
    const sid = '00000000-0000-0000-0000-000000000001';
    write(shop, sid, [call('mcp__chrome__navigate_page', 'https://a.example/')]);
    let now = NOW;
    const scanner = new SiteScanner({ configDir: config, now: () => now, everySeconds: 60 });
    await scanner.scan([shop.dir]);
    write(shop, sid, [call('mcp__chrome__navigate_page', 'https://b.example/')], NOW + 1000);
    await scanner.scan([shop.dir]); // too soon: nothing re-read
    expect([...(scanner.sessions(shop.dir).get(sid)?.keys() ?? [])]).toEqual(['a.example']);
    now += 61_000;
    await scanner.scan([shop.dir]);
    expect([...(scanner.sessions(shop.dir).get(sid)?.keys() ?? [])]).toEqual(['b.example']);
  });
});
