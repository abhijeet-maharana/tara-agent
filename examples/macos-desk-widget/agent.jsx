// Agent panel: tara-agent's glance (GET /glance), the failing jobs and oldest cards from
// GET /attention, optional extra tiles, and a macOS notification for each new urgent item. Look only (no clicks). Data: lib/agent-state.sh.
import { React, css, run } from 'uebersicht'; // React: <>…</> compiles to React.Fragment

const DIR = 'tara-desk-widget'; // the symlink's name in Übersicht's widgets folder (install.sh)
export const command = `./${DIR}/lib/agent-state.sh`;
export const refreshFrequency = 30000;

const SEEN_KEY = 'tara-desk-seen-urgent';
const HELD_KEY = 'tara-desk-held'; // set when new items waited for quiet hours to end

export const className = `
  left: 372px;
  top: 40px;
  width: 360px;
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  color: #e2e8f0;
  -webkit-font-smoothing: antialiased;
  pointer-events: none; /* look only: clicks go through to the desktop */
`;

export const initialState = {
  name: 'tara',
  url: null,
  state: null,
  attention: null,
  extra: null,
  okAt: null,
  downSince: null,
  error: null,
};

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A notification for urgent items new in /attention, read by this widget itself. The first run only
// records what is already there; in quiet hours nothing is shown and nothing is marked seen, so
// what came overnight is told in one notification when they end; an item that clears and comes
// back counts as new.
const notifyNew = (out) => {
  const urgent = out.attention?.items?.filter((i) => i.tier === 'urgent');
  if (!out.notify || !urgent) return;
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(SEEN_KEY));
  } catch {
    stored = null;
  }
  const keys = new Set(urgent.map((i) => i.key));
  const seen = new Set((Array.isArray(stored) ? stored : []).filter((k) => keys.has(k)));
  const fresh = urgent.filter((i) => !seen.has(i.key));
  const quiet = out.state.quiet?.now;
  const store = (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // no storage: every run looks like a first run, so nothing is notified twice
    }
  };
  if (!Array.isArray(stored)) for (const i of urgent) seen.add(i.key);
  else if (fresh.length && quiet) store(HELD_KEY, '1');
  else if (fresh.length) {
    for (const i of fresh) seen.add(i.key);
    const titles = fresh.map((i) => i.title);
    let overnight = false;
    try {
      overnight = localStorage.getItem(HELD_KEY) === '1';
    } catch {
      overnight = false;
    }
    store(HELD_KEY, null);
    const text =
      titles.length === 1 ? titles[0] : `${titles.length} new: ${titles.slice(0, 3).join('; ')}${titles.length > 3 ? '; …' : ''}`;
    run(`./${DIR}/lib/notify.sh ${shq(overnight ? `${out.name} · overnight` : out.name)} ${shq(text)} ${shq(`${out.url}/`)}`);
  } else if (!quiet) store(HELD_KEY, null); // what waited overnight cleared by itself
  store(SEEN_KEY, JSON.stringify([...seen]));
};

export const updateState = (event, prev) => {
  if (event.type !== 'UB/COMMAND_RAN') return prev;
  let out = null;
  try {
    out = JSON.parse(event.output);
  } catch {
    // fall through: treated like an unreachable host
  }
  if (out?.state) {
    notifyNew(out);
    return {
      name: out.name,
      url: out.url,
      state: out.state,
      attention: out.attention,
      extra: out.extra,
      okAt: Date.now(),
      downSince: null,
      error: null,
    };
  }
  // Keep the last good state on screen, dimmed, and say since when the host is unreachable.
  return {
    ...prev,
    name: out?.name ?? prev.name,
    url: out?.url ?? prev.url,
    downSince: prev.downSince ?? Date.now(),
    error: out?.error ?? String(event.error ?? 'no answer'),
  };
};

// Look: dark glass with one accent colour per tile label; red / amber / green / blue only for status.
const ACCENT = {
  claude: '#a78bfa',
  needs: '#fb7185',
  approvals: '#fbbf24',
  running: '#2dd4bf',
  next: '#60a5fa',
  extra: '#a3e635',
};

const panel = css`
  background: radial-gradient(120% 80% at 0% 0%, rgba(45, 212, 191, 0.08), transparent 60%), rgba(10, 11, 16, 0.86);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  padding: 12px 12px 8px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
  transition: opacity 0.3s;
`;
const head = css`
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #9ca3af;
  margin: 0 2px 6px;
`;
const tile = css`
  display: flex;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
`;
const label = css`
  width: 78px;
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding-top: 2px;
`;
const count = css`
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-right: 4px;
`;
const body = css`
  min-width: 0;
  flex: 1;
  font-variant-numeric: tabular-nums;
`;
const line = css`
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;
const dim = css`
  color: #8b93a3;
`;
const offline = css`
  color: #f87171;
  margin-bottom: 6px;
`;

const RED = '#f87171';
const AMBER = '#fbbf24';
const BLUE = '#60a5fa';
const GREEN = '#4ade80';
const LEVEL = { ok: GREEN, warn: AMBER, bad: RED, info: BLUE };

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const ago = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
};

const Tile = ({ name, accent = ACCENT.extra, children }) => (
  <div className={tile}>
    <span className={label} style={{ color: accent }}>
      {name}
    </span>
    <div className={body}>{children}</div>
  </div>
);

const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short' });

// One limit as a bar: "5h ▬▬▬▬ 84 % · 01:00". Amber from 70 %, red from 90 %.
const Limit = ({ name, share, resetsAt, week }) => {
  const p = Math.round(share * 100);
  const color = p >= 90 ? RED : p >= 70 ? AMBER : `linear-gradient(90deg, ${ACCENT.claude}, #f472b6)`;
  return (
    <div className={line}>
      <span className={dim} style={{ display: 'inline-block', width: 34 }}>
        {name}
      </span>
      <span
        style={{
          display: 'inline-block',
          width: 92,
          height: 6,
          borderRadius: 3,
          background: 'rgba(255,255,255,0.08)',
          verticalAlign: 'middle',
          marginRight: 8,
          overflow: 'hidden',
        }}
      >
        <span style={{ display: 'block', width: `${Math.min(p, 100)}%`, height: '100%', borderRadius: 3, background: color }} />
      </span>
      <span className={count}>{p}</span>
      <span className={dim}>%</span>
      {resetsAt ? <span className={dim}> · {week ? `${day(resetsAt)} ${hhmm(resetsAt)}` : hhmm(resetsAt)}</span> : null}
    </div>
  );
};

// Claude's 5-hour window and, once a run in this tara-agent process has reported it, the 7-day one.
const Usage = ({ usage }) => {
  if (!usage) return <span className={dim}>—</span>;
  return (
    <>
      <Limit name="5h" share={usage.share} resetsAt={usage.resetsAt} />
      {usage.week ? <Limit name="Week" share={usage.week.share} resetsAt={usage.week.resetsAt} week /> : null}
    </>
  );
};

// Up to `max` lines, then "+N more".
const List = ({ items, max, render }) => (
  <>
    {items.slice(0, max).map(render)}
    {items.length > max ? <div className={dim}>+{items.length - max} more</div> : null}
  </>
);

export const render = ({ name, url, state, attention, extra, okAt, downSince, error }) => {
  const s = state;
  const items = attention?.items ?? [];
  const urgent = attention ? items.filter((i) => i.tier === 'urgent').sort((a, b) => b.at - a.at) : (s?.needs.top ?? []);
  const oldest = items.filter((i) => i.kind === 'approval').sort((a, b) => a.at - b.at);
  const quiet = s?.quiet?.now;

  return (
    <div className={panel} style={{ opacity: downSince ? 0.75 : 1 }}>
      <div className={head}>
        <span>{name}</span>
        <span>{downSince ? '' : quiet ? '🌙 quiet' : okAt ? hhmm(okAt) : ''}</span>
      </div>

      {downSince ? (
        <div className={offline} title={error}>
          ⚠️ offline since {hhmm(downSince)}
          {okAt ? <span className={dim}> · last seen {hhmm(okAt)}</span> : null}
        </div>
      ) : null}

      {!s ? (
        <div className={dim}>{downSince ? `${url ?? ''} not reachable` : 'Loading…'}</div>
      ) : (
        <>
          <Tile name="Claude" accent={ACCENT.claude}>
            <Usage usage={s.usage} />
          </Tile>

          <Tile name="Needs you" accent={ACCENT.needs}>
            <div className={line}>
              <span style={{ color: s.needs.urgent ? RED : GREEN }}>
                {s.needs.urgent ? (
                  <>
                    <span className={count}>{s.needs.urgent}</span>urgent
                  </>
                ) : (
                  '✅ nothing urgent'
                )}
              </span>
              {s.needs.waiting ? <span style={{ color: AMBER }}> · {s.needs.waiting} waiting</span> : null}
            </div>
            <List
              items={urgent}
              max={3}
              render={(n) => (
                <div key={`${n.title}${n.at}`} className={`${line} ${dim}`} title={n.detail}>
                  {n.title}
                </div>
              )}
            />
          </Tile>

          <Tile name="Approvals" accent={ACCENT.approvals}>
            <div className={line}>
              <span className={count} style={{ color: s.approvals.total ? AMBER : GREEN }}>
                {s.approvals.total}
              </span>
              {s.approvals.projects.length ? (
                <span className={dim}>
                  {' '}
                  ({s.approvals.projects.map((p) => `${p.project} ${p.count}`).join(', ')})
                </span>
              ) : null}
            </div>
            {oldest.slice(0, 3).map((a) => (
              <div key={a.key ?? `${a.title}${a.at}`} className={line}>
                <span className={dim}>{ago(a.at)}</span> {a.title.replace(/^Approval waiting:\s*/, '')}
              </div>
            ))}
          </Tile>

          <Tile name="Running" accent={ACCENT.running}>
            {s.running.length ? (
              s.running.slice(0, 3).map((t) => (
                <div key={t.id} className={line}>
                  <span style={{ color: ACCENT.running }}>●</span> {t.title}{' '}
                  <span className={dim}>
                    {ago(t.startedAt)}
                    {t.step ? ` · ${t.step}` : ''}
                  </span>
                </div>
              ))
            ) : (
              <span className={dim}>— none —</span>
            )}
          </Tile>

          <Tile name="Next" accent={ACCENT.next}>
            {s.next.length ? (
              s.next.slice(0, 3).map((n) => (
                <div key={`${n.project}${n.name}${n.at}`} className={line}>
                  {hhmm(n.at)} {n.name} <span className={dim}>{n.project}</span>
                </div>
              ))
            ) : (
              <span className={dim}>—</span>
            )}
          </Tile>

          {(extra?.tiles ?? []).map((t) => (
            <Tile key={t.label} name={t.label}>
              <div className={line}>
                {(t.items ?? []).map((i, n) => (
                  <span key={`${i.text}${n}`} title={i.title}>
                    {n ? '  ' : ''}
                    <span style={{ color: LEVEL[i.level] ?? '#94a3b8' }}>●</span> {i.text}
                  </span>
                ))}
              </div>
            </Tile>
          ))}

        </>
      )}
    </div>
  );
};
