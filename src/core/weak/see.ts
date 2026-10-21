/**
 * Static exchange evaluation for the weakness stats (SPEC §6.11) — port of
 * ~/WeaknessStats/weakstats/see.py. Stockfish does not expose SEE.
 * Recaptures come from legal moves only, so pinned pieces and checks count.
 */
import { Board, type Color, opposite, parseSquare, type Role, type Square } from '../chess';

export const VALUE: Record<Role, number> = { pawn: 100, knight: 300, bishop: 300, rook: 500, queen: 900, king: 20000 };
const PROMOTION: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };

export function capturedValue(board: Board, uci: string): number {
  if (board.isEnPassant(uci)) return VALUE.pawn;
  const piece = board.pieceAt(parseSquare(uci.slice(2, 4))!);
  return piece ? VALUE[piece.role] : 0;
}

function leastValuableCapture(board: Board, square: Square): string | null {
  let best: string | null = null;
  let bestValue = Infinity;
  for (const m of board.legalMoves()) {
    if (parseSquare(m.slice(2, 4)) !== square || !board.isCapture(m)) continue;
    const v = VALUE[board.pieceAt(parseSquare(m.slice(0, 2))!)!.role];
    if (v < bestValue) {
      best = m;
      bestValue = v;
    }
  }
  return best;
}

/** Best material the side to move can win by capturing on `square` (≥ 0). */
function gainOn(board: Board, square: Square): number {
  const m = leastValuableCapture(board, square);
  if (m === null) return 0;
  const v = capturedValue(board, m);
  board.push(m);
  try {
    return Math.max(0, v - gainOn(board, square));
  } finally {
    board.pop();
  }
}

/** Material won by the side to move after the full exchange starting with `uci`. */
export function see(board: Board, uci: string): number {
  let v = capturedValue(board, uci);
  if (uci.length === 5) v += VALUE[PROMOTION[uci[4]]] - VALUE.pawn;
  const b = board.copy();
  b.push(uci);
  return v - gainOn(b, parseSquare(uci.slice(2, 4))!);
}

/** colour's material minus the other side's, in centipawns (kings excluded). */
export function material(board: Board, color: Color): number {
  let total = 0;
  for (const role of ['pawn', 'knight', 'bishop', 'rook', 'queen'] as Role[]) {
    total += VALUE[role] * (board.pieces(role, color).length - board.pieces(role, opposite(color)).length);
  }
  return total;
}
