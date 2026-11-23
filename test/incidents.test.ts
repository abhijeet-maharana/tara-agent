import { describe, expect, it } from 'vitest';
import { Incidents, incidentOf, OPEN_MS } from '../src/slack/incidents.js';
import { FakeChat } from './fakes.js';

const quiet = { info() {}, warn() {}, error() {} };

describe('Incidents', () => {
  it('tells a usage limit and a lost login apart from other failures', () => {
    expect(incidentOf({ status: 'limit', error: 'resets 3pm' }, 'claude')).toMatchObject({ kind: 'limit' });
    expect(
      incidentOf({ status: 'error', error: 'Failed to authenticate: OAuth session expired' }, 'claude'),
    ).toMatchObject({ kind: 'login' });
    expect(incidentOf({ status: 'error', error: 'error_during_execution' }, 'claude')).toBeUndefined();
    expect(incidentOf({ status: 'ok' }, 'claude')).toBeUndefined();
  });

  it('posts one message per incident, edits it as runs hit it, and closes it when a run works', async () => {
    let now = 0;
    const chat = new FakeChat('ts');
    const incidents = new Incidents({ chat, log: quiet, host: 'jarvis', runAs: 'tara', now: () => now });
    const limit = { kind: 'limit' as const, harness: 'claude', detail: 'resets 3pm' };
    await incidents.report('C1', limit, 'SLA Report');
    await incidents.report('C1', limit, 'Daily Summary');
    await incidents.report('C1', limit, 'SLA Report'); // named once
    expect(chat.posts).toHaveLength(1);
    expect(chat.log.at(-1)).toMatch(/Skipped \(2\):_ SLA Report, Daily Summary$/);

    await incidents.resolve('agy'); // another CLI: still open
    expect(chat.log.at(-1)).not.toContain('Over');
    await incidents.resolve('claude');
    expect(chat.log.at(-1)).toContain('✅ _Over: runs work again._');

    // A new hit after that, or long after the last one, is a new incident.
    await incidents.report('C1', limit, 'SLA Report');
    now += OPEN_MS + 1;
    await incidents.report('C1', limit, 'SLA Report');
    expect(chat.posts).toHaveLength(3);
  });

  it('says how to log in again for a lost login', () => {
    const incidents = new Incidents({ chat: new FakeChat('ts'), log: quiet, host: 'jarvis', runAs: 'tara' });
    const text = incidents.text({ incident: { kind: 'login', harness: 'claude', detail: '' }, runs: ['A'] });
    expect(text).toContain('ssh -t jarvis sudo -u tara -i claude auth login');
  });
});
