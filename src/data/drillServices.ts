/**
 * Opening Drill's database work (drill_tab.py's calls), run in the database
 * worker. The live drill session lives here too: picking a line, judging your
 * moves ("book elsewhere") and the opponent's real-world reply shares all read
 * the database. Screens get plain DrillView snapshots back.
 */
import { Board } from '../core/chess';
import * as db from '../core/db';
import { OpeningDrillSession } from '../core/drill';
import * as explorer from '../core/explorer';
import type { OpeningLine, PlayerColor } from '../core/models';
import * as openingImporter from '../core/openingImporter';
import * as openingTree from '../core/openingTree';
import type { Db } from '../core/sqlite';
import { level, type LevelView } from './level';

// ---------- repertoires ----------

export interface RepertoireEntry {
  name: string;             // a repertoire, or a group ("*", "*:d2d4")
  color: PlayerColor;
  label: string;            // "All White openings", "White · 1.d4 openings", "London (white)"
  group: boolean;
}

/** The Setup dropdown: groups first, then each repertoire (_refresh_repertoire_list). */
export function repertoires(conn: Db): RepertoireEntry[] {
  const pairs = db.listRepertoires(conn);
  const out: RepertoireEntry[] = [];
  for (const color of ['white', 'black'] as PlayerColor[]) {
    if (!pairs.some(([, c]) => c === color)) continue;
    const side = color === 'white' ? 'White' : 'Black';
    out.push({ name: db.groupName(), color, label: `All ${side} openings`, group: true });
    const firsts = db.firstMoves(conn, color);
    if (firsts.length > 1) {
      for (const [uci, san] of firsts) {
        out.push({ name: db.groupName(uci), color, group: true,
          label: color === 'white' ? `White · 1.${san} openings` : `Black vs 1.${san}` });
      }
    }
  }
  for (const [name, color] of pairs) out.push({ name, color: color as PlayerColor, label: `${name} (${color})`, group: false });
  return out;
}

export interface VariationEntry {
  kind: 'random' | 'weak' | 'line';
  rootId: string | null;
  label: string;
  repertoire: string | null;      // the line's own repertoire (for its plans)
}

/** Setup's variation list: Any line, Weak lines (when there are some), then each enabled line. */
export function variations(conn: Db, name: string, color: PlayerColor): VariationEntry[] {
  const roots = db.rootLines(conn, name, color);
  roots.sort((a, b) => ((a.line_name || a.move_san).toLowerCase() < (b.line_name || b.move_san).toLowerCase() ? -1 : 1));
  const weak = db.weakItemIds(conn, 'line');
  const weakCount = roots.filter((r) => weak.has(r.id)).length;
  const out: VariationEntry[] = [{ kind: 'random', rootId: null, label: 'Any line (random)', repertoire: null }];
  if (weakCount) out.push({ kind: 'weak', rootId: null, label: `Weak lines (${weakCount} to fix)`, repertoire: null });
  for (const r of roots) out.push({ kind: 'line', rootId: r.id, label: r.line_name || r.move_san, repertoire: r.repertoire_name });
  return out;
}

/** Notation for a variation: its first branch at each step, noting the alternatives (_line_preview). */
export function linePreview(conn: Db, rootId: string): string {
  const root = conn.get('SELECT * FROM opening_lines WHERE id = ?', [rootId]);
  if (!root) return '';
  const path = [db.rowToOpeningLine(root)];
  let branches = 0;
  for (;;) {
    const children = db.childrenOf(conn, path[path.length - 1].id);
    if (!children.length) break;
    branches += children.length - 1;
    path.push(children[0]);
  }
  const board = Board.fromFen();
  const sans = path.map((n) => { const san = board.san(n.move_uci); board.push(n.move_uci); return san; });
  const moves = sans.map((san, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${san}` : san)).join(' ');
  return moves + (branches ? `  (+${branches} alternative branch${branches !== 1 ? 'es' : ''})` : '');
}

/** Every repertoire's lines, enabled or not ("Turn lines on/off"). */
export function allLines(conn: Db): { name: string; color: string; lines: { id: string; label: string; enabled: boolean }[] }[] {
  return db.listRepertoires(conn).map(([name, color]) => ({
    name, color,
    lines: db.allRootLines(conn, name, color).map((r) => ({ id: r.id, label: r.line_name || r.move_san, enabled: r.is_enabled })),
  }));
}

export function setLineEnabled(conn: Db, rootId: string, enabled: boolean): void {
  db.setLineEnabled(conn, rootId, enabled);
}

const SUBTREE = `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL
                   SELECT o.id FROM opening_lines o JOIN sub ON o.parent_id = sub.id)`;

/** What deleting a whole line removes: its moves and how many lines end in it. */
export function lineSize(conn: Db, rootId: string): { moves: number; ends: number } {
  const moves = conn.get(`${SUBTREE} SELECT COUNT(*) AS n FROM sub`, [rootId])!.n;
  const ends = conn.get(`${SUBTREE} SELECT COUNT(*) AS n FROM opening_lines WHERE id IN (SELECT id FROM sub)
    AND id NOT IN (SELECT parent_id FROM opening_lines WHERE parent_id IS NOT NULL)`, [rootId])!.n;
  return { moves, ends };
}

export function deleteBranch(conn: Db, nodeIds: string[]): number {
  if (session && session.target_path.some((n) => nodeIds.includes(n.id))) session = null;   // it was being drilled
  return db.deleteBranch(conn, nodeIds);
}

/** A PGN (file or pasted moves) into a repertoire: how many positions were new. */
export function importPgn(conn: Db, pgnText: string, name: string, color: PlayerColor): number {
  return openingImporter.importPgnText(pgnText, name, color, conn);
}

export function repertoireNames(conn: Db): string[] {
  return [...new Set(db.listRepertoires(conn).map(([name]) => name))].sort();
}

// ---------- Lichess: real-world replies ----------

export interface LichessStatus {
  connected: boolean;
  bands: string;
  describe: string;           // "rated 1600–2000"
}

export function lichessStatus(conn: Db): LichessStatus {
  const bands = explorer.ratingBands(conn);
  return { connected: !!explorer.getToken(conn), bands, describe: explorer.describeBands(bands) };
}

export function setLichessToken(conn: Db, token: string | null): void {
  explorer.setToken(conn, token);
  shareCache = null;
}

/** Opponent positions of a repertoire (null: all) with no fresh Lichess data yet. */
export function explorerTodo(conn: Db, name: string | null): { token: string | null; bands: string; fens: string[] } {
  const token = explorer.getToken(conn);
  const bands = explorer.ratingBands(conn);
  if (!token) return { token, bands, fens: [] };
  const rep = name !== null && db.parseGroup(name) === null ? name : null;
  return { token, bands, fens: explorer.missing(conn, explorer.opponentPositions(conn, rep), bands) };
}

export function explorerSave(conn: Db, fen: string, bands: string, data: unknown): void {
  explorer.save(conn, fen, bands, data);
  shareCache = null;
}

/** Share of Lichess games (at your level) with this move here; null if unknown.
 *  Remembered for a minute: picking a line asks about the same positions many times. */
let shareCache: { at: number; bands: string | null; stats: Map<string, explorer.PositionStats | null> } | null = null;

function moveShare(conn: Db, fen: string, uci: string): number | null {
  const now = Date.now();
  if (!shareCache || now - shareCache.at > 60_000) {
    shareCache = { at: now, bands: explorer.getToken(conn) ? explorer.ratingBands(conn) : null, stats: new Map() };
  }
  if (shareCache.bands === null) return null;
  const key = fen.split(' ').slice(0, 4).join(' ');
  if (!shareCache.stats.has(key)) shareCache.stats.set(key, explorer.cached(conn, fen, shareCache.bands));
  const stats = shareCache.stats.get(key);
  return stats && stats.games ? stats.share(uci) : null;
}

// ---------- the tree (built on the page from these rows) ----------

export function treeLines(conn: Db, name: string | null, color: PlayerColor): OpeningLine[] {
  return openingTree.treeLines(conn, name, color);
}

/** Where each repertoire's opening starts, as moves from the start position. */
export function treeStarts(conn: Db, names: string[], color: PlayerColor): Record<string, string[]> {
  return Object.fromEntries(names.map((n) => [n, openingTree.startPath(conn, n, color)]));
}

/** Moves where this repertoire's opening starts (null: back to the default). */
export function setOpeningStart(conn: Db, name: string, color: PlayerColor, ucis: string[] | null): void {
  const key = openingTree.startKey(name, color);
  if (ucis === null) conn.run('DELETE FROM settings WHERE key = ?', [key]);
  else db.setSetting(conn, key, ucis.join(' '));
}

/** Cached Lichess stats (no network) for these positions, at your rating bands. */
export function explorerStats(conn: Db, fens: string[]): { bands: string; describe: string; stats: Record<string, explorer.PlainStats> } {
  const bands = explorer.ratingBands(conn);
  const stats: Record<string, explorer.PlainStats> = {};
  if (explorer.getToken(conn)) {
    for (const fen of fens) {
      const s = explorer.cached(conn, fen, bands);
      if (s) stats[fen] = explorer.toPlain(s);
    }
  }
  return { bands, describe: explorer.describeBands(bands), stats };
}

// ---------- the drill session ----------

let session: OpeningDrillSession | null = null;

export interface DrillView {
  fen: string;
  moves: string[];                                    // played so far (UCI)
  path: { id: string; uci: string; san: string; notes: string | null }[];   // the whole line
  index: number;                                      // moves of it played
  lineName: string;
  repertoire: string;                                 // the line's own repertoire
  sessionRepertoire: string;                          // what was picked in Setup (maybe a group)
  myColor: PlayerColor;
  finished: boolean;
  myTurn: boolean;
}

function view(s: OpeningDrillSession): DrillView {
  return {
    fen: s.board.fen(),
    moves: [...s.board.moveStack],
    path: s.target_path.map((n) => ({ id: n.id, uci: n.move_uci, san: n.move_san, notes: n.notes })),
    index: s.path_index,
    lineName: s.line_name ?? '',
    repertoire: s.target_path[0]?.repertoire_name ?? s.repertoire_name,
    sessionRepertoire: s.repertoire_name,
    myColor: s.my_color,
    finished: s.isFinished(),
    myTurn: s.isMyTurn(),
  };
}

function live(): OpeningDrillSession {
  if (!session) throw new Error('No drill is running.');
  return session;
}

/** A line to drill: this root's (its sub-branches picked at random), a weak
 *  line (weighted by misses), or a random one across the repertoire. */
export function drillStart(conn: Db, name: string, color: PlayerColor, pick: 'random' | 'weak' | string): DrillView | null {
  let rootId: string | null = pick === 'random' || pick === 'weak' ? null : pick;
  if (pick === 'weak') {
    const weak = db.weakItemIds(conn, 'line');
    const candidates = db.rootLines(conn, name, color).filter((r) => weak.has(r.id));
    if (candidates.length) {
      // weighted pick: lines you've missed more come up more often
      const total = candidates.reduce((s, r) => s + weak.get(r.id)!, 0);
      let x = Math.random() * total;
      rootId = candidates.find((r) => (x -= weak.get(r.id)!) < 0)?.id ?? candidates[candidates.length - 1].id;
    }
  }
  const s = new OpeningDrillSession(conn, name, color, (fen, uci) => moveShare(conn, fen, uci));
  if (!s.start(rootId)) return null;
  session = s;
  return view(s);
}

/** Drill exactly this line (moves from the start), e.g. picked in the tree. */
export function drillStartLine(conn: Db, name: string, color: PlayerColor, ids: string[]): DrillView | null {
  const rows = ids.map((id) => conn.get('SELECT * FROM opening_lines WHERE id = ?', [id]));
  if (!rows.length || rows.some((r) => !r)) return null;
  const s = new OpeningDrillSession(conn, name, color, (fen, uci) => moveShare(conn, fen, uci));
  if (!s.startLine(rows.map((r) => db.rowToOpeningLine(r!)) as OpeningLine[])) return null;
  session = s;
  return view(s);
}

export function drillRestart(_conn: Db): DrillView {
  const s = live();
  s.restart();
  return view(s);
}

/** A random line from the whole repertoire — a different one than just finished, when there are others. */
export function drillNewRandom(conn: Db): DrillView | null {
  const old = live();
  const previous = old.target_path.map((n) => n.id).join(' ');
  const s = new OpeningDrillSession(conn, old.repertoire_name, old.my_color, (fen, uci) => moveShare(conn, fen, uci));
  for (let i = 0; i < 10; i++) {
    if (!s.start()) return null;
    if (s.target_path.map((n) => n.id).join(' ') !== previous) break;
  }
  session = s;
  return view(s);
}

/** The opponent's (predetermined) move, and how often players at your level play it. */
export function drillOpponent(conn: Db): { san: string | null; share: number | null; view: DrillView } {
  const s = live();
  const fen = s.board.fen();
  const uci = s.isFinished() ? null : s.target_path[s.path_index].move_uci;
  const san = s.playOpponentMove();
  return { san, share: uci ? moveShare(conn, fen, uci) : null, view: view(s) };
}

export function drillAttempt(_conn: Db, uci: string) {
  const s = live();
  const result = s.attemptMyMove(uci);
  return { result, view: view(s) };
}

export function drillReveal(_conn: Db): { san: string | null; view: DrillView } {
  const s = live();
  const san = s.revealAndAdvance();
  return { san, view: view(s) };
}

/** End of a line: one attempt per line — a clean run counts as correct (clears it from Weak lines over time). */
export function drillFinish(conn: Db, missed: boolean): LevelView {
  const s = live();
  db.recordAttempt(conn, 'line', s.target_path[0].id, !missed);
  return level(conn);
}

export function drillStop(_conn: Db): void {
  session = null;
}

export const drillServices = {
  repertoires, variations, linePreview, allLines, setLineEnabled, lineSize, deleteBranch, importPgn, repertoireNames,
  lichessStatus, setLichessToken, explorerTodo, explorerSave, treeLines, treeStarts, setOpeningStart, explorerStats,
  drillStart, drillStartLine, drillRestart, drillNewRandom, drillOpponent, drillAttempt, drillReveal, drillFinish, drillStop,
};
