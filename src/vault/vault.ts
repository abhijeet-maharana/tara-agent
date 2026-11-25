import { siteMatches } from '../http/browser-usage.js';
import type { Logger } from '../sessions/manager.js';
import type { Store, VaultRow, VaultUse } from '../store/store.js';
import { CdpPage } from './cdp.js';
import { keyCheck, open, parseVaultKey, seal, VaultKeyError } from './crypto.js';
import { cleanUp, type SignInResult, signIn, type VaultPage } from './sign-in.js';
import { parseTotp, totpCode } from './totp.js';

/**
 * The vault: website logins (account, password, authenticator key) that runs sign in with without ever
 * seeing them. A run calls `vault_sign_in`; tara-agent opens its own tab in the project's Chrome, types
 * the values there and submits, and tells the run only how it went (vault/sign-in.ts). Secrets are
 * encrypted with TARA_VAULT_KEY (vault/crypto.ts), which only tara-agent's user can read; logins are added
 * and revealed only on the dashboard from an unlocked browser on another device. Every use is logged.
 */

export class VaultError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A login as the dashboard and runs see it: never the password or the authenticator key. */
export interface VaultLogin {
  id: string;
  projects: string[];
  service: string;
  account?: string;
  sites: string[];
  loginUrl: string;
  hasTotp: boolean;
  note?: string;
  createdAt: number;
  updatedAt: number;
  /** Set when the current key can't open it. */
  unreadable?: boolean;
}

export interface LoginInput {
  id: string;
  projects: string[];
  service: string;
  account?: string;
  /** Default: the sign-in page's host. */
  sites?: string[];
  loginUrl: string;
  /** Empty when editing = keep the saved one. */
  password?: string;
  /** Setup key or otpauth:// link; empty when editing = keep. */
  totp?: string;
  /** Drop the saved authenticator key. */
  clearTotp?: boolean;
  note?: string;
}

interface Secret {
  password: string;
  totp?: string;
}

export interface VaultDeps {
  store: Store;
  /** TARA_VAULT_KEY; unset = the vault is off. */
  key?: string;
  log: Logger;
  now?: () => number;
  /** Opens a fresh tab in the Chrome at this address (tests pass a fake). */
  openPage?: (cdpUrl: string) => Promise<VaultPage>;
  /** Tests: no waiting between polls. */
  sleep?: (ms: number) => Promise<void>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CHECK_KEY = 'key-check';
/** After a failed sign-in, the login waits this long for a person (a second wrong try can lock it). */
const AFTER_FAILURE_MS = 30 * 60_000;
const MAX_PER_HOUR = 4;
/** Longest a sign-in may take in all. */
const SIGN_IN_TIMEOUT_MS = 100_000;

/** The host part of a site pattern (`*.example.com` stays as it is). */
function cleanSite(site: string): string {
  const s = site.trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('*.')) return s;
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).hostname;
  } catch {
    return '';
  }
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/** Whether a page address is one a login may be typed into: https (or http on this machine), a listed host. */
export function allowedUrl(sites: string[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(host))) return false;
  return sites.some((s) => siteMatches(s, host));
}

export class Vault {
  private readonly key?: Buffer;
  /** Why the vault can't be used, if so. */
  readonly problem?: string;
  private readonly busy = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: VaultDeps) {
    this.now = deps.now ?? Date.now;
    if (!deps.key) {
      this.problem = 'The vault is off: TARA_VAULT_KEY is not set';
      return;
    }
    try {
      this.key = parseVaultKey(deps.key);
    } catch (err) {
      this.problem = (err as Error).message;
      return;
    }
    const check = deps.store.vaultMeta(CHECK_KEY);
    const mine = keyCheck(this.key);
    if (check === undefined) deps.store.setVaultMeta(CHECK_KEY, mine);
    else if (check !== mine) {
      this.problem =
        'TARA_VAULT_KEY is not the key the vault was saved with: nothing is read or written until the right key is back';
      this.key = undefined;
    }
  }

  get on(): boolean {
    return Boolean(this.key);
  }

  private needKey(): Buffer {
    if (!this.key) throw new VaultError(503, this.problem ?? 'The vault is off');
    return this.key;
  }

  private secretOf(row: VaultRow): Secret {
    const parsed = JSON.parse(open(this.needKey(), `login:${row.id}`, row.secret)) as Secret;
    if (typeof parsed.password !== 'string') throw new VaultKeyError('Damaged vault value');
    return parsed;
  }

  private view(row: VaultRow): VaultLogin {
    let unreadable: boolean | undefined;
    if (this.key)
      try {
        this.secretOf(row);
      } catch {
        unreadable = true;
      }
    const { secret: _secret, ...rest } = row;
    return { ...rest, ...(unreadable && { unreadable }) };
  }

  /** Every login, or those a project may use. */
  list(project?: string): VaultLogin[] {
    return this.deps.store
      .vaultLogins()
      .filter((r) => !project || r.projects.includes(project))
      .map((r) => this.view(r));
  }

  get(id: string): VaultLogin | undefined {
    const row = this.deps.store.vaultLogin(id);
    return row && this.view(row);
  }

  uses(opts: { loginId?: string; limit?: number } = {}): VaultUse[] {
    return this.deps.store.vaultUses(opts);
  }

  private logUse(u: Omit<VaultUse, 'id' | 'at'>): void {
    this.deps.store.addVaultUse({ ...u, at: this.now() });
  }

  /** Adds or changes a login (a person, from the dashboard). */
  save(input: LoginInput, by: string): VaultLogin {
    const key = this.needKey();
    const id = input.id.trim().toLowerCase();
    if (!ID.test(id)) throw new VaultError(400, 'Id: 1–40 lowercase letters, digits and dashes, e.g. "meesho"');
    const service = input.service.trim();
    if (!service) throw new VaultError(400, 'Service is required, e.g. "Meesho Supplier Panel"');
    let loginUrl: URL;
    try {
      loginUrl = new URL(input.loginUrl.trim());
    } catch {
      throw new VaultError(400, 'Sign-in page: a full address, e.g. https://supplier.meesho.com/panel/v3/new/root/login');
    }
    const sites = [...new Set((input.sites ?? []).map(cleanSite).filter(Boolean))];
    if (!sites.length) sites.push(loginUrl.hostname.toLowerCase());
    if (!allowedUrl(sites, loginUrl.href))
      throw new VaultError(400, `The sign-in page must be https and on one of the sites (${sites.join(', ')})`);
    const projects = [...new Set(input.projects.map((p) => p.trim()).filter(Boolean))];
    if (!projects.length) throw new VaultError(400, 'Pick at least one project that may use it');
    const old = this.deps.store.vaultLogin(id);
    let previous: Secret | undefined;
    if (old)
      try {
        previous = this.secretOf(old);
      } catch {
        previous = undefined;
      }
    const password = input.password ?? '';
    if (!password && !previous) throw new VaultError(400, old ? 'The saved password can\'t be opened: enter it again' : 'Password is required');
    let totp = input.clearTotp ? undefined : previous?.totp;
    if (input.totp?.trim()) {
      try {
        parseTotp(input.totp);
      } catch (err) {
        throw new VaultError(400, `Authenticator key: ${(err as Error).message}`);
      }
      totp = input.totp.trim();
    }
    const secret: Secret = { password: password || (previous as Secret).password, ...(totp && { totp }) };
    const at = this.now();
    this.deps.store.saveVaultLogin({
      id,
      projects,
      service,
      account: input.account?.trim() || undefined,
      sites,
      loginUrl: loginUrl.href,
      secret: seal(key, `login:${id}`, JSON.stringify(secret)),
      hasTotp: Boolean(totp),
      note: input.note?.trim() || undefined,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    });
    const changed = [old ? 'changed' : 'added', password && old && 'new password', input.totp?.trim() && 'authenticator key', input.clearTotp && 'authenticator key removed']
      .filter(Boolean)
      .join(', ');
    this.logUse({ loginId: id, action: 'saved', status: 'ok', detail: changed, by });
    this.deps.log.info(`vault: ${id} ${changed} by ${by}`);
    return this.view(this.deps.store.vaultLogin(id) as VaultRow);
  }

  delete(id: string, by: string): void {
    if (!this.deps.store.deleteVaultLogin(id)) throw new VaultError(404, `No saved login "${id}"`);
    this.logUse({ loginId: id, action: 'deleted', status: 'ok', by });
    this.deps.log.info(`vault: ${id} deleted by ${by}`);
  }

  /** The secrets, for a person on the dashboard (logged). */
  reveal(id: string, by: string): { account?: string; password: string; code?: string } {
    const row = this.deps.store.vaultLogin(id);
    if (!row) throw new VaultError(404, `No saved login "${id}"`);
    let secret: Secret;
    try {
      secret = this.secretOf(row);
    } catch (err) {
      throw new VaultError(409, (err as Error).message);
    }
    this.logUse({ loginId: id, action: 'reveal', status: 'ok', by });
    this.deps.log.info(`vault: ${id} revealed by ${by}`);
    return {
      account: row.account,
      password: secret.password,
      ...(secret.totp && { code: totpCode(parseTotp(secret.totp), this.now()) }),
    };
  }

  /**
   * Signs a project's Chrome in with a saved login (a run's `vault_sign_in`). `login` is the id or the
   * service name; `url`, a page to open instead of the saved sign-in page (must be on its sites).
   */
  async signIn(o: { project: string; by: string; login: string; url?: string; cdpUrl?: string }): Promise<SignInResult> {
    this.needKey();
    const wanted = o.login.trim().toLowerCase();
    const mine = this.deps.store.vaultLogins().filter((r) => r.projects.includes(o.project));
    const row = mine.find((r) => r.id === wanted) ?? mine.find((r) => r.service.toLowerCase() === wanted);
    if (!row)
      throw new VaultError(
        404,
        `No saved login "${o.login}" for this project. ${mine.length ? `Saved: ${mine.map((r) => `${r.id} (${r.service})`).join(', ')}.` : 'It has none.'} Raise a login card for a person instead.`,
      );
    const refuse = (message: string): never => {
      this.logUse({ loginId: row.id, project: o.project, action: 'sign-in', status: 'refused', detail: message, by: o.by });
      throw new VaultError(409, message);
    };
    if (!o.cdpUrl) refuse('This project has no shared Chrome (its .mcp.json --browserUrl), so the vault has nowhere to sign in.');
    const url = o.url?.trim() || row.loginUrl;
    if (!allowedUrl(row.sites, url)) refuse(`${url} is not on this login's sites (${row.sites.join(', ')}).`);
    if (this.busy.has(row.id)) refuse('A sign-in with this login is already running.');
    const recent = this.deps.store
      .vaultUses({ loginId: row.id, since: this.now() - 3_600_000, limit: 50 })
      .filter((u) => u.action === 'sign-in' && u.status !== 'refused');
    const lastFailed = recent.find((u) => u.status === 'failed');
    const lastSaved = this.deps.store.vaultUses({ loginId: row.id, limit: 20 }).find((u) => u.action === 'saved');
    if (lastFailed && this.now() - lastFailed.at < AFTER_FAILURE_MS && !(lastSaved && lastSaved.at > lastFailed.at))
      refuse(
        'The last sign-in with this login failed less than 30 minutes ago. It is not retried (a second wrong try can lock the account): raise a login card for a person.',
      );
    if (recent.length >= MAX_PER_HOUR)
      refuse(`${recent.length} sign-ins with this login in the last hour: something keeps signing it out. Raise a card for a person.`);
    let secret: Secret;
    try {
      secret = this.secretOf(row);
    } catch (err) {
      return refuse((err as Error).message);
    }
    this.busy.add(row.id);
    let page: VaultPage | undefined;
    try {
      page = await (this.deps.openPage ?? ((u: string) => CdpPage.open(u)))(o.cdpUrl as string);
      const opened = page;
      const run = signIn(opened, {
        url,
        allowed: (u) => allowedUrl(row.sites, u),
        secrets: { account: row.account, password: secret.password, totp: secret.totp ? parseTotp(secret.totp) : undefined },
        now: this.now,
        sleep: this.deps.sleep,
      });
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        run,
        new Promise<SignInResult>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: 'failed', message: 'The sign-in took too long and was stopped; it may or may not have gone through.' }),
            SIGN_IN_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      this.logUse({
        loginId: row.id,
        project: o.project,
        action: 'sign-in',
        status: result.status,
        detail: [result.message, result.url].filter(Boolean).join(' · ').slice(0, 500),
        by: o.by,
      });
      this.deps.log.info(`vault: ${row.id} sign-in for ${o.by}: ${result.status}`);
      return result;
    } catch (err) {
      const message = `The sign-in stopped: ${(err as Error).message}`;
      this.logUse({ loginId: row.id, project: o.project, action: 'sign-in', status: 'failed', detail: message, by: o.by });
      this.deps.log.warn(`vault: ${row.id} sign-in for ${o.by}: ${message}`);
      return { status: 'failed', message };
    } finally {
      if (page) await cleanUp(page);
      this.busy.delete(row.id);
    }
  }
}
