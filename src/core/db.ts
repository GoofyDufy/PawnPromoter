/**
 * SQLite storage for games, puzzles, and review state — port of db.py.
 * The schema and every query are the prototype's, unchanged, so a
 * chessprep.db from the desktop app opens here as-is (and vice versa).
 */
import { EVAL_VERSION } from './analyzer';
import * as gameNotes from './gameNotes';
import * as amazing from './amazing';
import * as lichessPuzzles from './lichessPuzzles';
import * as myLines from './myLines';
import * as openingCommentary from './openingCommentary';
import * as openingLibrary from './openingLibrary';
import * as practical from './practical';
import * as sac from './sac';
import * as threat from './threat';
import { STARTING_FEN } from './chess';
import {
  type Game, type MoveEvaluation, type OpeningLine, type Puzzle, ReviewState, inTimeFilter,
} from './models';
import * as puzzleTags from './puzzleTags';
import type { Db, Row } from './sqlite';
import { dateIso, fromIso, nowIso, todayIso, weekStart } from './time';

export { STARTING_FEN };

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    chess_com_url TEXT UNIQUE,
    pgn TEXT,
    played_at TEXT,
    time_control TEXT,
    my_color TEXT,
    opponent_username TEXT,
    result TEXT,
    is_analyzed INTEGER DEFAULT 0,
    analyzed_at TEXT,
    evaluated_at TEXT
);

-- raw Stockfish output for every one of your moves, cached permanently
-- so no game is ever sent through the engine twice (see analyzer.ts)
CREATE TABLE IF NOT EXISTS move_evaluations (
    game_id TEXT,
    ply INTEGER,
    fen_before TEXT,
    move_uci TEXT,
    best_move_uci TEXT,
    cp_before INTEGER,
    cp_after INTEGER,
    depth INTEGER,
    second_move_uci TEXT,
    cp_second INTEGER,
    third_move_uci TEXT,
    cp_third INTEGER,
    PRIMARY KEY (game_id, ply)
);

CREATE TABLE IF NOT EXISTS puzzles (
    id TEXT PRIMARY KEY,
    fen TEXT,
    correct_move_san TEXT,
    correct_move_uci TEXT,
    source TEXT,
    played_move_san TEXT,
    eval_swing_cp INTEGER,
    eval_before_cp INTEGER,
    eval_after_cp INTEGER,
    puzzle_type TEXT,
    source_game_id TEXT,
    opening_line_id TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS opening_lines (
    id TEXT PRIMARY KEY,
    move_san TEXT,
    move_uci TEXT,
    fen_after_move TEXT,
    repertoire_name TEXT,
    my_color TEXT,
    move_number INTEGER,
    parent_id TEXT,
    is_line_end INTEGER DEFAULT 0,
    line_name TEXT,
    is_enabled INTEGER DEFAULT 1,
    fen_before_move TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS review_state (
    puzzle_id TEXT PRIMARY KEY,
    ease_factor REAL,
    interval_days INTEGER,
    repetitions INTEGER,
    due_date TEXT,
    last_reviewed_at TEXT,
    consecutive_correct INTEGER,
    consecutive_wrong INTEGER
);

-- every puzzle / opening-line attempt: drives "Weak spots" practice and
-- the Progress dashboard. item_type 'puzzle' (item_id = puzzle id) or
-- 'line' (item_id = the drilled line's root id); correct = first try right.
-- outcome: 'correct' / 'near_best' (engine's 2nd/3rd choice or close to it) /
-- 'missed' / 'revealed' (Show answer without trying); NULL on older rows.
-- sharp: 1 if the puzzle had one clearly best move when tried (XP bonus).
CREATE TABLE IF NOT EXISTS attempts (
    item_type TEXT,
    item_id TEXT,
    correct INTEGER,
    attempted_at TEXT,
    outcome TEXT,
    sharp INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempts_item ON attempts (item_type, item_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Spot the Tactic rounds: was there a tactic, what you answered, and
-- whether your move afterwards was good (see spot.ts)
CREATE TABLE IF NOT EXISTS spot_attempts (
    fen TEXT,
    is_tactic INTEGER,
    reason TEXT,
    said_tactic INTEGER,
    move_ok INTEGER,
    attempted_at TEXT
);

-- Lichess Opening Explorer answers, so each position is downloaded once
-- (key = rating bands | speeds | position without move counters)
CREATE TABLE IF NOT EXISTS explorer_cache (
    key TEXT PRIMARY KEY,
    data TEXT,
    fetched_at TEXT
);
`;

export function getSetting(db: Db, key: string): string | null {
  const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

/** get_connection(): prepares an opened database (creates tables, migrates
 *  older files). Opening the file itself is the platform's job (OPFS in the
 *  browser, memory in tests). */
export function initDb(db: Db): Db {
  // one transaction: in browser storage every commit is a disk flush, and
  // ~60 separate schema statements took ~18 s on a new database
  db.transaction(() => initSchema(db));
  return db;
}

function initSchema(db: Db): void {
  db.exec(SCHEMA);
  lichessPuzzles.ensureSchema(db);       // its own table, kept apart from your games' puzzles
  puzzleTags.ensureSchema(db);           // tags you add to puzzles
  threat.ensureSchema(db);               // What's the threat? rounds
  openingCommentary.ensureSchema(db);    // why your opening deviations are worse (cached)
  practical.ensureSchema(db);            // what works at your level, per position (cached)
  openingLibrary.ensureSchema(db);       // every named opening (Lichess's dataset)
  myLines.ensureSchema(db);              // your games, matched to the library's named lines
  amazing.ensureSchema(db);              // amazing moves / missed sacrifices, searched once per game
  sac.ensureSchema(db);                  // Sacrifice!! rounds (Tactics & Threats)
  gameNotes.ensureSchema(db);            // your notes on positions (a web-app addition)
  migrate(db);
}

const columns = (db: Db, table: string) => new Set(db.all(`PRAGMA table_info(${table})`).map((r) => r.name));

/** Adds columns introduced after someone's chessprep.db already existed. */
function migrate(db: Db): void {
  const gameCols = columns(db, 'games');
  if (!gameCols.has('evaluated_at')) {
    // NULL for every existing game: games analyzed before the cache
    // existed keep their puzzles, but have no cached evaluations yet
    db.run('ALTER TABLE games ADD COLUMN evaluated_at TEXT');
  }
  if (!gameCols.has('eval_version')) {
    // games cached before versioning existed are version 1 (best move only)
    db.run('ALTER TABLE games ADD COLUMN eval_version INTEGER');
    db.run('UPDATE games SET eval_version = 1 WHERE evaluated_at IS NOT NULL');
  }
  const evalCols = columns(db, 'move_evaluations');
  for (const [col, type] of [['second_move_uci', 'TEXT'], ['cp_second', 'INTEGER'],
    ['third_move_uci', 'TEXT'], ['cp_third', 'INTEGER']]) {
    if (!evalCols.has(col)) db.run(`ALTER TABLE move_evaluations ADD COLUMN ${col} ${type}`);
  }
  const attemptCols = columns(db, 'attempts');
  if (!attemptCols.has('outcome')) db.run('ALTER TABLE attempts ADD COLUMN outcome TEXT');
  if (!attemptCols.has('sharp')) db.run('ALTER TABLE attempts ADD COLUMN sharp INTEGER');
  const puzzleCols = columns(db, 'puzzles');
  if (!puzzleCols.has('eval_before_cp')) db.run('ALTER TABLE puzzles ADD COLUMN eval_before_cp INTEGER');
  if (!puzzleCols.has('eval_after_cp')) db.run('ALTER TABLE puzzles ADD COLUMN eval_after_cp INTEGER');
  const gameCols2 = columns(db, 'games');
  for (const col of ['my_accuracy', 'opp_accuracy']) {         // chess.com's accuracy, when reviewed there
    if (!gameCols2.has(col)) db.run(`ALTER TABLE games ADD COLUMN ${col} REAL`);
  }
  if (!puzzleCols.has('puzzle_type')) db.run('ALTER TABLE puzzles ADD COLUMN puzzle_type TEXT');
  // what kind of puzzle (puzzleKind.ts): its solution, how many of your moves, attacking/defensive/positional
  for (const [col, type] of [['solution_ucis', 'TEXT'], ['solution_moves', 'INTEGER'], ['kind', 'TEXT']]) {
    if (!puzzleCols.has(col)) db.run(`ALTER TABLE puzzles ADD COLUMN ${col} ${type}`);
  }
  // renamed: "Hanging Piece" means winning a loose piece on Lichess; ours is leaving one
  db.run("UPDATE puzzles SET puzzle_type = 'Left Hanging' WHERE puzzle_type = 'Hanging Piece'");
  const openingCols = columns(db, 'opening_lines');
  if (!openingCols.has('line_name')) db.run('ALTER TABLE opening_lines ADD COLUMN line_name TEXT');
  if (!openingCols.has('is_enabled')) db.run('ALTER TABLE opening_lines ADD COLUMN is_enabled INTEGER DEFAULT 1');
  if (!openingCols.has('fen_before_move')) {
    db.run('ALTER TABLE opening_lines ADD COLUMN fen_before_move TEXT');
    // backfill: a node's fen_before_move is its parent's fen_after_move
    // (or the starting position for root nodes)
    db.run(`UPDATE opening_lines
            SET fen_before_move = (
                SELECT parent.fen_after_move FROM opening_lines AS parent
                WHERE parent.id = opening_lines.parent_id
            )
            WHERE fen_before_move IS NULL AND parent_id IS NOT NULL`);
    db.run(`UPDATE opening_lines SET fen_before_move = ?
            WHERE fen_before_move IS NULL AND parent_id IS NULL`, [STARTING_FEN]);
  }
}

// ---------- Games ----------

export function saveGame(db: Db, game: Game): void {
  db.run(
    `INSERT OR REPLACE INTO games
       (id, chess_com_url, pgn, played_at, time_control, my_color,
        opponent_username, result, is_analyzed, analyzed_at, my_accuracy, opp_accuracy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [game.id, game.chess_com_url, game.pgn, game.played_at, game.time_control, game.my_color,
      game.opponent_username, game.result, game.is_analyzed ? 1 : 0, game.analyzed_at,
      game.my_accuracy ?? null, game.opp_accuracy ?? null],
  );
}

/** chess.com's accuracy for a game you already have (it may be reviewed after you imported it). */
export function updateAccuracy(db: Db, chessComUrl: string, mine: number | null, theirs: number | null): void {
  if (mine === null && theirs === null) return;
  db.run('UPDATE games SET my_accuracy = ?, opp_accuracy = ? WHERE chess_com_url = ?', [mine, theirs, chessComUrl]);
}

export function gameExists(db: Db, chessComUrl: string): boolean {
  return db.get('SELECT 1 FROM games WHERE chess_com_url = ?', [chessComUrl]) !== undefined;
}

/** Games with no cached Stockfish evaluations, newest first, optionally
 *  limited to some time classes. Never-analyzed games come before ones
 *  analyzed under the old (pre-cache) system, since those already have puzzles. */
export function gamesNeedingEvaluation(db: Db, limit: number, timeClasses: Set<string> | null = null): Game[] {
  // also re-queues games cached under an older EVAL_VERSION
  const rows = db.all(
    `SELECT * FROM games
       WHERE evaluated_at IS NULL OR COALESCE(eval_version, 1) < ?
       ORDER BY is_analyzed ASC, played_at DESC`,
    [EVAL_VERSION],
  );
  return rows.filter((r) => inTimeFilter(r.time_control, timeClasses)).slice(0, limit).map(rowToGame);
}

/** Counts for the games summary line in the Puzzle Review tab.
 *  cached = saved at the current EVAL_VERSION; legacy = analyzed but needing a
 *  one-time re-analysis; uncached = the subset of legacy with no saved data. */
export function gameStats(db: Db, timeClasses: Set<string> | null = null) {
  const counts = { total: 0, cached: 0, legacy: 0, new: 0, uncached: 0 };
  for (const r of db.all('SELECT time_control, is_analyzed, evaluated_at, eval_version FROM games')) {
    if (!inTimeFilter(r.time_control, timeClasses)) continue;
    counts.total += 1;
    if (r.evaluated_at !== null && (r.eval_version || 1) >= EVAL_VERSION) {
      counts.cached += 1;
    } else if (r.is_analyzed) {
      counts.legacy += 1;
      counts.uncached += r.evaluated_at === null ? 1 : 0;
    } else {
      counts.new += 1;
    }
  }
  return counts;
}

export function rowToGame(r: Row): Game {
  return {
    id: r.id, chess_com_url: r.chess_com_url, pgn: r.pgn, played_at: r.played_at,
    time_control: r.time_control, my_color: r.my_color, opponent_username: r.opponent_username,
    result: r.result, is_analyzed: !!r.is_analyzed, analyzed_at: r.analyzed_at || null,
    my_accuracy: r.my_accuracy ?? null, opp_accuracy: r.opp_accuracy ?? null,
  };
}

export function getGame(db: Db, gameId: string): Game | null {
  const row = db.get('SELECT * FROM games WHERE id = ?', [gameId]);
  return row ? rowToGame(row) : null;
}

// ---------- Move evaluations (Stockfish cache) ----------

/** Stores one game's engine output and marks it evaluated, in a single
 *  transaction — a game is either fully cached or not at all. */
export function saveGameEvaluations(db: Db, gameId: string, evaluations: MoveEvaluation[]): void {
  const now = nowIso();
  db.transaction(() => {
    db.run('DELETE FROM move_evaluations WHERE game_id = ?', [gameId]);
    for (const e of evaluations) {
      db.run(
        `INSERT INTO move_evaluations
           (game_id, ply, fen_before, move_uci, best_move_uci,
            cp_before, cp_after, depth, second_move_uci, cp_second,
            third_move_uci, cp_third)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [e.game_id, e.ply, e.fen_before, e.move_uci, e.best_move_uci, e.cp_before, e.cp_after, e.depth,
          e.second_move_uci, e.cp_second, e.third_move_uci, e.cp_third],
      );
    }
    db.run(
      `UPDATE games SET evaluated_at = ?, eval_version = ?, is_analyzed = 1,
         analyzed_at = ? WHERE id = ?`,
      [now, EVAL_VERSION, now, gameId],
    );
  });
}

export function rowToEvaluation(r: Row): MoveEvaluation {
  return {
    game_id: r.game_id, ply: r.ply, fen_before: r.fen_before, move_uci: r.move_uci,
    best_move_uci: r.best_move_uci, cp_before: r.cp_before, cp_after: r.cp_after, depth: r.depth,
    second_move_uci: r.second_move_uci ?? null, cp_second: r.cp_second ?? null,
    third_move_uci: r.third_move_uci ?? null, cp_third: r.cp_third ?? null,
  };
}

export function allEvaluationsByGame(db: Db): Map<string, MoveEvaluation[]> {
  const byGame = new Map<string, MoveEvaluation[]>();
  for (const r of db.all('SELECT * FROM move_evaluations ORDER BY game_id, ply')) {
    let list = byGame.get(r.game_id);
    if (!list) byGame.set(r.game_id, (list = []));
    list.push(rowToEvaluation(r));
  }
  return byGame;
}

// ---------- Puzzles ----------

export function insertPuzzle(db: Db, p: Puzzle): void {
  db.run(
    `INSERT OR REPLACE INTO puzzles
       (id, fen, correct_move_san, correct_move_uci, source,
        played_move_san, eval_swing_cp, eval_before_cp, eval_after_cp,
        puzzle_type, source_game_id, opening_line_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.id, p.fen, p.correct_move_san, p.correct_move_uci, p.source, p.played_move_san, p.eval_swing_cp,
      p.eval_before_cp, p.eval_after_cp, p.puzzle_type, p.source_game_id, p.opening_line_id, p.created_at],
  );
  // every new puzzle gets a fresh review state, due immediately
  db.run(
    `INSERT OR IGNORE INTO review_state
       (puzzle_id, ease_factor, interval_days, repetitions, due_date,
        last_reviewed_at, consecutive_correct, consecutive_wrong)
       VALUES (?, 2.5, 0, 0, ?, NULL, 0, 0)`,
    [p.id, nowIso()],
  );
}

/** Deletes the existing puzzles (and review state) for these games and
 *  inserts the new set, in one transaction. */
export function replacePuzzlesForGames(db: Db, gameIds: string[], puzzles: Puzzle[]): void {
  db.transaction(() => {
    for (const gameId of gameIds) {
      // (puzzles you made yourself — ids 'pick-…' — stay)
      db.run(`DELETE FROM review_state WHERE puzzle_id IN
                (SELECT id FROM puzzles WHERE source_game_id = ? AND id NOT LIKE 'pick-%')`, [gameId]);
      db.run("DELETE FROM puzzles WHERE source_game_id = ? AND id NOT LIKE 'pick-%'", [gameId]);
    }
    for (const p of puzzles) insertPuzzle(db, p);
  });
}

export function rowToPuzzle(r: Row): Puzzle {
  return {
    id: r.id, fen: r.fen, correct_move_san: r.correct_move_san, correct_move_uci: r.correct_move_uci,
    source: r.source, played_move_san: r.played_move_san, eval_swing_cp: r.eval_swing_cp,
    eval_before_cp: r.eval_before_cp ?? null, eval_after_cp: r.eval_after_cp ?? null,
    puzzle_type: r.puzzle_type ?? null, source_game_id: r.source_game_id, opening_line_id: r.opening_line_id,
    created_at: r.created_at,
    solution_ucis: r.solution_ucis ?? null, solution_moves: r.solution_moves ?? null, kind: r.kind ?? null,
    rating: null, themes: null, game_url: null, opening: null, setup_fen: null, setup_uci: null,
  };
}

export function duePuzzles(db: Db, limit = 20): Puzzle[] {
  // ORDER BY RANDOM() samples randomly from everything currently due
  return db.all(
    `SELECT p.* FROM puzzles p
       JOIN review_state rs ON rs.puzzle_id = p.id
       WHERE rs.due_date <= ?
       ORDER BY RANDOM()
       LIMIT ?`,
    [nowIso(), limit],
  ).map(rowToPuzzle);
}

/** All puzzles, optionally filtered by type and by the source game's time
 *  class, in random order — the browsing queue (no due-date gating). */
export function allPuzzles(db: Db, puzzleType: string | null = null, timeClasses: Set<string> | null = null): Puzzle[] {
  return db.all(
    `SELECT p.*, g.time_control AS game_time_control FROM puzzles p
       LEFT JOIN games g ON g.id = p.source_game_id
       WHERE (? IS NULL OR p.puzzle_type = ?)
       ORDER BY RANDOM()`,
    [puzzleType, puzzleType],
  ).filter((r) => inTimeFilter(r.game_time_control, timeClasses)).map(rowToPuzzle);
}

export function distinctPuzzleTypes(db: Db): string[] {
  return db.all('SELECT DISTINCT puzzle_type FROM puzzles WHERE puzzle_type IS NOT NULL ORDER BY puzzle_type')
    .map((r) => r.puzzle_type);
}

// ---------- Attempts (weak spots / progress) ----------

export const OUTCOMES = ['correct', 'near_best', 'missed', 'revealed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Outcome of an attempts row; rows saved before outcomes existed only know right/wrong. */
export function attemptOutcome(row: Row): string {
  return row.outcome || (row.correct ? 'correct' : 'missed');
}

/** Returns the new row's id, for setAttemptOutcome. sharp is saved with the
 *  try because puzzle ids change when puzzles are regenerated. */
export function recordAttempt(db: Db, itemType: string, itemId: string, correct: boolean,
  outcome: string | null = null, sharp = false): number {
  return db.run(
    'INSERT INTO attempts (item_type, item_id, correct, attempted_at, outcome, sharp) VALUES (?, ?, ?, ?, ?, ?)',
    [itemType, itemId, correct ? 1 : 0, nowIso(), outcome || (correct ? 'correct' : 'missed'), sharp ? 1 : 0],
  ).lastInsertRowid;
}

/** Rewrites a saved first try — e.g. a multi-move puzzle whose first move
 *  was right but a later move wasn't. */
export function setAttemptResult(db: Db, attemptId: number, correct: boolean, outcome: string): void {
  db.run('UPDATE attempts SET correct = ?, outcome = ? WHERE rowid = ?', [correct ? 1 : 0, outcome, attemptId]);
}

export function triedToday(db: Db, itemType: string, itemId: string): boolean {
  return db.get(
    'SELECT 1 FROM attempts WHERE item_type = ? AND item_id = ? AND substr(attempted_at, 1, 10) = ?',
    [itemType, itemId, todayIso()],
  ) !== undefined;
}

/** Upgrades a saved try once the engine finishes judging it. */
export function setAttemptOutcome(db: Db, attemptId: number, outcome: string): void {
  db.run('UPDATE attempts SET outcome = ? WHERE rowid = ?', [outcome, attemptId]);
}

export type PuzzleRecord = { correct: number; near_best: number; missed: number };

/** puzzle id -> counts over every first try ever made (revealed counts as
 *  missed). itemType 'lichess' for Lichess puzzles. */
export function puzzleRecords(db: Db, itemType = 'puzzle'): Map<string, PuzzleRecord> {
  const records = new Map<string, PuzzleRecord>();
  for (const r of db.all('SELECT item_id, correct, outcome FROM attempts WHERE item_type = ?', [itemType])) {
    const outcome = attemptOutcome(r);
    let rec = records.get(r.item_id);
    if (!rec) records.set(r.item_id, (rec = { correct: 0, near_best: 0, missed: 0 }));
    rec[(outcome === 'revealed' ? 'missed' : outcome) as keyof PuzzleRecord] += 1;
  }
  return records;
}

/** Items you're still getting wrong -> weakness score (higher = weaker).
 *  Any item you've ever missed stays weak until you solve it twice in a row;
 *  the score is its miss count (+1 if the latest try was a miss). */
export function weakItemIds(db: Db, itemType: string): Map<string, number> {
  const history = new Map<string, number[]>();
  for (const r of db.all('SELECT item_id, correct FROM attempts WHERE item_type = ? ORDER BY attempted_at', [itemType])) {
    let list = history.get(r.item_id);
    if (!list) history.set(r.item_id, (list = []));
    list.push(r.correct);
  }
  const weak = new Map<string, number>();
  for (const [itemId, results] of history) {
    const misses = results.filter((c) => c === 0).length;
    const lastTwo = results.slice(-2);
    if (misses === 0 || (lastTwo.length === 2 && lastTwo[0] === 1 && lastTwo[1] === 1)) continue;
    weak.set(itemId, misses + (results[results.length - 1] === 0 ? 1 : 0));
  }
  return weak;
}

/** [ISO week start 'YYYY-MM-DD', attempts, first-try correct] per week. */
export function attemptsByWeek(db: Db, itemType: string): [string, number, number][] {
  const weeks = new Map<string, [number, number]>();
  for (const r of db.all('SELECT attempted_at, correct FROM attempts WHERE item_type = ?', [itemType])) {
    const start = dateIso(weekStart(fromIso(r.attempted_at)));
    let w = weeks.get(start);
    if (!w) weeks.set(start, (w = [0, 0]));
    w[0] += 1;
    w[1] += r.correct;
  }
  return [...weeks].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v[0], v[1]]);
}

// ---------- Review state ----------

export function loadReviewState(db: Db, puzzleId: string): ReviewState {
  const r = db.get('SELECT * FROM review_state WHERE puzzle_id = ?', [puzzleId]);
  if (!r) throw new Error(`no review state for puzzle ${puzzleId}`);
  return new ReviewState(r.puzzle_id, {
    ease_factor: r.ease_factor, interval_days: r.interval_days, repetitions: r.repetitions,
    due_date: r.due_date, last_reviewed_at: r.last_reviewed_at || null,
    consecutive_correct: r.consecutive_correct, consecutive_wrong: r.consecutive_wrong,
  });
}

export function saveReviewState(db: Db, rs: ReviewState): void {
  db.run(
    `UPDATE review_state SET ease_factor=?, interval_days=?, repetitions=?,
       due_date=?, last_reviewed_at=?, consecutive_correct=?, consecutive_wrong=?
       WHERE puzzle_id=?`,
    [rs.ease_factor, rs.interval_days, rs.repetitions, rs.due_date, rs.last_reviewed_at,
      rs.consecutive_correct, rs.consecutive_wrong, rs.puzzle_id],
  );
}

// ---------- Opening lines ----------

export function saveOpeningLine(db: Db, line: OpeningLine): void {
  db.run(
    `INSERT OR REPLACE INTO opening_lines
       (id, move_san, move_uci, fen_after_move, repertoire_name,
        my_color, move_number, parent_id, is_line_end, line_name,
        is_enabled, fen_before_move, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [line.id, line.move_san, line.move_uci, line.fen_after_move, line.repertoire_name, line.my_color,
      line.move_number, line.parent_id, line.is_line_end ? 1 : 0, line.line_name, line.is_enabled ? 1 : 0,
      line.fen_before_move, line.notes],
  );
}

export function rowToOpeningLine(r: Row): OpeningLine {
  return {
    id: r.id, move_san: r.move_san, move_uci: r.move_uci, fen_after_move: r.fen_after_move,
    repertoire_name: r.repertoire_name, my_color: r.my_color, move_number: r.move_number,
    parent_id: r.parent_id, is_line_end: !!r.is_line_end, line_name: r.line_name ?? null,
    is_enabled: r.is_enabled === null || r.is_enabled === undefined ? true : !!r.is_enabled,
    fen_before_move: r.fen_before_move ?? null, notes: r.notes,
  };
}

/** The existing node for this move in this line, if the line was imported
 *  before — lets a re-import update notes instead of duplicating. */
export function findLineNode(db: Db, repertoireName: string, myColor: string, lineName: string | null,
  parentId: string | null, moveUci: string): OpeningLine | null {
  const row = db.get(
    `SELECT * FROM opening_lines
       WHERE repertoire_name = ? AND my_color = ? AND line_name IS ?
       AND parent_id IS ? AND move_uci = ?`,
    [repertoireName, myColor, lineName, parentId, moveUci],
  );
  return row ? rowToOpeningLine(row) : null;
}

export function setLineNotes(db: Db, nodeId: string, notes: string | null): void {
  db.run('UPDATE opening_lines SET notes = ? WHERE id = ?', [notes, nodeId]);
}

/** Distinct [repertoire_name, my_color] pairs available to drill. */
export function listRepertoires(db: Db): [string, string][] {
  return db.all('SELECT DISTINCT repertoire_name, my_color FROM opening_lines')
    .map((r) => [r.repertoire_name, r.my_color]);
}

/** Every enabled line in this repertoire playable from a given board position
 *  — matched by the actual position (FEN), not by parent-child links, so lines
 *  imported as separate PGN games that share a position count as alternatives. */
export function linesAtFen(db: Db, repertoireName: string, myColor: string, fen: string): OpeningLine[] {
  if (parseGroup(repertoireName) !== null) {
    return db.all(
      'SELECT * FROM opening_lines WHERE my_color = ? AND fen_before_move = ? AND is_enabled = 1',
      [myColor, fen],
    ).map(rowToOpeningLine);
  }
  return db.all(
    `SELECT * FROM opening_lines
       WHERE repertoire_name = ? AND my_color = ? AND fen_before_move = ?
       AND is_enabled = 1`,
    [repertoireName, myColor, fen],
  ).map(rowToOpeningLine);
}

// Drilling several repertoires at once: a repertoire name of "*" means every
// repertoire of that colour, "*:d2d4" those whose lines start with that first
// move (1.d4 for White; for Black, White's first move, e.g. "*:e2e4").
export const ALL_REPERTOIRES = '*';

export function groupName(firstUci: string | null = null): string {
  return ALL_REPERTOIRES + (firstUci ? `:${firstUci}` : '');
}

/** null: an ordinary repertoire. Else the group's first-move filter ('' = all). */
export function parseGroup(repertoireName: string): string | null {
  if (!repertoireName.startsWith(ALL_REPERTOIRES)) return null;
  const i = repertoireName.indexOf(':');
  return i < 0 ? '' : repertoireName.slice(i + 1);
}

/** [uci, san, lines] of every first move your repertoires of this colour start with. */
export function firstMoves(db: Db, myColor: string): [string, string, number][] {
  return db.all(
    `SELECT move_uci, move_san, COUNT(*) AS n FROM opening_lines
       WHERE my_color = ? AND parent_id IS NULL AND is_enabled = 1
       GROUP BY move_uci ORDER BY n DESC`, [myColor],
  ).map((r) => [r.move_uci, r.move_san, r.n]);
}

/** Ply-1 nodes (parent_id IS NULL) for a given repertoire — enabled ones only. */
export function rootLines(db: Db, repertoireName: string, myColor: string): OpeningLine[] {
  const group = parseGroup(repertoireName);
  if (group !== null) {
    return db.all(
      `SELECT * FROM opening_lines WHERE my_color = ? AND parent_id IS NULL AND is_enabled = 1
         AND (? = '' OR move_uci = ?)`, [myColor, group, group],
    ).map(rowToOpeningLine);
  }
  return db.all(
    `SELECT * FROM opening_lines
       WHERE repertoire_name = ? AND my_color = ? AND parent_id IS NULL
       AND is_enabled = 1`,
    [repertoireName, myColor],
  ).map(rowToOpeningLine);
}

/** Enabled children only — used during drilling/book-move checks. */
export function childrenOf(db: Db, parentId: string): OpeningLine[] {
  return db.all('SELECT * FROM opening_lines WHERE parent_id = ? AND is_enabled = 1', [parentId]).map(rowToOpeningLine);
}

/** Every root line regardless of enabled state — the 'manage lines' menu. */
export function allRootLines(db: Db, repertoireName: string, myColor: string): OpeningLine[] {
  return db.all(
    `SELECT * FROM opening_lines
       WHERE repertoire_name = ? AND my_color = ? AND parent_id IS NULL
       ORDER BY line_name`,
    [repertoireName, myColor],
  ).map(rowToOpeningLine);
}

function allChildrenOf(db: Db, parentId: string): OpeningLine[] {
  return db.all('SELECT * FROM opening_lines WHERE parent_id = ?', [parentId]).map(rowToOpeningLine);
}

/** Deletes these opening-line moves and everything after them, then removes
 *  each emptied parent that wasn't the end of a line itself, upward (so a
 *  separately imported line leaves no stub). Returns how many moves were removed. */
export function deleteBranch(db: Db, nodeIds: string[]): number {
  let removed = 0;
  db.transaction(() => {
    for (const nodeId of nodeIds) {
      const row = db.get('SELECT parent_id FROM opening_lines WHERE id = ?', [nodeId]);
      if (!row) continue;                       // already gone (under another one deleted here)
      let parent: string | null = row.parent_id;
      const stack = [nodeId];
      while (stack.length) {
        const current = stack.pop()!;
        stack.push(...db.all('SELECT id FROM opening_lines WHERE parent_id = ?', [current]).map((r) => r.id));
        removed += db.run('DELETE FROM opening_lines WHERE id = ?', [current]).changes;
      }
      while (parent !== null) {
        const p = db.get('SELECT parent_id, is_line_end FROM opening_lines WHERE id = ?', [parent]);
        const hasChildren = db.get('SELECT 1 FROM opening_lines WHERE parent_id = ?', [parent]);
        if (!p || hasChildren || p.is_line_end) break;
        removed += db.run('DELETE FROM opening_lines WHERE id = ?', [parent]).changes;
        parent = p.parent_id;
      }
    }
  });
  return removed;
}

/** Toggles a whole line (the root plus every descendant) on or off. */
export function setLineEnabled(db: Db, rootId: string, enabled: boolean): void {
  const stack = [rootId];
  const ids: string[] = [];
  while (stack.length) {
    const nodeId = stack.pop()!;
    ids.push(nodeId);
    stack.push(...allChildrenOf(db, nodeId).map((c) => c.id));
  }
  db.transaction(() => {
    for (const id of ids) db.run('UPDATE opening_lines SET is_enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  });
}

/** Cheap fingerprint of what the Stats / Progress pages are computed from
 *  (games, analysis, puzzles, tries, repertoire): pages recompute only when it
 *  changes, instead of on every visit. */
export function dataSignature(db: Db): unknown[] {
  return Object.values(db.get(
    `SELECT (SELECT COUNT(*) FROM games) AS a, (SELECT MAX(rowid) FROM move_evaluations) AS b,
            (SELECT COUNT(*) FROM puzzles) AS c, (SELECT MAX(rowid) FROM attempts) AS d,
            (SELECT MAX(rowid) FROM spot_attempts) AS e, (SELECT MAX(rowid) FROM threat_attempts) AS f,
            (SELECT MAX(rowid) FROM sac_attempts) AS g, (SELECT COUNT(*) FROM opening_lines) AS h,
            (SELECT COUNT(*) FROM lichess_puzzles) AS i, (SELECT COUNT(*) FROM user_tags) AS j`,
  )!);
}
