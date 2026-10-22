/**
 * Progress' database work (progress_tab.py, progress_views.py), in the
 * database worker: the Overview numbers and charts, your themes and "seeing
 * the board" skills, and the week in review — as plain data.
 */
import * as db from '../core/db';
import * as progressData from '../core/progressData';
import type { Db } from '../core/sqlite';
import * as themeStats from '../core/themeStats';
import * as weekly from '../core/weekly';

export const TIME_CLASSES = ['Rapid', 'Blitz', 'Bullet', 'Daily'];
export const DEFAULT_GOAL = '2000';

/** Settings, then the Overview for that time class and goal (an unreadable goal: none). */
export function progressOverview(conn: Db, tclass: string | null, goalText: string | null): progressData.Progress & { goalText: string } {
  const t = tclass ?? db.getSetting(conn, 'progress_class') ?? 'Rapid';
  const g = goalText ?? db.getSetting(conn, 'rating_goal') ?? DEFAULT_GOAL;
  db.setSetting(conn, 'progress_class', t);
  const goal = /^\s*-?\d+\s*$/.test(g) ? parseInt(g, 10) : null;
  if (goal !== null) db.setSetting(conn, 'rating_goal', String(goal));
  return { ...progressData.compute(conn, t, goal), goalText: g };
}

export interface ThemeRowView {
  tag: string;
  yours: boolean;
  tries: number;
  solved: number;
  recentTries: number;
  recentSolved: number;
  lichessTheme: string;
}

const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface GameThemeView {
  tag: string;
  yours: boolean;
  mistakes: number;
  games: number;                 // games with at least one
  share: number;                 // games / analysed
  perTen: number;                // mistakes per 10 analysed games
  pointsPerGame: number;
  recentPerTen: number | null;   // the last 30 days (null: under 10 analysed games then)
  trend: 'fewer' | 'more' | 'same' | null;
  latest: themeStats.GameExample | null;
}

export const MIN_RECENT_GAMES = 10;

/** Recent vs before: "fewer" / "more" only when the recent count is ~2 standard deviations (Poisson) from
 *  what the earlier rate predicts — smaller swings are "about the same". */
export function themeTrend(recent: number, recentGames: number, older: number, olderGames: number): 'fewer' | 'more' | 'same' | null {
  if (recentGames < MIN_RECENT_GAMES || olderGames < MIN_RECENT_GAMES) return null;
  const expected = (older / olderGames) * recentGames;
  if (expected <= 0) return recent >= 3 ? 'more' : 'same';
  const z = (recent - expected) / Math.sqrt(expected);
  return z <= -2 ? 'fewer' : z >= 2 ? 'more' : 'same';
}

export function progressThemes(conn: Db): {
  skills: { name: string; hits: number; total: number }[]; rows: ThemeRowView[];
  games: { analysed: number; recentAnalysed: number; rows: GameThemeView[] };
} {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const g = themeStats.gameThemeRows(conn, isoDate(since));
  const olderGames = g.analysed - g.recent_analysed;
  return {
    skills: themeStats.skills(conn).map((s) => ({ name: s.name, hits: s.hits, total: s.total })),
    rows: themeStats.themeRows(conn, isoDate(since)).map((r) => ({ tag: r.tag, yours: r.yours, tries: r.tries, solved: r.solved,
      recentTries: r.recent_tries, recentSolved: r.recent_solved, lichessTheme: r.lichess_theme })),
    games: {
      analysed: g.analysed, recentAnalysed: g.recent_analysed,
      rows: g.rows.map((r) => ({
        tag: r.tag, yours: r.yours, mistakes: r.mistakes, games: r.games.size,
        share: g.analysed ? r.games.size / g.analysed : 0,
        perTen: g.analysed ? (10 * r.mistakes) / g.analysed : 0,
        pointsPerGame: g.analysed ? r.points / g.analysed : 0,
        recentPerTen: g.recent_analysed >= MIN_RECENT_GAMES ? (10 * r.recent_mistakes) / g.recent_analysed : null,
        trend: themeTrend(r.recent_mistakes, g.recent_analysed, r.mistakes - r.recent_mistakes, olderGames),
        latest: r.latest,
      })),
    },
  };
}

export interface MistakeView {
  puzzleId: string;
  gameId: string;
  fen: string;
  text: string;            // "vs X, move 24: you played Qd2, best was Nf5 — +4.1 → −5.7, winning → losing"
  note: string;            // "threw away 63% of your winning chances · Defensive · Blunder"
}

export type WeekView = Omit<weekly.Week, 'mistakes'> & { mistakes: MistakeView[]; end: string };

export function progressWeek(conn: Db): WeekView {
  const w = weekly.review(conn);
  const end = new Date(`${w.start}T00:00:00`);
  end.setDate(end.getDate() + weekly.DAYS - 1);
  const mistakes = w.mistakes.map((m): MistakeView => {
    const tags = [m.kind, m.puzzle_type].filter(Boolean).join(' · ');
    return {
      puzzleId: m.puzzle_id, gameId: m.game_id, fen: m.fen,
      text: `vs ${m.opponent}, move ${m.move_number}: you played ${m.played_san}, best was ${m.best_san} — ${m.swingText()}`,
      note: `threw away ${Math.round(m.cost * 100)}% of your winning chances${tags ? ` · ${tags}` : ''}`,
    };
  });
  return { ...w, mistakes, end: isoDate(end) };
}

export const progressServices = { progressOverview, progressThemes, progressWeek };
