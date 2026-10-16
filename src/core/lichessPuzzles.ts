/**
 * Puzzles from the Lichess puzzle database (database.lichess.org, CC0) — port
 * of lichess_puzzles.py — kept apart from the puzzles made from your own games:
 *  - their own table (lichess_puzzles), so Stats / Progress / Weak spots of
 *    your games never mix with them;
 *  - tries are saved as attempts with item_type 'lichess' (they still earn XP);
 *  - Puzzle Review's "Puzzles" dropdown picks My games / Lichess / Both.
 *
 * Where they come from differs from the desktop app: browsers can't download
 * the big file from database.lichess.org (no CORS headers), so
 * tools/build_lichess_packs.py pre-filters it with these same rules into small
 * gzip packs per 100-point rating band, hosted with the app (public/lichess/).
 * packRows() merges the packs of a rating range by puzzle id — the file's own
 * order — so download() picks the same puzzles as streaming the file would.
 *
 * Lichess's format: FEN is the position BEFORE the opponent's move; Moves
 * starts with that move, then the solution (yours and the replies). We store
 * the position after it (your move) and keep the opponent's move to show it.
 */
import { Board } from './chess';
import { type Puzzle, makePuzzle } from './models';
import type { Db, Row } from './sqlite';

export const URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
export const ITEM_TYPE = 'lichess';            // attempts.item_type for these puzzles
// quality: well-played puzzles with a settled rating
export const MIN_POPULARITY = 80;              // -100..100, players' thumbs up/down
export const MIN_PLAYS = 300;
export const MAX_RATING_DEVIATION = 100;
export const DEFAULT_COUNT = 5000;
export const DEFAULT_WINDOW = 300;             // rating range around yours by default
export const CHESS_COM_TO_LICHESS = 200;       // same rough offset as the opening explorer

/** Lichess theme -> our puzzle type (first match wins), shown in the Type filter */
export const THEME_TYPES: [string, string][] = [
  ['mateIn1', 'Mate in 1'], ['mateIn2', 'Mate in 2'], ['mateIn3', 'Mate in 3'],
  ['mateIn4', 'Mate in 4+'], ['mateIn5', 'Mate in 4+'], ['mate', 'Mate in 4+'],
  ['fork', 'Fork'], ['pin', 'Pin'], ['skewer', 'Skewer'],
  ['discoveredAttack', 'Discovered Attack'], ['doubleCheck', 'Discovered Attack'],
  ['hangingPiece', 'Hanging Piece'], ['trappedPiece', 'Trapped Piece'],
  ['sacrifice', 'Sacrifice'], ['deflection', 'Deflection'], ['attraction', 'Deflection'],
  ['interference', 'Deflection'], ['clearance', 'Deflection'],
  ['xRayAttack', 'X-Ray'], ['zugzwang', 'Zugzwang'], ['promotion', 'Promotion'],
  ['advancedPawn', 'Promotion'], ['defensiveMove', 'Defensive Move'], ['quietMove', 'Quiet Move'],
  ['capturingDefender', 'Deflection'], ['intermezzo', 'Intermezzo'],
  ['kingsideAttack', 'King Attack'], ['queensideAttack', 'King Attack'], ['attackingF2F7', 'King Attack'],
  ['exposedKing', 'King Attack'],
  // no named motif: by phase / what it wins
  ['rookEndgame', 'Endgame'], ['pawnEndgame', 'Endgame'], ['bishopEndgame', 'Endgame'],
  ['knightEndgame', 'Endgame'], ['queenEndgame', 'Endgame'], ['queenRookEndgame', 'Endgame'],
  ['endgame', 'Endgame'], ['crushing', 'Win Material'], ['advantage', 'Win Material'],
];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS lichess_puzzles (
    id TEXT PRIMARY KEY,          -- Lichess puzzle id
    setup_fen TEXT,               -- before the opponent's move
    setup_uci TEXT,               -- the opponent's move that sets the puzzle up
    fen TEXT,                     -- after it: your move
    solution_ucis TEXT,           -- your moves and the replies
    rating INTEGER,
    popularity INTEGER,
    plays INTEGER,
    themes TEXT,
    game_url TEXT,
    opening TEXT,
    imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lichess_puzzles_rating ON lichess_puzzles (rating);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

export function puzzleType(themes: string[]): string {
  const have = new Set(themes);
  for (const [theme, name] of THEME_TYPES) if (have.has(theme)) return name;
  return 'Tactic';
}

/** Attacking / Defensive / Positional, like puzzleKind.ts's kinds. */
export function kind(themes: string[]): string {
  const have = new Set(themes);
  if (have.has('defensiveMove')) return 'Defensive';
  if (have.has('quietMove') && !['mate', 'fork', 'pin', 'skewer', 'hangingPiece'].some((t) => have.has(t))) return 'Positional';
  return 'Attacking';
}

export interface LichessRow {
  id: string;
  setup_fen: string;
  setup_uci: string;
  fen: string;
  solution_ucis: string;
  rating: number;
  deviation: number;
  popularity: number;
  plays: number;
  themes: string;
  game_url: string;
  opening: string;
}

/** Python's int(): an optional sign and digits, surrounding spaces allowed. */
function pyInt(s: string): number {
  if (!/^\s*[-+]?\d+\s*$/.test(s)) throw new Error(`invalid literal for int(): '${s}'`);
  return parseInt(s, 10);
}

/** A CSV row -> a lichess_puzzles row, or null if it's malformed. */
export function parse(row: string[]): LichessRow | null {
  try {
    if (row.length < 9) return null;
    const [pid, fen, moves, rating, deviation, popularity, plays, themes, url] = row;
    const opening = row.length > 9 ? row[9] : '';
    const ucis = moves.split(/\s+/).filter(Boolean);
    const board = Board.fromFen(fen);
    if (!ucis.length || !board.isLegal(ucis[0]) || ucis.length < 2) return null;
    board.push(ucis[0]);
    return {
      id: pid, setup_fen: fen, setup_uci: ucis[0], fen: board.fen(), solution_ucis: ucis.slice(1).join(' '),
      rating: pyInt(rating), deviation: pyInt(deviation), popularity: pyInt(popularity), plays: pyInt(plays),
      themes, game_url: url, opening: opening ? opening.split(' ')[0].replaceAll('_', ' ') : '',
    };
  } catch {
    return null;
  }
}

/** theme: only puzzles with this Lichess theme ('' = any). */
export function good(p: LichessRow, minRating: number, maxRating: number, theme = ''): boolean {
  return (!theme || p.themes.split(/\s+/).includes(theme)) && minRating <= p.rating && p.rating <= maxRating
    && p.popularity >= MIN_POPULARITY && p.plays >= MIN_PLAYS && p.deviation <= MAX_RATING_DEVIATION;
}

/** CSV text -> records (handles quoted fields), header row included. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out;
}

/** rows(stream): the data rows of a Lichess CSV (header skipped). */
export function csvRows(text: string): string[][] {
  return parseCsv(text).slice(1);
}

type Rows = Iterable<string[]> | AsyncIterable<string[]>;

/** Hands batches of new, good puzzles from `rows` to onBatch (the caller saves
 *  them). onProgress(found, scanned). theme: only puzzles with this Lichess
 *  theme. Resolves to how many were found. */
export async function download(
  minRating: number, maxRating: number, count: number, skip: Set<string>,
  onBatch: (batch: LichessRow[]) => void, stop: () => boolean, rows: Rows,
  onProgress?: (found: number, scanned: number) => void, batch = 500, theme = '',
): Promise<number> {
  let found = 0;
  let scanned = 0;
  let pending: LichessRow[] = [];
  for await (const row of rows) {
    if (stop() || found >= count) break;
    scanned += 1;
    if (row.length && skip.has(row[0])) continue;
    const p = row.length ? parse(row) : null;
    if (p === null || !good(p, minRating, maxRating, theme)) {
      if (onProgress && scanned % 20000 === 0) onProgress(found, scanned);
      continue;
    }
    pending.push(p);
    found += 1;
    if (pending.length >= batch) {
      onBatch(pending);
      pending = [];
      onProgress?.(found, scanned);
    }
  }
  if (pending.length) onBatch(pending);
  onProgress?.(found, scanned);
  return found;
}

// ---------- the packs (public/lichess/, built by tools/build_lichess_packs.py) ----------

interface PackFile { band: number; file: string; count: number }

export interface PackManifest {
  built: string;
  band: number;
  per_band: number;
  per_theme: number;
  packs: PackFile[];
  /** theme -> top-up packs (puzzles with it beyond the base packs) and how many exist per band */
  themes: Record<string, { packs: PackFile[]; available: Record<string, number> }>;
}

type Fetch = typeof fetch;

/** A pack's text. Some servers (Vite's dev server, some hosts) send .gz files
 *  with Content-Encoding: gzip, so the browser has already unpacked them:
 *  only unpack what still starts with gzip's magic bytes. */
async function gunzipText(resp: Response): Promise<string> {
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** The puzzle rows of every pack overlapping minRating..maxRating, merged by
 *  puzzle id (the Lichess file's order). theme: also that theme's top-up packs,
 *  so a theme request finds what streaming the file would. baseUrl: where
 *  public/lichess/ is served. */
export async function packRows(minRating: number, maxRating: number, baseUrl: string,
  fetchImpl: Fetch = fetch, theme = ''): Promise<string[][]> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const manifest: PackManifest = await (await fetchImpl(`${base}manifest.json`)).json();
  const overlaps = (p: PackFile) => p.band <= maxRating && p.band + manifest.band - 1 >= minRating;
  const files = manifest.packs.filter(overlaps);
  if (theme) files.push(...(manifest.themes?.[theme]?.packs ?? []).filter(overlaps));
  const byId = new Map<string, string[]>();
  for (const pack of files) {
    const resp = await fetchImpl(`${base}${pack.file}`);
    if (!resp.ok) throw new Error(`couldn't load Lichess puzzle pack ${pack.file} (${resp.status})`);
    for (const row of csvRows(await gunzipText(resp))) byId.set(row[0], row);
  }
  return [...byId.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------- the database ----------

export function save(conn: Db, puzzles: LichessRow[]): void {
  conn.transaction(() => {
    for (const p of puzzles) {
      conn.run(
        `INSERT OR IGNORE INTO lichess_puzzles
           (id, setup_fen, setup_uci, fen, solution_ucis, rating, popularity, plays, themes, game_url, opening)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.setup_fen, p.setup_uci, p.fen, p.solution_ucis, p.rating, p.popularity, p.plays, p.themes,
          p.game_url, p.opening],
      );
    }
  });
}

export function ids(conn: Db): Set<string> {
  return new Set(conn.all('SELECT id FROM lichess_puzzles').map((r) => r.id));
}

export function count(conn: Db): number {
  return conn.get('SELECT COUNT(*) AS n FROM lichess_puzzles')!.n;
}

export function ratingSpan(conn: Db): [number | null, number | null] {
  const r = conn.get('SELECT MIN(rating) AS lo, MAX(rating) AS hi FROM lichess_puzzles')!;
  return [r.lo, r.hi];
}

/** Removes the puzzles; your tries stay in attempts (XP isn't lost). */
export function removeAll(conn: Db): void {
  conn.run('DELETE FROM lichess_puzzles');
}

export function defaultRange(myChessComRating: number | null): [number, number] {
  const centre = (myChessComRating || 1300) + CHESS_COM_TO_LICHESS;
  return [Math.max(400, centre - DEFAULT_WINDOW), centre + DEFAULT_WINDOW];
}

export function load(conn: Db, puzzleTypeFilter: string | null = null): Puzzle[] {
  return conn.all('SELECT * FROM lichess_puzzles ORDER BY RANDOM()').map(toPuzzle)
    .filter((p) => puzzleTypeFilter === null || p.puzzle_type === puzzleTypeFilter);
}

export function toPuzzle(r: Row): Puzzle {
  const themes = (r.themes || '').split(/\s+/).filter(Boolean);
  const ucis: string[] = r.solution_ucis.split(/\s+/).filter(Boolean);
  const board = Board.fromFen(r.fen);
  return makePuzzle({
    id: r.id, fen: r.fen, correct_move_san: board.san(ucis[0]), correct_move_uci: ucis[0],
    source: 'lichess', puzzle_type: puzzleType(themes),
    solution_ucis: r.solution_ucis, solution_moves: Math.floor((ucis.length + 1) / 2), kind: kind(themes),
    rating: r.rating, themes: r.themes, game_url: r.game_url, opening: r.opening,
    setup_fen: r.setup_fen, setup_uci: r.setup_uci,
  });
}

/** 'crushing hangingPiece long' -> 'crushing, hanging piece, long'. */
export function niceThemes(themes: string | null): string {
  return (themes || '').split(/\s+/).filter(Boolean)
    .map((t) => [...t].map((c) => (c >= 'A' && c <= 'Z' ? ` ${c.toLowerCase()}` : c)).join('')).join(', ');
}
