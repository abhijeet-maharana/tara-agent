// Mac panel: temperature, thermal state, CPU, memory, power and what uses the most.
// Data: lib/mac-stats.sh (macmon + ps + sysctl). See README.md.
import { React, css } from 'uebersicht'; // React: <>…</> compiles to React.Fragment

const DIR = 'tara-desk-widget'; // the symlink's name in Übersicht's widgets folder (install.sh)
export const command = `./${DIR}/lib/mac-stats.sh`;
export const refreshFrequency = 5000;

const HISTORY = 24; // samples in the sparkline (2 min at 5 s)
const NIGHT = [23, 7]; // dim from 23:00 to 07:00 (match tara-agent's http.phone.quietHours)
const GB = 1024 ** 3;

export const className = `
  left: 20px;
  top: 40px;
  width: 340px;
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  color: #e2e8f0;
  -webkit-font-smoothing: antialiased;
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
const row = css`
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  padding: 2px 0;
`;
const label = css`
  color: #94a3b8;
  flex: none;
`;
const value = css`
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;
const big = css`
  font-size: 15px;
  font-weight: 600;
`;
const dim = css`
  color: #8494ab;
`;

const COLOR = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171' };
const THERMAL = [
  ['nominal', 'ok'],
  ['fair', 'warn'],
  ['serious', 'bad'],
  ['critical', 'bad'],
];
const PRESSURE = { 1: ['normal', 'ok'], 2: ['warn', 'warn'], 4: ['critical', 'bad'] };

const isNight = (h = new Date().getHours()) => (NIGHT[0] > NIGHT[1] ? h >= NIGHT[0] || h < NIGHT[1] : h >= NIGHT[0] && h < NIGHT[1]);
const tempLevel = (c) => (c >= 90 ? 'bad' : c >= 75 ? 'warn' : 'ok');
const gb = (bytes) => (bytes / GB).toFixed(1);
const pct = (x) => `${Math.round(x)} %`;

const Spark = ({ values }) => {
  if (values.length < 2) return null;
  const w = 90;
  const h = 18;
  const step = w / (HISTORY - 1);
  const x0 = w - (values.length - 1) * step;
  const pts = values
    .map((v, i) => `${(x0 + i * step).toFixed(1)},${(h - (Math.min(v, 100) / 100) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={w} height={h} style={{ verticalAlign: 'middle', marginLeft: 8 }}>
      <polyline points={pts} fill="none" stroke="#60a5fa" strokeWidth="1.5" />
    </svg>
  );
};

const Dot = ({ level }) => (
  <span style={{ color: COLOR[level] ?? '#94a3b8', marginRight: 4 }}>●</span>
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

  return (
    <div className={panel} style={{ opacity: isNight() ? 0.4 : 1 }}>
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

      <div className={row}>
        <span className={label}>🌡 Temp</span>
        <span className={value}>
          {temp ? (
            <>
              <span className={big} style={{ color: COLOR[tempLevel(temp)] }}>
                {Math.round(temp)} °C
              </span>
              <span className={dim}> CPU · GPU {Math.round(m.temp.gpu_temp_avg)} °C</span>
            </>
          ) : (
            '—'
          )}
        </span>
      </div>

      <div className={row}>
        <span className={label}>CPU</span>
        <span className={value}>
          {m ? (
            <>
              <span className={big}>{pct(m.cpu_usage_pct * 100)}</span>
              <span className={dim}>
                {' '}
                P {pct(m.pcpu_active_ratio * 100)} · E {pct(m.ecpu_active_ratio * 100)}
              </span>
              <Spark values={cpu} />
            </>
          ) : (
            '—'
          )}
        </span>
      </div>

      <div className={row}>
        <span className={label}>RAM</span>
        <span className={value}>
          {mem ? `${gb(mem.ram_usage)} / ${gb(mem.ram_total)} GB` : `${gb(data.memsize)} GB`}
          {mem && mem.swap_usage > 0 ? (
            <span className={dim}> · swap {gb(mem.swap_usage)} GB</span>
          ) : null}
        </span>
      </div>

      <div className={row}>
        <span className={label}>Pressure</span>
        <span className={value}>
          {pressure ? (
            <>
              <Dot level={pressure[1]} />
              {pressure[0]}
            </>
          ) : (
            '—'
          )}
        </span>
      </div>

      {vm ? (
        <div className={row}>
          <span className={label}>{vm.name}</span>
          <span className={value}>
            {pct(share(vm))} CPU · {gb(vm.rssKb * 1024)} GB
          </span>
        </div>
      ) : null}

      <div className={row}>
        <span className={label}>Top</span>
        <span className={value} title={top.map((g) => `${g.name} ${pct(share(g))}`).join(', ')}>
          {top.map((g, i) => (
            <span key={g.name}>
              {i ? <span className={dim}>, </span> : null}
              {g.name} <span className={dim}>{pct(share(g))}</span>
            </span>
          ))}
        </span>
      </div>

      {m ? (
        <div className={row}>
          <span className={label}>Power</span>
          <span className={value}>
            {(m.sys_power || m.all_power).toFixed(1)} W
            <span className={dim}> · chip {m.all_power.toFixed(1)} W</span>
          </span>
        </div>
      ) : null}
    </div>
  );
};
