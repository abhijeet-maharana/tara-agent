// Mac panel: temperature, thermal state, CPU, memory, power and what uses the most.
// Data: lib/mac-stats.sh (macmon + ps + sysctl). See README.md.
import { React, css } from 'uebersicht'; // React: <>…</> compiles to React.Fragment

const DIR = 'tara-desk-widget'; // the symlink's name in Übersicht's widgets folder (install.sh)
export const command = `./${DIR}/lib/mac-stats.sh`;
export const refreshFrequency = 5000;

const HISTORY = 24; // samples in the sparkline (2 min at 5 s)
const GB = 1024 ** 3;

export const className = `
  left: 20px;
  top: 40px;
  width: 340px;
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  color: #e2e8f0;
  -webkit-font-smoothing: antialiased;
  pointer-events: none; /* look only: clicks go through to the desktop */
`;

export const initialState = { data: null, cpu: [], error: null };

export const updateState = (event, prev) => {
  if (event.type !== 'UB/COMMAND_RAN') return prev;
  if (event.error) return { ...prev, error: String(event.error) };
  let data;
  try {
    data = JSON.parse(event.output);
  } catch {
    return { ...prev, error: 'bad output from mac-stats.sh' };
  }
  const usage = data.macmon ? data.macmon.cpu_usage_pct * 100 : null;
  const cpu = usage == null ? prev.cpu : [...prev.cpu, usage].slice(-HISTORY);
  return { data, cpu, error: null };
};

// Look: dark glass cards with one accent colour per metric; red / amber / green only for status.
const ACCENT = { cpu: '#2dd4bf', temp: '#fb7185', mem: '#a78bfa', power: '#fbbf24', vm: '#a3e635', top: '#60a5fa' };
const COLOR = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171' };

const panel = css`
  background: radial-gradient(120% 80% at 100% 0%, rgba(167, 139, 250, 0.1), transparent 60%), rgba(10, 11, 16, 0.86);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  padding: 12px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
`;
const head = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #9ca3af;
  margin: 0 2px 8px;
`;
const grid = css`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
`;
const card = css`
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  padding: 8px 10px;
  min-width: 0;
  overflow: hidden;
`;
const tag = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
`;
const num = css`
  font-size: 22px;
  font-weight: 600;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  color: #f8fafc;
  margin-top: 2px;
`;
const unit = css`
  font-size: 12px;
  font-weight: 500;
  color: #9ca3af;
  margin-left: 2px;
`;
const sub = css`
  font-size: 11px;
  color: #9ca3af;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
`;
const dim = css`
  color: #8b93a3;
`;

const THERMAL = [
  ['nominal', 'ok'],
  ['fair', 'warn'],
  ['serious', 'bad'],
  ['critical', 'bad'],
];
const PRESSURE = { 1: ['normal', 'ok'], 2: ['warn', 'warn'], 4: ['critical', 'bad'] };

const tempLevel = (c) => (c >= 90 ? 'bad' : c >= 75 ? 'warn' : 'ok');
const gb = (bytes) => (bytes / GB).toFixed(1);
const pct = (x) => `${Math.round(x)} %`;

// The CPU line with a soft fill under it, newest sample on the right. The scale follows the data
// (top: 1.2 × the highest sample, at least 40 %), so a quiet Mac still shows its ups and downs.
const Spark = ({ values, color }) => {
  if (values.length < 2) return <div style={{ height: 30 }} />;
  const w = 300;
  const h = 30;
  const step = w / (HISTORY - 1);
  const x0 = w - (values.length - 1) * step;
  const top = Math.min(100, Math.max(40, Math.max(...values) * 1.2));
  const pts = values.map((v, i) => [x0 + i * step, h - 1 - (Math.min(v, top) / top) * (h - 2)]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${x0.toFixed(1)},${h} ${line} ${w},${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, display: 'block', marginTop: 4 }}>
      <defs>
        <linearGradient id="tara-cpu-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#tara-cpu-fill)" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

const Bar = ({ share, color }) => (
  <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.08)', marginTop: 5, overflow: 'hidden' }}>
    <div style={{ width: `${Math.min(100, Math.max(0, share * 100))}%`, height: '100%', borderRadius: 3, background: color }} />
  </div>
);

const Dot = ({ level }) => (
  <span style={{ color: COLOR[level] ?? '#9ca3af', marginRight: 4 }}>●</span>
);

const Card = ({ name, color, right, span, children }) => (
  <div className={card} style={span ? { gridColumn: '1 / -1' } : undefined}>
    <div className={tag}>
      <span style={{ color }}>{name}</span>
      {right ? <span className={dim} style={{ fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>{right}</span> : null}
    </div>
    {children}
  </div>
);

export const render = ({ data, cpu, error }) => {
  if (!data) {
    return (
      <div className={panel}>
        <div className={head}>
          <span>Mac</span>
        </div>
        <div className={dim}>{error ? `⚠️ ${error}` : 'Loading…'}</div>
      </div>
    );
  }
  const m = data.macmon;
  const mem = m?.memory;
  const thermal = THERMAL[data.thermal];
  const pressure = PRESSURE[data.pressure];
  const vm = data.groups.find((g) => g.name === data.vmLabel);
  // ps counts % of one core; divide by the core count for a share of the whole Mac.
  const share = (g) => g.cpu / data.ncpu;
  const top = data.groups.filter((g) => g !== vm).slice(0, 3);
  const temp = m?.temp?.cpu_temp_avg;
  const level = temp ? tempLevel(temp) : 'ok';

  return (
    <div className={panel}>
      <div className={head}>
        <span>Mac</span>
        <span>
          {thermal ? (
            <>
              <Dot level={thermal[1]} />
              thermal {thermal[0]}
            </>
          ) : (
            'thermal —'
          )}
        </span>
      </div>

      <div className={grid}>
        <Card
          name="CPU"
          color={ACCENT.cpu}
          span
          right={m ? `P ${pct(m.pcpu_active_ratio * 100)} · E ${pct(m.ecpu_active_ratio * 100)}` : null}
        >
          <div className={num}>
            {m ? Math.round(m.cpu_usage_pct * 100) : '—'}
            {m ? <span className={unit}>%</span> : null}
          </div>
          <Spark values={cpu} color={ACCENT.cpu} />
        </Card>

        <Card name="Temp" color={ACCENT.temp}>
          <div className={num} style={level === 'ok' ? undefined : { color: COLOR[level] }}>
            {temp ? Math.round(temp) : '—'}
            {temp ? <span className={unit}>°C</span> : null}
          </div>
          <div className={sub}>{m?.temp ? `GPU ${Math.round(m.temp.gpu_temp_avg)} °C` : '—'}</div>
        </Card>

        <Card name="Memory" color={ACCENT.mem} right={pressure ? <><Dot level={pressure[1]} />{pressure[0]}</> : null}>
          <div className={num}>
            {mem ? gb(mem.ram_usage) : gb(data.memsize)}
            <span className={unit}>{mem ? `/ ${gb(mem.ram_total)} GB` : 'GB'}</span>
          </div>
          {mem ? <Bar share={mem.ram_usage / mem.ram_total} color={ACCENT.mem} /> : null}
          {mem && mem.swap_usage > 0 ? <div className={sub} style={{ marginTop: 3 }}>swap {gb(mem.swap_usage)} GB</div> : null}
        </Card>

        <Card name="Power" color={ACCENT.power} span={!vm}>
          <div className={num}>
            {m ? (m.sys_power || m.all_power).toFixed(1) : '—'}
            {m ? <span className={unit}>W</span> : null}
          </div>
          <div className={sub}>{m ? `chip ${m.all_power.toFixed(1)} W` : '—'}</div>
        </Card>

        {vm ? (
          <Card name={vm.name} color={ACCENT.vm}>
            <div className={num}>
              {Math.round(share(vm))}
              <span className={unit}>% CPU</span>
            </div>
            <div className={sub}>{gb(vm.rssKb * 1024)} GB memory</div>
          </Card>
        ) : null}

        <Card name="Top" color={ACCENT.top} span>
          <div className={sub} style={{ color: '#e5e7eb', marginTop: 3 }} title={top.map((g) => `${g.name} ${pct(share(g))}`).join(', ')}>
            {top.map((g, i) => (
              <span key={g.name}>
                {i ? <span className={dim}> · </span> : null}
                {g.name} <span className={dim}>{pct(share(g))}</span>
              </span>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};
