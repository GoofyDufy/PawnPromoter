/**
 * Playing-style analysis — port of style.py: are you relatively stronger in
 * sharp/tactical or quiet/positional positions, and which openings fit that.
 * Pure functions, no engine — works off the cached move_evaluations.
 *
 * Every label is a hand-built heuristic, good for trends over many games:
 *  - A position is SHARP when the engine's best move is clearly better than
 *    its 2nd choice (an "only move"), or, for games cached before MultiPV,
 *    when you're in check or a piece is hanging.
 *  - A game's sharpness = share of your moves 9-30 played in sharp positions.
 *  - The verdict compares your SCORE in your sharpest vs quietest games.
 */
import { MATE_CP } from './analyzer';
import { Board, type Role, opposite } from './chess';
import { pyPercent } from './format';
import { type Puzzle, inTimeFilter } from './models';
import { readHeaders } from './pgn';
import type { Db, Row } from './sqlite';
import { BLUNDER_CP, MAX_LOSS_CP, PhaseStat, Record, openingKey, openingName } from './stats';

export const ONLY_MOVE_GAP_CP = 120;     // best beats 2nd best by this much = only move
export const PUNISH_CHANCE_CP = 200;     // opponent's move handed you at least this much
export const PUNISH_KEEP_CP = 100;       // "punished" = you gave back less than this
/** below this, a sharp-vs-quiet score gap is mostly noise (~±10%) */
export const MIN_GAMES_PER_BUCKET = 25;
export const VERDICT_MARGIN = 0.06;      // score difference needed to call a preference
const HANG_VALUES: { [role in Role]?: number } = { knight: 3, bishop: 3, rook: 5, queen: 9 };

const clamp = (cp: number) => Math.max(-MATE_CP, Math.min(MATE_CP, cp));

function hasHangingPiece(board: Board): boolean {
  for (const [square, piece] of board.pieceMap()) {
    if (piece.role in HANG_VALUES) {
      if (board.isAttackedBy(opposite(piece.color), square) && !board.isAttackedBy(piece.color, square)) return true;
    }
  }
  return false;
}

export function isSharp(row: { cp_second?: number | null; cp_before: number; fen_before: string }): boolean {
  if (row.cp_second !== null && row.cp_second !== undefined) {
    return clamp(row.cp_before) - clamp(row.cp_second) >= ONLY_MOVE_GAP_CP;
  }
  const board = Board.fromFen(row.fen_before);
  return board.isCheck() || hasHangingPiece(board);
}

/** Closed = 3+ pawn pairs locked head-to-head; Open = at most one locked pair
 *  and 12 or fewer pawns left; otherwise Semi-open. */
export function pawnStructure(fen: string): string {
  const board = Board.fromFen(fen);
  const white = board.pieces('pawn', 'white');
  const black = new Set(board.pieces('pawn', 'black'));
  const locked = white.filter((sq) => sq + 8 < 64 && black.has(sq + 8)).length;
  if (locked >= 3) return 'Closed center';
  if (locked <= 1 && white.length + black.size <= 12) return 'Open center';
  return 'Semi-open center';
}

export class StyleReport {
  games = 0;                    // games with engine data in the filter
  multipv_games = 0;
  accuracy = new Map<string, PhaseStat>();   // Sharp / Quiet positions
  only_moves = 0;
  only_moves_found = 0;
  punish_chances = 0;
  punished = 0;
  game_types = new Map<string, Record>();    // ordered for display
  /** openingKey(opening, color) -> [record, average game sharpness] */
  openings = new Map<string, [Record, number]>();
  sharp_cutoffs: [number, number] = [0.0, 0.0];
  style: 'sharp' | 'quiet' | 'balanced' | null = null;   // null = not enough data
  verdict = '';

  character(sharpness: number): string {
    const [low, high] = this.sharp_cutoffs;
    return sharpness >= high ? 'Sharp' : sharpness <= low ? 'Quiet' : 'Mixed';
  }
}

export function computeStyle(db: Db, timeClasses: Set<string> | null = null): StyleReport {
  const report = new StyleReport();
  report.accuracy = new Map([['Sharp positions', new PhaseStat()], ['Quiet positions', new PhaseStat()]]);

  const games = new Map<string, Row>();
  for (const g of db.all('SELECT id, pgn, my_color, result, time_control FROM games WHERE evaluated_at IS NOT NULL')) {
    if (inTimeFilter(g.time_control, timeClasses)) games.set(g.id, g);
  }

  const evalsByGame = new Map<string, Row[]>();
  for (const ev of db.all('SELECT * FROM move_evaluations ORDER BY game_id, ply')) {
    if (!games.has(ev.game_id)) continue;
    if (!evalsByGame.has(ev.game_id)) evalsByGame.set(ev.game_id, []);
    evalsByGame.get(ev.game_id)!.push(ev);
  }

  const gameSharpness = new Map<string, number>();
  const structureOf = new Map<string, string>();
  const queensOf = new Map<string, string>();

  for (const [gameId, evs] of evalsByGame) {
    if (evs.some((e) => e.cp_second !== null)) report.multipv_games += 1;
    let sharpMid = 0;
    let totalMid = 0;
    let prev: Row | null = null;
    for (const ev of evs) {
      const sharp = isSharp(ev as { cp_second: number | null; cp_before: number; fen_before: string });
      if (ev.ply >= 16 && ev.ply <= 60) {
        totalMid += 1;
        sharpMid += sharp ? 1 : 0;
      }

      if (ev.cp_after !== null) {
        const loss = Math.min(Math.max(0, ev.cp_before - ev.cp_after), MAX_LOSS_CP);
        const stat = report.accuracy.get(sharp ? 'Sharp positions' : 'Quiet positions')!;
        stat.moves += 1;
        stat.total_loss += loss;
        stat.blunders += loss >= BLUNDER_CP ? 1 : 0;
      }

      // only-move positions (MultiPV data only): did you find it?
      if (ev.cp_second !== null && sharp) {
        report.only_moves += 1;
        report.only_moves_found += ev.move_uci === ev.best_move_uci ? 1 : 0;
      }

      // opponent's move in between handed you a big gain: did you cash in?
      if (prev !== null && prev.ply + 2 === ev.ply && prev.cp_after !== null) {
        const gain = Math.min(ev.cp_before, MAX_LOSS_CP) - Math.max(prev.cp_after, -MAX_LOSS_CP);
        if (gain >= PUNISH_CHANCE_CP && Math.abs(prev.cp_after) < MATE_CP) {
          report.punish_chances += 1;
          if (ev.cp_after !== null) report.punished += ev.cp_before - ev.cp_after < PUNISH_KEEP_CP ? 1 : 0;
          else report.punished += ev.move_uci === ev.best_move_uci ? 1 : 0;
        }
      }
      prev = ev;

      if (!structureOf.has(gameId) && ev.ply >= 28) structureOf.set(gameId, pawnStructure(ev.fen_before));
      if (!queensOf.has(gameId) && ev.ply >= 40) {
        const board = Board.fromFen(ev.fen_before);
        queensOf.set(gameId, board.pieces('queen', 'white').length || board.pieces('queen', 'black').length
          ? 'Queens kept past move 20' : 'Queens off by move 20');
      }
    }
    if (totalMid >= 5) gameSharpness.set(gameId, sharpMid / totalMid);
  }

  report.games = evalsByGame.size;
  if (gameSharpness.size >= 3) {
    const ordered = [...gameSharpness.values()].sort((a, b) => a - b);
    report.sharp_cutoffs = [ordered[Math.floor(ordered.length / 3)], ordered[Math.floor((2 * ordered.length) / 3)]];
  }

  const types = new Map<string, Record>([
    'Sharp games', 'Mixed games', 'Quiet games',
    'Open center', 'Semi-open center', 'Closed center',
    'Queens off by move 20', 'Queens kept past move 20',
  ].map((k) => [k, new Record()]));
  const openingRecords = new Map<string, Record>();
  const openingSharpness = new Map<string, number[]>();
  for (const [gameId, g] of games) {
    if (gameSharpness.has(gameId)) types.get(`${report.character(gameSharpness.get(gameId)!)} games`)!.add(g.result);
    if (structureOf.has(gameId)) types.get(structureOf.get(gameId)!)!.add(g.result);
    if (queensOf.has(gameId)) types.get(queensOf.get(gameId)!)!.add(g.result);
    const key = openingKey(openingName(readHeaders(g.pgn)), g.my_color);
    if (!openingRecords.has(key)) openingRecords.set(key, new Record());
    openingRecords.get(key)!.add(g.result);
    if (!openingSharpness.has(key)) openingSharpness.set(key, []);
    if (gameSharpness.has(gameId)) openingSharpness.get(key)!.push(gameSharpness.get(gameId)!);
  }
  report.game_types = types;
  for (const [k, r] of openingRecords) {
    const list = openingSharpness.get(k)!;
    if (list.length) report.openings.set(k, [r, list.reduce((a, b) => a + b, 0) / list.length]);
  }

  const sharp = types.get('Sharp games')!;
  const quiet = types.get('Quiet games')!;
  if (Math.min(sharp.games, quiet.games) < MIN_GAMES_PER_BUCKET) {
    report.verdict = `Not enough data yet — need ${MIN_GAMES_PER_BUCKET}+ sharp and quiet `
      + `games each (have ${sharp.games} / ${quiet.games}). Analyze more games.`;
  } else {
    const diff = sharp.score - quiet.score;
    const detail = `You score ${pyPercent(sharp.score)} in your sharpest games vs ${pyPercent(quiet.score)} in your quietest.`;
    if (diff >= VERDICT_MARGIN) {
      report.style = 'sharp';
      report.verdict = `You're relatively stronger in sharp, tactical games. ${detail}`;
    } else if (diff <= -VERDICT_MARGIN) {
      report.style = 'quiet';
      report.verdict = `You're relatively stronger in quiet, positional games. ${detail}`;
    } else {
      report.style = 'balanced';
      report.verdict = `No clear preference — you're a balanced player. ${detail}`;
    }
  }
  return report;
}

/** puzzle id -> true if its position is sharp (one clearly best move), using
 *  the cached engine data for that exact position when available, else the
 *  check / hanging-piece fallback (see isSharp). */
export function puzzleSharpness(db: Db, puzzles: Puzzle[]): Map<string, boolean> {
  const gameIds = [...new Set(puzzles.map((p) => p.source_game_id).filter((id): id is string => !!id))];
  const rows = new Map<string, Row>();
  // chunked: SQLite caps the number of ? parameters per statement
  for (let i = 0; i < gameIds.length; i += 500) {
    const chunk = gameIds.slice(i, i + 500);
    for (const r of db.all(
      `SELECT game_id, fen_before, cp_before, cp_second FROM move_evaluations WHERE game_id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    )) rows.set(`${r.game_id}\t${r.fen_before}`, r);
  }
  const out = new Map<string, boolean>();
  for (const p of puzzles) {
    const row = rows.get(`${p.source_game_id}\t${p.fen}`) ?? { fen_before: p.fen, cp_before: 0, cp_second: null };
    out.set(p.id, isSharp(row as { cp_second: number | null; cp_before: number; fen_before: string }));
  }
  return out;
}
