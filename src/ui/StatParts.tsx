/**
 * The report components from UI.md, shared by Stats → Weaknesses and any page
 * that shows a statistic: StatCard (a headline number with its sample size and
 * state), StateBadge (Early read / Counts only / Not enough data), SplitBar
 * (segments against your own overall rate), WeaknessRow (a ranked weakness)
 * and TrendSpark (one stat over time). Every number shows its n.
 */
import type { ReactNode } from 'react';
import type { State } from '../core/weak/stats';

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
export const fmt = (v: number | null | undefined, digits = 1): string => (v == null ? '—' : v.toFixed(digits));

export function StateBadge({ state }: { state: State | 'empty' | null | undefined }) {
  if (state === 'provisional') return <span className="state-badge provisional" title="Fewer than 30 games">Early read</span>;
  if (state === 'suppressed') return <span className="state-badge suppressed" title="Fewer than 10 games: counts only">Counts only</span>;
  if (state === 'insufficient_data') return <span className="state-badge insufficient">Not enough data</span>;
  return null;
}

/** "48 games · 1,830 moves" */
export function SampleLine({ games, moves }: { games: number; moves?: number }) {
  return <div className="stat-n">{plural(games, 'game')}{moves ? ` · ${moves.toLocaleString()} moves` : ''}</div>;
}

export function StatCard({ title, state, headline, unit, sub, games, moves, hidden, wide, children }: {
  title: string;
  state: State;
  headline: string;
  unit?: string;
  sub?: ReactNode;
  games: number;
  moves?: number;
  /** What a suppressed / insufficient card says instead of a number. */
  hidden?: string;
  wide?: boolean;
  children?: ReactNode;
}) {
  const noValue = state === 'suppressed' || state === 'insufficient_data';
  return (
    <article className={`stat-card${wide ? ' wide' : ''}${state === 'insufficient_data' ? ' insufficient' : ''}`}>
      <div className="stat-title"><span>{title}</span><StateBadge state={state} /></div>
      {noValue
        ? <p className="stat-empty">{hidden ?? (state === 'suppressed' ? 'Fewer than 10 games, so no rate is shown.' : 'Not enough data yet.')}</p>
        : <>
          <div className="stat-headline">{headline}{unit && <small>{unit}</small>}</div>
          {sub && <div className="stat-sub">{sub}</div>}
        </>}
      {children}
      <SampleLine games={games} moves={moves} />
    </article>
  );
}

export interface SplitRow { label: string; value: number | null; games: number; why?: string }

/** Bars for each segment; the black tick is your own overall rate, red bars are above it. */
export function SplitBar({ rows, overall, unit, digits = 1 }: { rows: SplitRow[]; overall?: number | null; unit: string; digits?: number }) {
  const values = rows.map((r) => r.value).filter((v): v is number => v != null);
  const max = Math.max(...values, overall ?? 0, 0.0001) * 1.15;
  return (
    <>
      <div className="split">
        {rows.map((r) => {
          const over = r.value != null && overall != null && r.value > overall;
          return (
            <div className="split-row" key={r.label}>
              <span className="split-label">{r.label}</span>
              <div className="split-track" aria-hidden="true">
                {r.value != null && <div className={`split-fill${over ? ' over' : ''}`} style={{ width: `${(r.value / max) * 100}%` }} />}
                {overall != null && <div className="split-tick" style={{ left: `${(overall / max) * 100}%` }} />}
              </div>
              <span className="split-value">
                {r.value != null ? <span><b>{fmt(r.value, digits)}</b>{unit.startsWith('%') ? unit : ` ${unit}`}</span> : <span className="stat-n">{r.why ?? 'hidden'}</span>}
                <span className="stat-n">{plural(r.games, 'game')}</span>
              </span>
            </div>
          );
        })}
      </div>
      {overall != null && <div className="split-legend"><i /> your overall {fmt(overall, digits)} {unit}</div>}
    </>
  );
}

export function WeaknessRow({ rank, segment, cost, detail, selected, onClick }: {
  rank: number; segment: string; cost: number; detail: string; selected?: boolean; onClick?: () => void;
}) {
  return (
    <button type="button" className="weak-row" aria-pressed={selected} onClick={onClick}>
      <span className="weak-rank">{rank}</span>
      <span className="weak-main"><span className="weak-segment">{segment}</span><span className="weak-detail">{detail}</span></span>
      <span className="weak-cost"><b>−{cost.toFixed(2)}</b><span>points per game</span></span>
      <span className="weak-chev" aria-hidden="true">›</span>
    </button>
  );
}

/** A rolling 10-game mean of one per-game value, oldest to latest; one engine setting, so no breaks. */
export function TrendSpark({ values, label }: { values: number[]; label: string }) {
  if (values.length < 10) return <p className="note">The trend line appears after 10 games.</p>;
  const roll: number[] = [];
  for (let i = 9; i < values.length; i++) roll.push(values.slice(i - 9, i + 1).reduce((a, b) => a + b, 0) / 10);
  const lo = Math.floor(Math.min(...roll) / 5) * 5;
  const hi = Math.max(Math.ceil(Math.max(...roll) / 5) * 5, lo + 5);
  const [W, H, L, R, T, B] = [640, 120, 28, 8, 8, 18];
  const x = (i: number) => L + (roll.length === 1 ? 0 : (i * (W - L - R)) / (roll.length - 1));
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const line = roll.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = roll[roll.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}, from ${fmt(roll[0])} to ${fmt(last)}`}>
      <line x1={L} x2={W - R} y1={y(hi)} y2={y(hi)} className="spark-rule" />
      <line x1={L} x2={W - R} y1={y(lo)} y2={y(lo)} className="spark-rule" />
      <text x={0} y={y(hi) + 3}>{hi}</text><text x={0} y={y(lo) + 3}>{lo}</text>
      <text x={L} y={H - 2}>oldest</text><text x={W - R} y={H - 2} textAnchor="end">latest</text>
      <path d={`${line}L${x(roll.length - 1).toFixed(1)},${H - B}L${L},${H - B}Z`} className="area" />
      <path d={line} className="curve" />
      <circle cx={x(roll.length - 1)} cy={y(last)} r={3.5} className="end" />
    </svg>
  );
}
