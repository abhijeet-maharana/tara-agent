/**
 * The shared look of tara-agent's dashboard and the project dashboards it links to. Project
 * dashboards copy these two blocks verbatim (with a "copied from tara-agent src/http/look.ts" note)
 * so every page uses the same colours and the same "Dashboards" switcher. See docs/dashboard-look.md.
 */

/** Design tokens. Dark only. */
export const TOKENS = `:root{--bg:#090d16;--panel:#0d1320;--card-bg:#111827;--card-hover:#162032;--border:#1f293d;--border-light:#2e3e5c;
--text:#cbd5e1;--text-dim:#94a3b8;--text-heading:#f8fafc;--accent:#38bdf8;--accent-dim:rgba(56,189,248,.12);
--green:#10b981;--green-dim:rgba(16,185,129,.15);--amber:#f59e0b;--amber-dim:rgba(245,158,11,.12);--red:#f43f5e;--red-dim:rgba(244,63,94,.12);
--on-accent:#04121c;--radius:10px;--sidebar:236px;--font:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color-scheme:dark}`;

/** The brand letter and the "Dashboards" switcher at the bottom of every sidebar. */
export const SWITCHER_CSS = `.mark{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;flex:none;background:var(--border);color:var(--text-dim);font-size:12px;font-weight:700}
.brand .mark,.switch.on .mark{background:var(--accent-dim);color:var(--accent)}
.switcher{display:flex;flex-direction:column;gap:2px;padding:14px 8px 6px}
.switcher-label{padding:0 10px 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}
.switch{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:8px;color:var(--text);text-decoration:none;font-size:14px}
.switch:hover{background:var(--card-bg)}.switch.on{color:var(--accent);font-weight:600}`;
