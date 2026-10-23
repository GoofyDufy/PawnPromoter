// Port of the prototype's Themes & This week tests (theme_stats, weekly,
// the winning-chances rule for saved puzzles) — 67e3b53.
import { beforeEach, describe, expect, it } from 'vitest';
import * as analyzer from '../src/core/analyzer';
import { STARTING_FEN } from '../src/core/chess';
import * as db from '../src/core/db';
import { type MoveEvaluation, type Puzzle, makeGame } from '../src/core/models';
import * as puzzleKind from '../src/core/puzzleKind';
import { type Db, openMemoryDb } from '../src/core/sqlite';
import * as themeStats from '../src/core/themeStats';
import { nowIso } from '../src/core/time';
import * as weekly from '../src/core/weekly';
import * as goals from '../src/core/goals';

const START = STARTING_FEN;
const ev = (ply: number, fen: string, move: string, best: string, before: number, after: number): MoveEvaluation => ({
  game_id: 'g1', ply, fen_before: fen, move_uci: move, best_move_uci: best, cp_before: before, cp_after: after, depth: 14,
  second_move_uci: null, cp_second: null, third_move_uci: null, cp_third: null,
});

describe('Themes and This week', () => {
  let conn: Db;
  let p: Puzzle;

  beforeEach(async () => {
    conn = db.initDb(await openMemoryDb());
    db.saveGame(conn, makeGame({ id: 'g1', chess_com_url: 'u', pgn: '[Event "x"]\n[WhiteElo "1500"]\n\n1. e4 e5 *\n',
      played_at: nowIso(), time_control: '300', my_color: 'white', opponent_username: 'opp', result: 'loss' }));
    const evals = [ev(0, START, 'e2e4', 'd2d4', 30, -400)];
    db.saveGameEvaluations(conn, 'g1', evals);
    [p] = analyzer.puzzlesFromEvaluations(evals, 150);
    db.replacePuzzlesForGames(conn, ['g1'], [p]);
    puzzleKind.save(conn, p.id, new puzzleKind.Result(['d2d4'], 'Counterattack'));
  });

  it('theme rates from first tries', () => {
    for (const correct of [false, false, true]) db.recordAttempt(conn, 'puzzle', p.id, correct, correct ? 'correct' : 'missed');
    const rows = new Map(themeStats.themeRows(conn).map((r) => [r.tag, r]));
    expect([rows.get('Counterattack')!.solved, rows.get('Counterattack')!.tries]).toEqual([1, 3]);
    expect(rows.has('One move')).toBe(false);                     // length isn't a theme
    expect(themeStats.themeRows(conn)[0].tag).toBe('Counterattack');
  });

  it('costliest means lost winning chances, not pawns', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const evals = [ev(0, START, 'e2e4', 'd2d4', -900, -analyzer.MATE_CP),     // already lost, then mated
      ev(1, afterE4, 'e7e5', 'c7c5', 400, -400)];                              // winning -> losing
    db.saveGameEvaluations(conn, 'g1', evals);
    db.replacePuzzlesForGames(conn, ['g1'], analyzer.puzzlesFromEvaluations(evals, 150));
    const top = weekly.review(conn).mistakes;
    // the blunder when already lost isn't even a puzzle (analyzer.MIN_CHANCES_LOST)
    expect(top.map((m) => m.played_san)).toEqual(['e5']);
    expect(top[0].swingText()).toContain('winning → losing');
  });

  it('saved puzzles are refiltered in place', () => {
    const [lost] = analyzer.puzzlesFromEvaluations([ev(0, START, 'e2e4', 'd2d4', 30, -400)], 150);
    db.replacePuzzlesForGames(conn, ['g2'], [{ ...lost, eval_before_cp: -900, eval_after_cp: -analyzer.MATE_CP, id: 'old' }]);
    conn.run("UPDATE puzzles SET source_game_id = 'g2', puzzle_type = 'Mistake' WHERE id = ?", [p.id]);
    expect(analyzer.applyChancesRule(conn)).toEqual([1, 1]);                  // 30 -> -400 is a blunder
    expect(db.allPuzzles(conn).map((x) => [x.id, x.puzzle_type, x.kind])).toEqual([[p.id, 'Blunder', 'Counterattack']]);   // kind kept
  });

  it('the week finds the mistake and the threat pattern', () => {
    const w = weekly.review(conn);
    expect([w.games, w.losses, w.analyzed, w.mistake_count, w.facing_threat]).toEqual([1, 1, 1, 1, 1]);
    expect(w.mistakes[0].played_san).toBe('e4');
    expect(w.suggestions.map((s) => s.action)).toContain('threats');
  });

  it('the week by time control: only that kind of game, the practice for the whole week', () => {
    db.saveGame(conn, makeGame({ id: 'g2', chess_com_url: 'u2', pgn: '[Event "x"]\n\n1. d4 d5 *\n',
      played_at: nowIso(), time_control: '180+2', my_color: 'black', opponent_username: 'opp2', result: 'win' }));
    db.recordAttempt(conn, 'puzzle', p.id, true, 'correct');
    const all = weekly.review(conn);
    expect(all.time_controls).toEqual([{ time_control: '180+2', games: 1 }, { time_control: '300', games: 1 }]);
    expect([all.games, all.wins, all.losses, all.mistake_count]).toEqual([2, 1, 1, 1]);
    const blitz = weekly.review(conn, new Date(), '180+2');
    expect([blitz.games, blitz.wins, blitz.losses, blitz.analyzed, blitz.mistake_count]).toEqual([1, 1, 0, 0, 0]);
    expect(blitz.puzzles_tried).toBe(all.puzzles_tried);         // practice isn't tied to a game
    expect(weekly.review(conn, new Date(), '300').mistake_count).toBe(1);
  });
});

describe('your goals', () => {
  let conn: Db;
  beforeEach(async () => { conn = db.initDb(await openMemoryDb()); });

  it('short and long term, a target date, ticked off, removed — kept in the database', () => {
    goals.add(conn, 'long', 'Reach 1500 in rapid');
    goals.add(conn, 'short', '20 puzzles this week', '2026-10-30');
    goals.add(conn, 'short', '  ');                                 // empty: ignored
    const short = goals.list(conn).filter((g) => g.horizon === 'short');
    expect(short.map((g) => [g.text, g.due, g.done])).toEqual([['20 puzzles this week', '2026-10-30', null]]);
    const done = goals.toggle(conn, short[0].id).find((g) => g.id === short[0].id)!;
    expect(done.done).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(goals.list(conn).map((g) => g.text)).toEqual(['Reach 1500 in rapid', '20 puzzles this week']);   // open first, done last
    expect(goals.toggle(conn, short[0].id).find((g) => g.id === short[0].id)!.done).toBeNull();          // opened again
    expect(goals.remove(conn, short[0].id).map((g) => g.text)).toEqual(['Reach 1500 in rapid']);
  });

  it('a bad saved value reads as no goals', () => {
    conn.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('goals', 'not json')");
    expect(goals.list(conn)).toEqual([]);
  });
});
