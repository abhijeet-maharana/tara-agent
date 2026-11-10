import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { closeRunTabs, openTabs } from '../src/runner/browser-tabs.js';
import { fakeChrome } from './fakes.js';

let open: Server | undefined;
afterEach(() => open?.close());

describe('closeRunTabs', () => {
  it('closes the tabs a run opened or moved, and leaves the others alone', async () => {
    const chrome = await fakeChrome({ a: 'chrome://new-tab-page/', b: 'https://mail.example/' });
    open = chrome.server;
    const before = await openTabs(chrome.url);
    expect([...(before ?? new Map()).keys()]).toEqual(['a', 'b']); // pages only
    // The run opened a tab and left it.
    await fetch(`${chrome.url}/json/new?https://seller.example/`, { method: 'PUT' });
    const after = (await openTabs(chrome.url)) as Map<string, string>;
    const closed = await closeRunTabs(chrome.url, before as Map<string, string>, () => {});
    expect(after.size).toBe(3);
    expect(closed).toBe(1);
    expect(chrome.pages()).toEqual(['a chrome://new-tab-page/', 'b https://mail.example/']);
  });

  it('closes a tab the run moved to another page, keeping one new-tab page when it was the only one', async () => {
    const chrome = await fakeChrome({ a: 'https://seller.example/orders' });
    open = chrome.server;
    const warnings: string[] = [];
    const closed = await closeRunTabs(chrome.url, new Map([['a', 'chrome://new-tab-page/']]), (m) =>
      warnings.push(m),
    );
    expect(closed).toBe(1);
    expect(chrome.pages()).toEqual(['new1 chrome://newtab/']);
    expect(chrome.calls).toContain('PUT /json/new?chrome://newtab/');
    expect(warnings).toEqual([]);
  });

  it('does nothing when the browser does not answer', async () => {
    expect(await openTabs('http://127.0.0.1:9')).toBeUndefined();
    expect(await closeRunTabs('http://127.0.0.1:9', new Map(), () => {})).toBe(0);
  });
});
