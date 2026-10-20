/**
 * The evaluation bar beside the board (eval_bar.py): White's share fills from
 * the bottom (or the top when the board is flipped), using Lichess's winning
 * chances so +1 and +5 look as different as they feel.
 */
import { MATE_CP, winChances } from '../core/analyzer';
import type { Color } from '../core/chess';
import { pySigned } from '../core/format';

/** blank: a plain grey bar (nothing to read off it — e.g. while you're looking for a tactic). */
export function EvalBar({ cpWhite, mate, orientation = 'white', blank = false }: { cpWhite: number | null; mate?: number | null; orientation?: Color; blank?: boolean }) {
  if (blank) return <div className="eval-bar blank" role="meter" aria-label="Evaluation (hidden)" />;
  const share = cpWhite === null ? 0.5 : (winChances(Math.max(-MATE_CP, Math.min(MATE_CP, cpWhite))) + 1) / 2;
  const label = mate ? (mate > 0 ? `M${mate}` : `−M${-mate}`) : cpWhite === null ? '' : pySigned(cpWhite / 100, 1);
  return (
    <div className={`eval-bar ${orientation === 'black' ? 'flipped' : ''}`} role="meter" aria-label="Evaluation"
      aria-valuenow={cpWhite ?? 0} title={label}>
      <div className="eval-white" style={{ height: `${share * 100}%` }} />
      <span className={`eval-label ${share >= 0.5 ? 'on-white' : 'on-black'}`}>{label}</span>
    </div>
  );
}
