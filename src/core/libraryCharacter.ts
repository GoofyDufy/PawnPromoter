/**
 * Is an opening line sharp or quiet? — port of library_character.py. A label
 * and a short description for each line of the opening library, from computed
 * facts at the line's end position (no guessing, like explain.ts):
 *  - the board: a gambit (one side a pawn or more down), pawns in contact in
 *    the centre (tension) or locked face to face (closed), open files, queens
 *    traded, a symmetrical pawn structure;
 *  - the name: "Gambit", "Countergambit", "Attack", "Sacrifice";
 *  - Stockfish (MultiPV 3): only one good move or several about equal, and
 *    whether one side is already clearly better.
 *
 * Each fact scores toward sharp (+) or quiet (−); the total gives Sharp /
 * Balanced / Quiet. The web app ships these pre-computed (the facts depend
 * only on the line), so describe() runs at build time, not in the browser.
 */
import { MATE_CP, scoreToCp, winChances } from './analyzer';
import { BLACK, Board, type Color, WHITE, squareFile } from './chess';
import type { Engine } from './engine';
import { VALUES } from './explain';
import { pySigned } from './format';
import type { Opening } from './openingLibrary';

export const DEPTH = 12;
export const SHARP_AT = 3;             // score >= this: Sharp
export const QUIET_AT = -1;            // score <= this: Quiet
export const SETTLE_PLIES = 4;         // recaptures along Stockfish's line played out before counting material
export const LOOK_AHEAD = 12;          // plies of Stockfish's main line checked for opposite-side castling
export const MIN_PV_FOR_MATERIAL = 8;  // material down counts only if still down after this long a line (or a named gambit)
export const ONLY_MOVE_GAP = 0.15;     // winning chances (-1..1) between the best and the 2nd: "only one good move"
export const SEVERAL_CP = 25;          // the best three within this: "several good moves"
export const CLEAR_EDGE_CP = 90;
export const VERSION = 1;
const CENTRE_FILES = [2, 3, 4, 5];     // c-f

export interface Character {
  label: string;             // "Sharp" / "Balanced" / "Quiet"
  score: number;
  text: string;              // one or two sentences, from the facts
  eval_cp: number | null;    // White's point of view
}

export type Fact = [number, string];

function material(board: Board, color: Color): number {
  let total = 0;
  for (const p of board.pieceMap().values()) total += VALUES[p.role] * (p.color === color ? 1 : -1);
  return total;
}

/** The position once pending captures are played out along Stockfish's line. */
export function settled(board: Board, pv: string[]): Board {
  const b = board.copy();
  for (const move of pv.slice(0, SETTLE_PLIES)) {
    if (!b.isLegal(move) || !b.isCapture(move)) break;
    b.push(move);
  }
  return b;
}

/** [score, phrase] facts from the (settled) position and the name. */
export function boardFacts(board: Board, name: string, evalCp: number | null = null, laterBalance: number | null = null): Fact[] {
  const facts: Fact[] = [];
  const lower = name.toLowerCase();
  if (lower.includes('countergambit')) facts.push([2, 'a countergambit']);
  else if (lower.includes('gambit') && !lower.includes('declined')) facts.push([2, 'a gambit']);
  if (lower.includes('attack') || lower.includes('sacrifice')) facts.push([1, 'an attacking line']);

  const balance = material(board, WHITE);
  // only material still missing at the end of Stockfish's line counts
  const namedGambit = lower.includes('gambit') && !lower.includes('declined');
  const lasting = namedGambit || (laterBalance !== null && laterBalance * balance > 0 && Math.abs(laterBalance) >= 1);
  if (Math.abs(balance) >= 1 && lasting) {
    const side = balance < 0 ? 'White' : 'Black';
    const worth = `${Math.abs(balance)} pawn${Math.abs(balance) > 1 ? 's' : ''}`;
    const what = Math.abs(balance) === 1 ? `${side} is a pawn down` : `${side} has given up material (worth ${worth})`;
    // down but not worse (by Stockfish): material given for activity
    const fair = evalCp === null || Math.abs(evalCp) < 120;
    facts.push([2, fair ? `${what} for activity` : what]);
  }

  if (!board.pieces('queen', WHITE).length && !board.pieces('queen', BLACK).length) facts.push([-2, 'the queens are off']);

  const wp = board.pieces('pawn', WHITE);
  const bp = new Set(board.pieces('pawn', BLACK));
  // pawns attacking each other in the centre (c-f files): tension
  const tension = wp.some((sq) => CENTRE_FILES.includes(squareFile(sq)) && board.attacks(sq).some((s) => bp.has(s)));
  // pawns blocked face to face on the d/e files: a closed centre
  const locked = wp.filter((sq) => [3, 4].includes(squareFile(sq)) && sq + 8 < 64 && bp.has(sq + 8)).length;
  const all = [...wp, ...bp];
  const openFiles = [0, 1, 2, 3, 4, 5, 6, 7].filter((f) => !all.some((s) => squareFile(s) === f));
  if (tension) facts.push([1, 'pawns are in contact in the centre']);
  if (locked >= 2 && !tension) facts.push([-2, 'the centre is locked']);     // one blocked pair (e4/e5) is just an open game
  if (openFiles.length >= 2) facts.push([1, `${openFiles.length} files are open`]);
  const mirror = new Set([...bp].map((sq) => sq ^ 56));
  if (wp.length === mirror.size && wp.every((sq) => mirror.has(sq)) && wp.length >= 6) {
    facts.push([-1, 'the pawn structure is symmetrical']);
  }
  return facts;
}

/** Facts from Stockfish at the end position, its evaluation (White's view) and main line. */
export async function engineFacts(engine: Engine, board: Board): Promise<[Fact[], number | null, string[]]> {
  if (board.isGameOver()) return [[], null, []];
  const infos = await engine.analyse(board, { depth: DEPTH }, 3);
  const me = board.turn;
  const cps = infos.filter((i) => i.pv.length).map((i) => scoreToCp(i.score, me));
  if (!cps.length) return [[], null, []];
  const side = me === WHITE ? 'White' : 'Black';
  const facts: Fact[] = [];
  if (cps.length >= 2 && winChances(cps[0]) - winChances(cps[1]) >= ONLY_MOVE_GAP) {
    facts.push([2, `${side} has only one good move here — mistakes are punished`]);
  } else if (cps.length >= 3 && cps[0] - cps[2] <= SEVERAL_CP) {
    facts.push([-1, `${side} has several good moves — it's forgiving`]);
  }
  const whiteCp = me === WHITE ? cps[0] : -cps[0];
  if (Math.abs(whiteCp) >= CLEAR_EDGE_CP && Math.abs(whiteCp) < Math.floor(MATE_CP / 2)) {
    facts.push([1, `${whiteCp > 0 ? 'White' : 'Black'} is already clearly better (${pySigned(whiteCp / 100, 1)})`]);
  }
  const pv = [...infos[0].pv];
  // along the main line: do the kings end up on opposite wings? (pawn storms, a race)
  const b = board.copy();
  for (const move of pv.slice(0, LOOK_AHEAD)) {
    if (!b.isLegal(move)) break;
    b.push(move);
  }
  const wk = b.king(WHITE);
  const bk = b.king(BLACK);
  if (wk !== undefined && bk !== undefined) {
    const wf = squareFile(wk);
    const bf = squareFile(bk);
    if ((wf <= 2 && bf >= 5) || (wf >= 5 && bf <= 2)) {
      facts.push([2, "in Stockfish's main line the kings castle on opposite sides — a race"]);
    }
  }
  return [facts, whiteCp, pv];
}

export async function describe(engine: Engine | null, opening: Opening): Promise<Character> {
  const board = Board.fromFen();
  for (const uci of opening.ucis) board.push(uci);
  let evalCp: number | null = null;
  let pv: string[] = [];
  let more: Fact[] = [];
  if (engine) [more, evalCp, pv] = await engineFacts(engine, board);
  let later: number | null = null;                     // a short line can't tell lasting from temporary
  if (pv.length >= MIN_PV_FOR_MATERIAL) {
    const end = board.copy();
    for (const move of pv) {
      if (!end.isLegal(move)) break;
      end.push(move);
    }
    later = material(end, WHITE);
  }
  const facts = [...boardFacts(settled(board, pv), opening.name, evalCp, later), ...more];
  const score = facts.reduce((s, [v]) => s + v, 0);
  const label = score >= SHARP_AT ? 'Sharp' : score <= QUIET_AT ? 'Quiet' : 'Balanced';
  const why = [...facts].sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))
    .filter(([s]) => (s > 0) === (label === 'Sharp') || label === 'Balanced').map(([, t]) => t);
  const joined = why.slice(0, 3).join('; ');
  const text = why.length ? `${why[0][0].toUpperCase()}${joined.slice(1)}.`
    : 'Nothing forcing at the end of this line — a normal developing position.';
  return { label, score, text, eval_cp: evalCp };
}
