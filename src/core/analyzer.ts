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
import { BLACK, Board, type Color, type Role, SQUARES, WHITE, opposite } from './chess';
import type { Engine, PovScore } from './engine';
import { type Game, type MoveEvaluation, type Puzzle, makePuzzle } from './models';
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

export function classifyPuzzleType(boardBefore: Board, move: string, myColor: Color, cpBefore: number, swing: number): string {
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
  if (worstHangingValue >= 3) return 'Hanging Piece';   // minor piece or better left hanging

  // fallback: severity tiers, as chess.com/lichess label move quality
  if (swing >= 300) return 'Blunder';
  if (swing >= 150) return 'Mistake';
  return 'Inaccuracy';
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
    if (swing < thresholdCp) continue;

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
      puzzle_type: classifyPuzzleType(board, ev.move_uci, board.turn, ev.cp_before, swing),
      source_game_id: ev.game_id,
    }));
  }
  return puzzles;
}
