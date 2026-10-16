// Part 5 of the golden checks (tools/golden_core5.py, prototype b483c26):
// Lichess puzzles imported from the real packs in public/lichess/, answer kinds
// for every puzzle, automatic tags, and the Lichess puzzles / tags already in
// your snapshot. Skipped without fixtures / snapshot.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as db from '../src/core/db';
import * as lichess from '../src/core/lichessPuzzles';
import type { Puzzle } from '../src/core/models';
import * as progression from '../src/core/progression';
import * as puzzleKind from '../src/core/puzzleKind';
import * as tags from '../src/core/puzzleTags';
import { type Db, openMemoryDb } from '../src/core/sqlite';
import * as stats from '../src/core/stats';
import * as style from '../src/core/style';

const FIXTURE = new URL('./golden/core5.json', import.meta.url);
const DB_FILE = fileURLToPath(new URL('./golden/chessprep.snapshot.db', import.meta.url));   // tools/snapshot.py
const PACKS = new URL('../public/lichess/', import.meta.url);
const ready = existsSync(FIXTURE) && existsSync(DB_FILE);
const golden = ready ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;

/** fetch() for the packs on disk, as the browser would get them from the app. */
const diskFetch = (async (url: string) => new Response(readFileSync(new URL(url.replace(/^\/lichess\//, ''), PACKS)) as unknown as BodyInit)) as typeof fetch;

const puzzleJson = (p: Puzzle) => [p.id, p.fen, p.correct_move_san, p.correct_move_uci, p.puzzle_type, p.kind,
  p.solution_ucis, p.solution_moves, p.rating, p.themes, p.game_url, p.opening, p.setup_fen, p.setup_uci,
  tags.autoTags(p, false, false), lichess.niceThemes(p.themes)];

describe.skipIf(!ready)(`Lichess puzzles, kinds and tags match the Python prototype (packs ${golden?.packs_built})`, () => {
  let conn: Db;
  beforeAll(async () => {
    conn = db.initDb(await openMemoryDb(new Uint8Array(readFileSync(DB_FILE))));
  });

  it('imports the same puzzles from the packs as the prototype: three rating ranges and three themes', async () => {
    for (const g of golden.imports) {
      const [low, high, count] = g.range;
      const c = db.initDb(await openMemoryDb());
      const rows = await lichess.packRows(low, high, '/lichess/', diskFetch, g.theme);
      const found = await lichess.download(low, high, count, new Set(), (b) => lichess.save(c, b), () => false, rows,
        undefined, 500, g.theme);
      expect(found, `${low}-${high}`).toBe(g.found);
      expect(lichess.ratingSpan(c)).toEqual(g.span);
      const saved = c.all('SELECT * FROM lichess_puzzles ORDER BY id');
      expect(saved.map((r) => [r.id, r.setup_fen, r.setup_uci, r.fen, r.solution_ucis, r.rating, r.popularity, r.plays,
        r.themes, r.game_url, r.opening]), `${low}-${high}`).toEqual(g.rows);
      expect(saved.map((r) => puzzleJson(lichess.toPuzzle(r))), `${low}-${high}`).toEqual(g.puzzles);
    }
  });

  it('gives every puzzle the same answer kind (Counterattack / Defensive)', () => {
    const puzzles = new Map(conn.all('SELECT * FROM puzzles').map((r) => [r.id, db.rowToPuzzle(r)]));
    for (const [id, kind] of golden.answer_kinds) {
      const p = puzzles.get(id)!;
      expect(puzzleKind.answerKind(Board.fromFen(p.fen), p.correct_move_uci), p.fen).toBe(kind);
    }
  });

  it('tags your puzzles the same way, and reads your Lichess puzzles, tags and records', () => {
    const own = conn.all('SELECT * FROM puzzles ORDER BY id').map(db.rowToPuzzle);
    const sharp = style.puzzleSharpness(conn, own);
    expect(own.map((p) => [p.id, tags.autoTags(p, sharp.get(p.id)!, stats.isEndgame(p.fen))])).toEqual(golden.own_tags);
    expect(Object.fromEntries(conn.all("SELECT COALESCE(kind, '-') AS k, COUNT(*) AS n FROM puzzles GROUP BY 1")
      .map((r) => [r.k, r.n]))).toEqual(golden.kinds_in_db);
    expect(conn.all('SELECT * FROM lichess_puzzles ORDER BY id').map((r) => puzzleJson(lichess.toPuzzle(r))))
      .toEqual(golden.lichess_have);
    expect([...tags.allUserTags(conn)].map(([k, v]) => [k, [...v].sort()]).sort()).toEqual(golden.user_tags);
    expect(Object.fromEntries(db.puzzleRecords(conn, lichess.ITEM_TYPE))).toEqual(golden.lichess_records);
    expect(progression.totalXp(conn)).toBe(golden.xp);
  });
});
