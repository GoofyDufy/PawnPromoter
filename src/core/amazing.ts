/**
 * Amazing moves (!!) and accuracy, from your saved analysis — port of
 * amazing.py, no engine run.
 *
 * A missed sacrifice is the other side of it (see missedSacrifice): Stockfish's
 * best move was a sound piece sacrifice and you played something else that
 * cost you.
 *
 * An amazing move is chess.com's idea of a "brilliant" one, by its published
 * definition: a piece sacrifice that is the best or nearly-best move, made when
 * you weren't already completely winning, that doesn't leave you in a bad
 * position. Concretely, for one of your analyzed moves:
 *  - within NEAR_BEST_CP of Stockfish's best;
 *  - you weren't already winning by WINNING_CP or more, and aren't worse than
 *    BAD_AFTER_CP afterwards;
 *  - a piece move (not a pawn or the king) that newly offers at least MIN_OFFER
 *    pawns' worth: what your opponent could now take, minus what the move itself
 *    captured, minus anything they could already take before it.
 *
 * Accuracy: Lichess's per-move formula from your winning chances before and
 * after each move, combined the way Lichess does (plain average and harmonic
 * mean, half each).
 */
import { MATE_CP, winChances } from './analyzer';
import { Board, type Color, squareRank } from './chess';
import { VALUES } from './explain';
import type { Db } from './sqlite';

export const NEAR_BEST_CP = 40;
export const WINNING_CP = 500;
export const BAD_AFTER_CP = -150;
export const MIN_OFFER = 2;
/** a missed sacrifice: Stockfish's best was a sound sacrifice (you'd not be worse after it), you
 *  weren't already winning big, and what you played instead lost at least this much winning chance */
export const MISSED_MIN_CP = -30;
export const MISSED_MIN_LOST = 0.1;

/** Field order matches the Python dataclass: rows are saved as JSON in sac_found. */
export interface Amazing {
  game_id: string;
  ply: number;
  san: string;
  offered: number;          // pawns' worth newly offered
  cp_before: number;        // your point of view, with the best move
  cp_after: number;
  fen: string;              // the position before it
  uci: string;
}

export interface Missed {
  game_id: string;
  ply: number;
  fen: string;              // the position (your move)
  best_uci: string;         // the sacrifice you missed
  best_san: string;
  played_san: string;       // what you played instead
  offered: number;
  cp_before: number;        // with the sacrifice, your point of view
  cp_after: number;         // after what you played
}

const squareName = (sq: number) => String.fromCharCode(97 + (sq % 8)) + String(Math.floor(sq / 8) + 1);

/** What the side to move could win from `me` right now (one capture, defended or not). */
function bestCapture(board: Board, me: Color): number {
  let best = 0;
  const them = board.turn;
  for (const [square, victim] of [...board.pieceMap()].sort(([a], [b]) => a - b)) {
    if (victim.color !== me || victim.role === 'king') continue;
    const value = VALUES[victim.role];
    if (value <= best) continue;                          // can't beat what's already found
    const defended = board.isAttackedBy(me, square);
    for (const attackerSq of board.attackers(them, square)) {
      const attacker = board.pieceAt(attackerSq)!;
      let uci = squareName(attackerSq) + squareName(square);
      if (attacker.role === 'pawn' && [0, 7].includes(squareRank(square))) uci += 'q';
      if (!board.isLegal(uci)) continue;
      best = Math.max(best, value - (defended ? VALUES[attacker.role] : 0));
    }
  }
  return best;
}

const toSquare = (uci: string) => uci.charCodeAt(2) - 97 + 8 * (uci.charCodeAt(3) - 49);
const fromSquare = (uci: string) => uci.charCodeAt(0) - 97 + 8 * (uci.charCodeAt(1) - 49);

/** Pawns' worth this move newly puts en prise (0 if it isn't a sacrifice). */
export function offered(board: Board, move: string): number {
  const me = board.turn;
  const piece = board.pieceAt(fromSquare(move));
  if (!piece || piece.role === 'pawn' || piece.role === 'king') return 0;
  const victim = board.isCapture(move) ? board.pieceAt(toSquare(move)) : undefined;
  const took = victim ? VALUES[victim.role] : 0;
  const before = board.copy();
  before.pushNull();                                    // what they could already take, before your move
  const already = Board.isValidFen(before.fen()) ? bestCapture(before, me) : 0;
  const after = board.copy();
  after.push(move);
  if (after.isCheckmate()) return 0;
  return Math.max(0, bestCapture(after, me) - took - already);
}

/** Pawns' worth sacrificed if this is an amazing move, else 0. */
export function isAmazing(fen: string, moveUci: string, cpBefore: number | null, cpAfter: number | null): number {
  if (cpBefore === null || cpAfter === null) return 0;
  if (cpBefore - cpAfter > NEAR_BEST_CP || cpBefore >= WINNING_CP || cpAfter <= BAD_AFTER_CP) return 0;
  const size = offered(Board.fromFen(fen), moveUci);
  return size >= MIN_OFFER ? size : 0;
}

// ---------- missed sacrifices ----------

/** Pawns' worth Stockfish's best move would have sacrificed, if you missed a
 *  sound sacrifice that mattered; else 0. */
export function missedSacrifice(fen: string, playedUci: string, bestUci: string | null, cpBefore: number | null,
  cpAfter: number | null): number {
  if (bestUci === null || bestUci === playedUci || cpBefore === null || cpAfter === null) return 0;
  if (cpBefore >= WINNING_CP || cpBefore < MISSED_MIN_CP) return 0;
  if (winChances(cpBefore) - winChances(cpAfter) < MISSED_MIN_LOST) return 0;   // your move was about as good
  const size = offered(Board.fromFen(fen), bestUci);
  return size >= MIN_OFFER ? size : 0;
}

/** Every sound sacrifice you missed in your analyzed games, newest games first (no cache). */
function findMissedDirect(conn: Db): Missed[] {
  const out: Missed[] = [];
  for (const r of conn.all(
    `SELECT e.game_id, e.ply, e.fen_before, e.move_uci, e.best_move_uci, e.cp_before, e.cp_after
     FROM move_evaluations e JOIN games g ON g.id = e.game_id
     WHERE e.cp_after IS NOT NULL AND e.best_move_uci IS NOT NULL AND e.move_uci != e.best_move_uci
       AND e.cp_before < ? AND e.cp_before >= ?
     ORDER BY g.played_at DESC, e.ply`, [WINNING_CP, MISSED_MIN_CP])) {
    const size = missedSacrifice(r.fen_before, r.move_uci, r.best_move_uci, r.cp_before, r.cp_after);
    if (size) {
      const board = Board.fromFen(r.fen_before);
      out.push({ game_id: r.game_id, ply: r.ply, fen: r.fen_before, best_uci: r.best_move_uci,
        best_san: board.san(r.best_move_uci), played_san: board.san(r.move_uci), offered: size,
        cp_before: r.cp_before, cp_after: r.cp_after });
    }
  }
  return out;
}

// ---------- saved results (a game's analysis never changes: each game is searched once) ----------

export const CACHE_VERSION = 1;       // bump when the rules above change: every game is searched again

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sac_scanned (
    game_id TEXT PRIMARY KEY,
    version INTEGER,
    evals INTEGER              -- how many analyzed moves it had (re-analyzed: searched again)
);
CREATE TABLE IF NOT EXISTS sac_found (
    game_id TEXT,
    ply INTEGER,
    kind TEXT,                 -- "amazing" / "missed"
    data TEXT                  -- the Amazing / Missed, as JSON
);
CREATE INDEX IF NOT EXISTS idx_sac_found_game ON sac_found (game_id);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

function toScan(conn: Db): string[] {
  const done = new Map(conn.all('SELECT game_id, evals FROM sac_scanned WHERE version = ?', [CACHE_VERSION])
    .map((r) => [r.game_id, r.evals]));
  return conn.all('SELECT game_id, COUNT(*) AS n FROM move_evaluations GROUP BY game_id')
    .filter((r) => done.get(r.game_id) !== r.n).map((r) => r.game_id);
}

/** Search these games and save what's found. */
export function scan(conn: Db, gameIds: string[]): void {
  for (let i = 0; i < gameIds.length; i += 200) {
    const chunk = gameIds.slice(i, i + 200);
    const marks = chunk.map(() => '?').join(',');
    const found: [string, number, string, string][] = [];
    const counts = new Map<string, number>();
    for (const r of conn.all(
      `SELECT game_id, ply, fen_before, move_uci, best_move_uci, cp_before, cp_after
       FROM move_evaluations WHERE game_id IN (${marks})`, chunk)) {
      counts.set(r.game_id, (counts.get(r.game_id) ?? 0) + 1);
      if (r.cp_after === null) continue;
      let size = isAmazing(r.fen_before, r.move_uci, r.cp_before, r.cp_after);
      if (size) {
        const a: Amazing = { game_id: r.game_id, ply: r.ply, san: Board.fromFen(r.fen_before).san(r.move_uci),
          offered: size, cp_before: r.cp_before, cp_after: r.cp_after, fen: r.fen_before, uci: r.move_uci };
        found.push([r.game_id, r.ply, 'amazing', JSON.stringify(a)]);
      }
      size = missedSacrifice(r.fen_before, r.move_uci, r.best_move_uci, r.cp_before, r.cp_after);
      if (size) {
        const board = Board.fromFen(r.fen_before);
        const m: Missed = { game_id: r.game_id, ply: r.ply, fen: r.fen_before, best_uci: r.best_move_uci,
          best_san: board.san(r.best_move_uci), played_san: board.san(r.move_uci), offered: size,
          cp_before: r.cp_before, cp_after: r.cp_after };
        found.push([r.game_id, r.ply, 'missed', JSON.stringify(m)]);
      }
    }
    conn.transaction(() => {
      conn.run(`DELETE FROM sac_found WHERE game_id IN (${marks})`, chunk);
      for (const f of found) conn.run('INSERT INTO sac_found (game_id, ply, kind, data) VALUES (?, ?, ?, ?)', f);
      for (const g of chunk) {
        conn.run('INSERT OR REPLACE INTO sac_scanned (game_id, version, evals) VALUES (?, ?, ?)',
          [g, CACHE_VERSION, counts.get(g) ?? 0]);
      }
    });
  }
}

function cached<T>(conn: Db, kind: string): T[] {
  scan(conn, toScan(conn));                       // only games not searched yet (or re-analyzed)
  return conn.all(
    `SELECT f.data FROM sac_found f JOIN games g ON g.id = f.game_id WHERE f.kind = ?
     ORDER BY g.played_at DESC, f.ply`, [kind]).map((r) => JSON.parse(r.data) as T);
}

/** Every amazing move in your analyzed games, newest games first — from the
 *  saved search (new games are searched first). */
export function findAll(conn: Db): Amazing[] {
  return cached<Amazing>(conn, 'amazing');
}

/** Every sound sacrifice you missed, newest games first (see findAll).
 *  cachedResults=false: search directly, saving nothing (the one-off puzzle backfill). */
export function findMissed(conn: Db, cachedResults = true): Missed[] {
  return cachedResults ? cached<Missed>(conn, 'missed') : findMissedDirect(conn);
}

// ---------- accuracy ----------

/** Lichess's formula: 100 = you kept all your winning chances. */
export function moveAccuracy(cpBefore: number, cpAfter: number): number {
  const wpBefore = 50 + 50 * winChances(Math.max(-MATE_CP, Math.min(MATE_CP, cpBefore)));
  const wpAfter = 50 + 50 * winChances(Math.max(-MATE_CP, Math.min(MATE_CP, cpAfter)));
  const acc = 103.1668100711649 * Math.exp(-0.04354415386753951 * Math.max(0.0, wpBefore - wpAfter)) - 3.166924740191411;
  return Math.max(0.0, Math.min(100.0, acc));
}

/** Your accuracy in one game, the way Lichess combines its moves: half the
 *  plain average, half the harmonic mean (which a blunder drags down hard). */
export function gameAccuracy(evals: Iterable<{ cp_before: number; cp_after: number | null }>): number | null {
  const accs = [...evals].filter((e) => e.cp_after !== null).map((e) => moveAccuracy(e.cp_before, e.cp_after!));
  if (!accs.length) return null;
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  const harmonic = accs.length / accs.reduce((s, a) => s + 1 / Math.max(a, 1.0), 0);
  return (mean + harmonic) / 2;
}

