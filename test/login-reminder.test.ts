import { describe, expect, it } from 'vitest';
import type { ClaudeLogin } from '../src/health/claude-login.js';
import { LoginReminder } from '../src/health/login-reminder.js';
import { Store } from '../src/store/store.js';
import { FakeChat } from './fakes.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(login: () => ClaudeLogin, start: string) {
  let now = Date.parse(start);
  const store = new Store(':memory:');
  const chat = new FakeChat('ts');
  const reminder = new LoginReminder({
    login: async () => login(),
    store,
    chat,
    target: () => ({ channel: 'C1', owner: 'U1' }),
    host: 'jarvis',
    timeZone: 'Asia/Kolkata',
    log: { info() {}, warn() {}, error() {} },
    now: () => now,
  });
  return { chat, reminder, advance: (ms: number) => (now += ms), at: () => now };
}

describe('Claude login reminder', () => {
  it('posts once a day with the steps from three days before the end, and after it', async () => {
    const endsAt = Date.parse('2026-11-22T08:01:00Z'); // Sun 13:31 IST
    // Wed 12:00 IST: more than three days left, nothing.
    const s = setup(() => ({ loggedIn: true, user: 'tara', endsAt }), '2026-11-18T06:30:00Z');
    expect(await s.reminder.tick()).toBe(false);
    // Thu 14:00 IST: inside three days (2d 23h left).
    s.advance(DAY + 2 * HOUR);
    expect(await s.reminder.tick()).toBe(true);
    expect(await s.reminder.tick()).toBe(false); // once a day
    const text = s.chat.posts[0]?.text ?? '';
    expect(s.chat.posts[0]?.thread).toBe(''); // top level, so it notifies
    expect(text).toContain('<@U1>');
    expect(text).toContain('ends in 2d');
    expect(text).toContain('`ssh -t jarvis sudo -u tara -i claude auth login`');
    // Fri 04:00 IST: not in the night.
    s.advance(14 * HOUR);
    expect(await s.reminder.tick()).toBe(false);
    // Fri 09:00 IST, Sat, Sun (ended at 13:31), Mon: one each.
    s.advance(5 * HOUR);
    for (let d = 0; d < 4; d++) {
      expect(await s.reminder.tick()).toBe(true);
      s.advance(DAY);
    }
    expect(s.chat.posts).toHaveLength(5);
    expect(s.chat.posts.at(-1)?.text).toContain('ended');
  });

  it('stops once the login is renewed, and nags while logged out', async () => {
    let login: ClaudeLogin = { loggedIn: true, user: 'tara', endsAt: Date.parse('2026-11-20T00:00:00Z') };
    const s = setup(() => login, '2026-11-19T06:30:00Z');
    expect(await s.reminder.tick()).toBe(true);
    login = { loggedIn: true, user: 'tara', endsAt: s.at() + 30 * DAY };
    s.advance(DAY);
    expect(await s.reminder.tick()).toBe(false);
    login = { loggedIn: false, user: 'tara' };
    expect(await s.reminder.tick()).toBe(true);
    expect(s.chat.posts.at(-1)?.text).toContain('logged out');
    // A login file it can't read, or none at all: nothing to say.
    login = { loggedIn: false, error: 'sudo: a password is required' };
    s.advance(DAY);
    expect(await s.reminder.tick()).toBe(false);
  });
});
