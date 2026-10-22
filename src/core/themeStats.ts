/**
 * How well you do per theme (Progress → Themes) — port of theme_stats.py:
 * every first try at a puzzle, grouped by the puzzle's tags — its kind, type,
 * phase, Lichess themes and your own tags (puzzleTags.ts). Plus the two
 * "seeing" skills from the Tactics & Threats page. No engine involved.
 *
 * And (a web-app addition) the same themes in your actual games: every puzzle
 * made from your games is a real mistake you made, so grouping those by tag
 * says which kinds of mistake cost you the most, and whether that's changing.
 */
import { winChances } from './analyzer';
import * as db from './db';
import * as lichessPuzzles from './lichessPuzzles';
import type { Puzzle } from './models';
import * as puzzleTags from './puzzleTags';
import * as spot from './spot';
import type { Db } from './sqlite';
import * as stats from './stats';
import * as threat from './threat';

export const MIN_TRIES = 3;          // a theme needs this many tries before it's rated
/** tags that say how long / how big / whose game — not a theme to practise */
const NOT_THEMES = new Set(['one move', '2 moves', '3 moves', '4+ moves', '4 moves', '5 moves', 'sharp', 'quiet',
  'master game', 'master vs master', 'super gm game', 'crushing', 'advantage', 'equality',
  'blunder', 'mistake', 'inaccuracy', 'long', 'short', 'very long']);

export class ThemeRow {
  tries = 0;
  solved = 0;                // right on the first try
  near = 0;                  // near-best
  recent_tries = 0;          // the last 30 days
  recent_solved = 0;

  constructor(readonly tag: string, readonly yours = false) {}

  get rate(): number {
    return this.tries ? this.solved / this.tries : 0.0;
  }

  get lichess_theme(): string {
    return puzzleTags.lichessTheme(this.tag);
  }
}

export class Skill {
  constructor(readonly name: string, readonly hits: number, readonly total: number) {}

  get rate(): number {
    return this.total ? this.hits / this.total : 0.0;
  }
}

/** "itemType\tid" -> Puzzle, for both kinds of puzzle. */
function puzzles(conn: Db): Map<string, Puzzle> {
  const out = new Map<string, Puzzle>();
  for (const r of conn.all('SELECT * FROM puzzles')) out.set(`puzzle\t${r.id}`, db.rowToPuzzle(r));
  for (const r of conn.all('SELECT * FROM lichess_puzzles')) out.set(`${lichessPuzzles.ITEM_TYPE}\t${r.id}`, lichessPuzzles.toPuzzle(r));
  return out;
}

/** Every theme with at least one try, weakest first among the rated ones. */
export function themeRows(conn: Db, sinceRecent = ''): ThemeRow[] {
  const all = puzzles(conn);
  const user = new Map<string, Set<string>>();
  for (const [tag, keys] of puzzleTags.allUserTags(conn)) {
    for (const k of keys) {
      if (!user.has(k)) user.set(k, new Set());
      user.get(k)!.add(tag);
    }
  }
  const tagsOf = new Map<string, [string, boolean][]>();
  const rows = new Map<string, ThemeRow>();
  for (const r of conn.all("SELECT item_type, item_id, outcome, correct, attempted_at FROM attempts WHERE item_type IN ('puzzle', ?)",
    [lichessPuzzles.ITEM_TYPE])) {
    const key = `${r.item_type}\t${r.item_id}`;
    const p = all.get(key);
    if (!p) continue;                      // rebuilt at another blunder size since: its tags are gone
    if (!tagsOf.has(key)) {
      const auto: [string, boolean][] = puzzleTags.autoTags(p, false, stats.isEndgame(p.fen))
        .filter((t) => !NOT_THEMES.has(t.toLowerCase())).map((t) => [t, false]);
      const have = new Set(auto.map(([t]) => t.toLowerCase()));
      const mine: [string, boolean][] = [...(user.get(puzzleTags.key(p)) ?? [])]
        .filter((t) => !have.has(t.toLowerCase())).map((t) => [t, true]);
      tagsOf.set(key, [...auto, ...mine]);
    }
    const outcome = db.attemptOutcome(r);
    const recent = sinceRecent ? r.attempted_at >= sinceRecent : false;
    for (const [tag, yours] of tagsOf.get(key)!) {
      if (!rows.has(tag.toLowerCase())) rows.set(tag.toLowerCase(), new ThemeRow(tag, yours));
      const row = rows.get(tag.toLowerCase())!;
      row.tries += 1;
      row.solved += outcome === 'correct' ? 1 : 0;
      row.near += outcome === 'near_best' ? 1 : 0;
      row.recent_tries += recent ? 1 : 0;
      row.recent_solved += recent && outcome === 'correct' ? 1 : 0;
    }
  }
  const rated = [...rows.values()].filter((r) => r.tries >= MIN_TRIES).sort((a, b) => a.rate - b.rate || b.tries - a.tries);
  const unrated = [...rows.values()].filter((r) => r.tries < MIN_TRIES).sort((a, b) => b.tries - a.tries);
  return [...rated, ...unrated];
}

export function skills(conn: Db): Skill[] {
  const t = threat.summary(conn);
  const s = spot.summary(conn);
  return [
    new Skill("Seeing your opponent's threats", t.found, t.threats),
    new Skill('Answering threats well', t.answers_ok, t.rounds),
    new Skill('Spotting tactics', s.spotted, s.tactics),
    new Skill('Not crying wolf (quiet positions)', s.quiet - s.false_alarms, s.quiet),
  ];
}

// ---------- the same themes, in your games ----------

export interface GameExample { gameId: string; fen: string; playedAt: string; played: string; best: string }

export class GameThemeRow {
  mistakes = 0;
  games = new Set<string>();
  points = 0;                // share of a point thrown away, summed (weekly.ts's cost)
  recent_mistakes = 0;       // in games of the last 30 days
  latest: GameExample | null = null;

  constructor(readonly tag: string, readonly yours = false) {}
}

export interface GameThemes {
  analysed: number;          // analysed games (the denominator)
  recent_analysed: number;   // of those, played in the last 30 days
  rows: GameThemeRow[];      // costliest per game first
}

/** Your mistakes in real games (the puzzles made from them), by theme. */
export function gameThemeRows(conn: Db, sinceRecent: string): GameThemes {
  const user = new Map<string, Set<string>>();
  for (const [tag, keys] of puzzleTags.allUserTags(conn)) {
    for (const k of keys) {
      if (!user.has(k)) user.set(k, new Set());
      user.get(k)!.add(tag);
    }
  }
  const analysed = conn.get('SELECT COUNT(DISTINCT game_id) AS n FROM move_evaluations')!.n as number;
  const recentAnalysed = conn.get(`SELECT COUNT(DISTINCT e.game_id) AS n FROM move_evaluations e JOIN games g ON g.id = e.game_id
    WHERE g.played_at >= ?`, [sinceRecent])!.n as number;
  const rows = new Map<string, GameThemeRow>();
  for (const r of conn.all(`SELECT p.*, g.played_at AS game_played_at FROM puzzles p JOIN games g ON g.id = p.source_game_id
      ORDER BY g.played_at`)) {
    const p = db.rowToPuzzle(r);
    const auto: [string, boolean][] = puzzleTags.autoTags(p, false, stats.isEndgame(p.fen))
      .filter((t) => !NOT_THEMES.has(t.toLowerCase())).map((t) => [t, false]);
    const have = new Set(auto.map(([t]) => t.toLowerCase()));
    const mine: [string, boolean][] = [...(user.get(puzzleTags.key(p)) ?? [])]
      .filter((t) => !have.has(t.toLowerCase())).map((t) => [t, true]);
    const cost = r.eval_before_cp === null || r.eval_after_cp === null ? 0
      : Math.max(0, (winChances(r.eval_before_cp) - winChances(r.eval_after_cp)) / 2);
    const recent = r.game_played_at >= sinceRecent;
    for (const [tag, yours] of [...auto, ...mine]) {
      if (!rows.has(tag.toLowerCase())) rows.set(tag.toLowerCase(), new GameThemeRow(tag, yours));
      const row = rows.get(tag.toLowerCase())!;
      row.mistakes += 1;
      row.games.add(r.source_game_id);
      row.points += cost;
      row.recent_mistakes += recent ? 1 : 0;
      row.latest = { gameId: r.source_game_id, fen: r.fen, playedAt: r.game_played_at, played: r.played_move_san ?? '', best: r.correct_move_san ?? '' };
    }
  }
  return { analysed, recent_analysed: recentAnalysed, rows: [...rows.values()].sort((a, b) => b.points - a.points || b.mistakes - a.mistakes) };
}
