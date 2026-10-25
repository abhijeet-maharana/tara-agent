import { type HostConfig, hostConfigSchema } from '../src/config/schema.js';
import type { ChatPort, SlackBlock } from '../src/sessions/manager.js';
import { type StreamChunk, StreamError, type StreamPort } from '../src/slack/reply.js';

/** In-memory ChatPort: records every call, both as structured lists and as one readable log. */
export class FakeChat implements ChatPort {
  posts: { thread: string; text: string; ts: string }[] = [];
  updates: { ts: string; text: string; blocks?: SlackBlock[] }[] = [];
  blockPosts: { thread: string; text: string; ts: string; blocks: SlackBlock[] }[] = [];
  uploads: { thread: string; file: string; comment?: string }[] = [];
  reactions: string[] = [];
  deleted: string[] = [];
  log: string[] = [];
  stream?: StreamPort;
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
  async postBlocks(_c: string, thread: string, text: string, blocks: SlackBlock[]) {
    const ts = this.nextTs();
    this.blockPosts.push({ thread, text, ts, blocks });
    this.log.push(`blocks ${thread} ${ts}: ${text}`);
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
  async uploadFile(_c: string, thread: string, file: string, comment?: string) {
    this.uploads.push({ thread, file, comment });
    this.log.push(`upload ${thread}: ${file}`);
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

/** A host config with the schema's defaults, for tests (no HTTP server, no health cron). */
export function testHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    ...hostConfigSchema.parse({ projects: ['/repo'], timezone: 'UTC' }),
    stateDir: '/tmp',
    statusIntervalSeconds: 0,
    http: { enabled: false, bind: '127.0.0.1', port: 0, allowFrom: ['127.0.0.0/8'] },
    healthDigest: { enabled: false, cron: '0 9 * * *' },
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
  private n = 0;

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
