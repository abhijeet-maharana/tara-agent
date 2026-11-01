// Stands in for the `agy` CLI (stream-json mode) in tests. Behaviour is picked with FAKE_AGY_MODE.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_AGY_MODE ?? 'ok';
const cid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const step = (s) => out({ event: 'step_update', step_update: { conversation_id: cid, ...s } });
const result = (r) => out({ event: 'result', result: { conversation_id: cid, num_turns: 1, ...r } });
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  thinking_tokens: 3,
  cache_read_tokens: 7,
  total_tokens: 18,
};
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const prompt = JSON.parse(input.split('\n')[0]).message.content;
  if (mode !== 'crash')
    out({ event: 'init', conversation_id: cid, init: { model: 'gemini-test', cwd: process.cwd() } });
  switch (mode) {
    case 'ok':
      step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
      step({
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'read_file',
        tool_info: { name: 'read_file', parameters: { Path: '/repo/README.md' }, output: '1 lines' },
      });
      step({
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'tara_tara', ToolName: 'send_file' } },
      });
      step({
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: { name: 'call_mcp_tool', error: { message: 'boom' } },
      });
      step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Head' });
      step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'line' });
      result({ status: 'SUCCESS', response: 'Headline', duration_seconds: 1.5, usage });
      break;
    case 'echo': {
      // What the runner handed over: args, the prompt from stdin and the --add-dir plugin.
      const dir = arg('--add-dir');
      const plugin = path.join(dir, '.agents', 'plugins', 'tara');
      const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
      const settings = arg('--settings');
      result({
        status: 'SUCCESS',
        response: JSON.stringify({
          args: process.argv.slice(2),
          prompt,
          mcp: read(path.join(plugin, 'mcp_config.json')),
          rules: read(path.join(plugin, 'rules', 'AGENTS.md')),
          plugin: read(path.join(plugin, 'plugin.json')),
          settings: settings ? read(settings) : null,
          dir,
        }),
      });
      break;
    }
    case 'empty':
      result({
        status: 'SUCCESS',
        response: '',
        denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
      });
      break;
    case 'print-timeout':
      result({ status: 'SUCCESS', response: '', finished_reason: 'print_timeout', usage });
      break;
    case 'quota':
      result({ status: 'ERROR', response: '', error: { message: 'RESOURCE_EXHAUSTED: quota exceeded' } });
      process.exitCode = 1;
      break;
    case 'hang':
      setInterval(() => {}, 1000);
      return;
    case 'crash':
      process.stderr.write('Error: Please sign in\n');
      process.exitCode = 2;
      break;
  }
});
