/**
 * How you've done in each named opening line (the opening library), from your
 * whole game history — port of my_lines.py (Opening Drill → Add lines →
 * Opening library).
 *
 * Each game gets the deepest named line it reached (matched by position, so
 * transpositions count — the way Lichess names a game's opening), saved in
 * game_lines so only new games are matched later. Per line and colour: your
 * results, and from your analyzed games how accurately you played the opening
 * (average pawns lost per move over your first OPENING_PLIES/2 moves),
 * blunders there, and the evaluation when the opening is over.
 *
 * "Played well" ranks by a score that doesn't over-trust a handful of games
 * (your points shrunk toward 50% by PRIOR_GAMES), then accuracy.
 */
import { MATE_CP } from './analyzer';
import { Board } from './chess';
import { pyFixed, pyPercent, pySigned } from './format';
import { openingMoves, positionKey } from './repertoireGaps';
import type { Db } from './sqlite';
import { Record } from './stats';

export const MAX_PLY = 30;            // how deep a game is matched against the library
export const OPENING_PLIES = 30;      // the opening, for accuracy and "coming out of it": your first 15 moves
export const BLUNDER_CP = 300;
export const PRIOR_GAMES = 5;
export const MIN_GAMES = 3;           // fewer: shown, but not ranked
export const VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS game_lines (
    game_id TEXT PRIMARY KEY,
    library_id INTEGER,       -- NULL: no named line reached
    plies INTEGER,
    version INTEGER
);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

export class LineRecord {
  record = new Record();
  game_ids: string[] = [];
  loss_sum = 0;          // centipawns lost over your opening moves (analyzed games)
  loss_moves = 0;
  blunders = 0;
  eval_sum = 0;          // evaluation when the opening's over (analyzed games)
  eval_games = 0;

  constructor(readonly library_id: number, readonly color: string) {}

  get games(): number {
    return this.record.games;
  }

  get avg_loss(): number | null {
    return this.loss_moves ? this.loss_sum / this.loss_moves / 100 : null;
  }

  get eval_out(): number | null {
    return this.eval_games ? this.eval_sum / this.eval_games / 100 : null;
  }

  /** Your score, shrunk toward 50% for few games. */
  get rating(): number {
    const r = this.record;
    return (r.wins + 0.5 * r.draws + 0.5 * PRIOR_GAMES) / (r.games + PRIOR_GAMES);
  }
}

// ---------- matching ----------

/** position -> [library id, plies], the shortest named line for each position. */
export function libraryPositions(conn: Db): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const r of conn.all('SELECT id, ucis, plies FROM opening_library ORDER BY plies, id')) {
    const board = Board.fromFen();
    for (const uci of r.ucis.split(/\s+/).filter(Boolean)) board.push(uci);
    const key = positionKey(board.fen());
    if (!out.has(key)) out.set(key, [r.id, r.plies]);
  }
  return out;
}

export function matchGame(pgn: string, positions: Map<string, [number, number]>): [number | null, number] {
  const board = Board.fromFen();
  let best: [number | null, number] = [null, 0];
  for (const [i, san] of openingMoves(pgn, MAX_PLY).entries()) {
    const uci = board.parseSan(san);
    if (!uci) break;
    board.push(uci);
    const hit = positions.get(positionKey(board.fen()));
    if (hit) best = [hit[0], i + 1];
  }
  return best;
}

/** [game id, library id, plies] for these games (the desktop runs this on a background thread). */
export function matchAll(conn: Db, gameIds: string[]): [string, number | null, number][] {
  const positions = libraryPositions(conn);
  const out: [string, number | null, number][] = [];
  for (let i = 0; i < gameIds.length; i += 500) {
    const chunk = gameIds.slice(i, i + 500);
    for (const r of conn.all(`SELECT id, pgn FROM games WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)) {
      const [lid, plies] = matchGame(r.pgn, positions);
      out.push([r.id, lid, plies]);
    }
  }
  return out;
}

export function unmatched(conn: Db): string[] {
  return conn.all('SELECT g.id FROM games g LEFT JOIN game_lines l ON l.game_id = g.id AND l.version = ? WHERE l.game_id IS NULL',
    [VERSION]).map((r) => r.id);
}

export function save(conn: Db, rows: [string, number | null, number][]): void {
  conn.transaction(() => {
    for (const [g, l, p] of rows) {
      conn.run('INSERT OR REPLACE INTO game_lines (game_id, library_id, plies, version) VALUES (?, ?, ?, ?)', [g, l, p, VERSION]);
    }
  });
}

// ---------- your record per line ----------

/** "libraryId\tcolor" -> record. */
export function records(conn: Db): Map<string, LineRecord> {
  const out = new Map<string, LineRecord>();
  const owner = new Map<string, LineRecord>();
  for (const r of conn.all('SELECT l.game_id, l.library_id, g.my_color, g.result FROM game_lines l '
    + 'JOIN games g ON g.id = l.game_id WHERE l.library_id IS NOT NULL')) {
    const key = `${r.library_id}\t${r.my_color}`;
    if (!out.has(key)) out.set(key, new LineRecord(r.library_id, r.my_color));
    const rec = out.get(key)!;
    rec.record.add(r.result);
    rec.game_ids.push(r.game_id);
    owner.set(r.game_id, rec);
  }
  // the opening, from the saved analysis: your moves (only those are evaluated)
  const lastEval = new Map<string, number>();
  for (const r of conn.all('SELECT game_id, ply, cp_before, cp_after FROM move_evaluations WHERE ply < ? ORDER BY game_id, ply',
    [OPENING_PLIES])) {
    const rec = owner.get(r.game_id);
    if (!rec || r.cp_after === null) continue;
    const loss = Math.max(0, Math.min(r.cp_before, MATE_CP) - Math.max(r.cp_after, -MATE_CP));
    rec.loss_sum += Math.min(loss, 1000);           // one hung queen shouldn't swamp the average
    rec.loss_moves += 1;
    rec.blunders += loss >= BLUNDER_CP ? 1 : 0;
    lastEval.set(r.game_id, Math.max(-1000, Math.min(1000, r.cp_after)));
  }
  for (const [gid, cp] of lastEval) {
    owner.get(gid)!.eval_sum += cp;
    owner.get(gid)!.eval_games += 1;
  }
  return out;
}

export function byLibraryId(recs: Map<string, LineRecord>): Map<number, LineRecord[]> {
  const out = new Map<number, LineRecord[]>();
  for (const rec of recs.values()) {
    if (!out.has(rec.library_id)) out.set(rec.library_id, []);
    out.get(rec.library_id)!.push(rec);
  }
  for (const list of out.values()) list.sort((a, b) => b.games - a.games);
  return out;
}

export function describe(rec: LineRecord): string {
  const r = rec.record;
  const parts = [`As ${rec.color}: ${rec.games} game${rec.games !== 1 ? 's' : ''}, `
    + `${pyPercent(r.score)} (${r.wins}W ${r.draws}D ${r.losses}L)`];
  if (rec.avg_loss !== null) parts.push(`opening accuracy: ${pyFixed(rec.avg_loss, 2)} pawns lost per move`);
  if (rec.blunders) parts.push(`${rec.blunders} opening blunder${rec.blunders !== 1 ? 's' : ''}`);
  if (rec.eval_out !== null) parts.push(`you come out of the opening at ${pySigned(rec.eval_out, 1)} on average`.replaceAll('-', '−'));
  return parts.join(' · ');
}
