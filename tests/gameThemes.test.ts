// Progress → Themes → "In your games": your real mistakes (the puzzles made from your games) by theme,
// and the recent-vs-before trend.
import { describe, expect, it } from 'vitest';
import * as db from '../src/core/db';
import { openMemoryDb } from '../src/core/sqlite';
import { gameThemeRows } from '../src/core/themeStats';
import { themeTrend } from '../src/data/progressServices';

const MIDGAME = 'r1bq1rk1/pp2bppp/2n2n2/3p4/3P4/2NB1N2/PP3PPP/R1BQ1RK1 w - - 0 10';

describe('themeTrend', () => {
  it('calls a change only when it is well beyond noise', () => {
    expect(themeTrend(5, 50, 100, 250)).toBe('fewer');     // expected 20, saw 5
    expect(themeTrend(40, 50, 100, 250)).toBe('more');     // expected 20, saw 40
    expect(themeTrend(17, 50, 100, 250)).toBe('same');     // within noise
    expect(themeTrend(3, 9, 100, 250)).toBe(null);         // too few recent games
  });
});

describe('gameThemeRows', () => {
  it('counts mistakes per theme, costs them, orders by cost, keeps the latest example', async () => {
    const conn = db.initDb(await openMemoryDb());
    const game = (id: string, playedAt: string) => {
      conn.run('INSERT INTO games (id, chess_com_url, pgn, played_at, time_control, my_color, opponent_username, result) VALUES (?,?,?,?,?,?,?,?)',
        [id, `u-${id}`, '', playedAt, '180+2', 'white', 'x', 'loss']);
      conn.run('INSERT INTO move_evaluations (game_id, ply, fen_before, move_uci, best_move_uci, cp_before, cp_after, depth) VALUES (?,?,?,?,?,?,?,?)',
        [id, 18, MIDGAME, 'a2a3', 'c1g5', 30, 20, 14]);
    };
    const puzzle = (id: string, gameId: string, kind: string, type: string, before: number, after: number) => conn.run(
      `INSERT INTO puzzles (id, fen, correct_move_san, correct_move_uci, source, played_move_san, eval_swing_cp, eval_before_cp, eval_after_cp,
        puzzle_type, source_game_id, created_at, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, MIDGAME, 'Bg5', 'c1g5', 'game', 'a3', before - after, before, after, type, gameId, '2026-10-01', kind]);
    game('g1', '2026-08-01T10:00:00');
    game('g2', '2026-10-10T10:00:00');
    puzzle('p1', 'g1', 'Defensive', 'Left Hanging', 300, -400);     // winning → losing: costly
    puzzle('p2', 'g2', 'Defensive', 'Positional', 50, -150);         // smaller
    const t = gameThemeRows(conn, '2026-09-21');
    expect([t.analysed, t.recent_analysed]).toEqual([2, 1]);
    const by = Object.fromEntries(t.rows.map((r) => [r.tag, r]));
    expect(by.Defensive.mistakes).toBe(2);
    expect(by.Defensive.games.size).toBe(2);
    expect(by.Defensive.recent_mistakes).toBe(1);
    expect(by.Defensive.latest?.gameId).toBe('g2');                // the newest game
    expect(by['Left Hanging'].points).toBeGreaterThan(by.Positional.points);
    expect(t.rows[0].tag).toBe('Defensive');                       // most points lost overall
    expect(t.rows.some((r) => r.tag === 'One move')).toBe(false);  // length tags aren't themes
  });
});
