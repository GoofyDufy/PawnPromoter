/**
 * Progress numbers (rating vs goal, blunders per game, puzzle practice) as
 * plain data — port of progress_data.py.
 */
import * as db from './db';
import { timeClass } from './models';
import type { Db } from './sqlite';
import { addDays, dateIso, fromIso, weekStart as weekStartDate } from './time';

const ELO_RE: Record<string, RegExp> = { white: /\[WhiteElo "(\d+)"\]/, black: /\[BlackElo "(\d+)"\]/ };

/** Monday of the week containing a 'YYYY-MM-DD...' date, as 'YYYY-MM-DD'. */
export function weekStart(day: string): string {
  return dateIso(weekStartDate(fromIso(day)));
}

/** [date 'YYYY-MM-DD', rating] of your rating in each game of this time class, oldest first. */
export function ratings(conn: Db, tclass: string): [string, number][] {
  const out: [string, number][] = [];
  for (const g of conn.all('SELECT pgn, my_color, time_control, played_at FROM games ORDER BY played_at')) {
    if (timeClass(g.time_control) !== tclass) continue;
    const m = ELO_RE[g.my_color]?.exec(g.pgn);
    if (m) out.push([dateIso(fromIso(g.played_at)), parseInt(m[1], 10)]);
  }
  return out;
}

export interface Progress {
  time_class: string;
  goal: number | null;
  current_rating: number | null;
  peak_rating: number | null;
  change_30_days: number | null;
  to_goal: number | null;
  weekly_ratings: [string, number][];
  blunders_per_game_weekly: [string, number][];
  puzzle_weeks: [string, number, number][];
  puzzles_this_week: { tried: number; solved: number };
  weak_spots: number;
}

export function compute(conn: Db, tclass = 'Rapid', goal: number | null = null, today: Date = new Date()): Progress {
  const rated = ratings(conn, tclass);
  const weekly = new Map<string, number>();
  for (const [day, rating] of rated) weekly.set(weekStart(day), rating);    // last rating of each week
  const current = rated.length ? rated[rated.length - 1][1] : null;
  const cutoff = dateIso(addDays(today, -30));
  const monthAgo = [...rated].reverse().find(([d]) => d <= cutoff)?.[1] ?? null;

  const perGame: [string, number][] = conn.all(
    `SELECT g.played_at, g.time_control,
            SUM(e.cp_after IS NOT NULL AND e.cp_before - e.cp_after >= 300) AS n
       FROM move_evaluations e JOIN games g ON g.id = e.game_id
       GROUP BY e.game_id`,
  ).filter((r) => timeClass(r.time_control) === tclass).map((r) => [r.played_at, r.n]);
  perGame.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const blunderWeeks = new Map<string, number[]>();
  for (const [playedAt, n] of perGame) {
    const w = weekStart(playedAt);
    if (!blunderWeeks.has(w)) blunderWeeks.set(w, []);
    blunderWeeks.get(w)!.push(n);
  }

  const puzzleWeeks = db.attemptsByWeek(conn, 'puzzle');
  const thisWeek = dateIso(weekStartDate(today));
  const [tried, solved] = (() => {
    const w = puzzleWeeks.find(([week]) => week === thisWeek);
    return w ? [w[1], w[2]] : [0, 0];
  })();
  return {
    time_class: tclass,
    goal,
    current_rating: current,
    peak_rating: rated.length ? Math.max(...rated.map(([, r]) => r)) : null,
    change_30_days: current !== null && monthAgo !== null ? current - monthAgo : null,
    to_goal: goal && current ? goal - current : null,
    weekly_ratings: [...weekly].slice(-40),
    blunders_per_game_weekly: [...blunderWeeks].slice(-30).map(([w, v]) => [w, v.reduce((a, b) => a + b, 0) / v.length]),
    puzzle_weeks: puzzleWeeks.slice(-12),
    puzzles_this_week: { tried, solved },
    weak_spots: db.weakItemIds(conn, 'puzzle').size,
  };
}
