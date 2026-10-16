// Part 6 of the golden checks (tools/golden_core6.py, prototype 67e3b53+):
// amazing moves, missed sacrifices, accuracy, My games, the opening library
// (Lichess's real TSVs), line descriptions, your games per line, opening
// principles, themes, skills, the week and the one-off puzzle fixes.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import * as amazing from '../src/core/amazing';
import * as analyzer from '../src/core/analyzer';
import { Board } from '../src/core/chess';
import * as db from '../src/core/db';
import * as libraryCharacter from '../src/core/libraryCharacter';
import { TIME_FILTERS } from '../src/core/models';
import * as myLines from '../src/core/myLines';
import * as myOpenings from '../src/core/myOpenings';
import * as commentary from '../src/core/openingCommentary';
import * as library from '../src/core/openingLibrary';
import { type Db, openMemoryDb } from '../src/core/sqlite';
import type { Record } from '../src/core/stats';
import * as themeStats from '../src/core/themeStats';
import { fromIso } from '../src/core/time';
import * as weekly from '../src/core/weekly';

const FIXTURE = new URL('./golden/core6.json', import.meta.url);
const DB_FILE = fileURLToPath(new URL('./golden/chessprep.snapshot.db', import.meta.url));   // tools/snapshot.py
const ready = existsSync(FIXTURE) && existsSync(DB_FILE);
const golden = ready ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;
const rec = (r: Record) => [r.wins, r.draws, r.losses];
const snapshot = async () => db.initDb(await openMemoryDb(new Uint8Array(readFileSync(DB_FILE))));
/** Python's sorted() on lists: element by element (strings by code point, null first). */
function byJson(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = byJson(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return (a as any) < (b as any) ? -1 : 1;
}

describe.skipIf(!ready)(`new modules match the Python prototype (commit ${golden?.commit})`, () => {
  let conn: Db;
  beforeAll(async () => {
    conn = await snapshot();
  });

  it('finds the same amazing moves, missed sacrifices and game accuracies', () => {
    const allDirect = conn.all(
      `SELECT e.game_id, e.ply, e.fen_before, e.move_uci, e.cp_before, e.cp_after FROM move_evaluations e
       JOIN games g ON g.id = e.game_id
       WHERE e.cp_after IS NOT NULL AND e.cp_before - e.cp_after <= ? AND e.cp_before < ? AND e.cp_after > ?
       ORDER BY g.played_at DESC, e.ply`, [amazing.NEAR_BEST_CP, amazing.WINNING_CP, amazing.BAD_AFTER_CP])
      .map((r) => [r, amazing.isAmazing(r.fen_before, r.move_uci, r.cp_before, r.cp_after)] as const)
      .filter(([, size]) => size)
      .map(([r, size]) => [r.game_id, r.ply, Board.fromFen(r.fen_before).san(r.move_uci), size, r.cp_before, r.cp_after, r.fen_before, r.move_uci]);
    expect(allDirect).toEqual(golden.amazing);
    expect(amazing.findMissed(conn, false).map((m) => Object.values(m))).toEqual(golden.missed);
    const evals = new Map<string, { cp_before: number; cp_after: number | null }[]>();
    for (const r of conn.all<{ game_id: string; cp_before: number; cp_after: number | null }>(
      'SELECT game_id, cp_before, cp_after FROM move_evaluations')) {
      if (!evals.has(r.game_id)) evals.set(r.game_id, []);
      evals.get(r.game_id)!.push(r);
    }
    const acc = [...evals].map(([g, e]) => [g, amazing.gameAccuracy(e)] as [string, number | null]).sort(byJson);
    expect(acc.map(([g]) => g)).toEqual(golden.accuracy.map((a: any) => a[0]));
    acc.forEach(([, a], i) => {
      if (golden.accuracy[i][1] === null) expect(a).toBeNull();
      else expect(a!).toBeCloseTo(golden.accuracy[i][1], 9);
    });
    // and the saved scan agrees with the direct search
    expect(amazing.findAll(conn).map((a) => [a.game_id, a.ply, a.san])).toEqual(golden.amazing.map((a: any) => a.slice(0, 3)));
  });

  it('My games: the same openings and deviations, for every time filter', () => {
    for (const [name, classes] of Object.entries(TIME_FILTERS)) {
      const r = myOpenings.compute(conn, classes);
      const g = golden.my_openings[name];
      expect(r.games, name).toBe(g.games);
      expect(r.openings.map((o) => [o.name, o.color, rec(o.record), o.followed, o.left, o.no_prep, [...o.deviation_keys]]), name)
        .toEqual(g.openings);
      expect(r.deviations.map((d) => [d.color, d.prefix, d.fen, d.played_uci, d.played_san, d.prep_ucis, d.prep_sans, rec(d.record),
        rec(d.prep_record), d.opening, d.repertoires, d.game_ids, d.line, d.move_number]), name).toEqual(g.deviations);
      expect(r.opponent_deviations.map((o) => [o.color, o.prefix, o.fen, o.played_uci, o.played_san, o.prep_ucis, o.prep_sans,
        rec(o.record), [...o.replies], o.opening, o.game_ids, o.usual_reply]), name).toEqual(g.opponent);
    }
  });

  it('notes the same opening principles for each of your deviations', () => {
    const got: unknown[] = [];
    for (const d of myOpenings.compute(conn).deviations) {
      const board = Board.fromFen();
      for (const san of d.prefix) board.pushSan(san);
      for (const uci of [d.played_uci, ...d.prep_ucis]) {
        got.push([d.key, uci, commentary.principles(board, uci).map((f) => [f.good, f.text])]);
      }
    }
    expect(got).toEqual(golden.principles);
  });

  it("parses Lichess's opening files and describes every line the same way", () => {
    const rows = library.PARTS.split('').flatMap((part) => library.parse(golden.tsvs[part]));
    expect(rows).toEqual(golden.library_rows);
    return Promise.all(rows.map((row, i) => libraryCharacter.describe(null, new library.Opening(i + 1, row.eco, row.name, row.family,
      row.pgn, row.sans.split(' '), row.ucis.split(' '))))).then((described) => {
      expect(described.map((c) => [c.label, c.score, c.text])).toEqual(golden.described);
    });
  });

  it('matches your games to the same library lines, with the same records', async () => {
    const c2 = await snapshot();
    library.save(c2, golden.library_rows);
    const positions = myLines.libraryPositions(c2);
    const matches = c2.all('SELECT id, pgn FROM games').map((r) => [r.id, ...myLines.matchGame(r.pgn, positions)]).sort(byJson);
    expect(matches).toEqual(golden.matches);
    myLines.save(c2, matches as [string, number | null, number][]);
    const names = new Map(library.search(c2, '', null, 100000).map((o) => [o.id, o.name]));
    const recs = [...myLines.records(c2).values()].map((r) => [names.get(r.library_id), r.color, rec(r.record), r.loss_sum,
      r.loss_moves, r.blunders, r.eval_sum, r.eval_games, [...r.game_ids].sort(), myLines.describe(r)]).sort(byJson);
    expect(recs).toEqual(golden.line_records);
  });

  it('themes, skills and the week', () => {
    expect(themeStats.themeRows(conn, '2026-09-15').map((t) => [t.tag, t.tries, t.solved, t.near, t.recent_tries,
      t.recent_solved, t.yours])).toEqual(golden.themes);
    expect(themeStats.skills(conn).map((s) => [s.name, s.hits, s.total])).toEqual(golden.skills);
    const w = weekly.review(conn, fromIso(golden.week_today));
    const g = golden.week;
    expect([w.start, w.games, w.wins, w.losses, w.draws, w.analyzed, [w.rating_class, w.rating_from, w.rating_to]])
      .toEqual([g.start, g.games, g.wins, g.losses, g.draws, g.analyzed, g.rating]);
    expect(w.mistakes.map((m) => [m.puzzle_id, m.game_id, m.move_number, m.played_san, m.best_san, m.before_cp, m.after_cp,
      m.kind, m.puzzle_type, m.swingText()])).toEqual(g.mistakes.map((m: any[]) => [...m.slice(0, 9), m[10]]));
    w.mistakes.forEach((m, i) => expect(m.cost).toBeCloseTo(g.mistakes[i][9], 9));
    expect([w.mistake_count, w.facing_threat, w.endgame, w.common_type, w.common_type_count, w.puzzles_tried,
      w.puzzles_solved, w.spot_rounds, w.threat_rounds, w.lines_drilled]).toEqual(g.counts);
    expect(w.suggestions.map((s) => [s.text, s.action, s.arg])).toEqual(g.suggestions);
  });

  it('the one-off puzzle fixes change the same puzzles', async () => {
    for (const [fix, want] of [[analyzer.applyChancesRule, golden.chances_rule], [analyzer.addMissedSacrifices, golden.missed_sacrifices]] as const) {
      const c = await snapshot();
      expect((fix as (c: Db) => [number, number])(c)).toEqual(want[0]);
      expect(c.all('SELECT source_game_id, fen, correct_move_uci, puzzle_type FROM puzzles')
        .map((r) => [r.source_game_id, r.fen, r.correct_move_uci, r.puzzle_type]).sort(byJson)).toEqual(want[1]);
    }
  });
});
