import { describe, expect, it } from 'vitest';
import type { RunOptions, RunOutcome } from '../src/runner/run.js';
import { SessionManager } from '../src/sessions/manager.js';
import { StreamReply } from '../src/slack/reply.js';
import { Store } from '../src/store/store.js';
import { FakeChat, FakeStream, testHost } from './fakes.js';

const done = { summary: '✅ Done · 3s · 1 step', ok: true, answer: 'Hello world', notes: [] };

function reply(stream = new FakeStream(), chat = new FakeChat()) {
  chat.stream = stream;
  return { chat, stream, reply: new StreamReply(chat, stream, 'C1', '100.1', 'U1', false, 0) };
}

describe('StreamReply', () => {
  it('streams the card, tasks and text into one message and seals it', async () => {
    const { chat, stream, reply: r } = reply();
    r.working();
    r.text('Checking');
    r.toolStart('t1', 'Bash: npm test');
    r.toolEnd('t1', true);
    r.textBreak();
    r.text('All **42** tests pass.');
    await r.finish(done);

    expect(stream.calls[0]).toBe('start 100.1 for U1 → s1');
    expect(stream.calls.at(-1)).toBe('stop s1');
    expect(stream.text()).toBe('Checking\n\nAll **42** tests pass.');
    expect(stream.state()).toEqual({
      title: '✅ Done · 3s · 1 step',
      tasks: { 'Bash: npm test': 'complete' },
    });
    expect(chat.posts).toHaveLength(0); // the stream is the answer: nothing posted twice
  });

  it('streams the answer when no text arrived live, and failures as text', async () => {
    const a = reply();
    await a.reply.finish(done);
    expect(a.stream.text()).toBe('Hello world');

    const b = reply();
    b.reply.toolStart('t1', 'Bash: deploy');
    await b.reply.finish({ summary: '❌ Failed: boom', ok: false, answer: '', notes: ['⚠️ Blocked: Bash'] });
    expect(b.stream.text()).toBe('❌ Failed: boom\n\n⚠️ Blocked: Bash');
    expect(b.stream.state().tasks).toEqual({ 'Bash: deploy': 'error' });
  });

  it('falls back to an edited status message when the app cannot stream', async () => {
    const stream = new FakeStream();
    stream.failStart = 'feature_not_enabled';
    const { chat, reply: r } = reply(stream);
    r.toolStart('t1', 'Read: a.ts');
    r.text('ignored live');
    await r.finish(done);
    expect(stream.disabled).toBe(true);
    expect(chat.texts()).toEqual(['⏳ Working…', 'Hello world']);
    expect(chat.updates.at(-1)?.text).toBe('✅ Done · 3s · 1 step');
  });

  it('reopens a stream Slack sealed during a long turn, keeping the card state', async () => {
    const stream = new FakeStream();
    const { reply: r } = reply(stream);
    r.toolStart('t1', 'Bash: long job');
    r.text('part one ');
    await new Promise((resolve) => setTimeout(resolve, 5));
    stream.failAppends.push('message_not_in_streaming_state');
    r.text('part two');
    await r.finish(done);
    expect(stream.calls.filter((c) => c.startsWith('start'))).toHaveLength(2);
    expect(stream.text()).toBe('part one part two');
    expect(stream.calls.at(-1)).toBe('stop s2');
  });

  it('posts whatever Slack refuses as plain messages, so no text is lost', async () => {
    const stream = new FakeStream();
    const { chat, reply: r } = reply(stream);
    r.text('first ');
    await new Promise((resolve) => setTimeout(resolve, 5));
    stream.failAppends.push('msg_too_long');
    r.text('**second**');
    await r.finish(done);
    expect(stream.text()).toBe('first ');
    expect(chat.texts()).toEqual(['*second*']);
  });
});

describe('SessionManager with streaming', () => {
  it('asks the CLI for partial messages and streams only the main agent', async () => {
    const chat = new FakeChat('bot.');
    const stream = new FakeStream();
    chat.stream = stream;
    const calls: RunOptions[] = [];
    const manager = new SessionManager({
      projects: [
        {
          dir: '/repo',
          config: {
            name: 'shop',
            slackChannel: 'C1',
            permissionMode: 'bypassPermissions',
            chatModel: 'sonnet',
            allowedTools: [],
            allowedUsers: [],
            billing: 'subscription',
            selfImprove: true,
          },
        },
      ],
      host: testHost(),
      store: new Store(':memory:'),
      chat,
      env: {},
      log: { info() {}, warn() {}, error() {} },
      run: async (o): Promise<RunOutcome> => {
        calls.push(o);
        o.onEvent?.({ kind: 'text', text: 'Looking. ' });
        o.onEvent?.({ kind: 'tool', id: 'a1', name: 'Agent', status: 'Agent: research' });
        o.onEvent?.({ kind: 'tool', id: 'x', name: 'Read', status: 'Read: hidden.ts', parent: 'a1' });
        o.onEvent?.({ kind: 'text', text: 'sub-agent chatter', parent: 'a1' });
        o.onEvent?.({ kind: 'tool_result', id: 'a1', isError: false });
        o.onEvent?.({ kind: 'text_start' });
        o.onEvent?.({ kind: 'text', text: 'Answer.' });
        return {
          status: 'ok',
          text: 'Answer.',
          durationMs: 2000,
          toolCalls: 2,
          permissionDenials: [],
          model: 'm',
        };
      },
    });
    await manager.handle({ channel: 'C1', threadTs: '100.1', ts: '100.1', user: 'U1', text: 'go' });
    expect(calls[0]?.args).toContain('--include-partial-messages');
    expect(stream.text()).toBe('Looking. \n\nAnswer.');
    expect(stream.state()).toEqual({
      title: '✅ Done · 2s · 2 steps · m',
      tasks: { 'Agent: research': 'complete' },
    });
    expect(chat.texts()).toEqual([]);
    expect(chat.reactions).toContain('+white_check_mark@100.1');
  });
});
