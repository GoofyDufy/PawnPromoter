// The core modules must give the Python prototype's answers on your real data.
// Fixtures: tools/golden_core.py, both reading the frozen snapshot from
// tools/snapshot.py (loaded into memory here — never written).
// Skipped when the fixtures or the database aren't there.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { puzzlesFromEvaluations } from '../src/core/analyzer';
import * as db from '../src/core/db';
import { TIME_FILTERS, timeClass } from '../src/core/models';
import { type Db, openMemoryDb } from '../src/core/sqlite';

const FIXTURE = new URL('./golden/core.json', import.meta.url);
const DB_FILE = fileURLToPath(new URL('./golden/chessprep.snapshot.db', import.meta.url));   // tools/snapshot.py
const ready = existsSync(FIXTURE) && existsSync(DB_FILE);
const golden = ready ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;

const asObject = <V>(m: Map<string, V>) => Object.fromEntries(m);

describe.skipIf(!ready)(`core matches the Python prototype (commit ${golden?.commit})`, () => {
  let conn: Db;
  beforeAll(async () => {
    conn = db.initDb(await openMemoryDb(new Uint8Array(readFileSync(DB_FILE))));
  });

  it('generates the same puzzles from every cached evaluation, at two blunder sizes', () => {
    const evals = db.allEvaluationsByGame(conn);
    for (const threshold of [150, 300]) {
      const out: unknown[] = [];
      for (const gameId of [...evals.keys()].sort()) {
        for (const p of puzzlesFromEvaluations(evals.get(gameId)!, threshold)) {
          out.push([p.source_game_id, p.fen, p.correct_move_san, p.played_move_san, p.eval_swing_cp, p.puzzle_type]);
        }
      }
      expect(out.length).toBe(golden.puzzles[threshold].length);
      expect(out).toEqual(golden.puzzles[threshold]);
    }
  });

  it('counts games and queues analysis the same way for every time filter', () => {
    for (const [name, classes] of Object.entries(TIME_FILTERS)) {
      expect(db.gameStats(conn, classes), name).toEqual(golden.game_stats[name]);
      expect(db.gamesNeedingEvaluation(conn, 50, classes).map((g) => g.id), name).toEqual(golden.needing_eval[name]);
    }
  });

  it('agrees on weak spots, puzzle records and weekly attempts', () => {
    for (const t of ['puzzle', 'line']) {
      expect(asObject(db.weakItemIds(conn, t))).toEqual(golden.weak[t]);
      expect(db.attemptsByWeek(conn, t)).toEqual(golden.by_week[t]);
    }
    expect(asObject(db.puzzleRecords(conn))).toEqual(golden.records);
  });

  it('agrees on repertoires, first moves, puzzle types and time classes', () => {
    expect(db.listRepertoires(conn).sort()).toEqual(golden.repertoires);
    for (const c of ['white', 'black']) expect(db.firstMoves(conn, c)).toEqual(golden.first_moves[c]);
    expect(db.distinctPuzzleTypes(conn)).toEqual(golden.types);
    for (const [tc, expected] of Object.entries(golden.time_classes)) expect(timeClass(tc), tc).toBe(expected);
  });
});
