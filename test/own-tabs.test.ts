import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyState, type HookInput, pagesIn, record, refusal } from '../src/hooks/own-tabs.js';
import { OWN_TABS_HOOK, ownTabsSettings } from '../src/runner/run.js';

const pages = (selected: number, list: Record<number, string>) => [
  {
    type: 'text',
    text: `## Pages\n${Object.entries(list)
      .map(([id, url]) => `${id}: Title (${url})${Number(id) === selected ? ' [selected]' : ''}`)
      .join('\n')}`,
  },
];
const call = (tool: string, input: Record<string, unknown> = {}, response?: unknown): HookInput => ({
  tool_name: `mcp__chrome__${tool}`,
  tool_input: input,
  tool_response: response,
});

describe('own-tabs hook', () => {
  it('reads the page list of a Chrome MCP response', () => {
    expect(pagesIn(pages(2, { 1: 'chrome://new-tab-page/', 2: 'https://jobs.example/apply?x=1' }))).toEqual([
      { id: 1, url: 'chrome://new-tab-page/', selected: false },
      { id: 2, url: 'https://jobs.example/apply?x=1', selected: true },
    ]);
  });

  it('refuses page tools until the run opens its own tab, then allows them', () => {
    let state = emptyState('n1');
    expect(refusal(state, call('navigate_page', { url: 'https://x.example/' }))).toMatch(/new_page first/);
    expect(refusal(state, call('take_snapshot'))).toMatch(/new_page first/);
    expect(refusal(state, call('list_pages'))).toBeUndefined();
    expect(refusal(state, call('new_page', { url: 'https://x.example/' }))).toBeUndefined();
    state = record(
      state,
      call(
        'new_page',
        {},
        pages(3, { 1: 'chrome://new-tab-page/', 2: 'https://other.example/', 3: 'https://x.example/' }),
      ),
    );
    expect(state.own).toEqual([3]);
    expect(refusal(state, call('click', { uid: '1_2' }))).toBeUndefined();
    expect(refusal(state, call('select_page', { pageId: 2 }))).toMatch(
      /Page 2 is not a tab this session opened/,
    );
    expect(refusal(state, call('close_page', { pageId: 2 }))).toMatch(/close only your own/);
    expect(refusal(state, call('close_page', { pageId: 3 }))).toBeUndefined();
    state = record(
      state,
      call(
        'close_page',
        { pageId: 3 },
        pages(1, { 1: 'chrome://new-tab-page/', 2: 'https://other.example/' }),
      ),
    );
    expect(state.own).toEqual([]);
    expect(refusal(state, call('click', { uid: '1_2' }))).toMatch(/new_page first/); // the selected tab is someone else's now
  });

  it("lets a later turn pick its tab up again by address, never another run's", () => {
    let first = emptyState('n1');
    first = record(
      first,
      call('new_page', {}, pages(2, { 1: 'chrome://new-tab-page/', 2: 'https://x.example/form' })),
    );
    // A new CLI process: new page numbers, the addresses carry over.
    let later = { ...emptyState('n2'), ownUrls: first.ownUrls };
    later = record(
      later,
      call('list_pages', {}, pages(1, { 1: 'https://x.example/form?step=2', 4: 'https://other.example/' })),
    );
    expect(refusal(later, call('select_page', { pageId: 1 }))).toBeUndefined();
    expect(refusal(later, call('select_page', { pageId: 4 }))).toMatch(/not a tab this session opened/);
    later = record(later, call('select_page', { pageId: 1 }));
    expect(refusal(later, call('fill', { uid: 'a', value: 'b' }))).toBeUndefined();
  });

  it('hooks the repo browser MCP servers into a run, and nothing for a repo without one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tara-tabs-'));
    expect(ownTabsSettings(dir)).toBeUndefined();
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          chrome: {
            command: 'npx',
            args: ['chrome-devtools-mcp@latest', '--browserUrl=http://127.0.0.1:9223'],
          },
        },
      }),
    );
    const settings = JSON.parse(ownTabsSettings(dir) as string);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('mcp__(chrome)__.*');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain(OWN_TABS_HOOK);
    expect(OWN_TABS_HOOK).toMatch(/hooks[/\\]own-tabs\.js$/);
  });
});

describe('threadCards', () => {
  it('tells a chat in a thread of cards which cards it holds, and nothing in a thread without', async () => {
    const { threadCards } = await import('../src/sessions/manager.js');
    const item = {
      id: 'i1',
      title: '🧩 Solve the captcha: Auditdata',
      kind: 'notice',
      status: 'pending',
      body: 'Open in Jarvis Chrome:\nhttps://auditdata.recruitee.com/o/x/c/new',
    };
    const store = { itemsInThread: (_c: string, ts: string) => (ts === 't1' ? [item] : []) } as never;
    const text = threadCards(store, 'C1', 't1');
    expect(text).toMatch(/^## Cards in this thread\n/);
    expect(text).toContain(
      '- 🧩 Solve the captcha: Auditdata (item i1, notice, pending): Open in Jarvis Chrome: https://auditdata.recruitee.com/o/x/c/new',
    );
    expect(threadCards(store, 'C1', 't2')).toBe('');
  });
});
