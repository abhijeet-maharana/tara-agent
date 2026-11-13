import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type HostConfig, hostConfigSchema } from '../src/config/schema.js';
import type { ChatPort, SlackBlock } from '../src/sessions/manager.js';
import { type StreamChunk, StreamError, type StreamPort } from '../src/slack/reply.js';

/** In-memory ChatPort: records every call, both as structured lists and as one readable log. */
export class FakeChat implements ChatPort {
  posts: { thread: string; text: string; ts: string }[] = [];
  updates: { ts: string; text: string; blocks?: SlackBlock[] }[] = [];
  blockPosts: { thread: string; text: string; ts: string; blocks: SlackBlock[] }[] = [];
  uploads: { thread: string; file: string; data: string; comment?: string }[] = [];
  reactions: string[] = [];
  deleted: string[] = [];
  log: string[] = [];
  stream?: StreamPort;
  postAsUser?: (channel: string, text: string, threadTs?: string) => Promise<string>;
  private n = 0;

  /** `prefix` shapes the fake message ts: "bot." → bot.1, bot.2 … */
  constructor(private readonly prefix = 'ts') {}

  private nextTs() {
    return `${this.prefix}${++this.n}`;
  }
  async post(_c: string, thread: string | undefined, text: string) {
    const ts = this.nextTs();
    this.posts.push({ thread: thread ?? '', text, ts });
    this.log.push(`post ${thread ?? 'top'} ${ts}: ${text}`);
    return ts;
  }
  async postBlocks(_c: string, thread: string | undefined, text: string, blocks: SlackBlock[]) {
    const ts = this.nextTs();
    this.blockPosts.push({ thread: thread ?? '', text, ts, blocks });
    this.log.push(`blocks ${thread ?? 'top'} ${ts}: ${text}`);
    return ts;
  }
  async update(_c: string, ts: string, text: string, blocks?: SlackBlock[]) {
    this.updates.push({ ts, text, blocks });
    this.log.push(`update ${ts}: ${text}`);
  }
  async delete(_c: string, ts: string) {
    this.deleted.push(ts);
    this.log.push(`delete ${ts}`);
  }
  async uploadFile(_c: string, thread: string, file: { name: string; data: Buffer }, comment?: string) {
    this.uploads.push({ thread, file: file.name, data: file.data.toString(), comment });
    this.log.push(`upload ${thread}: ${file.name}`);
  }
  async react(_c: string, ts: string, emoji: string) {
    this.reactions.push(`+${emoji}@${ts}`);
  }
  async unreact(_c: string, ts: string, emoji: string) {
    this.reactions.push(`-${emoji}@${ts}`);
  }
  texts() {
    return this.posts.map((p) => p.text);
  }
}

/** A host config with the schema's defaults, for tests (no HTTP server). */
export function testHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    ...hostConfigSchema.parse({ projects: ['/repo'], timezone: 'UTC' }),
    stateDir: '/tmp',
    statusIntervalSeconds: 0,
    http: { enabled: false, bind: '127.0.0.1', port: 0, allowFrom: ['127.0.0.0/8'] },
    // Never touch a real Chrome on :9222 (the suite may run on the host that has one).
    browsers: [{ cdpUrl: 'http://127.0.0.1:9', lock: 'chrome', closeTabs: false, staleMinutes: 30 }],
    ...overrides,
  };
}

/** In-memory StreamPort that can fail the way Slack does. */
export class FakeStream implements StreamPort {
  disabled = false;
  calls: string[] = [];
  appended: StreamChunk[][] = [];
  /** Error code for every start() call. */
  failStart?: string;
  /** Error codes for the next append() calls, used one per call. */
  failAppends: string[] = [];
  /** What the reply reported (logged as warnings in the app). */
  problems: string[] = [];
  private n = 0;

  report(problem: string) {
    this.problems.push(problem);
  }

  async start(_c: string, thread: string, user: string) {
    if (this.failStart) throw new StreamError(this.failStart);
    const ts = `s${++this.n}`;
    this.calls.push(`start ${thread} for ${user} → ${ts}`);
    return ts;
  }
  async append(_c: string, ts: string, chunks: StreamChunk[]) {
    const fail = this.failAppends.shift();
    if (fail) throw new StreamError(fail);
    this.appended.push(chunks);
    this.calls.push(`append ${ts}: ${chunks.map((c) => c.type).join(',')}`);
  }
  async stop(_c: string, ts: string) {
    this.calls.push(`stop ${ts}`);
  }
  /** All streamed text, in order. */
  text(): string {
    return this.appended
      .flat()
      .map((c) => (c.type === 'markdown_text' ? c.text : ''))
      .join('');
  }
  /** Last title and each task's last status. */
  state(): { title?: string; tasks: Record<string, string> } {
    const tasks: Record<string, string> = {};
    let title: string | undefined;
    for (const c of this.appended.flat()) {
      if (c.type === 'plan_update') title = c.title;
      if (c.type === 'task_update') tasks[c.title] = c.status;
    }
    return { title, tasks };
  }
}

/** A fake Chrome DevTools HTTP endpoint holding page and other targets. */
export function fakeChrome(pages: Record<string, string>) {
  const targets = new Map(Object.entries(pages).map(([id, url]) => [id, { id, type: 'page', url }]));
  targets.set('sw', { id: 'sw', type: 'service_worker', url: 'https://x.com/sw.js' });
  const calls: string[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    calls.push(`${req.method} ${url}`);
    if (url === '/json/list') return res.end(JSON.stringify([...targets.values()]));
    if (url.startsWith('/json/close/')) {
      const ok = targets.delete(url.slice('/json/close/'.length));
      res.statusCode = ok ? 200 : 404;
      return res.end(ok ? 'Target is closing' : 'No such target');
    }
    if (url.startsWith('/json/new') && req.method === 'PUT') {
      const id = `new${++n}`;
      targets.set(id, { id, type: 'page', url: url.split('?')[1] ?? 'about:blank' });
      return res.end(JSON.stringify(targets.get(id)));
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise<{ url: string; calls: string[]; pages: () => string[]; server: Server }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        calls,
        server,
        pages: () => [...targets.values()].filter((t) => t.type === 'page').map((t) => `${t.id} ${t.url}`),
      }),
    ),
  );
}
