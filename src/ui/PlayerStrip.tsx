/**
 * The strip above or below a board (a web-app addition): the player, the pieces they've taken —
 * drawn with the board's own piece set — their material lead, and their clock at the move shown.
 */
import type { Color, Role } from '../core/chess';
import { clockText } from '../core/boardSides';

export interface SideView {
  name: string;
  rating: number | null;
  clock: number | null;          // seconds; null: no clock in this game
  captured: Role[];              // the opponent's pieces this side has taken, pawns first
  lead: number;                  // material ahead, in pawns (≤ 0: not shown)
  toMove: boolean;
}

export function PlayerStrip({ color, side }: { color: Color; side: SideView }) {
  const taken = side.captured;
  const theirs = color === 'white' ? 'black' : 'white';
  return (
    <div className={`player-strip ${color}`}>
      <span className={`strip-dot ${color}`} aria-hidden="true" />
      <span className="strip-name">{side.name}{side.rating !== null && <span className="strip-rating"> ({side.rating})</span>}</span>
      <span className="strip-captured cg-wrap" aria-label={taken.length ? `has taken: ${taken.join(', ')}` : 'nothing taken yet'}>
        {taken.map((r, i) => <piece key={i} className={`${r} ${theirs}${i > 0 && taken[i - 1] === r ? ' same' : ''}`} />)}
        {side.lead > 0 && <span className="strip-lead">+{side.lead}</span>}
      </span>
      {side.clock !== null && <span className={`strip-clock${side.toMove ? ' to-move' : ''}`}>{clockText(side.clock)}</span>}
    </div>
  );
}
