/**
 * What kind of puzzle a position is — port of puzzle_kind.py — decided by
 * Stockfish once and saved on the puzzle (puzzles.solution_ucis /
 * solution_moves / kind):
 *
 *  - Attacking: the solution is a forced mate or a forcing sequence (checks,
 *    captures, new threats) that wins material, leaves you +2 or better, with
 *    only one first move (Lichess's standard, spot.winsByForce) — the rule Spot
 *    the Tactic and multi-move puzzles use (spot.solutionFor / spot.forcingWin).
 *  - Defensive: you're facing a threat and the best move deals with it
 *    quietly — Lichess's "defensive move": no capture, no check, attacks
 *    nothing (escaping check counts if it isn't a capture and there were at
 *    least 3 ways out). Facing a threat = in check, or if you could pass, your
 *    opponent would gain at least THREAT_CP (Stockfish, a "null move").
 *  - Counterattack: you're facing a threat and the best answer hits back — a
 *    capture, a check, or a move that attacks one of their pieces.
 *  - Positional: neither — a quiet best move with no tactic to play and no
 *    threat to answer.
 *
 * The solution (yours and the opponent's replies, up to 4 of your moves) is
 * saved too, so a puzzle opens without working it out again.
 *
 * (classify_all — several engines working through the backlog — lives with
 * the app's Stockfish worker pool.)
 */
import { scoreToCp } from './analyzer';
import { Board } from './chess';
import type { Engine } from './engine';
import * as spot from './spot';
import type { Db } from './sqlite';

export const ATTACKING = 'Attacking';
export const DEFENSIVE = 'Defensive';
export const COUNTERATTACK = 'Counterattack';
export const POSITIONAL = 'Positional';
export const KINDS = [ATTACKING, DEFENSIVE, COUNTERATTACK, POSITIONAL];
/** settings 'puzzle_kind_version': 2 = Counterattack split out of Defensive */
export const VERSION = '2';
/** settings 'puzzle_rules_version': 3 = Lichess's tactic bar (+2, only move) */
export const RULES_VERSION = '3';
export const SOLUTION_DEPTH = 16;       // same as the puzzle tab's on-the-fly line
export const THREAT_DEPTH = 12;
export const THREAT_CP = 150;

export class Result {
  constructor(readonly solution: string[], readonly kind: string) {}

  get moves(): number {
    return Math.floor((this.solution.length + 1) / 2);
  }
}

export async function classify(engine: Engine, fen: string, bestUci: string): Promise<Result> {
  const board = Board.fromFen(fen);
  const best = bestUci;
  const lines = await engine.analyse(board, { depth: SOLUTION_DEPTH }, 2);
  const info = lines[0];
  const pv = [...info.pv];
  const bestCp = scoreToCp(info.score, board.turn);
  const secondCp = lines.length > 1 && lines[1].pv.length ? scoreToCp(lines[1].score, board.turn) : null;
  let solution = [best];
  let attacking = false;
  if (pv.length && pv[0] === best) {               // the engine agrees on the first move
    const pov = info.score.pov(board.turn);
    const mateIn = pov.mate();
    const mate = pov.isMate() && mateIn !== null && mateIn > 0 && mateIn <= spot.MAX_MATE;
    const [gain, length] = spot.forcingWin(board, pv);
    if (mate) {
      const line = spot.mateLine(board, pv);
      solution = line.length ? line : [best];
      attacking = true;
    } else if (spot.winsByForce(gain, length, bestCp, secondCp)) {
      solution = pv.slice(0, length);
      attacking = true;
    }
  }
  if (attacking) return new Result(solution, ATTACKING);
  if (board.isCheck()) return new Result(solution, answerKind(board, best));
  // a threat: what would the opponent get if you could pass?
  const now = bestCp;
  const passed = board.copy();
  passed.pushNull();
  const passedFen = passed.fen();                  // the same position, without the pass in its history
  if (Board.isValidFen(passedFen)) {
    const [after] = await engine.analyse(Board.fromFen(passedFen), { depth: THREAT_DEPTH });
    if (now - scoreToCp(after.score, board.turn) >= THREAT_CP) return new Result(solution, answerKind(board, best));
  }
  return new Result(solution, POSITIONAL);
}

/** Facing a threat: Defensive if the best move is quiet, Counterattack if it
 *  hits back (Lichess's defensiveMove / check-escape rules). */
export function answerKind(board: Board, best: string): string {
  if (board.isCapture(best)) return COUNTERATTACK;
  if (board.isCheck() && board.legalMoves().length < 3) return COUNTERATTACK;   // a forced reply, not a precise find
  const after = board.copy();
  after.push(best);
  if (after.isCheck()) return COUNTERATTACK;
  const to = best.charCodeAt(2) - 97 + 8 * (best.charCodeAt(3) - 49);
  for (const square of after.attacks(to)) {
    const piece = after.pieceAt(square);
    if (piece && piece.color === after.turn) return COUNTERATTACK;   // attacks one of their pieces (pawns too, like Lichess)
  }
  return DEFENSIVE;
}

/** The tactic rules changed (RULES_VERSION): forget every kind and saved
 *  solution, so the background classifier works them all out again. */
export function resetForNewRules(conn: Db): void {
  conn.run('UPDATE puzzles SET kind = NULL, solution_ucis = NULL, solution_moves = NULL');
}

/** One-off (VERSION 2): splits Counterattack out of the saved Defensive
 *  puzzles — no engine needed, it only looks at the best move. Returns how
 *  many changed. */
export function relabelDefensive(conn: Db): number {
  const changed: string[] = [];
  for (const r of conn.all('SELECT id, fen, correct_move_uci FROM puzzles WHERE kind = ?', [DEFENSIVE])) {
    try {
      if (answerKind(Board.fromFen(r.fen), r.correct_move_uci) === COUNTERATTACK) changed.push(r.id);
    } catch {
      continue;                                    // an unreadable position or move
    }
  }
  conn.transaction(() => {
    for (const id of changed) conn.run('UPDATE puzzles SET kind = ? WHERE id = ?', [COUNTERATTACK, id]);
  });
  return changed.length;
}

export function save(conn: Db, puzzleId: string, result: Result): void {
  conn.run('UPDATE puzzles SET solution_ucis = ?, solution_moves = ?, kind = ? WHERE id = ?',
    [result.solution.join(' '), result.moves, result.kind, puzzleId]);
}

/** [id, fen, best move] of every puzzle not classified yet. */
export function unclassified(conn: Db): [string, string, string][] {
  return conn.all('SELECT id, fen, correct_move_uci FROM puzzles WHERE kind IS NULL')
    .map((r) => [r.id, r.fen, r.correct_move_uci]);
}
