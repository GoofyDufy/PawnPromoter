/**
 * The weakness stats' tables (SPEC §2, as in ~/WeaknessStats/weakstats/store.py):
 * an engine cache by (position, engine config), one row per analysed game and
 * one per ply, the §9 re-checks of showcased moves, and the training plans
 * being tracked. Created on demand, like the other modules' tables.
 */
import type { Db } from '../sqlite';
import type { Eval, WeakGameRow } from './analysis';
import { Game, type GameRow, type PositionRow, buildMoves } from './stats';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS weak_engine_cache (
    epd TEXT, config_id TEXT, score_type TEXT, score_value INTEGER,
    best_move_uci TEXT, pv_uci TEXT, depth_reached INTEGER,
    PRIMARY KEY (epd, config_id)
);
CREATE TABLE IF NOT EXISTS weak_games (
    game_id TEXT, config_id TEXT, player_colour TEXT, result REAL,
    eco_code TEXT, opening_name TEXT, eco_source TEXT,
    time_control TEXT, base_s INTEGER, increment_s INTEGER, date TEXT,
    player_rating INTEGER, opponent_rating INTEGER, opponent TEXT, termination TEXT,
    variant TEXT, clock_coverage REAL, clock_valid INTEGER, n_plies INTEGER, analysed_at TEXT,
    PRIMARY KEY (game_id, config_id)
);
CREATE INDEX IF NOT EXISTS idx_weak_games_tc ON weak_games (config_id, time_control, date);
CREATE TABLE IF NOT EXISTS weak_positions (
    game_id TEXT, config_id TEXT, ply INTEGER, fen TEXT, side_to_move TEXT, move_number INTEGER,
    move_uci TEXT, move_san TEXT, mover TEXT,
    score_type TEXT, score_value INTEGER, best_move_uci TEXT, pv_uci TEXT, depth_reached INTEGER,
    phase TEXT, clock_after_s REAL, emt_s REAL,
    cp_raw_white INTEGER, cp_cap_white INTEGER, mate_white INTEGER,
    n_legal INTEGER, is_book INTEGER, terminal TEXT,
    PRIMARY KEY (game_id, config_id, ply)
);
CREATE TABLE IF NOT EXISTS weak_verified (
    fen TEXT, move_uci TEXT, config_id TEXT, cap_after_white INTEGER,
    PRIMARY KEY (fen, move_uci, config_id)
);
CREATE TABLE IF NOT EXISTS weak_training (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT, time_control TEXT, config_id TEXT,
    focus_key TEXT, title TEXT, metric TEXT,
    baseline_value REAL, baseline_n INTEGER, baseline_games INTEGER, baseline_through TEXT,
    status TEXT DEFAULT 'active'
);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

export function cachedKeys(conn: Db, keys: string[], configId: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    for (const r of conn.all(`SELECT epd FROM weak_engine_cache WHERE config_id = ? AND epd IN (${chunk.map(() => '?').join(',')})`, [configId, ...chunk])) out.add(r.epd);
  }
  return out;
}

export function loadEvals(conn: Db, keys: string[], configId: string): Map<string, Eval> {
  const out = new Map<string, Eval>();
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    for (const r of conn.all(`SELECT * FROM weak_engine_cache WHERE config_id = ? AND epd IN (${chunk.map(() => '?').join(',')})`, [configId, ...chunk])) {
      out.set(r.epd, { score_type: r.score_type, score_value: r.score_value, best_move_uci: r.best_move_uci, pv_uci: r.pv_uci ?? '', depth_reached: r.depth_reached });
    }
  }
  return out;
}

const POS_COLS = ['game_id', 'config_id', 'ply', 'fen', 'side_to_move', 'move_number', 'move_uci', 'move_san', 'mover', 'score_type', 'score_value',
  'best_move_uci', 'pv_uci', 'depth_reached', 'phase', 'clock_after_s', 'emt_s', 'cp_raw_white', 'cp_cap_white', 'mate_white', 'n_legal', 'is_book', 'terminal'] as const;
const GAME_COLS = ['game_id', 'config_id', 'player_colour', 'result', 'eco_code', 'opening_name', 'eco_source', 'time_control', 'base_s', 'increment_s', 'date',
  'player_rating', 'opponent_rating', 'opponent', 'termination', 'variant', 'clock_coverage', 'clock_valid', 'n_plies', 'analysed_at'] as const;

/** One analysed game: its new engine results, its game row and its plies, all or nothing. */
export function saveGame(conn: Db, configId: string, game: WeakGameRow, positions: (PositionRow & { depth_reached: number | null })[],
  newEvals: Map<string, Eval>, analysedAt: string): void {
  conn.transaction(() => {
    for (const [k, e] of newEvals) {
      conn.run('INSERT OR REPLACE INTO weak_engine_cache VALUES (?,?,?,?,?,?,?)', [k, configId, e.score_type, e.score_value, e.best_move_uci, e.pv_uci, e.depth_reached]);
    }
    const g = { ...game, config_id: configId, analysed_at: analysedAt } as Record<string, unknown>;
    conn.run(`INSERT OR REPLACE INTO weak_games (${GAME_COLS.join(',')}) VALUES (${GAME_COLS.map(() => '?').join(',')})`, GAME_COLS.map((c) => (g[c] ?? null) as never));
    conn.run('DELETE FROM weak_positions WHERE game_id = ? AND config_id = ?', [game.game_id, configId]);
    for (const p of positions) {
      const r = { ...p, config_id: configId } as Record<string, unknown>;
      conn.run(`INSERT INTO weak_positions (${POS_COLS.join(',')}) VALUES (${POS_COLS.map(() => '?').join(',')})`, POS_COLS.map((c) => (r[c] ?? null) as never));
    }
  });
}

/** Exact time controls of your games (standard "base+inc" only): games, and how many are analysed. */
export function timeControls(conn: Db, configId: string): { time_control: string; games: number; analysed: number }[] {
  return conn.all(`SELECT g.time_control, COUNT(*) AS games, COUNT(w.game_id) AS analysed FROM games g
      LEFT JOIN weak_games w ON w.game_id = g.id AND w.config_id = ?
      WHERE g.time_control GLOB '[0-9]*' AND g.time_control NOT LIKE '%/%'
      GROUP BY g.time_control ORDER BY games DESC`, [configId]);
}

/** Your games in one time control not analysed at this config yet, newest first. */
export function gamesToAnalyse(conn: Db, configId: string, timeControl: string, limit: number): string[] {
  return conn.all(`SELECT g.id FROM games g WHERE g.time_control = ?
      AND NOT EXISTS (SELECT 1 FROM weak_games w WHERE w.game_id = g.id AND w.config_id = ?)
      ORDER BY g.played_at DESC LIMIT ?`, [timeControl, configId, limit]).map((r) => r.id);
}

/** The analysed games of one time control, newest first, ready for the stats. */
export function loadGames(conn: Db, configId: string, timeControl: string, window: number, after: string | null = null): Game[] {
  const rows = conn.all<GameRow>(`SELECT * FROM weak_games WHERE config_id = ? AND time_control = ? AND variant = 'standard'
      ${after ? 'AND date > ?' : ''} ORDER BY date DESC LIMIT ?`, after ? [configId, timeControl, after, window] : [configId, timeControl, window]);
  if (!rows.length) return [];
  const byGame = new Map<string, PositionRow[]>(rows.map((r) => [r.game_id, []]));
  const ids = rows.map((r) => r.game_id);
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const p of conn.all<PositionRow>(`SELECT * FROM weak_positions WHERE config_id = ? AND game_id IN (${chunk.map(() => '?').join(',')}) ORDER BY game_id, ply`, [configId, ...chunk])) {
      byGame.get(p.game_id)!.push(p);
    }
  }
  return rows.map((r) => {
    const g = new Game(r, byGame.get(r.game_id)!);
    buildMoves(g);
    return g;
  });
}

export function verified(conn: Db, configId: string): Map<string, number> {
  return new Map(conn.all('SELECT fen, move_uci, cap_after_white FROM weak_verified WHERE config_id = ?', [configId])
    .map((r) => [`${r.fen}|${r.move_uci}`, r.cap_after_white]));
}

export function saveVerified(conn: Db, configId: string, rows: [string, string, number][]): void {
  conn.transaction(() => {
    for (const [fen, uci, cap] of rows) conn.run('INSERT OR REPLACE INTO weak_verified VALUES (?,?,?,?)', [fen, uci, configId, cap]);
  });
}
