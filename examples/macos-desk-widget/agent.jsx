// Agent panel: tara-agent's glance (GET /phone/state, the same data the desk phone shows), the
// failing jobs and oldest cards from GET /attention, optional extra tiles, and a macOS notification
// for each new urgent item. Click a tile to open that dashboard page. Data: lib/agent-state.sh.
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

// A notification for urgent items new in /attention, read by this widget itself: tara-agent only
// raises its own alerts while a desk phone listens. Same rules as the phone: the first run only
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

const panel = css`
  background: rgba(15, 23, 42, 0.84);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  transition: opacity 0.3s;
  &:hover {
    opacity: 1 !important;
  }
`;
const head = css`
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #94a3b8;
  margin-bottom: 6px;
`;
const tile = css`
  display: flex;
  gap: 10px;
  padding: 3px 4px;
  margin: 0 -4px;
  border-radius: 6px;
  cursor: pointer;
  &:hover {
    background: rgba(148, 163, 184, 0.12);
  }
`;
const label = css`
  color: #94a3b8;
  width: 74px;
  flex: none;
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
  color: #8494ab;
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

const open = (href) => href && run(`open ${shq(href)}`);

const Tile = ({ name, href, children }) => (
  <div className={tile} onClick={() => open(href)}>
    <span className={label}>{name}</span>
    <div className={body}>{children}</div>
  </div>
);

const Usage = ({ usage }) => {
  if (!usage) return <span className={dim}>—</span>;
  const p = Math.round(usage.share * 100);
  const color = p >= 90 ? RED : p >= 70 ? AMBER : BLUE;
  return (
    <div className={line}>
      <span
        style={{
          display: 'inline-block',
          width: 110,
          height: 7,
          borderRadius: 4,
          background: 'rgba(148,163,184,0.2)',
          verticalAlign: 'middle',
          marginRight: 8,
          overflow: 'hidden',
        }}
      >
        <span style={{ display: 'block', width: `${Math.min(p, 100)}%`, height: '100%', background: color }} />
      </span>
      {p} %{usage.resetsAt ? <span className={dim}> · resets {hhmm(usage.resetsAt)}</span> : null}
    </div>
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
    <div className={panel} style={{ opacity: downSince ? 0.75 : quiet ? 0.4 : 1 }}>
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
          <Tile name="Claude" href={url && `${url}/`}>
            <Usage usage={s.usage} />
          </Tile>

          <Tile name="Needs you" href={url && `${url}/`}>
            <div className={line}>
              <span style={{ color: s.needs.urgent ? RED : GREEN }}>
                {s.needs.urgent ? `🔴 ${s.needs.urgent} urgent` : '✅ nothing urgent'}
              </span>
              {s.needs.waiting ? <span style={{ color: AMBER }}> · {s.needs.waiting} waiting</span> : null}
              {s.held ? <span className={dim}> · {s.held} held</span> : null}
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

          <Tile name="Approvals" href={url && `${url}/approvals`}>
            <div className={line}>
              <span style={{ color: s.approvals.total ? AMBER : GREEN }}>{s.approvals.total}</span>
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

          <Tile name="Running" href={url && `${url}/sessions`}>
            {s.running.length ? (
              s.running.slice(0, 3).map((t) => (
                <div key={t.id} className={line}>
                  <span style={{ color: BLUE }}>●</span> {t.title}{' '}
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

          <Tile name="Next" href={url && `${url}/schedule`}>
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
            <Tile key={t.label} name={t.label} href={t.href}>
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

          {s.alerts.length ? (
            <Tile name="Alerts" href={url && `${url}/`}>
              {s.alerts.slice(0, 2).map((a) => (
                <div key={a.id} className={line} style={{ color: a.kind === 'urgent' ? RED : undefined }}>
                  {hhmm(a.at)} {a.text}
                </div>
              ))}
            </Tile>
          ) : null}
        </>
      )}
    </div>
  );
};
