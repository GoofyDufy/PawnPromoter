// Part 3 of the golden checks (tools/golden_core3.py): repertoire import of
// every .pgn in ~/Chess, gaps from your games and from the cached Lichess
// explorer data, scouting, opening notes, the catalog and rating bands — on
// your real data (read-only copies). Skipped without fixtures / database.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import * as db from '../src/core/db';
import * as explorer from '../src/core/explorer';
import { TIME_FILTERS } from '../src/core/models';
import { importPgnText } from '../src/core/openingImporter';
import { notesFor } from '../src/core/openingNotes';
import { CATALOG, fit, yourRecord } from '../src/core/openingsCatalog';
import * as gaps from '../src/core/repertoireGaps';
import { scoutLines } from '../src/core/scouting';
import { type Db, openMemoryDb } from '../src/core/sqlite';
import * as stats from '../src/core/stats';

// the committed .pgn files, from the prototype copy tools/golden_common.py extracts
const CHESS = fileURLToPath(new URL('./golden/prototype/', import.meta.url));
const FIXTURE = new URL('./golden/core3.json', import.meta.url);
const DB_FILE = fileURLToPath(new URL('./golden/chessprep.snapshot.db', import.meta.url));   // tools/snapshot.py
const ready = existsSync(FIXTURE) && existsSync(DB_FILE);
const golden = ready ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;
const rec = (r: stats.Record) => [r.wins, r.draws, r.losses];

/** Opening lines as [path of UCIs from the root, fields] — ids differ between runs. */
function treeRows(c: Db) {
  const rows = new Map(c.all('SELECT * FROM opening_lines').map((r) => [r.id, r]));
  const path = (r: any) => {
    const out: string[] = [];
    while (r) { out.push(r.move_uci); r = rows.get(r.parent_id); }
    return out.reverse();
  };
  const cmp = (a: unknown, b: unknown) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return [...rows.values()].map((r) => [r.repertoire_name, r.my_color, r.line_name, path(r).join(' '), r.move_san,
    r.fen_before_move, r.fen_after_move, r.move_number, r.is_line_end, r.notes]).sort(cmp);
}

describe.skipIf(!ready)('repertoire import, gaps, scouting, notes and catalog match the Python prototype', () => {
  let conn: Db;
  beforeAll(async () => {
    conn = db.initDb(await openMemoryDb(new Uint8Array(readFileSync(DB_FILE))));
  });

  it('imports every repertoire PGN into the same tree (and re-imports add nothing)', async () => {
    for (const [file, g] of Object.entries<any>(golden.imports)) {
      const c = db.initDb(await openMemoryDb());
      const text = readFileSync(join(CHESS, file), 'utf8');
      const name = file.replace(/\.pgn$/, '');
      expect(importPgnText(text, name, g.color, c), file).toBe(g.added);
      expect(importPgnText(text, name, g.color, c), file).toBe(g.again);
      const rows = treeRows(c);
      const want = [...g.rows].sort((a: unknown, b: unknown) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      expect(rows.length, file).toBe(want.length);
      expect(rows, file).toEqual(want);
    }
  });

  it('finds the same gaps and common lines in your games, for every time filter', () => {
    for (const [name, classes] of Object.entries(TIME_FILTERS)) {
      const r = gaps.compute(conn, classes);
      const g = golden.gaps[name];
      expect(r.games, name).toBe(g.games);
      expect(r.has_repertoire, name).toEqual(g.has_repertoire);
      expect([...r.first_moves], name).toEqual(g.first_moves);
      expect(r.gaps.map((x) => [x.color, x.prefix, x.move, x.by_opponent, x.covered, rec(x.record), x.opening,
        x.suggestion, x.suggestion_source, x.game_ids, x.line, x.who]), name).toEqual(g.gaps);
      expect(r.common.map((c) => [c.color, c.sans, rec(c.record), c.opening, c.in_repertoire, c.game_ids]), name)
        .toEqual(g.common);
    }
  });

  it('finds the same popular gaps from the cached Lichess data', () => {
    const bands = explorer.ratingBands(conn);
    expect([bands, explorer.myRecentRating(conn), explorer.describeBands(bands)])
      .toEqual([golden.bands, golden.rating, golden.describe]);
    const popular = gaps.popularGaps(conn, (fen) => explorer.cached(conn, fen, bands));
    expect(popular.length).toBe(golden.popular.length);
    for (const [i, p] of popular.entries()) {
      const [color, prefix, move, share, reach, games, score, suggestion, source, line] = golden.popular[i];
      expect([p.color, p.prefix, p.move, p.games, p.suggestion, p.suggestion_source, p.line], line)
        .toEqual([color, prefix, move, games, suggestion, source, line]);
      expect(p.share).toBeCloseTo(share, 12);
      expect(p.reach).toBeCloseTo(reach, 12);
      expect(p.opponent_score).toBeCloseTo(score, 12);
    }
    expect(explorer.opponentPositions(conn)).toEqual(golden.opponent_positions);
  });

  it('scouts the same lines (your own games standing in for an opponent)', () => {
    const games = conn.all('SELECT * FROM games ORDER BY played_at').map(db.rowToGame);
    for (const [name, classes] of Object.entries(TIME_FILTERS)) {
      const s = scoutLines(conn, games, classes);
      const g = golden.scout[name];
      expect(s.games, name).toBe(g.games);
      for (const color of ['white', 'black'] as const) {
        expect(s[color].map((l) => ({ ...l, score: undefined })), name)
          .toEqual(g[color].map((l: any) => ({ ...l, score: undefined })));
        s[color].forEach((l, i) => expect(l.score).toBeCloseTo(g[color][i].score, 12));
      }
    }
  });

  it('picks the same opening notes and catalog records', () => {
    for (const [name, title] of golden.notes) expect(notesFor(name)?.title ?? null, name).toBe(title);
    const records = stats.compute(conn).openings;
    expect(CATALOG.map((o) => [o.name, (() => { const r = yourRecord(o, records); return r ? rec(r) : null; })(),
      ['sharp', 'quiet', 'balanced', null].map((s) => fit(s, o))])).toEqual(golden.catalog);
  });
});
