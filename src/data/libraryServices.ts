/**
 * Opening Drill → Add lines → Opening library (library_window.py's database
 * work), in the database worker: every named opening (the pre-built
 * public/openings/library.json, loaded once), searched and filtered, each
 * flagged ✓ in your repertoire / ◐ partly / ○ not yet, with your record in
 * the games that reached it (my_lines.ts), and added to a repertoire.
 */
import { Board } from '../core/chess';
import type { PlayerColor } from '../core/models';
import * as myLines from '../core/myLines';
import * as openingImporter from '../core/openingImporter';
import * as openingLibrary from '../core/openingLibrary';
import type { Db } from '../core/sqlite';
import * as style from '../core/style';

export const LIMIT = 600;                  // lines listed at once
export const SHOW_ALL = 'All lines';
export const SHOW_IN = 'In my repertoire';
export const SHOW_OUT = 'Not in my repertoire';
export const SHOW_PLAYED = 'Played in my games';
export const BOOK = 'Book order';
export const MOST = 'Most played';
export const BEST = 'Played best';
export const WORST = 'Played worst';
export const FLAGS: Record<string, string> = { in: '✓', partly: '◐', out: '○' };

export interface LibraryRowView {
  id: number;
  label: string;          // "✓ [55% in 12]  B90  Najdorf · 6. Be3  · Sharp"
  flag: string;           // in / partly / out
}

export interface LibrarySearch {
  query: string;
  family: string | null;
  character: string | null;
  show: string;
  sort: string;
  /** Only lines for this side (null: both). */
  side?: PlayerColor | null;
}

/** Whose opening a line is: the side that made its last (defining) move — the Sicilian (…c5) is Black's,
 *  the Ruy Lopez (Bb5) White's. */
export const sideOf = (o: { plies: number }): PlayerColor => (o.plies % 2 === 1 ? 'white' : 'black');

export function libraryCount(conn: Db): number {
  return openingLibrary.count(conn);
}

/** The pre-built library into the database (once). */
export function libraryLoad(conn: Db, built: { columns: string[]; rows: unknown[][] }): number {
  openingLibrary.save(conn, openingLibrary.fromBuilt(built));
  return openingLibrary.count(conn);
}

export function libraryFamilies(conn: Db): [string, number][] {
  return openingLibrary.families(conn);
}

/** Your record per line and your style change only with new games or matches: worked out once, then reused. */
let cached: { key: string; recs: Map<number, myLines.LineRecord[]>; style: string | null | undefined } | null = null;

function cacheFor(conn: Db) {
  const key = `${conn.get('SELECT COUNT(*) AS n FROM games')!.n}|${conn.get('SELECT COUNT(*) AS n FROM game_lines')!.n}`;
  if (cached?.key !== key) cached = { key, recs: myLines.byLibraryId(myLines.records(conn)), style: undefined };
  return cached;
}

function yourStyle(conn: Db): string | null {
  const c = cacheFor(conn);
  if (c.style === undefined) {
    try {
      c.style = style.computeStyle(conn).style;
    } catch {
      c.style = null;
    }
  }
  return c.style;
}

const mine = (conn: Db) => ({ white: openingLibrary.repertoireMoves(conn, 'white'), black: openingLibrary.repertoireMoves(conn, 'black') });

/** The list (_search + _sorted): filtered, sorted, at most LIMIT lines. */
export function librarySearch(conn: Db, s: LibrarySearch): { rows: LibraryRowView[]; total: number; countText: string } {
  const found = openingLibrary.search(conn, s.query, s.family, 10_000, s.character);
  const reps = mine(conn);
  const recs = cacheFor(conn).recs;
  let rows: [openingLibrary.Opening, string][] = [];
  for (const o of found) {
    // a side's lines: its own openings, any line you've played with that colour, and any in that colour's repertoire
    if (s.side && sideOf(o) !== s.side && !(recs.get(o.id) ?? []).some((r) => r.color === s.side)
      && openingLibrary.status(o, { [s.side]: reps[s.side] ?? new Set() })[0] !== 'in') continue;
    const [flag] = openingLibrary.status(o, reps);
    if ((s.show === SHOW_IN && flag !== 'in') || (s.show === SHOW_OUT && flag === 'in')) continue;
    if (s.show === SHOW_PLAYED && !recs.has(o.id)) continue;
    rows.push([o, flag]);
  }
  rows = sorted(rows, s.sort, recs).slice(0, LIMIT);
  // all one family: show just the variation, so the part that differs isn't cut off
  const oneFamily = new Set(rows.map(([o]) => o.family)).size === 1;
  const views = rows.map(([o, flag]): LibraryRowView => {
    const label = oneFamily ? (o.variation || o.name) : o.name;
    const char = o.character ? `  · ${o.character}` : '';
    const lineRecs = recs.get(o.id)?.filter((r) => !s.side || r.color === s.side);
    let you = '';
    if (lineRecs?.length) {                      // up front: long names would hide it at the end
      const games = lineRecs.reduce((n, r) => n + r.games, 0);
      const points = lineRecs.reduce((n, r) => n + r.record.wins + 0.5 * r.record.draws, 0);
      you = `[${Math.round((points / games) * 100)}% in ${games}]  `;
    }
    return { id: o.id, flag, label: `${FLAGS[flag]} ${you}${o.eco}  ${label} · ${o.last_move}${char}` };
  });
  const total = openingLibrary.count(conn);
  const shown = `${views.length} line${views.length !== 1 ? 's' : ''}`
    + (views.length >= LIMIT ? ` (the first ${LIMIT} — search or pick a family to narrow it)` : '')
    + (s.family ? ` · ${s.family}` : '');
  return { rows: views, total, countText: `${total.toLocaleString()} named openings · showing ${shown}` };
}

/** Book order, or by your games: most played / played best / played worst. */
function sorted(rows: [openingLibrary.Opening, string][], sort: string, recs: Map<number, myLines.LineRecord[]>) {
  if (sort === BOOK) return rows;
  if (sort === MOST) {
    const games = (id: number) => (recs.get(id) ?? []).reduce((n, r) => n + r.games, 0);
    return [...rows].sort((a, b) => games(b[0].id) - games(a[0].id));
  }
  const sign = sort === BEST ? -1 : 1;
  const key = (o: openingLibrary.Opening): number[] => {
    const list = recs.get(o.id) ?? [];
    const rec = list.length ? list.reduce((a, b) => (b.games > a.games ? b : a)) : null;
    if (!rec || rec.games < myLines.MIN_GAMES) return [1, 0, 0];
    const loss = rec.avg_loss ?? 0.5;
    return [0, sign * rec.rating, -sign * loss];
  };
  return [...rows].sort((a, b) => {
    const [ka, kb] = [key(a[0]), key(b[0])];
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

export interface LibraryDetail {
  id: number;
  title: string;          // "B90 · Sicilian Defense: Najdorf Variation"
  pgn: string;
  fen: string;
  orientation: 'white' | 'black';
  flag: string;
  flagColor: string | null;
  covered: number;
  plies: number;
  character: string | null;
  description: string | null;
  evalCp: number | null;
  games: string[];        // my_lines.describe per colour
  gameIds: string[];
  style: string | null;   // your style (Stats): sharp / quiet / balanced
}

export function libraryDetail(conn: Db, id: number): LibraryDetail | null {
  const [o] = openingLibrary.get(conn, [id]);
  if (!o) return null;
  const board = Board.fromFen();
  for (const uci of o.ucis) board.push(uci);
  const [flag, color, n] = openingLibrary.status(o, mine(conn));
  const recs = cacheFor(conn).recs.get(o.id) ?? [];
  return {
    id: o.id, title: `${o.eco} · ${o.name}`, pgn: o.pgn, fen: board.fen(),
    // from the side that plays the last move (that's usually whose opening it is)
    orientation: board.turn === 'white' ? 'black' : 'white',
    flag, flagColor: color, covered: n, plies: o.plies, character: o.character, description: o.description, evalCp: o.eval_cp,
    games: recs.map((r) => myLines.describe(r)), gameIds: recs.flatMap((r) => r.game_ids), style: yourStyle(conn),
  };
}

/** The picked lines into a repertoire: how many new moves. */
export function libraryAdd(conn: Db, ids: number[], name: string, color: PlayerColor): number {
  return openingImporter.importPgnText(openingLibrary.toPgn(openingLibrary.get(conn, ids)), name, color, conn);
}

/** Your games matched to the library's lines (once per game): how many were new. */
export function libraryMatchGames(conn: Db): number {
  const todo = myLines.unmatched(conn);
  if (todo.length) myLines.save(conn, myLines.matchAll(conn, todo));
  return todo.length;
}

export const libraryServices = {
  libraryCount, libraryLoad, libraryFamilies, librarySearch, libraryDetail, libraryAdd, libraryMatchGames,
};
