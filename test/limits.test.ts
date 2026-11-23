import { describe, expect, it } from 'vitest';
import { LimitHolds, limitResetAt, parseResetText } from '../src/scheduler/limits.js';

describe('usage limit reset times', () => {
  const now = Date.parse('2026-11-21T10:00:00Z'); // 15:30 in Kolkata

  it("reads the CLI's message in its own timezone", () => {
    expect(
      parseResetText("You've hit your weekly limit · resets Nov 22, 3:30pm (Asia/Kolkata)", 'UTC', now),
    ).toBe(Date.parse('2026-11-22T10:00:00Z'));
    // No date: today if still ahead, else tomorrow.
    expect(parseResetText('Limit reached · resets 9pm (Asia/Kolkata)', 'UTC', now)).toBe(
      Date.parse('2026-11-21T15:30:00Z'),
    );
    expect(parseResetText('resets at 9:15 AM', 'Asia/Kolkata', now)).toBe(Date.parse('2026-11-22T03:45:00Z'));
    expect(parseResetText('resets Jan 2, 1am (UTC)', 'UTC', Date.parse('2026-12-30T00:00:00Z'))).toBe(
      Date.parse('2027-01-02T01:00:00Z'),
    );
    expect(parseResetText('nothing here', 'UTC', now)).toBeUndefined();
  });

  it('prefers the reported window, and falls back to an hour', () => {
    const at = Date.parse('2026-11-21T13:00:00Z');
    expect(
      limitResetAt(
        {
          rateLimit: {
            status: 'rejected',
            windows: { seven_day: { status: 'rejected', resetsAt: at / 1000 } },
          },
        },
        'UTC',
        now,
      ),
    ).toBe(at);
    expect(limitResetAt({ rateLimit: { status: 'rejected', resetsAt: at / 1000 } }, 'UTC', now)).toBe(at);
    expect(limitResetAt({ error: 'Claude usage limit reached' }, 'UTC', now)).toBe(now + 3_600_000);
  });

  it('holds each CLI until its reset and says once when a hold ended', () => {
    let t = now;
    const holds = new LimitHolds(() => t);
    holds.hit('claude', now + 60_000);
    holds.hit('claude', now + 30_000); // an earlier reset never shortens a hold
    expect(holds.heldUntil('claude')).toBe(now + 60_000);
    expect(holds.heldUntil('agy')).toBeUndefined();
    expect(holds.ended()).toEqual([]);
    t = now + 60_000;
    expect(holds.heldUntil('claude')).toBeUndefined();
    expect(holds.ended()).toEqual(['claude']);
    expect(holds.ended()).toEqual([]);
  });
});
