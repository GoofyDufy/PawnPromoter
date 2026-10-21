/**
 * The weakness stats' database work, in the database worker: preparing and
 * saving each game for the analysis job (jobs.ts runs the engines), the report
 * for Stats → Weaknesses (with the §9 re-checks of showcased moves), and the
 * training plans (suggested focuses, tracked baselines and their reviews).
 */
import * as db from '../core/db';
import type { Db } from '../core/sqlite';
import { nowIso, todayIso } from '../core/time';
import { CONFIG, CONFIG_ID, type Eval, fillEvaluations, parseGame, toSearch } from '../core/weak/analysis';
import { Book } from '../core/weak/book';
import * as ec from '../core/weak/evalcore';
import { type Ctx, type Example, type Report, computeAll } from '../core/weak/stats';
import * as store from '../core/weak/store';
import * as training from '../core/weak/training';

export const WINDOWS = { last50: 50, all: 100_000 } as const;
export type WindowKey = keyof typeof WINDOWS;

let book: { size: number; book: Book } | null = null;

/** The book from the opening library (rebuilt only when the library changes). */
function bookFor(conn: Db): Book {
  const size = conn.get('SELECT COUNT(*) AS n FROM opening_library')!.n as number;
  if (book?.size !== size) book = { size, book: Book.fromDb(conn) };
  return book.book;
}

const ready = (conn: Db) => store.ensureSchema(conn);

// ---------- the analysis job ----------

export interface WeakTimeControl { time_control: string; games: number; analysed: number }

export function weakTimeControls(conn: Db): { list: WeakTimeControl[]; current: string | null } {
  ready(conn);
  const list = store.timeControls(conn, CONFIG_ID);
  const saved = db.getSetting(conn, 'weak_time_control');
  return { list, current: saved && list.some((t) => t.time_control === saved) ? saved : list[0]?.time_control ?? null };
}

export function weakSetTimeControl(conn: Db, timeControl: string): void {
  db.setSetting(conn, 'weak_time_control', timeControl);
}

export function weakGamesToAnalyse(conn: Db, timeControl: string, limit: number): string[] {
  ready(conn);
  return store.gamesToAnalyse(conn, CONFIG_ID, timeControl, limit);
}

/** The positions of one game Stockfish still has to search (in game order),
 *  or null when the game can't be used (it's marked, so it isn't offered again). */
export function weakPrepare(conn: Db, gameId: string): string[] | null {
  ready(conn);
  const game = db.getGame(conn, gameId);
  const parsed = game ? parseGame(game, bookFor(conn)) : null;
  if (!parsed) {
    conn.run(`INSERT OR REPLACE INTO weak_games (game_id, config_id, variant, analysed_at) VALUES (?, ?, 'unusable', ?)`, [gameId, CONFIG_ID, nowIso()]);
    return null;
  }
  const [, drafts] = parsed;
  return toSearch(drafts, store.cachedKeys(conn, drafts.map((d) => d.key), CONFIG_ID));
}

/** Saves one analysed game: the new searches, the game row and every ply. */
export function weakSaveGame(conn: Db, gameId: string, searched: [string, Eval][]): void {
  ready(conn);
  const game = db.getGame(conn, gameId);
  const parsed = game ? parseGame(game, bookFor(conn)) : null;
  if (!parsed) return;
  const [row, drafts] = parsed;
  const fresh = new Map(searched);
  const evals = store.loadEvals(conn, drafts.map((d) => d.key), CONFIG_ID);
  for (const [k, e] of fresh) evals.set(k, e);
  store.saveGame(conn, CONFIG_ID, row, fillEvaluations(drafts, evals), fresh, nowIso());
}

// ---------- the report ----------

function reportFor(conn: Db, timeControl: string, window: number) {
  const games = store.loadGames(conn, CONFIG_ID, timeControl, window);
  const ctx: Ctx = { time_control: timeControl, config_id: CONFIG_ID, spec_version: CONFIG.spec_version, window_games: window };
  return { games, report: computeAll(ctx, games) };
}

const SHOWCASED = ['worst_move', 'material', 'opportunism'] as const;
const examplesOf = (r: Report): Example[] => SHOWCASED.flatMap((k) => ((r[k] as { examples?: Example[] }).examples ?? []));

/** §9: an example is shown only once a fresh search of the played move agrees. */
function markVerified(conn: Db, report: Report): void {
  const checked = store.verified(conn, CONFIG_ID);
  for (const ex of examplesOf(report)) {
    const cap = checked.get(`${ex.fen}|${ex.played_uci}`);
    if (cap === undefined || ex.cap_before_white == null) continue;
    const white = ex.colour === 'white';
    const w = Math.max(0, ec.winPct(ec.moverPov(ex.cap_before_white, white)) - ec.winPct(ec.moverPov(cap, white)));
    ex.verified_wpl = Number(w.toFixed(1));
    ex.verified = ec.classify(w) === ec.classify(ex.wpl ?? 0) || w >= (ex.wpl ?? 0);
  }
}

export interface TrackedView extends training.Tracked { result: training.ReviewResult; lowerIsBetter: boolean }

export function weakReport(conn: Db, timeControl: string, windowKey: WindowKey) {
  ready(conn);
  const { games, report } = reportFor(conn, timeControl, WINDOWS[windowKey]);
  markVerified(conn, report);
  // the plan always comes from your last 50 games, whatever the window shown
  const recent = windowKey === 'last50' ? { games, report } : reportFor(conn, timeControl, WINDOWS.last50);
  const tracked = conn.all<training.Tracked>(`SELECT * FROM weak_training WHERE time_control = ? AND config_id = ? AND status = 'active' ORDER BY id`,
    [timeControl, CONFIG_ID]).map((t): TrackedView => {
    const lower = training.lowerIsBetter(t.focus_key);
    return { ...t, lowerIsBetter: lower, result: training.review(t, store.loadGames(conn, CONFIG_ID, timeControl, 100_000, t.baseline_through), todayIso(), lower) };
  });
  const unchecked = examplesOf(report).filter((e) => e.verified === undefined).length;
  return { report, config: { id: CONFIG_ID, ...CONFIG }, focuses: training.suggest(recent.report, recent.games), tracked, unchecked };
}

/** Showcased moves not re-checked yet (both windows): [fen, played move, cap before]. */
export function weakToVerify(conn: Db, timeControl: string): [string, string][] {
  ready(conn);
  const checked = store.verified(conn, CONFIG_ID);
  const out = new Map<string, [string, string]>();
  for (const w of Object.values(WINDOWS)) {
    for (const ex of examplesOf(reportFor(conn, timeControl, w).report)) {
      const k = `${ex.fen}|${ex.played_uci}`;
      if (!checked.has(k)) out.set(k, [ex.fen, ex.played_uci]);
    }
  }
  return [...out.values()];
}

/** rows: [fen, move, White-POV capped eval after the move]. */
export function weakSaveVerified(conn: Db, rows: [string, string, number][]): void {
  ready(conn);
  store.saveVerified(conn, CONFIG_ID, rows);
}

// ---------- training plans ----------

/** Track a focus: its number on your last 50 games becomes the baseline. */
export function weakTrack(conn: Db, timeControl: string, focusKey: string): { ok: boolean; text: string } {
  ready(conn);
  const { games, report } = reportFor(conn, timeControl, WINDOWS.last50);
  const focus = training.suggest(report, games).find((f) => f.key === focusKey);
  const m = training.measure(focusKey, games);
  if (!focus || !m || !games.length) return { ok: false, text: 'That focus has nothing to measure yet.' };
  conn.run(`INSERT INTO weak_training (created_at, time_control, config_id, focus_key, title, metric, baseline_value, baseline_n, baseline_games, baseline_through)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [nowIso(), timeControl, CONFIG_ID, focusKey, focus.title, focus.metric, m.value, m.n, games.length, games[0].row.date]);
  return { ok: true, text: `Tracking "${focus.title}". Its number is checked again after ${training.REVIEW_GAMES} new games and ${training.REVIEW_DAYS} days.` };
}

export function weakUntrack(conn: Db, id: number): void {
  ready(conn);
  conn.run(`UPDATE weak_training SET status = 'stopped' WHERE id = ?`, [id]);
}

export const weakServices = {
  weakTimeControls, weakSetTimeControl, weakGamesToAnalyse, weakPrepare, weakSaveGame,
  weakReport, weakToVerify, weakSaveVerified, weakTrack, weakUntrack,
};
