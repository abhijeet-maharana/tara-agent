import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * tara's MCP server as Claude Code runs it: a stdio process that forwards each tool to tara-agent's
 * /internal API with the run's token. Here the API is a fake that records what it gets.
 */
const seen: Array<{ path: string; token?: string; body: Record<string, unknown> }> = [];
let refuse = false;
const api = createServer((req: IncomingMessage, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seen.push({
      path: req.url ?? '',
      token: req.headers['x-tara-run'] as string,
      body: raw ? JSON.parse(raw) : {},
    });
    if (refuse) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown run token' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'card1', options: ['Approve', 'Reject'], name: 'shot.png' }));
  });
});

async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.resolve('src/mcp/server.ts')],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
}

let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => api.close());

describe('tara MCP server', () => {
  it('offers only the tools this run may use, and forwards a call with the run token', async () => {
    const plain = await connect({ TARA_API: base, TARA_RUN_TOKEN: 'tok-1' });
    const names = (await plain.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['request_approval', 'send_file', 'withdraw_card']));
    expect(names).not.toContain('permission');
    expect(names).not.toContain('start_pull_request');
    expect(names).not.toContain('set_reminder');

    const answer = await plain.callTool({
      name: 'request_approval',
      arguments: {
        title: 'Cut bids',
        details: 'Spend is up 40%',
        options: ['Approve', 'Reject'],
        handoff: 'Cut bids on ad 7',
      },
    });
    expect(answer.isError).toBeFalsy();
    expect(JSON.stringify(answer.content)).toContain('end your turn');
    expect(seen.at(-1)).toMatchObject({
      path: '/internal/approval',
      token: 'tok-1',
      body: { title: 'Cut bids' },
    });
    await plain.close();

    const all = await connect({
      TARA_API: base,
      TARA_RUN_TOKEN: 'tok-2',
      TARA_PERMISSION_PROMPTS: '1',
      TARA_GITHUB_TOOLS: '1',
      TARA_REMINDER_TOOLS: '1',
    });
    const more = (await all.listTools()).tools.map((t) => t.name);
    expect(more).toEqual(expect.arrayContaining(['permission', 'start_pull_request', 'set_reminder']));
    await all.close();
  }, 30_000);

  it("reports tara-agent's refusal to Claude as a tool error, not a crash", async () => {
    const client = await connect({ TARA_API: base, TARA_RUN_TOKEN: 'stale' });
    refuse = true;
    const answer = await client.callTool({ name: 'send_file', arguments: { path: '.scratch/shot.png' } });
    refuse = false;
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toContain('Unknown run token');
    await client.close();
  }, 30_000);
});
