// Part 2 of the golden checks (tools/golden_core2.py): stats, style, progress,
// XP, puzzle sharpness, explanations and the forcing-move test, on your real
// data (read-only in-memory copy). Skipped without fixtures / database.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as db from '../src/core/db';
import { explainAttempt, explainSolution } from '../src/core/explain';
import { TIME_FILTERS } from '../src/core/models';
import * as progressData from '../src/core/progressData';
import { fromIso } from '../src/core/time';
import * as progression from '../src/core/progression';
import * as spot from '../src/core/spot';
import { type Db, openMemoryDb } from '../src/core/sqlite';
import * as stats from '../src/core/stats';
import * as style from '../src/core/style';

const FIXTURE = new URL('./golden/core2.json', import.meta.url);
const DB_FILE = fileURLToPath(new URL('./golden/chessprep.snapshot.db', import.meta.url));   // tools/snapshot.py
const ready = existsSync(FIXTURE) && existsSync(DB_FILE);
const golden = ready ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;

const rec = (r: stats.Record) => [r.wins, r.draws, r.losses];
const phase = (p: stats.PhaseStat) => [p.moves, p.total_loss, p.blunders];

describe.skipIf(!ready)('stats, style, progress, XP and explanations match the Python prototype', () => {
  let conn: Db;
  beforeAll(async () => {
    conn = db.initDb(await openMemoryDb(new Uint8Array(readFileSync(DB_FILE))));
  });

  it('weakness stats for every time filter', () => {
    for (const [name, classes] of Object.entries(TIME_FILTERS)) {
      const s = stats.compute(conn, classes);
      expect({
        total_games: s.total_games, engine_games: s.engine_games,
        openings: [...s.openings].map(([k, r]) => [k, rec(r)]),
        loss_reasons: [...s.loss_reasons].map(([tc, v]) => [tc, [...v]]),
        phases: [...s.phases].map(([k, v]) => [k, phase(v)]),
        clock: [...s.clock].map(([k, v]) => [k, phase(v)]),
      }, name).toEqual(golden.stats[name]);
    }
  });

  it('playing style for every time filter', () => {
    for (const [name, classes] of Object.entries(TIME_FILTERS)) {
      const r = style.computeStyle(conn, classes);
      const g = golden.style[name];
      expect({
        games: r.games, multipv_games: r.multipv_games,
        accuracy: [...r.accuracy].map(([k, v]) => [k, phase(v)]),
        only_moves: [r.only_moves, r.only_moves_found], punish: [r.punish_chances, r.punished],
        game_types: [...r.game_types].map(([k, v]) => [k, rec(v)]),
        cutoffs: r.sharp_cutoffs, style: r.style, verdict: r.verdict,
      }, name).toEqual({
        games: g.games, multipv_games: g.multipv_games, accuracy: g.accuracy, only_moves: g.only_moves,
        punish: g.punish, game_types: g.game_types, cutoffs: g.cutoffs, style: g.style, verdict: g.verdict,
      });
      const openings = [...r.openings].map(([k, [record, sharpness]]) => [k, rec(record), sharpness]);
      expect(openings.length, name).toBe(g.openings.length);
      for (const [i, [k, record, sharpness]] of openings.entries()) {
        expect([k, record], name).toEqual(g.openings[i].slice(0, 2));
        expect(sharpness).toBeCloseTo(g.openings[i][2], 12);
      }
    }
  });

  it('progress numbers for every time class', () => {
    for (const tc of ['Rapid', 'Blitz', 'Bullet', 'Daily']) {
      // the date the prototype's answers were recorded on ("this week", "30 days ago" depend on it)
      const p = progressData.compute(conn, tc, 1800, fromIso(golden.progress_today));
      const g = golden.progress[tc];
      expect({ ...p, blunders_per_game_weekly: undefined }, tc)
        .toEqual({ ...g, blunders_per_game_weekly: undefined });
      expect(p.blunders_per_game_weekly.length).toBe(g.blunders_per_game_weekly.length);
      for (const [i, [w, v]] of p.blunders_per_game_weekly.entries()) {
        expect(w).toBe(g.blunders_per_game_weekly[i][0]);
        expect(v).toBeCloseTo(g.blunders_per_game_weekly[i][1], 12);
      }
    }
  });

  it('XP, level, spot summary and puzzle sharpness', () => {
    const xp = progression.totalXp(conn);
    const level = progression.levelFor(xp);
    expect(xp).toBe(golden.xp);
    expect([level.number, level.name, level.xp_into_level, level.xp_for_level]).toEqual(golden.level);
    expect(progression.LEVEL_COSTS).toEqual(golden.level_costs);
    expect({ ...spot.summary(conn) }).toEqual(golden.spot_summary);
    expect(spot.xp(conn)).toBe(golden.spot_xp);
    const puzzles = conn.all('SELECT * FROM puzzles ORDER BY id').map(db.rowToPuzzle);
    const sharp = [...style.puzzleSharpness(conn, puzzles)].sort(([a], [b]) => (a < b ? -1 : 1));
    expect(sharp).toEqual(golden.sharpness);
  });

  it('explains every puzzle word for word (board facts, no engine)', async () => {
    const puzzles = new Map(conn.all('SELECT * FROM puzzles').map((r) => [r.id, db.rowToPuzzle(r)]));
    for (const [id, solution, attempt] of golden.explanations) {
      const p = puzzles.get(id)!;
      const played = p.played_move_san ? Board.fromFen(p.fen).parseSan(p.played_move_san)! : null;
      expect(await explainSolution(p.fen, p.correct_move_uci, played), p.fen).toBe(solution);
      if (played) expect((await explainAttempt(p.fen, played)).text, p.fen).toBe(attempt);
    }
  });

  it("agrees on forcing moves, pawn structure and endgames for every puzzle position", () => {
    const puzzles = new Map(conn.all('SELECT * FROM puzzles').map((r) => [r.id, db.rowToPuzzle(r)]));
    for (const [id, bestForcing, playedForcing, structure, endgame] of golden.forcing) {
      const p = puzzles.get(id)!;
      const board = Board.fromFen(p.fen);
      const played = p.played_move_san ? board.parseSan(p.played_move_san)! : null;
      expect([spot.isForcing(board, p.correct_move_uci), played ? spot.isForcing(board, played) : null,
        style.pawnStructure(p.fen), stats.isEndgame(p.fen)], p.fen)
        .toEqual([bestForcing, playedForcing, structure, endgame]);
    }
  });
});
