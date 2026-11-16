import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DashboardContext, homePage } from '../src/http/dashboard.js';
import { loadQuotes, parseQuotes, pickQuote, QUOTES_FILE } from '../src/http/quotes.js';

describe('quotes', () => {
  it('reads one quote per line, dropping blanks, comments and checklist marks', () => {
    expect(
      parseQuotes(
        '# mine\n- [ ] Consistency wins\n\n* Learning should never stop\n- [x] Done\nPlain line\r\n',
      ),
    ).toEqual(['Consistency wins', 'Learning should never stop', 'Done', 'Plain line']);
  });

  it('joins every project file and skips projects without one', () => {
    const a = mkdtempSync(path.join(tmpdir(), 'quotes-'));
    const b = mkdtempSync(path.join(tmpdir(), 'quotes-'));
    mkdirSync(path.join(a, '.tara'));
    writeFileSync(path.join(a, QUOTES_FILE), 'One\nTwo\n');
    expect(loadQuotes([a, b])).toEqual(['One', 'Two']);
  });

  it('picks at random, nothing when empty', () => {
    expect(pickQuote(['a', 'b', 'c'], () => 0.99)).toBe('c');
    expect(pickQuote([], () => 0)).toBeUndefined();
  });

  it('shows the quote on Home, escaped, and nothing without one', () => {
    const ctx: DashboardContext = { projects: [], timeZone: 'UTC', agentName: 'tara' };
    const data = { jobs: [], latest: [], quietRuns: 0, pending: [], uptimeSeconds: 0, now: 0 };
    expect(homePage(ctx, { ...data, quote: 'Do it <now>' })).toContain(
      '<span class="quote-text">Do it &lt;now&gt;</span>',
    );
    expect(homePage(ctx, data)).not.toContain('class="quote"');
  });
});
