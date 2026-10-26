#!/usr/bin/env node
/**
 * tara's MCP server. Claude Code starts one per run (stdio, from the `--mcp-config` file tara-agent
 * writes), and every tool forwards to tara-agent's local API with that run's token:
 *   request_approval  a card (Approvals page + Slack buttons) for anything that needs a person; the
 *                     answer comes back as the next message ("USER DECISION …")
 *   send_file         upload a file into the thread
 *   request_privileged  a root action (runs at once, or after approval), or a command for a person to run
 *   permission        Allow/Deny buttons for tool calls (only when the run asks for prompts)
 *   propose_item, list_items, finish_item   approval cards for drafts that run later through a queue
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
      'Ask a person through a card on the Approvals page and in this Slack thread, for anything that needs ' +
      'one: a decision before you act (spending money, changing prices, listings, ads or data, publishing, ' +
      'sending messages to others), a suggestion worth acting on, or something only a person can do (a login, ' +
      'an OTP, a call, a failure you could not fix: say exactly what, with options like "Done, continue" / ' +
      '"Skip"). After calling it, END YOUR TURN without doing the action: the answer arrives as your next ' +
      'message, starting with "USER DECISION", or as a normal reply.',
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
      kind: z
        .string()
        .max(40)
        .optional()
        .describe('What sort of decision, so scripts can find it (e.g. "post-topic"). Default "decision".'),
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

server.registerTool(
  'request_privileged',
  {
    title: 'Ask for something only root can do',
    description:
      'You have no sudo. When a step needs root (a "Permission denied" you cannot fix, restarting a service), ask ' +
      'for one of the root actions listed in your instructions with `action` (+ `args`), or, if none fits, for a ' +
      'person to run a `command`. An action marked "runs at once" returns its output now: check it and carry on. ' +
      'Anything else becomes an approval card: END YOUR TURN; the decision (and the command output) arrives as ' +
      'your next message, starting with "USER DECISION".',
    inputSchema: {
      action: z.string().max(80).optional().describe('Id of a root action, e.g. "fix-permissions"'),
      args: z
        .record(z.string(), z.string().max(500))
        .optional()
        .describe('The action\'s arguments, e.g. {"path": "/srv/shop/data"}'),
      command: z
        .string()
        .max(2000)
        .optional()
        .describe('Only when no action fits: the exact shell command a person should run'),
      reason: z
        .string()
        .min(1)
        .max(2000)
        .describe('What failed and why this fixes it (the error message, the file or service)'),
      title: z.string().max(150).optional().describe('Short card title; a default is made from the action'),
    },
  },
  async (args) => {
    try {
      const r = await api<{ ran?: boolean; ok?: boolean; result?: string }>('/internal/privileged', args);
      if (r.ran) return text(r.result ?? '', !r.ok);
      return text(
        'Approval card posted (Approvals page and this thread). Stop now: end your turn. The decision, and the ' +
          "command's output if it ran, arrives as your next message.",
      );
    } catch (err) {
      return text(`Could not ask for it: ${(err as Error).message}`, true);
    }
  },
);

const field = z.object({
  key: z.string().min(1).max(60).describe('Stable name, e.g. "note"'),
  label: z.string().min(1).max(80).describe('What the person sees, e.g. "Connection note"'),
  type: z.enum(['text', 'textarea', 'list']).default('textarea'),
  value: z.union([z.string(), z.array(z.string())]),
  maxLength: z.number().int().positive().optional().describe('Characters allowed (checked on every edit)'),
  required: z.boolean().optional(),
  readOnly: z.boolean().optional().describe('Shown but not editable, e.g. the recipient'),
});

server.registerTool(
  'propose_item',
  {
    title: 'Propose a draft for approval',
    description:
      'Leave a draft that should go out later (a LinkedIn note, an email, an application, a post) as an ' +
      'approval card. The person approves, edits or rejects it on the Approvals page; approved items run later ' +
      'through the given queue (see .tara/queues.json), at its time, one at a time, by its executor. Do not send ' +
      'the draft yourself. Proposing the same `key` again replaces the pending card (also after a revise request).',
    inputSchema: {
      kind: z.string().min(1).max(40).describe('What it is, e.g. "linkedin-outreach", "email", "post"'),
      key: z.string().min(1).max(120).describe('Stable id of the thing, e.g. "outreach:acme-jane"'),
      title: z.string().min(1).max(200).describe('One line: who/what, e.g. "Jane Doe, CTO at Acme (EU)"'),
      body: z.string().max(8000).optional().describe('Context the person needs to decide (markdown)'),
      fields: z.array(field).max(40).optional().describe('The editable draft: what the executor will send'),
      media: z
        .array(
          z.object({
            type: z.enum(['image', 'video', 'file']),
            url: z.string(),
            caption: z.string().optional(),
            poster: z.string().optional().describe('Videos: the still shown before play'),
          }),
        )
        .max(20)
        .optional(),
      checks: z
        .array(z.object({ text: z.string(), blocking: z.boolean() }))
        .max(20)
        .optional()
        .describe('Problems you already know of; blocking ones stop approval until fixed'),
      queue: z.string().min(1).describe('Queue that runs it once approved'),
      window: z.string().optional().describe("Window key in the queue's config, e.g. a region like EU"),
      runAfter: z.string().optional().describe('ISO time it must not run before'),
    },
  },
  async ({ runAfter, ...args }) => {
    try {
      const at = runAfter ? Date.parse(runAfter) : undefined;
      if (at !== undefined && Number.isNaN(at)) return text('runAfter is not an ISO time', true);
      const { id, checks } = await api<{ id: string; checks: Array<{ text: string; blocking: boolean }> }>(
        '/internal/item',
        { ...args, runAfter: at },
      );
      const blocking = checks.filter((c) => c.blocking);
      return text(
        `Card ${id} is waiting for approval.${
          blocking.length
            ? ` It cannot be approved yet: ${blocking.map((c) => c.text).join('; ')}. Fix and propose again with the same key.`
            : ''
        }`,
      );
    } catch (err) {
      return text(`Could not propose the item: ${(err as Error).message}`, true);
    }
  },
);

server.registerTool(
  'list_items',
  {
    title: "List this project's approval cards",
    description:
      'Approval cards of this project: waiting, approved (scheduled) and running by default. Check before proposing ' +
      'so you update a card (same key) instead of adding a duplicate.',
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe('Comma list: pending, approved, running, done, failed, rejected, expired'),
      kind: z.string().optional(),
    },
  },
  async ({ status, kind }) => {
    try {
      const q = new URLSearchParams({ ...(status && { status }), ...(kind && { kind }) });
      const { items } = await api<{ items: unknown[] }>(`/internal/items${q.size ? `?${q}` : ''}`);
      return text(JSON.stringify(items));
    } catch (err) {
      return text(`Could not list items: ${(err as Error).message}`, true);
    }
  },
);

server.registerTool(
  'finish_item',
  {
    title: 'Report an approved item',
    description:
      'Report the result of one approved item you were given under "## Approved items": done (with what happened, ' +
      'e.g. the URL) or failed (with why). Report every item, as soon as it is done. An item you never report is ' +
      'marked failed and is not run again.',
    inputSchema: {
      id: z.string().min(1),
      status: z.enum(['done', 'failed']),
      result: z.string().max(4000).optional(),
    },
  },
  async (args) => {
    try {
      await api('/internal/item-done', args);
      return text(`Reported ${args.id} as ${args.status}.`);
    } catch (err) {
      return text(`Could not report the item: ${(err as Error).message}`, true);
    }
  },
);

if (process.env.TARA_JOB_TOOLS === '1') {
  server.registerTool(
    'list_jobs',
    {
      title: "List this channel's scheduled jobs",
      description: 'The scheduled jobs of this Slack channel, with ids, next run and last status.',
      inputSchema: {},
    },
    async () => {
      try {
        const { jobs } = await api<{ jobs: unknown[] }>('/internal/jobs');
        return text(JSON.stringify(jobs));
      } catch (err) {
        return text(`Could not list jobs: ${(err as Error).message}`, true);
      }
    },
  );
  server.registerTool(
    'run_job',
    {
      title: 'Run a scheduled job now',
      description:
        "Start one of this channel's scheduled jobs right away (as if its schedule fired). It runs in its own " +
        'message in the channel; this call returns as soon as it has started.',
      inputSchema: { id: z.string().min(1).describe('Job id from list_jobs') },
    },
    async ({ id }) => {
      try {
        const { result, name } = await api<{ result: string; name?: string }>('/internal/run-job', { id });
        const what = name ?? id;
        if (result === 'started') return text(`Started "${what}". It posts its own message in the channel.`);
        if (result === 'running') return text(`"${what}" is already running.`);
        if (result === 'paused') return text(`"${what}" is paused, so it was not started.`);
        return text(`Could not start "${what}": ${result}`, true);
      } catch (err) {
        return text(`Could not start the job: ${(err as Error).message}`, true);
      }
    },
  );
}

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
