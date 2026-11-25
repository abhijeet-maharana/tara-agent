import type { VaultUse } from '../store/store.js';
import type { VaultLogin } from '../vault/vault.js';
import type { Login } from './browser-usage.js';
import { type DashboardContext, esc, layout, pageHead, projectTitle, relative, section, when } from './dashboard.js';

/**
 * The Vault page: saved website logins (never their secrets), adding and changing them, revealing one,
 * and the log of every sign-in, reveal and change. Changes and reveals need an unlocked browser on another
 * device (`c.human`), like decisions: runs on this machine can read the page but never a secret.
 */

export interface VaultPageData {
  on: boolean;
  problem?: string;
  logins: VaultLogin[];
  uses: VaultUse[];
  /** Logins named in projects' `.tara/logins.json` that are not saved yet, to add in one tap. */
  suggestions: { project: string; login: Login }[];
  canEdit: boolean;
  now: number;
}

const STYLE = `<style>
.vault-list{display:grid;gap:8px}
.vault .title{font-weight:600}
.vault code{font-size:12px}
.vault-form{display:grid;gap:10px;max-width:760px}
.vault-form .checks{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--text)}
.vault-form .checks label{display:flex;gap:6px;align-items:center}
.vault-form .hint{font-size:12px;color:var(--text-dim)}
.revealed{margin-top:8px;font-size:13px;display:grid;gap:4px}
.revealed code{user-select:all;font-size:13px;padding:2px 6px;background:var(--bg);border-radius:6px}
.uses{width:100%;border-collapse:collapse;font-size:13px}
.uses td,.uses th{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.uses th{color:var(--text-dim);font-weight:600}
.uses td.detail{color:var(--text-dim);overflow-wrap:anywhere}
.sugg{display:flex;flex-wrap:wrap;gap:6px}
</style>`;

const SCRIPT = `{
const form = document.getElementById('vault-form');
const fill = (d) => {
  form.reset();
  for (const [k, v] of Object.entries(d)) {
    const el = form.elements[k];
    if (el && !(el instanceof RadioNodeList) && el.type !== 'checkbox') el.value = v ?? '';
  }
  for (const box of form.querySelectorAll('input[name=projects]')) box.checked = (d.projects || []).includes(box.value);
  form.elements.id.readOnly = Boolean(d.editing);
  form.elements.password.placeholder = d.editing ? 'Leave empty to keep the saved one' : '';
  form.elements.totp.placeholder = d.editing && d.hasTotp ? 'Saved; leave empty to keep it' : 'Setup key or otpauth:// link (optional)';
  form.querySelector('.clear-totp').hidden = !(d.editing && d.hasTotp);
  document.getElementById('vault-add').open = true;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  (d.editing ? form.elements.password : form.elements.id).focus();
};
document.addEventListener('click', async (e) => {
  const edit = e.target.closest('button[data-edit]');
  if (edit) return fill({ ...JSON.parse(edit.dataset.edit), editing: true });
  const sugg = e.target.closest('button[data-suggest]');
  if (sugg) return fill(JSON.parse(sugg.dataset.suggest));
  const del = e.target.closest('button[data-delete]');
  if (del) {
    if (!(await ask('Delete ' + del.dataset.name + '?', 'Runs can no longer sign in with it. This cannot be undone.', 'Delete', true))) return;
    try { await post('/vault/' + del.dataset.delete + '/delete', {}); toast('Deleted'); reload(); }
    catch (err) { toast(err.message, { error: true }); }
    return;
  }
  const show = e.target.closest('button[data-reveal]');
  if (show) {
    if (!(await ask('Show the password for ' + show.dataset.name + '?', 'It is shown here for a minute and logged.', 'Show'))) return;
    try {
      const r = await post('/vault/' + show.dataset.reveal + '/reveal', {});
      const box = document.getElementById('revealed-' + show.dataset.reveal);
      box.replaceChildren();
      const line = (label, value) => { if (!value) return; const p = document.createElement('div'); p.append(label + ' '); const c = document.createElement('code'); c.textContent = value; p.append(c); box.append(p); };
      line('Account', r.account); line('Password', r.password); line('Code now', r.code);
      box.hidden = false;
      setTimeout(() => { box.replaceChildren(); box.hidden = true; }, 60000);
    } catch (err) { toast(err.message, { error: true }); }
  }
});
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  const body = {
    id: f.id.value, service: f.service.value, account: f.account.value, loginUrl: f.loginUrl.value,
    sites: f.sites.value.split(/[\\s,]+/).filter(Boolean), note: f.note.value,
    projects: [...form.querySelectorAll('input[name=projects]:checked')].map((b) => b.value),
    password: f.password.value, totp: f.totp.value, clearTotp: f.clearTotp.checked,
  };
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await post('/vault', body);
    f.password.value = ''; f.totp.value = '';
    toast('Saved'); reload();
  } catch (err) { toast(err.message, { error: true }); btn.disabled = false; }
});
}`;

const STATUS_TAG: Record<string, string> = {
  'signed-in': 'ok',
  'already-signed-in': 'ok',
  ok: 'ok',
  failed: 'bad',
  refused: 'warn',
  captcha: 'warn',
  'needs-code': 'warn',
  'wrong-site': 'bad',
};

function loginRow(ctx: DashboardContext, l: VaultLogin, last: VaultUse | undefined, d: VaultPageData): string {
  const edit = {
    id: l.id,
    service: l.service,
    account: l.account ?? '',
    loginUrl: l.loginUrl,
    sites: l.sites.join(', '),
    note: l.note ?? '',
    projects: l.projects,
    hasTotp: l.hasTotp,
  };
  const buttons = d.canEdit
    ? `<button type="button" class="btn ghost" data-edit="${esc(JSON.stringify(edit))}">Edit</button>
<button type="button" class="btn ghost" data-reveal="${esc(l.id)}" data-name="${esc(l.service)}">Show</button>
<button type="button" class="btn quiet" data-delete="${esc(l.id)}" data-name="${esc(l.service)}">Delete</button>`
    : '';
  const lastText = last
    ? `Last sign-in: <span class="tag ${STATUS_TAG[last.status] ?? 'dim'}">${esc(last.status)}</span> ${esc(relative(last.at, d.now))} by ${esc(last.by ?? '?')}`
    : 'Never used by a run';
  return `<div class="row vault"><span class="dot ${l.unreadable ? 'bad' : 'ok'}"></span><span class="grow">
<span class="title">${esc(l.service)}</span> <code>${esc(l.id)}</code>${l.hasTotp ? ' <span class="tag">🔢 Authenticator</span>' : ''}${
    l.unreadable ? ' <span class="tag bad">Can\'t be opened with this key</span>' : ''
  }
<span class="meta">${l.account ? `<b>${esc(l.account)}</b>` : '<span>No account</span>'}<span>${l.sites.map((s) => esc(s)).join(', ')}</span>${l.projects
    .map((p) => `<span class="tag dim">${esc(projectTitle(ctx, p))}</span>`)
    .join('')}</span>
<span class="meta">${lastText}${l.note ? ` · ${esc(l.note)}` : ''}</span>
<div class="revealed" id="revealed-${esc(l.id)}" hidden></div>
</span>${buttons}</div>`;
}

function formHtml(ctx: DashboardContext): string {
  const projects = ctx.projects
    .map(
      (p) =>
        `<label><input type="checkbox" name="projects" value="${esc(p.config.name)}"> ${esc(projectTitle(ctx, p.config.name))}</label>`,
    )
    .join('');
  return `<details id="vault-add" class="card"><summary><b>Add or change a login</b></summary>
<form id="vault-form" class="vault-form" autocomplete="off">
<div class="fields">
<label class="field">Id (short, fixed)<input class="input" name="id" required pattern="[a-z0-9][a-z0-9-]{0,39}" placeholder="meesho"></label>
<label class="field">Service<input class="input" name="service" required placeholder="Meesho Supplier Panel"></label>
<label class="field">Account (email, phone or username)<input class="input" name="account" autocomplete="off" placeholder="business@example.com"></label>
<label class="field">Sign-in page<input class="input" name="loginUrl" required type="url" placeholder="https://supplier.meesho.com/panel/v3/new/root/login"></label>
<label class="field">Password<input class="input" name="password" type="password" autocomplete="new-password"></label>
<label class="field">Authenticator key<input class="input" name="totp" autocomplete="off" spellcheck="false"><label class="clear-totp hint" hidden><input type="checkbox" name="clearTotp"> Remove the saved key</label></label>
</div>
<label class="field">Sites it may be typed into (comma separated; default: the sign-in page's host; <code>*.example.com</code> covers subdomains)<input class="input" name="sites" placeholder="supplier.meesho.com"></label>
<div class="field">Projects whose runs may use it<div class="checks">${projects}</div></div>
<label class="field">Note (for runs and you, no secrets)<input class="input" name="note" placeholder="e.g. OTP goes to the business phone"></label>
<p class="hint">The authenticator key is what a site shows next to its QR code when you turn on two-step sign-in (often behind "Can't scan it?"). With it, runs enter the 6-digit code too. SMS and email codes still need you.</p>
<div><button type="submit" class="btn">Save</button></div>
</form></details>`;
}

export function vaultPage(ctx: DashboardContext, d: VaultPageData): string {
  const head = pageHead(
    'Vault',
    'Website logins runs sign in with without ever seeing them: a run calls vault_sign_in, and tara-agent types the account, password and authenticator code into its own tab of the project\'s Chrome, then tells the run only how it went. Passwords are encrypted with TARA_VAULT_KEY.',
  );
  if (!d.on)
    return layout(
      ctx,
      'Vault',
      'Vault',
      `${STYLE}${head}<div class="card bad"><b>${esc(d.problem ?? 'The vault is off')}</b><p class="dim">To turn it on, add <code>TARA_VAULT_KEY=$(openssl rand -hex 32)</code> to tara-agent's root-only env file, keep a copy of it somewhere safe (saved logins can't be read without it), and restart tara-agent.</p></div>`,
    );
  const lastSignIn = new Map<string, VaultUse>();
  for (const u of d.uses) if (u.action === 'sign-in' && !lastSignIn.has(u.loginId)) lastSignIn.set(u.loginId, u);
  const list = d.logins.length
    ? `<div class="vault-list">${d.logins.map((l) => loginRow(ctx, l, lastSignIn.get(l.id), d)).join('')}</div>`
    : '<p class="empty">No saved logins yet.</p>';
  const lock = d.canEdit
    ? ''
    : '<div class="card warn">Adding, changing and showing logins needs this browser <a href="/unlock">unlocked</a>, from a device other than the server.</div>';
  const sugg = d.suggestions.length
    ? section(
        'From the projects\' logins lists',
        `<p class="dim">Named in a project's <code>.tara/logins.json</code> but not saved here. Tap one to fill the form, then add the password.</p><div class="sugg">${d.suggestions
          .map(({ project, login }) => {
            const site = login.sites.find((s) => !s.startsWith('*.')) ?? login.sites[0]?.replace(/^\*\./, '') ?? '';
            const fillWith = {
              id: login.service
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 40),
              service: login.service,
              account: login.account ?? '',
              sites: login.sites.join(', '),
              loginUrl: site ? `https://${site}/` : '',
              note: login.note ?? '',
              projects: [project],
            };
            return `<button type="button" class="btn ghost" data-suggest="${esc(JSON.stringify(fillWith))}" ${d.canEdit ? '' : 'disabled'}>${esc(login.service)} · ${esc(projectTitle(ctx, project))}</button>`;
          })
          .join('')}</div>`,
      )
    : '';
  const uses = d.uses.length
    ? `<div class="tbl-wrap"><table class="uses"><thead><tr><th>When</th><th>Login</th><th>What</th><th>By</th><th>Detail</th></tr></thead><tbody>${d.uses
        .map(
          (u) =>
            `<tr><td title="${esc(when(u.at, ctx.timeZone))}">${esc(relative(u.at, d.now))}</td><td><code>${esc(u.loginId)}</code></td><td>${esc(u.action)} <span class="tag ${STATUS_TAG[u.status] ?? 'dim'}">${esc(u.status)}</span></td><td>${esc(u.by ?? '')}</td><td class="detail">${esc(u.detail ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="empty">Nothing yet.</p>';
  const body = `${STYLE}${head}${lock}${section('Saved logins', list, { sub: `${d.logins.length} saved` })}${
    d.canEdit ? formHtml(ctx) : ''
  }${sugg}${section('Log', uses, { sub: 'sign-ins, reveals and changes' })}`;
  return layout(ctx, 'Vault', 'Vault', body, { script: d.canEdit ? SCRIPT : undefined });
}
