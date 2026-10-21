/**
 * The weakness stats' engine pass — port of ~/WeaknessStats/weakstats/pipeline.py,
 * with the web's faster engine setting (CONFIG below):
 *
 *   1. parseGame()        — a game → one row per ply (SPEC §2), no engine fields;
 *   2. toSearch()         — the positions that need Stockfish: not terminal,
 *                           not cached, and not deep inside the opening book
 *                           (both this position and the next are book
 *                           positions: no stat reads their evaluation);
 *   3. searchGame()       — searches them in game order on one engine, its
 *                           hash kept within the game (cleared per game);
 *   4. fillEvaluations()  — stored scores → White-POV derived values (§3.2).
 *
 * Kept apart from analyzer.ts (puzzles): different positions, depth and storage.
 */
import { parseComment } from 'chessops/pgn';
import { Board } from '../chess';
import type { Engine } from '../engine';
import type { Game } from '../models';
import { readGame } from '../pgn';
import { type Book, epd } from './book';
import * as ec from './evalcore';
import type { GameRow, PositionRow } from './stats';

/** The one engine setting every web-analysed game uses (SPEC §1). Changing any
 *  of it means a new id and re-analysing the corpus — never mix them. */
export const CONFIG = {
  engine: 'Stockfish 19 lite (WASM, single thread)',
  limit: 'depth 14',
  depth: 14,
  threads: 1,
  hash_mb: 16,
  hash: 'kept within a game, cleared between games',
  book_positions: 'not searched when the next position is also book',
  spec_version: '1.2-draft',
} as const;
export const CONFIG_ID = 'sf19lite-d14-g1';

export interface Eval {
  score_type: 'cp' | 'mate';
  score_value: number;
  best_move_uci: string | null;
  pv_uci: string;                // first 6 plies
  depth_reached: number;
}

/** A position row before evaluation (key = the EPD used as the cache key). */
export type Draft = Omit<PositionRow, 'score_type' | 'score_value' | 'best_move_uci' | 'pv_uci' | 'cp_raw_white' | 'cp_cap_white' | 'mate_white'>
  & { key: string; in_book: boolean };

export interface WeakGameRow extends GameRow {
  player_rating: number | null;
  opponent_rating: number | null;
  opponent: string;
  termination: string;
  variant: string;
  n_plies: number;
}

const toInt = (x: string | undefined): number | null => (x && /^\d+$/.test(x) ? parseInt(x, 10) : null);

function terminalOf(board: Board): string | null {
  if (board.isCheckmate()) return 'checkmate';
  if (board.isStalemate()) return 'stalemate';
  if (board.isInsufficientMaterial()) return 'insufficient';
  return null;
}

/** v1.2 F3: [%clk] includes the increment; elapsed must never be negative. */
export function clockValid(rows: Draft[], baseS: number, incS: number): boolean {
  const last: Record<string, number> = { white: baseS, black: baseS };
  for (const row of rows.slice(0, -1)) {
    const c = row.clock_after_s;
    if (c == null) continue;
    if (last[row.side_to_move] - c + incS < -0.2) return false;
    last[row.side_to_move] = c;
  }
  return true;
}

/** game → [game row, position drafts], or null when it can't be used (not
 *  standard chess from the normal start, no result, no time control). */
export function parseGame(game: Game, book: Book): [WeakGameRow, Draft[]] | null {
  const parsed = readGame(game.pgn);
  if (!parsed) return null;
  const h = parsed.headers;
  // v1.2 F4: standard chess from the normal start only
  if (!['standard', ''].includes((h.get('Variant') ?? 'Standard').toLowerCase()) || h.get('SetUp') === '1' || parsed.chess960) return null;
  const tc = game.time_control ?? '';
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
  if (!m) return null;
  const [baseS, incS] = [parseInt(m[1], 10), parseInt(m[2] ?? '0', 10)];
  const colour = game.my_color;
  const clocks: (number | null)[] = [];
  const emts: (number | null)[] = [];
  for (const node of parsed.raw.moves.mainline()) {
    let clock: number | null = null;
    let emt: number | null = null;
    for (const c of node.comments ?? []) {
      const shape = parseComment(c);
      if (shape.clock !== undefined) clock = shape.clock;
      if (shape.emt !== undefined) emt = shape.emt;
    }
    clocks.push(clock);
    emts.push(emt);
  }
  const board = Board.fromFen();
  const drafts: Draft[] = [];
  const n = parsed.mainline.length;
  for (let p = 0; p <= n; p++) {
    const white = board.turn === 'white';
    const letters = [...board.pieceMap().values()].map((pc) => ({ pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' }[pc.role]));
    const key = epd(board.fen());
    const inBook = book.isBook(key);
    const row: Draft = {
      game_id: game.id, ply: p, fen: board.fen(), key, in_book: inBook, side_to_move: white ? 'white' : 'black',
      move_number: board.fullmoveNumber, move_uci: null, move_san: null, mover: null,
      phase: ec.phase(board.fullmoveNumber, ec.phaseWeight(letters), letters.includes('q'), inBook),
      clock_after_s: null, emt_s: null, n_legal: board.legalMoves().length, is_book: 0, terminal: terminalOf(board),
    };
    if (p < n) {
      const uci = parsed.mainline[p];
      row.move_uci = uci;
      row.move_san = board.san(uci);
      row.mover = row.side_to_move === colour ? 'player' : 'opponent';
      row.clock_after_s = clocks[p];
      row.emt_s = emts[p];
      board.push(uci);
      row.is_book = book.isBook(epd(board.fen())) ? 1 : 0;      // v1.2 F2: book if the move lands in book
    }
    drafts.push(row);
  }
  const moves = drafts.slice(0, -1);
  const withClock = moves.filter((r) => r.clock_after_s != null).length;
  const opening = book.opening(drafts.map((d) => d.key), h.get('ECO') ?? '', '');
  const isWhite = colour === 'white';
  const result = game.result === 'win' ? 1 : game.result === 'draw' ? 0.5 : 0;
  const row: WeakGameRow = {
    game_id: game.id, player_colour: colour, result, eco_code: opening.eco, opening_name: opening.name, eco_source: opening.source,
    time_control: tc, base_s: baseS, increment_s: incS, date: game.played_at,
    clock_coverage: moves.length ? withClock / moves.length : 0, clock_valid: clockValid(drafts, baseS, incS) ? 1 : 0,
    player_rating: toInt(h.get(isWhite ? 'WhiteElo' : 'BlackElo')), opponent_rating: toInt(h.get(isWhite ? 'BlackElo' : 'WhiteElo')),
    opponent: game.opponent_username, termination: h.get('Termination') ?? '', variant: 'standard', n_plies: n,
  };
  return [row, drafts];
}

/** Whether a position's evaluation is ever read (see the file comment). */
export function needsEval(drafts: Draft[], p: number): boolean {
  const d = drafts[p];
  if (d.terminal) return false;
  const next = drafts[p + 1];
  return !(d.in_book && (next ? next.in_book : true));
}

/** The keys to search, in game order, skipping cached ones. */
export function toSearch(drafts: Draft[], cached: Set<string>): string[] {
  const out: string[] = [];
  for (let p = 0; p < drafts.length; p++) {
    const k = drafts[p].key;
    if (needsEval(drafts, p) && !cached.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

export class AnalysisStopped extends Error {}

/** One engine, one game: a fresh hash, then each key in game order. */
export async function searchGame(engine: Engine & { newGame?: () => Promise<void> }, keys: string[],
  onPosition?: () => void, shouldStop?: () => boolean): Promise<Map<string, Eval>> {
  await engine.newGame?.();
  const out = new Map<string, Eval>();
  for (const key of keys) {
    if (shouldStop?.()) throw new AnalysisStopped();
    const [info] = await engine.analyse(Board.fromFen(`${key} 0 1`), { depth: CONFIG.depth });
    const rel = info.score.relative;
    const pv = info.pv.slice(0, 6);
    out.set(key, {
      score_type: rel.isMate() ? 'mate' : 'cp',
      score_value: rel.isMate() ? rel.mate()! : rel.score()!,
      best_move_uci: pv[0] ?? null, pv_uci: pv.join(' '), depth_reached: info.depth ?? CONFIG.depth,
    });
    onPosition?.();
  }
  return out;
}

/** Drafts + evaluations → stored position rows (null evaluation where none is needed). */
export function fillEvaluations(drafts: Draft[], evals: Map<string, Eval>): (PositionRow & { depth_reached: number | null })[] {
  return drafts.map((d, p) => {
    const { key, in_book: _inBook, ...rest } = d;
    void _inBook;
    const wtm = d.side_to_move === 'white';
    let st: 'cp' | 'mate' | null = null;
    let sv: number | null = null;
    let best: string | null = null;
    let pv: string | null = null;
    let depth: number | null = null;
    if (d.terminal === 'checkmate') [st, sv] = ['mate', 0];
    else if (d.terminal) [st, sv] = ['cp', 0];
    else if (needsEval(drafts, p) || evals.has(key)) {
      const e = evals.get(key);
      if (!e) throw new Error(`no evaluation for ${key}`);
      [st, sv, best, pv, depth] = [e.score_type, e.score_value, e.best_move_uci, e.pv_uci, e.depth_reached];
    }
    const [raw, cap, mw] = st === null ? [null, null, null] : ec.derive(st, sv!, wtm, d.terminal === 'checkmate');
    return { ...rest, score_type: st, score_value: sv, best_move_uci: best, pv_uci: pv, depth_reached: depth,
      cp_raw_white: raw, cp_cap_white: cap, mate_white: mw };
  });
}
