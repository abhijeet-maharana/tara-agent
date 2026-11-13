import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The Claude Code login the runs use, from `<config dir>/.credentials.json`. The access token renews
 * itself every few hours, but the refresh token behind it has a hard end (`refreshTokenExpiresAt`,
 * about 30 days after `claude auth login`); after that every run fails until someone logs in again.
 */
export interface ClaudeLogin {
  loggedIn: boolean;
  /** When the login stops renewing (ms). Unset: the CLI didn't record it. */
  endsAt?: number;
  /** The OS user to log in as. */
  user?: string;
  /** Why the file couldn't be read. */
  error?: string;
}

/** Only the expiry is kept from the file; the tokens are dropped right here. */
export function parseCredentials(json: string): Pick<ClaudeLogin, 'loggedIn' | 'endsAt'> {
  const oauth = (
    JSON.parse(json) as { claudeAiOauth?: { refreshToken?: unknown; refreshTokenExpiresAt?: unknown } }
  )?.claudeAiOauth;
  if (!oauth?.refreshToken) return { loggedIn: false };
  const raw = Number(oauth.refreshTokenExpiresAt);
  if (!Number.isFinite(raw) || raw <= 0) return { loggedIn: true };
  return { loggedIn: true, endsAt: raw < 1e12 ? raw * 1000 : raw };
}

export interface LoginReaderOptions {
  /** CLAUDE_CONFIG_DIR of the runs; default ~/.claude of `readAs` or this user. */
  configDir: string;
  /** The run user (`claude.runAs`): its file is readable by it only, so it is read through sudo. */
  readAs?: string;
  /** Re-read at most this often (sudo logs every read). Default 15 minutes. */
  cacheMs?: number;
  now?: () => number;
}

/**
 * Reads the login, cached. Undefined when there is no file: the login is in the macOS keychain or
 * the runs use an API key, and neither has an end date to watch.
 */
export function claudeLoginReader(o: LoginReaderOptions): () => Promise<ClaudeLogin | undefined> {
  const file = path.join(o.configDir, '.credentials.json');
  const now = o.now ?? Date.now;
  const cacheMs = o.cacheMs ?? 15 * 60_000;
  let cached: { at: number; value: ClaudeLogin | undefined } | undefined;

  const read = async (): Promise<string | undefined> => {
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      if (code !== 'EACCES' || !o.readAs) throw err;
    }
    try {
      const { stdout } = await run('sudo', ['-n', '-u', o.readAs, '/bin/cat', '--', file], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      return stdout;
    } catch (err) {
      if (/No such file/i.test((err as { stderr?: string }).stderr ?? '')) return undefined;
      throw err;
    }
  };

  return async () => {
    const at = now();
    if (cached && at - cached.at < cacheMs) return cached.value;
    let value: ClaudeLogin | undefined;
    try {
      const json = await read();
      value = json === undefined ? undefined : { ...parseCredentials(json), user: o.readAs };
    } catch (err) {
      value = {
        loggedIn: false,
        user: o.readAs,
        error: ((err as Error).message || String(err)).split('\n')[0],
      };
    }
    cached = { at, value };
    return value;
  };
}
