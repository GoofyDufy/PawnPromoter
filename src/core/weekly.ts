/**
 * Your week in review (Progress → This week) — port of weekly.py: the games of
 * the last 7 days, their costliest mistakes, the pattern behind them, what you
 * practised, and what to practise next. Plain data, no engine involved.
 *
 * "Costliest" is measured the way Lichess judges moves: by how much of your
 * chance of winning the move threw away (winChances), not by pawns — so going
 * from +4 to -5 counts far more than allowing mate when already -8.
 */
import { MATE_CP, winChances } from './analyzer';
import { Board } from './chess';
import * as db from './db';
import { pyPercent, pySigned } from './format';
import * as lichessPuzzles from './lichessPuzzles';
import { timeClass } from './models';
import * as progressData from './progressData';
import { Counter } from './repertoireGaps';
import type { Db } from './sqlite';
import * as stats from './stats';
import * as themeStats from './themeStats';
import * as threat from './threat';
import { addDays, dateIso } from './time';

export const DAYS = 7;
export const TOP_MISTAKES = 3;
export const FACING_THREAT = ['Defensive', 'Counterattack'];

export class Mistake {
  constructor(
    readonly puzzle_id: string,
    readonly game_id: string,
    readonly fen: string,
    readonly opponent: string,
    readonly played_at: string,
    readonly move_number: number,
    readonly played_san: string,
    readonly best_san: string,
    readonly before_cp: number,      // with the best move, your point of view
    readonly after_cp: number,       // after what you played
    readonly kind: string | null,
    readonly puzzle_type: string | null,
  ) {}

  /** Share of the game's result thrown away: 0 .. 1 (winning -> lost). */
  get cost(): number {
    return Math.max(0.0, (winChances(this.before_cp) - winChances(this.after_cp)) / 2);
  }

  /** '+4.1 → −5.7, winning → losing'. */
  swingText(): string {
    return `${evalText(this.before_cp)} → ${evalText(this.after_cp)}, ${state(this.before_cp)} → ${state(this.after_cp)}`;
  }
}

function evalText(cp: number): string {
  if (Math.abs(cp) >= Math.floor(MATE_CP / 2)) return cp > 0 ? 'mating' : 'mated';
  return pySigned(cp / 100, 1).replaceAll('-', '−');
}

/** Lichess's bands: +2 or more is a decisive advantage. */
function state(cp: number): string {
  return cp >= 200 ? 'winning' : cp <= -200 ? 'losing' : 'about equal';
}

export interface Suggestion {
  text: string;
  action: string;            // "threats" / "theme" / "analyze" / "tactics"
  arg: string;
}

export class Week {
  games = 0;
  wins = 0;
  losses = 0;
  draws = 0;
  analyzed = 0;
  rating_class: string | null = null;
  /** The time controls played this week (most played first), and the one shown (null: all games). */
  time_controls: { time_control: string; games: number }[] = [];
  time_control: string | null = null;
  rating_from: number | null = null;
  rating_to: number | null = null;
  mistakes: Mistake[] = [];
  mistake_count = 0;
  facing_threat = 0;         // of this week's mistakes, made when facing a threat
  endgame = 0;
  common_type: string | null = null;
  common_type_count = 0;
  puzzles_tried = 0;
  puzzles_solved = 0;
  spot_rounds = 0;
  threat_rounds = 0;
  lines_drilled = 0;
  suggestions: Suggestion[] = [];

  constructor(readonly start: string) {}
}

/** The week in review. timeControl: only games at that time control ("180+2"), or null for all of them —
 *  the practice (puzzles, drills) isn't tied to a game, so it's the whole week's either way. */
export function review(conn: Db, today: Date = new Date(), timeControl: string | null = null): Week {
  const since = dateIso(addDays(today, -(DAYS - 1)));
  const w = new Week(since);
  w.time_controls = conn.all(`SELECT time_control, COUNT(*) AS games FROM games WHERE played_at >= ? AND time_control IS NOT NULL
      GROUP BY time_control ORDER BY games DESC, time_control`, [since]);
  w.time_control = timeControl;
  const only = timeControl ? ' AND g.time_control = ?' : '';
  const args = (...a: unknown[]) => (timeControl ? [...a, timeControl] : a) as never;

  const games = conn.all(`SELECT id, result, time_control, is_analyzed FROM games g WHERE played_at >= ?${only}`, args(since));
  w.games = games.length;
  for (const g of games) {
    w.wins += g.result === 'win' ? 1 : 0;
    w.losses += g.result === 'loss' ? 1 : 0;
    w.draws += g.result === 'draw' ? 1 : 0;
  }
  w.analyzed = conn.get('SELECT COUNT(DISTINCT e.game_id) AS n FROM move_evaluations e JOIN games g ON g.id = e.game_id '
    + `WHERE g.played_at >= ?${only}`, args(since))!.n;

  // rating: the time class you played most this week
  const classes = new Counter<string>();
  for (const g of games) classes.add(timeClass(g.time_control));
  if (classes.size) {
    w.rating_class = classes.mostCommon()!;
    const rated = progressData.ratings(conn, w.rating_class);
    const before = rated.filter(([d]) => d < since).map(([, r]) => r);
    const during = rated.filter(([d]) => d >= since).map(([, r]) => r);
    if (during.length) {
      w.rating_from = before.length ? before[before.length - 1] : during[0];
      w.rating_to = during[during.length - 1];
    }
  }

  // mistakes = this week's puzzles (your mistakes of at least the blunder size)
  const rows = conn.all(
    `SELECT p.id, p.fen, p.played_move_san, p.correct_move_san, p.eval_before_cp, p.eval_after_cp, p.kind,
            p.puzzle_type, g.id AS game_id, g.opponent_username, g.played_at, e.ply
     FROM puzzles p JOIN games g ON g.id = p.source_game_id
     LEFT JOIN move_evaluations e ON e.game_id = g.id AND e.fen_before = p.fen
     WHERE g.played_at >= ?${only}`, args(since));
  w.mistake_count = rows.length;
  w.facing_threat = rows.filter((r) => FACING_THREAT.includes(r.kind)).length;
  w.endgame = rows.filter((r) => stats.isEndgame(r.fen)).length;
  const types = new Counter<string>();                  // a pattern, not how big it was
  for (const r of rows) {
    if (r.puzzle_type && !['Blunder', 'Mistake', 'Inaccuracy'].includes(r.puzzle_type)) types.add(r.puzzle_type);
  }
  if (types.size) {
    w.common_type = types.mostCommon()!;
    w.common_type_count = types.get(w.common_type)!;
  }
  const mistakes: Mistake[] = [];
  for (const r of rows) {
    if (r.eval_before_cp === null || r.eval_after_cp === null) continue;
    const ply = r.ply !== null ? r.ply : 2 * (Board.fromFen(r.fen).fullmoveNumber - 1);
    mistakes.push(new Mistake(r.id, r.game_id, r.fen, r.opponent_username, r.played_at, Math.floor(ply / 2) + 1,
      r.played_move_san || '?', r.correct_move_san, r.eval_before_cp, r.eval_after_cp, r.kind, r.puzzle_type));
  }
  w.mistakes = mistakes.sort((a, b) => b.cost - a.cost).slice(0, TOP_MISTAKES);

  // practice this week
  for (const r of conn.all('SELECT item_type, outcome, correct FROM attempts WHERE attempted_at >= ?', [since])) {
    if (r.item_type === 'puzzle' || r.item_type === lichessPuzzles.ITEM_TYPE) {
      w.puzzles_tried += 1;
      w.puzzles_solved += db.attemptOutcome(r) === 'correct' ? 1 : 0;
    } else {
      w.lines_drilled += 1;
    }
  }
  w.spot_rounds = conn.get('SELECT COUNT(*) AS n FROM spot_attempts WHERE attempted_at >= ?', [since])!.n;
  w.threat_rounds = threat.summary(conn, since).rounds;

  w.suggestions = suggest(conn, w);
  return w;
}

function suggest(conn: Db, w: Week): Suggestion[] {
  const out: Suggestion[] = [];
  if (w.games > w.analyzed) {
    out.push({ text: `Analyze this week's ${w.games - w.analyzed} new game(s) — your mistakes become puzzles.`,
      action: 'analyze', arg: '' });
  }
  if (w.mistake_count && w.facing_threat * 2 >= w.mistake_count) {
    out.push({ text: `${w.facing_threat} of your ${w.mistake_count} mistakes came when your opponent `
      + "had a threat. Drill: What's the threat?", action: 'threats', arg: '' });
  }
  const weak = themeStats.themeRows(conn).find((r) => r.tries >= themeStats.MIN_TRIES && r.rate < 0.6);
  if (weak) out.push({ text: `Your weakest theme: ${weak.tag} (${pyPercent(weak.rate)} solved). Practise it.`, action: 'theme', arg: weak.tag });
  if (!out.length || w.spot_rounds + w.threat_rounds === 0) {
    out.push({ text: 'A few rounds of Spot the Tactic keep your eyes sharp.', action: 'tactics', arg: '' });
  }
  return out;
}
