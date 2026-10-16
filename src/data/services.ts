/**
 * What the screens ask the database worker for: plain data only (it crosses
 * a thread boundary, where class instances lose their getters), built from
 * the core modules. Each phase adds the services its screens need; the
 * puzzle ones follow puzzle_tab.py.
 */
import * as analyzer from '../core/analyzer';
import * as db from '../core/db';
import * as explorer from '../core/explorer';
import * as lichessPuzzles from '../core/lichessPuzzles';
import { type Game, type MoveEvaluation, type Puzzle, TIME_FILTERS } from '../core/models';
import * as progression from '../core/progression';
import * as puzzleKind from '../core/puzzleKind';
import * as puzzleTags from '../core/puzzleTags';
import type { Db } from '../core/sqlite';
import * as stats from '../core/stats';
import * as style from '../core/style';
import { fromIso } from '../core/time';
import { drillServices } from './drillServices';
import { libraryServices } from './libraryServices';
import { myGamesServices } from './myGamesServices';
import { level, type LevelView } from './level';

export { level, type LevelView };

// ---------- summary & level ----------

export interface Summary {
  games: number;
  analyzed: number;
  puzzles: number;
  lichessPuzzles: number;
  repertoireMoves: number;
  attempts: number;
  username: string | null;
  level: LevelView;
}

export function summary(conn: Db): Summary {
  const count = (sql: string) => conn.get(sql)!.n as number;
  return {
    games: count('SELECT COUNT(*) AS n FROM games'),
    analyzed: count('SELECT COUNT(*) AS n FROM games WHERE evaluated_at IS NOT NULL'),
    puzzles: count('SELECT COUNT(*) AS n FROM puzzles'),
    lichessPuzzles: lichessPuzzles.count(conn),
    repertoireMoves: count('SELECT COUNT(*) AS n FROM opening_lines'),
    attempts: count('SELECT COUNT(*) AS n FROM attempts'),
    username: db.getSetting(conn, 'chess_com_username'),
    level: level(conn),
  };
}

// ---------- settings ----------

export function getSettings(conn: Db, keys: string[]): Record<string, string | null> {
  return Object.fromEntries(keys.map((k) => [k, db.getSetting(conn, k)]));
}

export function setSettings(conn: Db, values: Record<string, string>): void {
  for (const [k, v] of Object.entries(values)) db.setSetting(conn, k, v);
}

// ---------- the one-off puzzle upgrades (puzzle_tab.py runs these on opening) ----------

/** The desktop's rules versions: brings an older database's puzzles up to date. */
export function upgradePuzzles(conn: Db): string[] {
  const done: string[] = [];
  if (db.getSetting(conn, 'puzzle_cost_version') !== analyzer.RULES_VERSION) {
    analyzer.applyChancesRule(conn);                    // puzzles must cost real winning chances
    db.setSetting(conn, 'puzzle_cost_version', analyzer.RULES_VERSION);
    done.push('chances');
  }
  if (db.getSetting(conn, 'puzzle_sac_version') !== analyzer.RULES_SAC_VERSION) {
    analyzer.addMissedSacrifices(conn);                 // sacrifices you missed: labelled and added
    db.setSetting(conn, 'puzzle_sac_version', analyzer.RULES_SAC_VERSION);
    done.push('sacrifices');
  }
  if (db.getSetting(conn, 'puzzle_rules_version') !== puzzleKind.RULES_VERSION) {
    puzzleKind.resetForNewRules(conn);                  // new tactic rules: every puzzle classified again
    db.setSetting(conn, 'puzzle_rules_version', puzzleKind.RULES_VERSION);
    db.setSetting(conn, 'puzzle_kind_version', puzzleKind.VERSION);   // nothing left to relabel
    done.push('rules');
  }
  if (db.getSetting(conn, 'puzzle_kind_version') !== puzzleKind.VERSION) {
    puzzleKind.relabelDefensive(conn);
    db.setSetting(conn, 'puzzle_kind_version', puzzleKind.VERSION);
    done.push('kinds');
  }
  return done;
}

// ---------- the puzzle queue (puzzle_tab._reload_queue) ----------

export const WEAK_SPOTS = 'Weak spots';
export const ENDGAMES = 'Endgames';
export const ALL_TYPES = 'All types';
export const ALL_POSITIONS = 'All positions';
export const SHARP_ONLY = 'Sharp (one best move)';
export const QUIET_ONLY = 'Quiet (several good moves)';
export const ALL_KINDS = 'All kinds';
export const MULTI_STEP = 'Multi-step (2+ moves)';
export const MY_GAMES = 'My games';
export const LICHESS = 'Lichess';
export const BOTH_SOURCES = 'My games + Lichess';
export const TAG_PREFIX = 'Tag: ';            // Type filter entries for the tags you've added
export const THEME_PREFIX = 'Theme: ';        // practising one theme (Progress → Themes)

export interface QueueFilters {
  source: string;
  type: string;
  kind: string;
  position: string;
  focus: string;
}

export type PuzzleRecordView = { correct: number; near_best: number; missed: number };

export interface QueueView {
  queue: Puzzle[];
  typeOptions: string[];
  type: string;                       // the type filter (reset to All types if it no longer exists)
  records: Record<string, PuzzleRecordView>;
  emptyText: string;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function records(conn: Db): Record<string, PuzzleRecordView> {
  return { ...Object.fromEntries(db.puzzleRecords(conn)), ...Object.fromEntries(db.puzzleRecords(conn, lichessPuzzles.ITEM_TYPE)) };
}

export function puzzleQueue(conn: Db, f: QueueFilters): QueueView {
  const mine = f.source !== LICHESS;
  const lichess = f.source !== MY_GAMES;
  const types = new Set(mine ? db.distinctPuzzleTypes(conn) : []);
  if (lichess) {
    for (const r of conn.all('SELECT DISTINCT themes FROM lichess_puzzles')) {
      types.add(lichessPuzzles.puzzleType((r.themes || '').split(/\s+/).filter(Boolean)));
    }
  }
  const userTags = puzzleTags.allUserTags(conn);
  const byLower = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  const options = [ALL_TYPES, WEAK_SPOTS, ENDGAMES, ...[...types].sort(),
    ...[...userTags.keys()].sort(byLower).map((t) => TAG_PREFIX + t)];
  let selected = f.type;
  if (selected.startsWith(THEME_PREFIX)) options.push(selected);
  if (!options.includes(selected)) selected = ALL_TYPES;

  const filterType = [ALL_TYPES, WEAK_SPOTS, ENDGAMES].includes(selected) || selected.startsWith(TAG_PREFIX)
    || selected.startsWith(THEME_PREFIX) ? null : selected;
  let queue: Puzzle[] = mine ? db.allPuzzles(conn, filterType, TIME_FILTERS[f.focus] ?? null) : [];
  if (lichess) {               // the Games (time control) filter is about your games only
    queue.push(...lichessPuzzles.load(conn, filterType));
    if (mine) shuffle(queue);
  }
  const recs = records(conn);
  if (selected === WEAK_SPOTS) {
    // puzzles you keep missing, weakest first (solve twice in a row to clear one)
    const weak = new Map([...db.weakItemIds(conn, 'puzzle'), ...db.weakItemIds(conn, lichessPuzzles.ITEM_TYPE)]);
    queue = queue.filter((p) => weak.has(p.id)).sort((a, b) => weak.get(b.id)! - weak.get(a.id)!);
  } else if (selected === ENDGAMES) {
    queue = queue.filter((p) => stats.isEndgame(p.fen));
  } else if (selected.startsWith(TAG_PREFIX)) {
    const keys = userTags.get(selected.slice(TAG_PREFIX.length)) ?? new Set();
    queue = queue.filter((p) => keys.has(puzzleTags.key(p)));
  } else if (selected.startsWith(THEME_PREFIX)) {
    const want = selected.slice(THEME_PREFIX.length).toLowerCase();
    const keys = new Set<string>();
    for (const [t, ks] of userTags) if (t.toLowerCase() === want) for (const k of ks) keys.add(k);
    queue = queue.filter((p) => keys.has(puzzleTags.key(p))
      || puzzleTags.autoTags(p, false, stats.isEndgame(p.fen)).some((t) => t.toLowerCase() === want));
    // ones you haven't solved yet first
    queue.sort((a, b) => Number((recs[a.id]?.correct ?? 0) > 0) - Number((recs[b.id]?.correct ?? 0) > 0));
  }
  if (f.kind === MULTI_STEP) queue = queue.filter((p) => (p.solution_moves ?? 0) > 1);
  else if (f.kind !== ALL_KINDS) queue = queue.filter((p) => p.kind === f.kind);
  if (f.position !== ALL_POSITIONS) {
    // sharp = one clearly best move (engine's top choice far ahead of its 2nd)
    const sharp = style.puzzleSharpness(conn, queue);
    queue = queue.filter((p) => sharp.get(p.id) === (f.position === SHARP_ONLY));
  }
  const emptyText = selected === WEAK_SPOTS
    ? 'No weak spots right now. Puzzles you miss show up here until you solve them twice in a row.'
    : selected === ENDGAMES ? 'No endgame puzzles in this filter yet.'
      : f.position !== ALL_POSITIONS || f.kind !== ALL_KINDS ? 'No puzzles match these filters.'
        : f.source === LICHESS ? 'No Lichess puzzles yet. Add some on Import & Analyze → Lichess puzzles.'
          : 'No puzzles yet. Import your games, then click Analyze new games.';
  return { queue, typeOptions: options, type: selected, records: recs, emptyText };
}

// ---------- one puzzle ----------

export interface PuzzleDetails {
  game: { id: string; white: string; black: string; played: string; url: string } | null;
  sharp: boolean;
  endgame: boolean;
  autoTags: string[];
  userTags: string[];
  triedToday: boolean;
  /** The engine's saved 2nd / 3rd choices for this exact position (near-best tries). */
  top: { second: string | null; cpSecond: number | null; third: string | null; cpThird: number | null } | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** strftime("%b %d, %Y") */
function shortDate(iso: string): string {
  const d = fromIso(iso);
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`;
}

const itemType = (p: Puzzle) => (p.source === 'lichess' ? lichessPuzzles.ITEM_TYPE : 'puzzle');

export function puzzleDetails(conn: Db, p: Puzzle): PuzzleDetails {
  let game: PuzzleDetails['game'] = null;
  if (p.source_game_id) {
    const g = db.getGame(conn, p.source_game_id);
    if (g) {
      const me = db.getSetting(conn, 'chess_com_username') || 'You';
      const [white, black] = g.my_color === 'white' ? [me, g.opponent_username] : [g.opponent_username, me];
      game = { id: g.id, white, black, played: shortDate(g.played_at), url: g.chess_com_url };
    }
  }
  const sharp = style.puzzleSharpness(conn, [p]).get(p.id) ?? false;
  const endgame = stats.isEndgame(p.fen);
  const autoTags = puzzleTags.autoTags(p, sharp, endgame);
  const have = new Set(autoTags.map((t) => t.toLowerCase()));
  const userTags = puzzleTags.userTags(conn, p).filter((t) => !have.has(t.toLowerCase()));
  let top: PuzzleDetails['top'] = null;
  if (p.source_game_id) {
    const row = conn.get('SELECT second_move_uci, cp_second, third_move_uci, cp_third FROM move_evaluations WHERE game_id = ? AND fen_before = ?',
      [p.source_game_id, p.fen]);
    if (row) top = { second: row.second_move_uci, cpSecond: row.cp_second, third: row.third_move_uci, cpThird: row.cp_third };
  }
  return { game, sharp, endgame, autoTags, userTags, triedToday: db.triedToday(conn, itemType(p), p.id), top };
}

export interface TryResult {
  attemptId: number;
  record: PuzzleRecordView;
  level: LevelView;
}

function recordOf(conn: Db, p: Puzzle): PuzzleRecordView {
  return db.puzzleRecords(conn, itemType(p)).get(p.id) ?? { correct: 0, near_best: 0, missed: 0 };
}

/** The first try at a puzzle (only it counts for Weak spots, Progress and XP). */
export function recordFirstTry(conn: Db, p: Puzzle, correct: boolean, outcome: string): TryResult {
  const sharp = style.puzzleSharpness(conn, [p]).get(p.id) ?? false;
  const attemptId = db.recordAttempt(conn, itemType(p), p.id, correct, outcome, sharp);
  return { attemptId, record: recordOf(conn, p), level: level(conn) };
}

/** A saved first try upgraded (near-best after all) or downgraded (a later move missed). */
export function updateTry(conn: Db, p: Puzzle, attemptId: number, correct: boolean | null, outcome: string): TryResult {
  if (correct === null) db.setAttemptOutcome(conn, attemptId, outcome);
  else db.setAttemptResult(conn, attemptId, correct, outcome);
  return { attemptId, record: recordOf(conn, p), level: level(conn) };
}

export function savePuzzleKind(conn: Db, puzzleId: string, solution: string[], kind: string): void {
  puzzleKind.save(conn, puzzleId, new puzzleKind.Result(solution, kind));
}

export function saveKinds(conn: Db, results: [string, string[], string][]): void {
  conn.transaction(() => {
    for (const [id, solution, kind] of results) puzzleKind.save(conn, id, new puzzleKind.Result(solution, kind));
  });
}

export function unclassified(conn: Db): [string, string, string][] {
  return puzzleKind.unclassified(conn);
}

// ---------- tags ----------

export interface TagsView {
  userTags: string[];
  allTags: string[];          // every tag you've used (the Type filter's Tag: entries)
}

export function changeTag(conn: Db, p: Puzzle, tag: string, on: boolean, autoTags: string[]): TagsView {
  (on ? puzzleTags.add : puzzleTags.remove)(conn, p, tag);
  const have = new Set(autoTags.map((t) => t.toLowerCase()));
  const byLower = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  return { userTags: puzzleTags.userTags(conn, p).filter((t) => !have.has(t.toLowerCase())),
    allTags: [...puzzleTags.allUserTags(conn).keys()].sort(byLower) };
}

// ---------- Import & Analyze ----------

export interface GamesSummaryView {
  total: number;
  cached: number;
  legacy: number;
  new: number;
  uncached: number;
}

export function gameSummary(conn: Db, focus: string): GamesSummaryView {
  return db.gameStats(conn, TIME_FILTERS[focus] ?? null);
}

/** New games from chess.com: saved, or (already there) their chess.com accuracy picked up. */
export function importGames(conn: Db, games: Game[]): number {
  let added = 0;
  conn.transaction(() => {
    for (const g of games) {
      if (!db.gameExists(conn, g.chess_com_url)) {
        db.saveGame(conn, g);
        added += 1;
      } else {
        db.updateAccuracy(conn, g.chess_com_url, g.my_accuracy, g.opp_accuracy);   // reviewed on chess.com since
      }
    }
  });
  return added;
}

export function gamesToAnalyze(conn: Db, limit: number, focus: string): Game[] {
  return db.gamesNeedingEvaluation(conn, limit, TIME_FILTERS[focus] ?? null);
}

/** One game's engine output saved, and its puzzles made, the moment it finishes. */
export function saveGameAnalysis(conn: Db, gameId: string, evaluations: MoveEvaluation[], thresholdCp: number): number {
  db.saveGameEvaluations(conn, gameId, evaluations);
  const puzzles = analyzer.puzzlesFromEvaluations(evaluations, thresholdCp);
  db.replacePuzzlesForGames(conn, [gameId], puzzles);
  return puzzles.length;
}

/** "Apply blunder size": every saved evaluation re-filtered, no engine. */
export function regeneratePuzzles(conn: Db, thresholdCp: number): { games: number; puzzles: number; legacy: number } {
  const byGame = db.allEvaluationsByGame(conn);
  const puzzles = [...byGame.values()].flatMap((evs) => analyzer.puzzlesFromEvaluations(evs, thresholdCp));
  db.replacePuzzlesForGames(conn, [...byGame.keys()], puzzles);
  return { games: byGame.size, puzzles: puzzles.length, legacy: db.gameStats(conn).uncached };
}

// ---------- Lichess puzzles ----------

export function lichessSummary(conn: Db): { count: number; low: number | null; high: number | null; defaults: [number, number] } {
  const [low, high] = lichessPuzzles.ratingSpan(conn);
  return { count: lichessPuzzles.count(conn), low, high, defaults: lichessPuzzles.defaultRange(explorer.myRecentRating(conn)) };
}

export function lichessIds(conn: Db): string[] {
  return [...lichessPuzzles.ids(conn)];
}

export function lichessSave(conn: Db, batch: lichessPuzzles.LichessRow[]): void {
  lichessPuzzles.save(conn, batch);
}

export function lichessRemoveAll(conn: Db): void {
  lichessPuzzles.removeAll(conn);
}

export const services = {
  summary, level, getSettings, setSettings, upgradePuzzles, puzzleQueue, records, puzzleDetails, recordFirstTry,
  updateTry, savePuzzleKind, saveKinds, unclassified, changeTag, gameSummary, importGames, gamesToAnalyze,
  saveGameAnalysis, regeneratePuzzles, lichessSummary, lichessIds, lichessSave, lichessRemoveAll,
  ...drillServices,
  ...myGamesServices,
  ...libraryServices,
};
export type Services = typeof services;
