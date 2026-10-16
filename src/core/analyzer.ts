/**
 * Runs each of your games through Stockfish and turns significant mistakes
 * into puzzles — port of analyzer.py.
 *
 * Two phases, deliberately kept separate:
 *
 *   1. evaluateGame() — the slow part. Runs Stockfish once per move of yours
 *      and returns raw MoveEvaluation records with NO threshold applied. The
 *      caller saves these permanently (move_evaluations table), so a game
 *      never goes through the engine twice.
 *   2. puzzlesFromEvaluations() — pure and engine-free. Turns cached
 *      evaluations into puzzles at whatever threshold is currently set, so
 *      changing the threshold is instant.
 *
 * Don't merge threshold checking back into the engine loop — that would mean
 * every threshold change requires re-running Stockfish on everything.
 *
 * (Running several engines side by side — evaluate_games_parallel — lives with
 * the Stockfish worker pool in the app, not here.)
 */
import * as amazing from './amazing';
import { BLACK, Board, type Color, type Role, SQUARES, WHITE, opposite } from './chess';
import * as db from './db';
import type { Engine, PovScore } from './engine';
import { type Game, type MoveEvaluation, type Puzzle, makePuzzle } from './models';
import type { Db } from './sqlite';
import { readGame } from './pgn';

/** Centipawn drop that counts as "worth turning into a puzzle". */
export const MISTAKE_THRESHOLD_CP = 150;

/** How deep Stockfish searches each position. */
export const ANALYSIS_DEPTH = 14;

/** If the position was ALREADY at or beyond this evaluation before your move,
 *  the game was decided — skip it (and the second engine call). */
export const DECISIVE_EVAL_CP = 600;

/** Mate scores are clamped to +/- this value so comparisons still work. */
export const MATE_CP = 10000;

/** A mistake has to cost you real winning chances to become a puzzle — Lichess's
 *  move labels (winning chances on a -1..1 scale): a drop of 0.2+ is a mistake,
 *  0.3+ a blunder. So -8 -> mated, or +10 -> +6, isn't a puzzle; +4 -> -5 is. */
export const MIN_CHANCES_LOST = 0.2;
export const BLUNDER_CHANCES_LOST = 0.3;
export const RULES_VERSION = '1';       // settings 'puzzle_cost_version': 1 = the winning-chances rule

/** Lichess's winning chances, -1 (lost) .. 1 (won), from centipawns. */
export function winChances(cp: number): number {
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

export const MISSED_SACRIFICE = 'Missed Sacrifice';    // the best move was a sound piece sacrifice (amazing.ts)
export const RULES_SAC_VERSION = '1';                    // settings 'puzzle_sac_version': missed sacrifices added

export function chancesLost(cpBefore: number, cpAfter: number): number {
  return winChances(cpBefore) - winChances(cpAfter);
}

/** How many top engine moves to record per position (best + 2nd + 3rd). */
export const MULTI_PV = 3;

/** Bump when the stored evaluation data changes shape; games cached under an
 *  older version get re-analyzed once. 1 = best move only, 2 = MultiPV top 3. */
export const EVAL_VERSION = 2;

/** Engine score -> centipawns from `povColor`'s side, mates clamped to ±MATE_CP. */
export function scoreToCp(score: PovScore, povColor: Color): number {
  const pov = score.pov(povColor);
  if (pov.isMate()) {
    const mateIn = pov.mate();
    return mateIn && mateIn > 0 ? MATE_CP : -MATE_CP;
  }
  return pov.score()!;
}

// Stockfish has no concept of tactical "types" — it only gives an evaluation
// and a best move. This is our own lightweight heuristic classifier on top.
const PIECE_VALUES: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

/** your move left one of your pieces loose. Not Lichess's "Hanging piece",
 *  which is the opposite: a puzzle where you win an undefended piece. */
export const LEFT_HANGING = 'Left Hanging';

export function classifyPuzzleType(boardBefore: Board, move: string, myColor: Color, cpBefore: number, swing: number,
  lost = 1.0): string {
  // you had a forced mate available and didn't take it
  if (cpBefore >= MATE_CP) return 'Missed Mate';

  // did your move leave a piece attacked with no defender? (not a full
  // exchange evaluation, so it can miss subtler cases)
  const boardAfter = boardBefore.copy();
  boardAfter.push(move);
  const opponent = opposite(myColor);
  let worstHangingValue = 0;
  for (const square of SQUARES) {
    const piece = boardAfter.pieceAt(square);
    if (piece && piece.color === myColor) {
      if (boardAfter.isAttackedBy(opponent, square) && !boardAfter.isAttackedBy(myColor, square)) {
        worstHangingValue = Math.max(worstHangingValue, PIECE_VALUES[piece.role] ?? 0);
      }
    }
  }
  if (worstHangingValue >= 3) return LEFT_HANGING;     // minor piece or better left hanging

  // fallback: by severity, Lichess's tiers (winning chances lost)
  if (lost >= BLUNDER_CHANCES_LOST) return 'Blunder';
  if (lost >= MIN_CHANCES_LOST) return 'Mistake';
  return 'Inaccuracy';
}

/** One-off (RULES_VERSION 1) for saved puzzles: removes the ones that didn't
 *  cost real winning chances and re-labels Blunder / Mistake by Lichess's tiers
 *  — in place, so kinds, solutions and ids are kept. Returns [removed, relabelled]. */
export function applyChancesRule(conn: Db): [number, number] {
  const removed: string[] = [];
  const relabel: [string, string][] = [];
  for (const r of conn.all('SELECT id, eval_before_cp, eval_after_cp, puzzle_type FROM puzzles WHERE eval_after_cp IS NOT NULL')) {
    if (r.puzzle_type === MISSED_SACRIFICE) continue;          // its own rule (amazing.missedSacrifice)
    if (String(r.id).startsWith('pick-')) continue;            // one you made yourself
    const lost = chancesLost(r.eval_before_cp || 0, r.eval_after_cp);
    if (lost < MIN_CHANCES_LOST) {
      removed.push(r.id);
    } else if (['Blunder', 'Mistake', 'Inaccuracy'].includes(r.puzzle_type)) {
      const label = lost >= BLUNDER_CHANCES_LOST ? 'Blunder' : 'Mistake';
      if (label !== r.puzzle_type) relabel.push([label, r.id]);
    }
  }
  conn.transaction(() => {
    for (const id of removed) {
      conn.run('DELETE FROM review_state WHERE puzzle_id = ?', [id]);
      conn.run('DELETE FROM puzzles WHERE id = ?', [id]);
    }
    for (const [label, id] of relabel) conn.run('UPDATE puzzles SET puzzle_type = ? WHERE id = ?', [label, id]);
  });
  return [removed.length, relabel.length];
}

/** One-off (RULES_SAC_VERSION): saved puzzles whose answer is a sacrifice you
 *  missed become Missed Sacrifice, and missed sacrifices below the blunder size
 *  become new puzzles (their kind is worked out in the background). Returns
 *  [relabelled, added]. */
export function addMissedSacrifices(conn: Db): [number, number] {
  const existing = new Map<string, [string, string]>();
  for (const r of conn.all('SELECT source_game_id, fen, id, puzzle_type FROM puzzles WHERE source_game_id IS NOT NULL')) {
    existing.set(`${r.source_game_id}\t${r.fen}`, [r.id, r.puzzle_type]);
  }
  const relabel: string[] = [];
  const added: Puzzle[] = [];
  for (const m of amazing.findMissed(conn, false)) {
    const hit = existing.get(`${m.game_id}\t${m.fen}`);
    if (hit) {
      if (hit[1] !== MISSED_SACRIFICE && hit[1] !== 'Missed Mate') relabel.push(hit[0]);
      continue;
    }
    added.push(makePuzzle({
      fen: m.fen, correct_move_san: m.best_san, correct_move_uci: m.best_uci, source: 'own_game_mistake',
      played_move_san: m.played_san, eval_swing_cp: m.cp_before - m.cp_after, eval_before_cp: m.cp_before,
      eval_after_cp: m.cp_after, puzzle_type: MISSED_SACRIFICE, source_game_id: m.game_id,
    }));
  }
  conn.transaction(() => {
    for (const id of relabel) conn.run('UPDATE puzzles SET puzzle_type = ? WHERE id = ?', [MISSED_SACRIFICE, id]);
    for (const p of added) db.insertPuzzle(conn, p);
  });
  return [relabel.length, added.length];
}

export function myChessColor(game: Pick<Game, 'my_color'>): Color {
  return game.my_color === 'white' ? WHITE : BLACK;
}

/** How many moves in this game were played by you — PGN walking only, for
 *  sizing the progress bar before analysis starts. */
export function countMyMoves(game: Game): number {
  const parsed = readGame(game.pgn);
  if (!parsed) return 0;
  const myColor = myChessColor(game);
  const board = Board.fromFen(parsed.startFen, parsed.chess960);
  let count = 0;
  for (const move of parsed.mainline) {
    if (board.turn === myColor) count += 1;
    board.push(move);
  }
  return count;
}

/** Thrown inside the engine loop when the user presses Stop. Games already
 *  finished (and saved) are kept. */
export class AnalysisStopped extends Error {
  constructor() {
    super('analysis stopped');
  }
}

/** Runs Stockfish on every move of yours in one game and returns the raw
 *  results — no threshold applied, nothing filtered out. */
export async function evaluateGame(
  game: Game, engine: Engine,
  onMoveAnalyzed?: () => void,
  shouldStop?: () => boolean,
): Promise<MoveEvaluation[]> {
  const parsed = readGame(game.pgn);
  if (!parsed) return [];

  const myColor = myChessColor(game);
  const limit = { depth: ANALYSIS_DEPTH };
  const evaluations: MoveEvaluation[] = [];
  const board = Board.fromFen(parsed.startFen, parsed.chess960);

  for (const [ply, move] of parsed.mainline.entries()) {
    if (board.turn === myColor) {
      if (shouldStop?.()) throw new AnalysisStopped();

      // MultiPV: one search returns the top 3 lines, best first
      const lines = await engine.analyse(board, limit, MULTI_PV);
      const infoBefore = lines[0];
      const bestMove = infoBefore.pv.length ? infoBefore.pv[0] : null;
      const cpBefore = scoreToCp(infoBefore.score, myColor);
      const alternatives: [string | null, number | null][] = lines.slice(1)
        .filter((line) => line.pv.length)
        .map((line) => [line.pv[0], scoreToCp(line.score, myColor)]);
      while (alternatives.length < 2) alternatives.push([null, null]);

      // already decisively won or lost before this move — skip the second
      // engine call; this move can never become a puzzle at any threshold
      // (don't reuse the MultiPV score when you played a top-3 move: it saves
      // no time — this search primes the hash — and it changes which puzzles
      // are found)
      let cpAfter: number | null = null;
      if (Math.abs(cpBefore) < DECISIVE_EVAL_CP) {
        board.push(move);
        const [infoAfter] = await engine.analyse(board, limit);
        cpAfter = scoreToCp(infoAfter.score, myColor);
        board.pop();
      }

      evaluations.push({
        game_id: game.id, ply, fen_before: board.fen(), move_uci: move, best_move_uci: bestMove,
        cp_before: cpBefore, cp_after: cpAfter, depth: ANALYSIS_DEPTH,
        second_move_uci: alternatives[0][0], cp_second: alternatives[0][1],
        third_move_uci: alternatives[1][0], cp_third: alternatives[1][1],
      });

      onMoveAnalyzed?.();
    }
    board.push(move);
  }
  return evaluations;
}

/** Pure, engine-free: turns cached evaluations into puzzles at the given
 *  threshold. Cheap enough to re-run over every game whenever it changes. */
export function puzzlesFromEvaluations(evaluations: MoveEvaluation[], thresholdCp = MISTAKE_THRESHOLD_CP): Puzzle[] {
  const puzzles: Puzzle[] = [];
  for (const ev of evaluations) {
    if (ev.cp_after === null || ev.best_move_uci === null) continue;
    if (ev.best_move_uci === ev.move_uci) continue;
    const swing = ev.cp_before - ev.cp_after;
    const lost = chancesLost(ev.cp_before, ev.cp_after);
    // a sound sacrifice you missed is a puzzle even below the blunder size (amazing.ts)
    const missedSac = amazing.missedSacrifice(ev.fen_before, ev.move_uci, ev.best_move_uci, ev.cp_before, ev.cp_after);
    if (!missedSac) {
      if (swing < thresholdCp) continue;
      if (lost < MIN_CHANCES_LOST) continue;           // the game was decided either way
    }

    const board = Board.fromFen(ev.fen_before);
    puzzles.push(makePuzzle({
      fen: ev.fen_before,
      correct_move_san: board.san(ev.best_move_uci),
      correct_move_uci: ev.best_move_uci,
      source: 'own_game_mistake',
      played_move_san: board.san(ev.move_uci),
      eval_swing_cp: swing,
      eval_before_cp: ev.cp_before,
      eval_after_cp: ev.cp_after,
      puzzle_type: missedSac && ev.cp_before < MATE_CP
        ? MISSED_SACRIFICE : classifyPuzzleType(board, ev.move_uci, board.turn, ev.cp_before, swing, lost),
      source_game_id: ev.game_id,
    }));
  }
  return puzzles;
}
