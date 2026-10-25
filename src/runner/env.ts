import type { ProjectConfig } from '../config/schema.js';

/**
 * Variables never passed to the CLI. Credentials: the CLI must use its own login (or the API key when a
 * project opts into API billing), never a token handed over by tara-agent. CLAUDECODE: set when tara-agent
 * itself runs inside a Claude Code session, which would make the child think it is nested.
 */
const STRIPPED = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'TARA_HTTP_TOKEN',
  'TARA_ADMIN_TOKEN',
  'APPROVAL_SEAL_KEY',
  'CLAUDECODE',
];

export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  billing: ProjectConfig['billing'],
): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of STRIPPED) delete env[key];
  if (billing === 'api') {
    if (!parent.ANTHROPIC_API_KEY) throw new Error('billing is "api" but ANTHROPIC_API_KEY is not set');
    env.ANTHROPIC_API_KEY = parent.ANTHROPIC_API_KEY;
  }
  return env;
}
