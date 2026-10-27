import { describe, expect, it } from 'vitest';
import { decodeSlackText, toIncoming, voiceClip, vttToText } from '../src/slack/app.js';

const BOT = 'UBOT';
const base = { channel: 'C1', ts: '100.1' };

describe('toIncoming', () => {
  it('accepts a plain user message as a new thread', () => {
    expect(toIncoming({ ...base, user: 'U1', text: 'hi' }, BOT)).toEqual({
      channel: 'C1',
      threadTs: '100.1',
      ts: '100.1',
      user: 'U1',
      text: 'hi',
    });
  });

  it('uses thread_ts for replies and strips the bot mention', () => {
    const msg = toIncoming(
      { ...base, ts: '100.2', thread_ts: '100.1', user: 'U1', text: '<@UBOT> go &amp; check' },
      BOT,
    );
    expect(msg).toMatchObject({ threadTs: '100.1', ts: '100.2', text: 'go & check' });
  });

  it('accepts a person posting through an app with a user token (bot_id + user)', () => {
    expect(toIncoming({ ...base, user: 'U1', bot_id: 'B1', text: 'from automation' }, BOT)).not.toBeNull();
  });

  it('accepts file shares', () => {
    expect(toIncoming({ ...base, subtype: 'file_share', user: 'U1', text: 'see file' }, BOT)).not.toBeNull();
  });

  it.each([
    ['our own posts', { user: BOT, bot_id: 'B9' }],
    ['pure bot posts', { subtype: 'bot_message', bot_id: 'B2' }],
    ['bot posts without user', { bot_id: 'B2' }],
    ['edits', { subtype: 'message_changed', user: 'U1' }],
    ['joins', { subtype: 'channel_join', user: 'U1' }],
  ])('ignores %s', (_name, extra) => {
    expect(toIncoming({ ...base, text: 'x', ...extra }, BOT)).toBeNull();
  });
});

describe('decodeSlackText', () => {
  it('unescapes entities but keeps mentions', () => {
    expect(decodeSlackText('a &lt;b&gt; &amp; <@U1>')).toBe('a <b> & <@U1>');
  });
});

describe('voiceClip', () => {
  it('finds a Slack audio clip among the files', () => {
    const clip = { id: 'F2', subtype: 'slack_audio' };
    expect(voiceClip([{ id: 'F1', subtype: 'slack_image' }, clip])).toBe(clip);
  });

  it('ignores messages without audio', () => {
    expect(voiceClip(undefined)).toBeUndefined();
    expect(voiceClip([{ id: 'F1', media_display_type: 'image' }])).toBeUndefined();
  });
});

describe('vttToText', () => {
  it('keeps only the spoken text', () => {
    const vtt =
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nI have cold,\n\n2\n00:00:02.000 --> 00:00:03.500\ncan I eat banana?\n';
    expect(vttToText(vtt)).toBe('I have cold, can I eat banana?');
  });
});
