/**
 * What the strips above and below a board show for each side (a web-app addition): the pieces it has
 * captured, its material lead, and its clock at the move on the board, from the game's [%clk] times.
 * Pure functions, no I/O.
 */
import { Board, type Color, type Role } from './chess';

const START: Partial<Record<Role, number>> = { pawn: 8, knight: 2, bishop: 2, rook: 2, queen: 1 };
const ORDER: Role[] = ['pawn', 'knight', 'bishop', 'rook', 'queen'];
const VALUE: Partial<Record<Role, number>> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 };

export interface Captures {
  /** The pieces each side has taken from the other, pawns first. */
  white: Role[];
  black: Role[];
  /** Material, White minus Black, in pawns (1 / 3 / 3 / 5 / 9). */
  diff: number;
}

/** The pieces `c` has lost: missing from its starting set. A promoted pawn is not a lost pawn: each piece
 *  beyond the starting number (a second queen) came from one of its own pawns. */
function lost(board: Board, c: Color): Role[] {
  const count = (r: Role) => board.pieces(r, c).length;
  const promoted = ORDER.slice(1).reduce((n, r) => n + Math.max(0, count(r) - START[r]!), 0);
  const out: Role[] = [];
  for (const r of ORDER) {
    const missing = Math.max(0, START[r]! - count(r) - (r === 'pawn' ? promoted : 0));
    for (let i = 0; i < missing; i++) out.push(r);
  }
  return out;
}

export function captures(fen: string): Captures {
  const board = Board.fromFen(fen);
  const material = (c: Color) => ORDER.reduce((n, r) => n + VALUE[r]! * board.pieces(r, c).length, 0);
  return { white: lost(board, 'black'), black: lost(board, 'white'), diff: material('white') - material('black') };
}

/** Each side's clock (seconds) after `ply` moves: its last recorded time, or the starting time before its
 *  first move. clocks[i] = the mover's clock after move i (null where the PGN has none). Null: no clock. */
export function clocksAt(clocks: (number | null)[], baseSeconds: number | null, ply: number): Record<Color, number | null> {
  if (!clocks.some((c) => c !== null)) return { white: null, black: null };
  const last = (side: 0 | 1) => {
    for (let i = Math.min(ply, clocks.length) - 1; i >= 0; i--) if (i % 2 === side && clocks[i] !== null) return clocks[i];
    return baseSeconds;
  };
  return { white: last(0), black: last(1) };
}

/** "3:00", "0:59", "1:02:05"; tenths under 10 seconds ("0:07.4"). */
export function clockText(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secs = s < 10 ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${secs}` : `${m}:${secs}`;
}

/** The starting time of a "base+increment" time control, in seconds (null for daily games). */
export function baseSecondsOf(timeControl: string | null | undefined): number | null {
  const m = /^(\d+)(?:\+\d+)?$/.exec(timeControl ?? '');
  return m ? parseInt(m[1], 10) : null;
}

/** The increment of a "base+increment" time control, in seconds (0 when there is none). */
export function incrementOf(timeControl: string | null | undefined): number {
  const m = /^\d+\+(\d+)$/.exec(timeControl ?? '');
  return m ? parseInt(m[1], 10) : 0;
}

/** Seconds each move took: the mover's clock before it, less the clock after, plus the increment
 *  ([%clk] already includes it). null where either clock is missing. */
export function secondsSpent(clocks: (number | null)[], baseSeconds: number | null, increment: number): (number | null)[] {
  return clocks.map((c, ply) => {
    const prev = ply >= 2 ? clocks[ply - 2] : baseSeconds;
    return c === null || prev === null ? null : Math.max(0, prev - c + increment);
  });
}
