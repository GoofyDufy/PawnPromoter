/**
 * The opening library — port of opening_library.py: every named opening and
 * variation from Lichess's open dataset (github.com/lichess-org/chess-openings,
 * CC0), about 3,900 lines with their ECO code, name and moves, in the
 * opening_library table; from Opening Drill → Add lines → Opening library you
 * search or browse it and add lines to a repertoire to drill.
 *
 * The web app loads it pre-built (public/openings/library.json, made by
 * tools/build_opening_library.py) with every line already described Sharp /
 * Balanced / Quiet, instead of downloading the TSVs and spending ~35 minutes
 * of browser Stockfish on the descriptions. parse() reads the raw TSVs too.
 */
import { Board } from './chess';
import type { Db, Row } from './sqlite';

export const URL = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/{part}.tsv';
export const PARTS = 'abcde';
export const SOURCE = 'Lichess opening names (github.com/lichess-org/chess-openings, CC0)';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS opening_library (
    id INTEGER PRIMARY KEY,
    eco TEXT,
    name TEXT,                -- "Sicilian Defense: Najdorf Variation"
    family TEXT,              -- "Sicilian Defense"
    pgn TEXT,                 -- "1. e4 c5 2. Nf3 d6 ..."
    sans TEXT,                -- "e4 c5 Nf3 d6 ..." (for searching by moves)
    ucis TEXT,
    plies INTEGER
);
CREATE INDEX IF NOT EXISTS idx_opening_library_family ON opening_library (family);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
  // sharp / quiet, described by libraryCharacter.ts (pre-built in the web app)
  const cols = new Set(conn.all('PRAGMA table_info(opening_library)').map((r) => r.name));
  for (const [col, kind] of [['character', 'TEXT'], ['sharpness', 'INTEGER'], ['description', 'TEXT'],
    ['eval_cp', 'INTEGER'], ['char_version', 'INTEGER']]) {
    if (!cols.has(col)) conn.run(`ALTER TABLE opening_library ADD COLUMN ${col} ${kind}`);
  }
}

export class Opening {
  constructor(
    readonly id: number,
    readonly eco: string,
    readonly name: string,
    readonly family: string,
    readonly pgn: string,
    readonly sans: string[],
    readonly ucis: string[],
    readonly character: string | null = null,    // "Sharp" / "Balanced" / "Quiet" (null: not described yet)
    readonly description: string | null = null,
    readonly eval_cp: number | null = null,
  ) {}

  get variation(): string {
    const i = this.name.indexOf(':');
    return i >= 0 ? this.name.slice(i + 1).trim() : '';
  }

  get plies(): number {
    return this.ucis.length;
  }

  /** '6. Be3' / '8...h5': tells apart lines sharing a name (different move orders). */
  get last_move(): string {
    if (!this.sans.length) return '';
    const n = this.sans.length - 1;
    return `${Math.floor(n / 2) + 1}${n % 2 === 0 ? '.' : '...'} ${this.sans[n]}`;
  }
}

export interface LibraryRow {
  eco: string;
  name: string;
  family: string;
  pgn: string;
  sans: string;
  ucis: string;
  plies: number;
  character?: string | null;
  sharpness?: number | null;
  description?: string | null;
  eval_cp?: number | null;
  char_version?: number | null;
}

// ---------- reading the data ----------

/** A Lichess chess-openings TSV (eco, name, pgn) -> rows; lines with an unreadable move are skipped. */
export function parse(tsv: string): LibraryRow[] {
  const lines = tsv.split(/\r?\n/);
  const header = lines[0].split('\t');
  const at = (k: string) => header.indexOf(k);
  const out: LibraryRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = line.split('\t');
    const pgn = cells[at('pgn')];
    const eco = cells[at('eco')];
    const rawName = cells[at('name')];
    if (pgn === undefined || eco === undefined || rawName === undefined) continue;
    const board = Board.fromFen();
    const sans: string[] = [];
    const ucis: string[] = [];
    let ok = true;
    for (const token of pgn.split(/\s+/).filter(Boolean)) {
      if (token.endsWith('.')) continue;
      const uci = board.parseSan(token);
      if (!uci) { ok = false; break; }
      sans.push(board.san(uci));
      ucis.push(uci);
      board.push(uci);
    }
    if (!ok) continue;
    const name = rawName.trim();
    out.push({ eco: eco.trim(), name, family: name.split(':', 1)[0].trim(), pgn: pgn.trim(),
      sans: sans.join(' '), ucis: ucis.join(' '), plies: ucis.length });
  }
  return out;
}

/** The pre-built library (public/openings/library.json) -> rows, descriptions included. */
export function fromBuilt(json: { columns: string[]; rows: unknown[][] }): LibraryRow[] {
  return json.rows.map((r) => Object.fromEntries(json.columns.map((c, i) => [c, r[i]])) as unknown as LibraryRow);
}

// ---------- the database ----------

export function save(conn: Db, rows: LibraryRow[]): void {
  conn.transaction(() => {
    conn.run('DELETE FROM opening_library');
    for (const r of rows) {
      conn.run(
        `INSERT INTO opening_library (eco, name, family, pgn, sans, ucis, plies, character, sharpness, description,
           eval_cp, char_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.eco, r.name, r.family, r.pgn, r.sans, r.ucis, r.plies, r.character ?? null, r.sharpness ?? null,
          r.description ?? null, r.eval_cp ?? null, r.char_version ?? null],
      );
    }
  });
}

export function count(conn: Db): number {
  return conn.get('SELECT COUNT(*) AS n FROM opening_library')!.n;
}

export function rowToOpening(r: Row): Opening {
  return new Opening(r.id, r.eco, r.name, r.family, r.pgn, r.sans.split(/\s+/).filter(Boolean),
    r.ucis.split(/\s+/).filter(Boolean), r.character ?? null, r.description ?? null, r.eval_cp ?? null);
}

export function families(conn: Db): [string, number][] {
  return conn.all('SELECT family, COUNT(*) AS n FROM opening_library GROUP BY family ORDER BY family')
    .map((r) => [r.family, r.n]);
}

/** By name, ECO code (B90, or B9 for the B90s) or moves ('e4 c5 Nf3' — the line
 *  starts so); character: only Sharp / Balanced / Quiet lines. */
export function search(conn: Db, query = '', family: string | null = null, limit = 600,
  character: string | null = null): Opening[] {
  const q = query.split(/\s+/).filter(Boolean).join(' ');
  let sql = 'SELECT * FROM opening_library WHERE 1 = 1';
  const args: (string | number)[] = [];
  if (family) { sql += ' AND family = ?'; args.push(family); }
  if (character) { sql += ' AND character = ?'; args.push(character); }
  if (q) {
    sql += ' AND (name LIKE ? OR eco LIKE ? OR sans LIKE ? OR sans = ?)';
    args.push(`%${q}%`, `${q}%`, `${q} %`, q);
  }
  sql += ' ORDER BY eco, plies, name LIMIT ?';
  args.push(limit);
  return conn.all(sql, args).map(rowToOpening);
}

export function get(conn: Db, ids: number[]): Opening[] {
  if (!ids.length) return [];
  return conn.all(`SELECT * FROM opening_library WHERE id IN (${ids.map(() => '?').join(',')})`, ids).map(rowToOpening);
}

// ---------- your repertoire ----------

const positionOf = (fen: string) => fen.split(/\s+/).slice(0, 4).join(' ');

/** "position\tmove" pairs of every enabled line of that colour. */
export function repertoireMoves(conn: Db, color: string): Set<string> {
  return new Set(conn.all('SELECT fen_before_move, move_uci FROM opening_lines WHERE my_color = ? AND is_enabled = 1', [color])
    .map((r) => `${positionOf(r.fen_before_move)}\t${r.move_uci}`));
}

/** How many of the line's first moves your repertoire (that colour) already has. */
export function coveredPlies(opening: Opening, moves: Set<string>): number {
  const board = Board.fromFen();
  let n = 0;
  for (const uci of opening.ucis) {
    if (!moves.has(`${positionOf(board.fen())}\t${uci}`)) break;
    board.push(uci);
    n += 1;
  }
  return n;
}

/** Is every move of this line already in your repertoire (that colour)? */
export function covered(opening: Opening, moves: Set<string>): boolean {
  return coveredPlies(opening, moves) === opening.plies;
}

export const PARTLY_MIN = 4;   // "partly in your repertoire": at least this many of its moves, and half of it

/** ["in" / "partly" / "out", the colour, moves covered] — the best of White and Black. */
export function status(opening: Opening, mine: { [color: string]: Set<string> }): [string, string | null, number] {
  const w = coveredPlies(opening, mine.white ?? new Set());
  const b = coveredPlies(opening, mine.black ?? new Set());
  const best = b > w ? 'black' : 'white';               // max() keeps the first (White) on a tie
  const n = Math.max(w, b);
  if (n === opening.plies) return ['in', best, n];
  if (n >= PARTLY_MIN && n * 2 >= opening.plies) return ['partly', best, n];
  return ['out', null, n];
}

// ---------- sharp / quiet (libraryCharacter.ts) ----------

export function undescribed(conn: Db, version: number): Opening[] {
  return conn.all('SELECT * FROM opening_library WHERE char_version IS NULL OR char_version != ? ORDER BY eco, plies',
    [version]).map(rowToOpening);
}

/** items: [opening id, character]. */
export function saveCharacter(conn: Db, items: [number, { label: string; score: number; text: string; eval_cp: number | null }][],
  version: number): void {
  conn.transaction(() => {
    for (const [id, c] of items) {
      conn.run('UPDATE opening_library SET character = ?, sharpness = ?, description = ?, eval_cp = ?, char_version = ? WHERE id = ?',
        [c.label, c.score, c.text, c.eval_cp, version, id]);
    }
  });
}

/** One game per line, its name as the [Event] (the line's name once imported). */
export function toPgn(openings: Opening[]): string {
  return openings.map((o) => `[Event "${o.name.replaceAll('"', "'")}"]\n[ECO "${o.eco}"]\n\n${o.pgn} *\n`).join('\n');
}
