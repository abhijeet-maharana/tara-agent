import type { ChatPort, SlackBlock } from '../src/sessions/manager.js';

/** In-memory ChatPort: records every call, both as structured lists and as one readable log. */
export class FakeChat implements ChatPort {
  posts: { thread: string; text: string; ts: string }[] = [];
  updates: { ts: string; text: string; blocks?: SlackBlock[] }[] = [];
  blockPosts: { thread: string; text: string; ts: string; blocks: SlackBlock[] }[] = [];
  uploads: { thread: string; file: string; comment?: string }[] = [];
  reactions: string[] = [];
  deleted: string[] = [];
  log: string[] = [];
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
