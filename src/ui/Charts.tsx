/**
 * Small charts (charts.py), as SVG: a line chart with an optional goal line,
 * and a two-part bar chart (total, the good part in green).
 */
const [PAD_L, PAD_R, PAD_T, PAD_B] = [44, 12, 12, 22];
const W = 600;

export function LineChart({ points, goal = null, color = 'var(--good)', format = (v) => v.toFixed(0), empty = 'No data yet', height = 200 }: {
  points: [string, number][];
  goal?: number | null;
  color?: string;
  format?: (v: number) => string;
  empty?: string;
  height?: number;
}) {
  const h = height;
  if (points.length < 2) return <div className="chart-empty" style={{ height }}>{empty}</div>;
  const values = [...points.map(([, v]) => v), ...(goal !== null ? [goal] : [])];
  let [lo, hi] = [Math.min(...values), Math.max(...values)];
  const span = (hi - lo) || 1;
  [lo, hi] = [lo - span * 0.08, hi + span * 0.08];
  const [pw, ph] = [W - PAD_L - PAD_R, h - PAD_T - PAD_B];
  const xy = (i: number, v: number): [number, number] => [PAD_L + (pw * i) / (points.length - 1), PAD_T + ph * (1 - (v - lo) / (hi - lo))];
  const [lx, ly] = xy(points.length - 1, points[points.length - 1][1]);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${h}`} role="img">
      {[0, 0.5, 1].map((f) => {
        const v = lo + (hi - lo) * f;
        const [, y] = xy(0, v);
        return <g key={f}><line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} className="grid" />
          <text x={PAD_L - 6} y={y} textAnchor="end" dominantBaseline="central" className="tick">{format(v)}</text></g>;
      })}
      {goal !== null && (() => {
        const [, gy] = xy(0, goal);
        return <g><line x1={PAD_L} y1={gy} x2={W - PAD_R} y2={gy} className="goal" strokeDasharray="5 4" strokeWidth={2} />
          <text x={W - PAD_R} y={gy - 4} textAnchor="end" className="tick goal-text">Goal {format(goal)}</text></g>;
      })()}
      <path className="area" fill={color}
        d={`M${points.map(([, v], i) => xy(i, v).join(',')).join('L')}L${xy(points.length - 1, lo).join(',')}L${xy(0, lo).join(',')}Z`} />
      <polyline points={points.map(([, v], i) => xy(i, v).join(',')).join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={4} fill={color} />
      {[[0, 'start'], [Math.floor(points.length / 2), 'middle'], [points.length - 1, 'end']].map(([i, anchor]) => (
        <text key={String(i)} x={xy(i as number, lo)[0]} y={h - 4} textAnchor={anchor as 'start'} className="tick">{points[i as number][0]}</text>
      ))}
    </svg>
  );
}

/** Several lines over the same months (e.g. accuracy by area), with a legend. */
export function MultiLineChart({ series, format = (v) => v.toFixed(0), empty = 'No data yet', height = 220 }: {
  series: { name: string; color: string; points: [string, number][] }[];
  format?: (v: number) => string;
  empty?: string;
  height?: number;
}) {
  const h = height;
  const labels = [...new Set(series.flatMap((s) => s.points.map(([l]) => l)))].sort();
  const values = series.flatMap((s) => s.points.map(([, v]) => v));
  if (labels.length < 2 || !values.length) return <div className="chart-empty" style={{ height }}>{empty}</div>;
  let [lo, hi] = [Math.min(...values), Math.max(...values)];
  const span = (hi - lo) || 1;
  [lo, hi] = [lo - span * 0.1, hi + span * 0.1];
  const [pw, ph] = [W - PAD_L - PAD_R, h - PAD_T - PAD_B - 16];
  const x = (label: string) => PAD_L + (pw * labels.indexOf(label)) / (labels.length - 1);
  const y = (v: number) => PAD_T + 16 + ph * (1 - (v - lo) / (hi - lo));
  const nice = (l: string) => { const [yy, mm] = l.split('-'); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mm) - 1]} ${yy.slice(2)}`; };
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${h}`} role="img">
      {series.map((s, i) => <g key={s.name}><rect x={PAD_L + i * 120} y={2} width={10} height={10} fill={s.color} />
        <text x={PAD_L + i * 120 + 14} y={7} dominantBaseline="central" className="tick">{s.name}</text></g>)}
      {[0, 0.5, 1].map((f) => {
        const v = lo + (hi - lo) * f;
        return <g key={f}><line x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)} className="grid" />
          <text x={PAD_L - 6} y={y(v)} textAnchor="end" dominantBaseline="central" className="tick">{format(v)}</text></g>;
      })}
      {series.map((s) => s.points.length > 1 && (
        <polyline key={s.name} points={s.points.map(([l, v]) => `${x(l)},${y(v)}`).join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
      ))}
      {series.map((s) => s.points.map(([l, v]) => <circle key={`${s.name}${l}`} cx={x(l)} cy={y(v)} r={2.5} fill={s.color} />))}
      {[0, Math.floor(labels.length / 2), labels.length - 1].map((i, k) => (
        <text key={k} x={x(labels[i])} y={h - 4} textAnchor={k === 0 ? 'start' : k === 1 ? 'middle' : 'end'} className="tick">{nice(labels[i])}</text>
      ))}
    </svg>
  );
}

export function BarChart({ bars, labels, empty = 'No data yet', height = 150 }: {
  bars: [string, number, number][];
  labels: [string, string];
  empty?: string;
  height?: number;
}) {
  const h = height;
  if (!bars.length) return <div className="chart-empty" style={{ height }}>{empty}</div>;
  const top = Math.max(...bars.map(([, t]) => t)) || 1;
  const [pw, ph] = [W - PAD_L - PAD_R, h - PAD_T - PAD_B];
  const slot = pw / bars.length;
  const bw = Math.max(4, Math.min(28, slot * 0.6));
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${h}`} role="img">
      <text x={PAD_L - 6} y={PAD_T} textAnchor="end" dominantBaseline="hanging" className="tick">{top}</text>
      {bars.map(([label, total, good], i) => {
        const cx = PAD_L + slot * (i + 0.5);
        const yt = PAD_T + ph * (1 - total / top);
        const yg = PAD_T + ph * (1 - good / top);
        return <g key={i}>
          <rect x={cx - bw / 2} y={yt} width={bw} height={PAD_T + ph - yt} className="bar-total" />
          <rect x={cx - bw / 2} y={yg} width={bw} height={PAD_T + ph - yg} className="bar-good" />
          {(bars.length <= 8 || i === 0 || i === bars.length - 1) && <text x={cx} y={h - 4} textAnchor="middle" className="tick">{label}</text>}
        </g>;
      })}
      <rect x={W - 150} y={4} width={10} height={10} className="bar-good" />
      <text x={W - 136} y={9} dominantBaseline="central" className="tick">{labels[1]}</text>
      <rect x={W - 80} y={4} width={10} height={10} className="bar-total" />
      <text x={W - 66} y={9} dominantBaseline="central" className="tick">{labels[0]}</text>
    </svg>
  );
}
