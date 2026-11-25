import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_COOKIE, adminCookieValue } from '../src/http/guards.js';
import { startHttpServer } from '../src/http/server.js';
import { buildChildEnv } from '../src/runner/env.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import { Store } from '../src/store/store.js';
import { keyCheck, open, parseVaultKey, seal } from '../src/vault/crypto.js';
import { signIn, type VaultPage } from '../src/vault/sign-in.js';
import { base32Decode, parseTotp, totpCode } from '../src/vault/totp.js';
import { allowedUrl, Vault } from '../src/vault/vault.js';

const silent = { info() {}, warn() {}, error() {} };
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

describe('vault crypto', () => {
  const key = parseVaultKey(KEY);
  it('opens what it sealed, only with the same key and purpose', () => {
    const sealed = seal(key, 'login:x', 'hunter2');
    expect(sealed).not.toContain('hunter2');
    expect(open(key, 'login:x', sealed)).toBe('hunter2');
    expect(() => open(key, 'login:y', sealed)).toThrow(/can't be opened/);
    expect(() => open(parseVaultKey(OTHER_KEY), 'login:x', sealed)).toThrow(/can't be opened/);
  });
  it('takes 32 bytes as hex or base64, nothing else', () => {
    expect(parseVaultKey(Buffer.alloc(32, 7).toString('base64')).length).toBe(32);
    expect(() => parseVaultKey('short')).toThrow(/32 bytes/);
    expect(keyCheck(key)).not.toBe(keyCheck(parseVaultKey(OTHER_KEY)));
  });
});

describe('TOTP', () => {
  // RFC 6238 appendix B: the ASCII secret "12345678901234567890".
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches the RFC test vectors', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    const t = parseTotp(`otpauth://totp/x?secret=${secret}&digits=8`);
    expect(totpCode(t, 59_000)).toBe('94287082');
    expect(totpCode(t, 1_111_111_109_000)).toBe('07081804');
    expect(totpCode(parseTotp(secret.toLowerCase()), 59_000)).toBe('287082');
  });
  it('says what is wrong with a bad key', () => {
    expect(() => parseTotp('not base32!')).toThrow(/base32/);
    expect(() => parseTotp('otpauth://hotp/x?secret=GEZD')).toThrow(/time-based/);
  });
});

describe('allowedUrl', () => {
  it('needs https (http only on this machine) and a listed host', () => {
    expect(allowedUrl(['example.com'], 'https://example.com/login')).toBe(true);
    expect(allowedUrl(['example.com'], 'http://example.com/login')).toBe(false);
    expect(allowedUrl(['example.com'], 'https://evil.com/?example.com')).toBe(false);
    expect(allowedUrl(['*.example.com'], 'https://id.example.com/')).toBe(true);
    expect(allowedUrl(['localhost'], 'http://localhost:4000/')).toBe(true);
  });
});

/** A sign-in page as a list of steps: each shows some fields; submitting moves to the next. */
interface Step {
  user?: boolean;
  userValue?: string;
  pass?: boolean;
  code?: boolean;
  codeBoxes?: number;
  captcha?: boolean;
  error?: string;
  url?: string;
  /** Submitting stays on this step (the site said no). */
  stay?: boolean;
}

class FakePage implements VaultPage {
  at = 0;
  focused = '';
  typed: Array<[string, string]> = [];
  clicks = 0;
  closed = false;
  cleared = false;
  constructor(
    private readonly steps: Step[],
    private readonly base = 'https://shop.example.com/login',
  ) {}
  private get step(): Step {
    return this.steps[Math.min(this.at, this.steps.length - 1)] ?? {};
  }
  async url() {
    return this.step.url ?? this.base;
  }
  async evaluate<T>(expression: string): Promise<T> {
    if (expression === 'document.title') return 'Shop' as T;
    if (expression.includes("document.querySelectorAll('[data-tara-vault]')") && expression.includes('captcha')) {
      const s = this.step;
      return {
        user: Boolean(s.user),
        userValue: s.userValue ?? '',
        pass: Boolean(s.pass),
        code: Boolean(s.code || s.codeBoxes),
        codeBoxes: s.codeBoxes ?? 0,
        captcha: Boolean(s.captcha),
        frames: false,
        title: 'Shop',
        error: s.error,
      } as T;
    }
    if (expression.includes('.focus()')) {
      this.focused = /data-tara-vault="([^"]+)"/.exec(expression)?.[1] ?? '';
      return true as T;
    }
    if (expression.includes("closest('form')")) return { x: 10, y: 20 } as T;
    if (expression.includes("el.value = ''")) {
      this.cleared = true;
      return true as T;
    }
    throw new Error(`unexpected script ${expression.slice(0, 40)}`);
  }
  async navigate() {}
  async insertText(text: string) {
    this.typed.push([this.focused, text]);
  }
  async click() {
    this.clicks++;
    if (!this.step.stay) this.at++;
  }
  async pressEnter() {
    await this.click();
  }
  async close() {
    this.closed = true;
  }
}

describe('signIn', () => {
  let clock = 1_000_000;
  const opts = (extra: Partial<Parameters<typeof signIn>[1]> = {}) => ({
    url: 'https://shop.example.com/login',
    allowed: (u: string) => allowedUrl(['shop.example.com'], u),
    secrets: { account: 'me@shop.com', password: 'hunter2' },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    settleMs: 3_000,
    ...extra,
  });

  it('fills a one-page form and submits once', async () => {
    const page = new FakePage([{ user: true, pass: true }, {}]);
    const r = await signIn(page, opts());
    expect(r.status).toBe('signed-in');
    expect(page.typed).toEqual([
      ['user', 'me@shop.com'],
      ['pass', 'hunter2'],
    ]);
    expect(page.clicks).toBe(1);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('follows account → password → authenticator code', async () => {
    const totp = parseTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const page = new FakePage([{ user: true }, { pass: true, userValue: 'me@shop.com' }, { codeBoxes: 6 }, {}]);
    clock = 1_000_010_000;
    const r = await signIn(page, opts({ secrets: { account: 'me@shop.com', password: 'hunter2', totp } }));
    expect(r.status).toBe('signed-in');
    const code = page.typed.filter(([m]) => m.startsWith('code-')).map(([, d]) => d).join('');
    expect(code).toBe(totpCode(totp, clock));
    expect(page.typed.filter(([m]) => m === 'user')).toHaveLength(1);
  });

  it('never types the password twice when the site says no', async () => {
    const page = new FakePage([{ user: true, pass: true, stay: true, error: 'Wrong password hunter2' }]);
    const r = await signIn(page, opts());
    expect(r.status).toBe('failed');
    expect(page.typed.filter(([m]) => m === 'pass')).toHaveLength(1);
    expect(r.message).not.toContain('hunter2');
  });

  it('stops at a captcha, an unsaved code, another site, or an existing session', async () => {
    expect((await signIn(new FakePage([{ captcha: true, user: true }]), opts())).status).toBe('captcha');
    expect((await signIn(new FakePage([{ user: true, pass: true }, { code: true }]), opts())).status).toBe(
      'needs-code',
    );
    expect(
      (await signIn(new FakePage([{ user: true, pass: true }, { user: true, url: 'https://evil.com/x' }]), opts()))
        .status,
    ).toBe('wrong-site');
    expect((await signIn(new FakePage([{}]), opts())).status).toBe('already-signed-in');
  });
});

describe('Vault', () => {
  const input = {
    id: 'shop',
    projects: ['shop'],
    service: 'Shop admin',
    account: 'me@shop.com',
    loginUrl: 'https://shop.example.com/login',
    password: 'hunter2',
  };

  it('stays off without a key and refuses a different key than it was saved with', () => {
    const store = new Store(':memory:');
    expect(new Vault({ store, log: silent }).on).toBe(false);
    const v = new Vault({ store, key: KEY, log: silent });
    v.save(input, 'dashboard');
    const wrong = new Vault({ store, key: OTHER_KEY, log: silent });
    expect(wrong.on).toBe(false);
    expect(wrong.problem).toMatch(/not the key/);
    expect(() => wrong.reveal('shop', 'dashboard')).toThrow(/not the key/);
  });

  it('never lists a secret, keeps the password on edit, logs reveals', () => {
    const store = new Store(':memory:');
    const v = new Vault({ store, key: KEY, log: silent, now: () => 5 });
    v.save({ ...input, totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }, 'dashboard');
    v.save({ ...input, password: '', account: 'other@shop.com' }, 'dashboard');
    expect(JSON.stringify(v.list())).not.toContain('hunter2');
    expect(v.list()[0]).toMatchObject({ account: 'other@shop.com', hasTotp: true, sites: ['shop.example.com'] });
    const shown = v.reveal('shop', 'dashboard');
    expect(shown.password).toBe('hunter2');
    expect(shown.code).toMatch(/^\d{6}$/);
    expect(v.uses().map((u) => u.action)).toEqual(['reveal', 'saved', 'saved']);
    expect(() => v.save({ ...input, loginUrl: 'http://shop.example.com/' }, 'x')).toThrow(/https/);
    expect(() => v.save({ ...input, id: 'Bad Id' }, 'x')).toThrow(/Id/);
  });

  it('signs in through a fresh tab it closes, and holds the login after a failure', async () => {
    const store = new Store(':memory:');
    let clock = 10_000_000;
    const pages: FakePage[] = [];
    let next: Step[] = [{ user: true, pass: true, stay: true, error: 'Wrong password' }];
    const v = new Vault({
      store,
      key: KEY,
      log: silent,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      openPage: async () => {
        const p = new FakePage(next);
        pages.push(p);
        return p;
      },
    });
    v.save(input, 'dashboard');
    const sign = () => v.signIn({ project: 'shop', by: 'shop/orders', login: 'Shop admin', cdpUrl: 'http://c' });
    await expect(v.signIn({ project: 'other', by: 'x', login: 'shop', cdpUrl: 'http://c' })).rejects.toThrow(
      /No saved login/,
    );
    await expect(v.signIn({ project: 'shop', by: 'x', login: 'shop' })).rejects.toThrow(/no shared Chrome/);
    expect((await sign()).status).toBe('failed');
    expect(pages[0]?.closed).toBe(true);
    expect(pages[0]?.cleared).toBe(true);
    await expect(sign()).rejects.toThrow(/failed less than 30 minutes ago/);
    // A new password saved by a person lifts the hold.
    clock += 60_000;
    v.save({ ...input, password: 'correct' }, 'dashboard');
    next = [{ user: true, pass: true }, {}];
    expect((await sign()).status).toBe('signed-in');
    expect(pages[1]?.typed).toContainEqual(['pass', 'correct']);
    const signIns = v.uses().filter((u) => u.action === 'sign-in');
    expect(signIns.map((u) => u.status)).toEqual(['signed-in', 'refused', 'failed', 'refused']);
    expect(signIns[0]?.by).toBe('shop/orders');
  });
});

describe('vault keys and routes', () => {
  const servers: Array<{ close(): void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('never hands the key to a run', () => {
    expect(buildChildEnv({ TARA_VAULT_KEY: KEY, PATH: '/bin' }, undefined).TARA_VAULT_KEY).toBeUndefined();
  });

  it('lists without secrets and refuses changes from this machine', async () => {
    const store = new Store(':memory:');
    const vault = new Vault({ store, key: KEY, log: silent });
    vault.save(
      { id: 'shop', projects: ['shop'], service: 'Shop', loginUrl: 'https://shop.example.com/', password: 'hunter2' },
      'dashboard',
    );
    const server = await startHttpServer({
      bind: '127.0.0.1',
      port: 0,
      scheduler: { list: () => [], plannedRuns: () => [] } as unknown as Scheduler,
      store,
      projects: ['shop'],
      log: silent,
      vault,
      adminToken: 'key',
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const list = await (await fetch(`${base}/vault`)).text();
    expect(list).toContain('"shop"');
    expect(list).not.toContain('hunter2');
    const reveal = await fetch(`${base}/vault/shop/reveal`, {
      method: 'POST',
      headers: { cookie: `${ADMIN_COOKIE}=${adminCookieValue('key')}` },
      body: '{}',
    });
    expect(reveal.status).toBe(403);
    expect(await reveal.text()).not.toContain('hunter2');
  });
});
