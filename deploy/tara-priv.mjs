#!/usr/bin/env node
/**
 * tara-priv: the one thing tara-agent may run as root. It runs an action from a root-owned allowlist,
 * never a command a run made up:
 *   tara-priv --list                    the actions, as JSON
 *   tara-priv --plan <id> [args-json]   what an action would run, as JSON (nothing runs)
 *   tara-priv <id> [args-json]          runs it; output and exit code pass through (124 = timed out)
 *
 * Allowlist: /etc/tara-agent/privileged.json (root-owned, see examples/privileged.json). Install a
 * root-owned copy and allow only that path in sudoers, never a path another user can write:
 *   sudo install -o root -g root -m 755 deploy/tara-priv.mjs /usr/local/sbin/tara-priv
 *   tara-agent ALL=(root) NOPASSWD: /usr/local/sbin/tara-priv
 * See docs/security.md "Privileged actions". No dependencies: it runs outside the checkout.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Only a caller that isn't root (the tests) may point at another allowlist; under sudo it is always this one.
const CONFIG =
  (process.getuid?.() !== 0 && process.env.TARA_PRIV_CONFIG) || '/etc/tara-agent/privileged.json';
const MAX_ARG = 500;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function loadActions() {
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (err) {
    fail(`Cannot read ${CONFIG}: ${err.message}`);
  }
  const actions = config?.actions;
  if (!actions || typeof actions !== 'object') fail(`${CONFIG} has no "actions"`);
  for (const [id, a] of Object.entries(actions)) {
    const ok =
      Array.isArray(a?.command) &&
      a.command.length > 0 &&
      a.command.every((c) => typeof c === 'string') &&
      a.command[0].startsWith('/');
    if (!ok) fail(`Action "${id}": "command" must be a list of strings starting with an absolute path`);
  }
  return actions;
}

/** The command line of one action with its arguments filled in; every value is checked first. */
function plan(actions, id, rawArgs) {
  if (!Object.hasOwn(actions, id)) fail(`No action "${id}". Actions: ${Object.keys(actions).join(', ')}`);
  const action = actions[id];
  let args = {};
  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      fail('Arguments must be a JSON object');
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) fail('Arguments must be a JSON object');
  const declared = action.args ?? {};
  for (const name of Object.keys(args))
    if (!Object.hasOwn(declared, name)) fail(`"${id}" takes no argument "${name}"`);
  for (const [name, pattern] of Object.entries(declared)) {
    const value = args[name];
    if (typeof value !== 'string' || !value) fail(`"${id}" needs "${name}"`);
    if (value.length > MAX_ARG || /[\0-\x1f\x7f]/.test(value)) fail(`"${name}" is too long or has control characters`);
    if (/(^|\/)\.\.(\/|$)/.test(value)) fail(`"${name}" must not contain ".."`);
    if (!new RegExp(`^(?:${pattern})$`).test(value)) fail(`"${name}" does not match ${pattern}`);
  }
  const argv = action.command.map((part) =>
    part.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => (Object.hasOwn(declared, name) ? args[name] : `{${name}}`)),
  );
  return { id, description: action.description ?? id, auto: action.auto === true, argv, timeoutSeconds: action.timeoutSeconds ?? 120 };
}

const [first, ...rest] = process.argv.slice(2);
const actions = loadActions();
if (first === '--list') {
  const list = Object.entries(actions).map(([id, a]) => ({
    id,
    description: a.description ?? id,
    args: a.args ?? {},
    auto: a.auto === true,
  }));
  process.stdout.write(`${JSON.stringify(list)}\n`);
} else if (first === '--plan') {
  process.stdout.write(`${JSON.stringify(plan(actions, rest[0] ?? '', rest[1]))}\n`);
} else if (first) {
  const p = plan(actions, first, rest[0]);
  const run = spawnSync(p.argv[0], p.argv.slice(1), {
    stdio: 'inherit',
    timeout: p.timeoutSeconds * 1000,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
  });
  if (run.error?.code === 'ETIMEDOUT') {
    process.stderr.write(`Timed out after ${p.timeoutSeconds}s\n`);
    process.exit(124);
  }
  if (run.error) fail(`Could not start ${p.argv[0]}: ${run.error.message}`);
  process.exit(run.status ?? 1);
} else {
  fail('Usage: tara-priv --list | --plan <id> [args-json] | <id> [args-json]');
}
