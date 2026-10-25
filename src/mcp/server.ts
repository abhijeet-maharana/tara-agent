#!/usr/bin/env node
/**
 * tara's MCP server. Claude Code starts one per run (stdio, from the `--mcp-config` file tara-agent
 * writes), and every tool forwards to tara-agent's local API with that run's token:
 *   request_approval  Slack buttons; the tap comes back as the next message ("USER DECISION …")
 *   send_file         upload a file into the thread
 *   permission        Allow/Deny buttons for tool calls (only when the run asks for prompts)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = process.env.TARA_API ?? 'http://127.0.0.1:4100';
const TOKEN = process.env.TARA_RUN_TOKEN ?? '';
const PERMISSION_PROMPTS = process.env.TARA_PERMISSION_PROMPTS === '1';
/** Longest a permission prompt can wait in total (tara-agent itself denies after 10 minutes). */
const PERMISSION_DEADLINE_MS = 11 * 60_000;
const POLL_SECONDS = 45;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-tara-run': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout((POLL_SECONDS + 15) * 1000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `tara-agent answered ${res.status}`);
  return json;
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });

const server = new McpServer({ name: 'tara', version: '0.1.0' });

server.registerTool(
  'request_approval',
  {
    title: 'Ask for approval in Slack',
    description:
      'Ask the people in this Slack thread to approve or reject something before you do it (spending money, ' +
      'changing prices, listings, ads or data, publishing, sending messages to others). Posts the proposal with ' +
      'buttons. After calling it, END YOUR TURN without doing the action: the answer arrives as your next message, ' +
      'starting with "USER DECISION", or as a normal reply.',
    inputSchema: {
      title: z
        .string()
        .min(1)
        .max(150)
        .describe('Short name of the decision, e.g. "Cut Amazon ad bids on 4 keywords"'),
      details: z
        .string()
        .min(1)
        .describe(
          'The exact proposal: what changes, the numbers, and why. Slack mrkdwn, phone-friendly bullets.',
        ),
      options: z
        .array(z.string().min(1).max(75))
        .min(2)
        .max(5)
        .optional()
        .describe('Button labels, first = the recommended choice. Default: Approve, Reject.'),
    },
  },
  async (args) => {
    try {
      const { options } = await api<{ options: string[] }>('/internal/approval', args);
      return text(
        `Approval request posted in the Slack thread (buttons: ${options.join(' / ')}). ` +
          'Stop now: end your turn without doing the action. The decision arrives as your next message.',
      );
    } catch (err) {
      return text(`Could not post the approval request: ${(err as Error).message}`, true);
    }
  },
);

server.registerTool(
  'send_file',
  {
    title: 'Send a file to the Slack thread',
    description:
      'Upload a file (screenshot, PDF, CSV, image) into this Slack thread. The file must be inside the project ' +
      'directory (for example .scratch/) or the temp directory.',
    inputSchema: {
      path: z.string().min(1).describe('Path to the file, absolute or relative to the project root'),
      comment: z.string().max(2000).optional().describe('Message to post with the file'),
    },
  },
  async (args) => {
    try {
      const { name } = await api<{ name: string }>('/internal/file', args);
      return text(`Posted ${name} to the Slack thread.`);
    } catch (err) {
      return text(`Could not send the file: ${(err as Error).message}`, true);
    }
  },
);

if (PERMISSION_PROMPTS) {
  server.registerTool(
    'permission',
    {
      title: 'Permission prompt (used by Claude Code, not by the model)',
      description: 'Asks the Slack thread whether a tool call may run.',
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async (args) => {
      const deny = (message: string) => text(JSON.stringify({ behavior: 'deny', message }));
      try {
        const { id } = await api<{ id: string }>('/internal/permission', {
          tool_name: args.tool_name,
          input: args.input,
        });
        const deadline = Date.now() + PERMISSION_DEADLINE_MS;
        while (Date.now() < deadline) {
          const { decision } = await api<{ decision: unknown }>(
            `/internal/permission/${encodeURIComponent(id)}?wait=${POLL_SECONDS}`,
          );
          if (decision) return text(JSON.stringify(decision));
        }
        return deny('Nobody answered the permission prompt in time.');
      } catch (err) {
        return deny(`Permission prompt failed: ${(err as Error).message}`);
      }
    },
  );
}

await server.connect(new StdioServerTransport());
