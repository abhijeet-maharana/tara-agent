// Stands in for the `claude` CLI in tests. Behaviour is picked with FAKE_CLAUDE_MODE.
import { readFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const fixture = new URL('./turn-with-tool.jsonl', import.meta.url);
const sid = '11111111-2222-4333-8444-555555555555';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let prompt = '';
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', () => {
  switch (mode) {
    case 'ok':
      process.stdout.write(readFileSync(fixture, 'utf8'));
      break;
    case 'echo':
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'm' });
      out({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify({
          prompt,
          args: process.argv.slice(2),
          oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
        }),
        session_id: sid,
        permission_denials: [],
      });
      break;
    case 'hang':
      setInterval(() => {}, 1000);
      return;
    case 'crash':
      process.stderr.write('Error: something broke\n');
      process.exitCode = 2;
      break;
    case 'limit':
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'm' });
      out({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1792924200, rateLimitType: 'five_hour' },
      });
      out({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Claude usage limit reached',
        session_id: sid,
        permission_denials: [],
      });
      process.exitCode = 1;
      break;
    case 'denied':
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'm' });
      out({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'could not run it',
        session_id: sid,
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 't1', tool_input: {} },
          { tool_name: 'Bash', tool_use_id: 't2', tool_input: {} },
        ],
      });
      break;
  }
});
