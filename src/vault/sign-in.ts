import { secondsLeft, type Totp, totpCode } from './totp.js';

/**
 * Signing in with a saved login, in a tab tara-agent opens itself (vault/cdp.ts). The run never sees the
 * tab: the tab-ownership hook keeps runs on the tabs they opened, so neither the page nor its fields reach
 * the model. Steps: open the sign-in page, then up to a few rounds of "find the fields, type what they ask
 * for, submit, wait for the page to change", which covers one-page forms and email → password → code
 * flows alike. The session cookies land in the shared Chrome profile, so the run's own tab is signed in
 * once it reloads.
 *
 * Never retried on its own: a wrong password typed twice can lock an account.
 */

/** A browser tab as the sign-in needs it. */
export interface VaultPage {
  /** The address as the browser reports it (page scripts can't change it). */
  url(): Promise<string>;
  /** Runs an expression in the page and returns its value (JSON). */
  evaluate<T>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  /** Types into the focused element, as a person would (input events included). */
  insertText(text: string): Promise<void>;
  click(x: number, y: number): Promise<void>;
  pressEnter(): Promise<void>;
  close(): Promise<void>;
}

export interface Secrets {
  account?: string;
  password: string;
  totp?: Totp;
}

export type SignInStatus =
  /** No sign-in form left after submitting. */
  | 'signed-in'
  /** The page had no sign-in form to begin with. */
  | 'already-signed-in'
  /** A captcha: a person must sign in. */
  | 'captcha'
  /** A code the vault doesn't hold (SMS, email, or no authenticator key saved). */
  | 'needs-code'
  /** The site said no, or nothing happened. */
  | 'failed'
  /** The page went somewhere the login is not for. */
  | 'wrong-site';

export interface SignInResult {
  status: SignInStatus;
  /** For the run: what happened, never a secret. */
  message: string;
  /** Where the tab ended up (no query or fragment). */
  url?: string;
  title?: string;
}

/** What the page shows now (FIND_FORM). */
interface Form {
  user: boolean;
  userValue?: string;
  pass: boolean;
  code: boolean;
  /** One box per digit. */
  codeBoxes: number;
  captcha: boolean;
  /** No fields here, but frames that may hold them. */
  frames: boolean;
  title: string;
  error?: string;
}

/**
 * Finds the sign-in fields and marks them (`data-tara-vault`): visible, enabled inputs. A password field;
 * the account field (autocomplete username/email, a name like user/email/login/phone, or the text field
 * just before the password); a code field (autocomplete one-time-code, or a name like otp/code/2fa, or a
 * row of one-character boxes) when there is no password field.
 */
const FIND_FORM = `(() => {
  for (const el of document.querySelectorAll('[data-tara-vault]')) el.removeAttribute('data-tara-vault');
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && !el.disabled && !el.readOnly;
  };
  const inputs = [...document.querySelectorAll('input')].filter(shown);
  const words = (i) => [i.name, i.id, i.autocomplete, i.placeholder, i.getAttribute('aria-label'), i.labels && i.labels[0] && i.labels[0].textContent].filter(Boolean).join(' ');
  const textual = inputs.filter((i) => ['text', 'email', 'tel', 'number', ''].includes(i.type));
  const pass = inputs.find((i) => i.type === 'password');
  let code;
  let boxes = [];
  if (!pass) {
    code = textual.find((i) => i.autocomplete === 'one-time-code') ||
      textual.find((i) => /otp|totp|2fa|mfa|one.?time|verification|verify|security.?code|auth.*code|passcode|\\bcode\\b|\\bpin\\b/i.test(words(i)));
    const single = textual.filter((i) => i.maxLength === 1);
    if (!code && single.length >= 4 && single.length <= 8) boxes = single;
  }
  const others = textual.filter((i) => i !== code && !boxes.includes(i));
  let user = others.find((i) => /username|email/.test(i.autocomplete)) ||
    others.find((i) => /user|e-?mail|login|phone|mobile|account|identifier/i.test(words(i)));
  if (!user && pass) user = others.filter((i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
  if (user && !pass && !code && !boxes.length && !/username|email/.test(user.autocomplete) && !/user|e-?mail|login|phone|mobile|account|identifier/i.test(words(user))) user = undefined;
  if (user) user.setAttribute('data-tara-vault', 'user');
  if (pass) pass.setAttribute('data-tara-vault', 'pass');
  if (code) code.setAttribute('data-tara-vault', 'code');
  boxes.forEach((b, n) => b.setAttribute('data-tara-vault', 'code-' + n));
  const captcha = [...document.querySelectorAll('iframe, .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')].some((el) =>
    shown(el) && (el.tagName !== 'IFRAME' || /recaptcha|hcaptcha|turnstile|challenges\\.cloudflare|arkoselabs|funcaptcha|captcha/i.test(el.src)));
  const errors = [...document.querySelectorAll('[role=alert], [aria-live=assertive], [aria-live=polite], .error, .alert, [class*=error i], [class*=invalid i]')]
    .filter((el) => el.getBoundingClientRect().height > 0)
    .map((el) => (el.innerText || '').trim()).filter((t) => t && t.length < 300);
  return {
    user: Boolean(user), userValue: user ? user.value : undefined, pass: Boolean(pass), code: Boolean(code) || boxes.length > 0,
    codeBoxes: boxes.length, captcha, frames: !user && !pass && !code && !boxes.length && document.querySelectorAll('iframe').length > 0,
    title: document.title, error: [...new Set(errors)].join(' · ').slice(0, 300) || undefined,
  };
})()`;

/** Focuses a marked field and selects what is in it, so typing replaces it. */
const focus = (mark: string) => `(() => {
  const el = document.querySelector('[data-tara-vault="${mark}"]');
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el.select) el.select();
  return document.activeElement === el;
})()`;

/**
 * Where to click to submit: a submit button (or one that reads like "Sign in", "Next", "Continue",
 * "Verify") in the field's form, else on the page; undefined = press Enter in the field.
 */
const submitTarget = (mark: string) => `(() => {
  const field = document.querySelector('[data-tara-vault="${mark}"]');
  const scope = (field && field.closest('form')) || document;
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; };
  const all = [...scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')].filter(shown);
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
  const words = /^(log ?in|sign ?in|continue|next|submit|verify|confirm|proceed|login|done)\\b/i;
  const pick = all.find((el) => el.type === 'submit' && words.test(label(el))) || all.find((el) => words.test(label(el))) ||
    (scope !== document ? all.find((el) => el.type === 'submit') : undefined);
  if (!pick) return undefined;
  pick.scrollIntoView({ block: 'center' });
  const r = pick.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/** Empties the fields typed into, in case the page stays on them (a failed sign-in). */
const CLEAR = `(() => {
  for (const el of document.querySelectorAll('[data-tara-vault]')) {
    if (el.getAttribute('data-tara-vault') !== 'user') el.value = '';
    el.removeAttribute('data-tara-vault');
  }
  return true;
})()`;

export interface SignInOptions {
  /** The page to open. */
  url: string;
  /** Whether an address is one this login may be typed into. */
  allowed: (url: string) => boolean;
  secrets: Secrets;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a page to change after submitting. */
  settleMs?: number;
}

const ROUNDS = 5;
const POLL_MS = 500;

const sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An address without query or fragment (they may hold tokens). */
export function plainUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

/** Removes the secrets from text going back to the run (an error that echoes what was typed). */
function redact(text: string | undefined, secrets: Secrets): string | undefined {
  if (!text) return text;
  let out = text;
  for (const s of [secrets.password]) if (s && s.length >= 3) out = out.split(s).join('•••');
  return out;
}

const signature = (f: Form, url: string) =>
  JSON.stringify([plainUrl(url), f.user, f.pass, f.code, f.codeBoxes, f.captcha]);

export async function signIn(page: VaultPage, o: SignInOptions): Promise<SignInResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? sleeper;
  const settleMs = o.settleMs ?? 15_000;
  const { secrets } = o;
  const done = async (status: SignInStatus, message: string): Promise<SignInResult> => {
    const url = await page.url().catch(() => '');
    const title = await page.evaluate<string>('document.title').catch(() => undefined);
    return { status, message: redact(message, secrets) ?? message, url: plainUrl(url) || undefined, title };
  };
  const read = () => page.evaluate<Form>(FIND_FORM);
  /** The form once the page shows fields (or a captcha), or what it shows after `ms`. */
  const settle = async (ms: number, before?: string): Promise<Form> => {
    const until = now() + ms;
    for (;;) {
      const url = await page.url().catch(() => '');
      const form = await read().catch(() => undefined);
      if (form) {
        const changed = before === undefined || signature(form, url) !== before;
        const ready = form.user || form.pass || form.code || form.captcha;
        if (changed && (ready || before !== undefined)) {
          // A page that just changed may still be drawing its next step: look once more.
          if (before !== undefined && !ready) {
            await sleep(POLL_MS * 2);
            const again = await read().catch(() => undefined);
            if (again) return again;
          }
          return form;
        }
        if (now() >= until) return form;
      } else if (now() >= until) return { user: false, pass: false, code: false, codeBoxes: 0, captcha: false, frames: false, title: '' };
      await sleep(POLL_MS);
    }
  };
  const type = async (mark: string, text: string) => {
    if (!(await page.evaluate<boolean>(focus(mark)))) throw new Error(`could not focus the ${mark} field`);
    await page.insertText(text);
  };

  await page.navigate(o.url);
  if (!o.allowed(await page.url())) return done('wrong-site', 'The sign-in page went to an address this login is not saved for.');
  let form = await settle(10_000);
  let typedPassword = false;
  let typedCode = false;
  let typedAccount = false;
  for (let round = 0; round < ROUNDS; round++) {
    const url = await page.url();
    if (!o.allowed(url))
      return done('wrong-site', `The page moved to ${new URL(url).host}, which this login is not saved for (add it to its sites if it belongs).`);
    if (form.captcha) return done('captcha', 'The site shows a captcha: a person must sign in.');
    if (!form.user && !form.pass && !form.code) {
      if (round === 0)
        return form.frames
          ? done('failed', 'No sign-in fields on the page itself (the form may be inside a frame, which the vault does not fill).')
          : done('already-signed-in', 'The sign-in page shows no sign-in form: the browser seems to be signed in already.');
      return done('signed-in', 'Signed in: the page no longer asks for anything.');
    }
    // A field asked for again after it was typed: the site said no. Never type it twice.
    if ((form.pass && typedPassword) || (form.code && typedCode))
      return done('failed', `The site asked again after the ${form.pass ? 'password' : 'code'} was typed${form.error ? `: "${form.error}"` : ''}. Not retried (a second wrong try can lock the account); a person should check the login.`);
    let last = '';
    if (form.user && !(form.pass && form.userValue && form.userValue === secrets.account)) {
      if (!secrets.account) return done('failed', 'The site asks for an account, and the saved login has none.');
      if (typedAccount && !form.pass) return done('failed', `The site asked for the account again${form.error ? `: "${form.error}"` : ''}.`);
      if (form.userValue !== secrets.account) await type('user', secrets.account);
      typedAccount = true;
      last = 'user';
    }
    if (form.pass) {
      await type('pass', secrets.password);
      typedPassword = true;
      last = 'pass';
    } else if (form.code) {
      if (!secrets.totp) return done('needs-code', 'The site asks for a verification code, and this login has no authenticator key saved (an SMS or email code needs a person).');
      // A code about to change may expire on the way: wait for the next one.
      if (secondsLeft(secrets.totp, now()) < 4) await sleep(secondsLeft(secrets.totp, now()) * 1000 + 500);
      const code = totpCode(secrets.totp, now());
      if (form.codeBoxes)
        for (let n = 0; n < form.codeBoxes; n++) await type(`code-${n}`, code[n] ?? '');
      else await type('code', code);
      typedCode = true;
      last = form.codeBoxes ? `code-${form.codeBoxes - 1}` : 'code';
    }
    const before = signature(form, url);
    const at = await page.evaluate<{ x: number; y: number } | undefined>(submitTarget(last));
    if (at) await page.click(at.x, at.y);
    else {
      await page.evaluate<boolean>(focus(last));
      await page.pressEnter();
    }
    form = await settle(settleMs, before);
    if (signature(form, await page.url().catch(() => '')) === before)
      return done('failed', `Nothing changed after submitting${form.error ? `: "${form.error}"` : ''}.`);
  }
  return done('failed', 'The site kept asking for more steps than a sign-in takes.');
}

/** Empties typed fields and closes the tab; never throws. */
export async function cleanUp(page: VaultPage): Promise<void> {
  await page.evaluate(CLEAR).catch(() => undefined);
  await page.close().catch(() => undefined);
}
