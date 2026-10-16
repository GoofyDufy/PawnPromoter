/**
 * Why your deviation from your prep is (or isn't) worse — port of
 * opening_commentary.py (Opening Drill → My games). Every sentence comes from a
 * computed fact, like explain.ts:
 *  - Stockfish: both moves searched side by side (rootMoves) — the evaluation
 *    of each, and its main line after your move;
 *  - opening principles, from the board: development, moving a piece twice, an
 *    early queen, giving up castling, blocking your own c/d/e pawn, the centre,
 *    a bishop's scope, a loose piece, pawn cover in front of the king, giving
 *    up the bishop pair;
 *  - what the opponent's best reply does to you (attacks, check, tempo).
 *
 * Results are saved in deviation_notes, so a deviation is only worked out once.
 * The board passed in must carry the game's moves (it checks "moved twice").
 */
import { MATE_CP, scoreToCp } from './analyzer';
import { BLACK, Board, type Color, type Role, WHITE, opposite, parseSquare, squareFile, squareName, squareRank } from './chess';
import type { Engine, InfoLine } from './engine';
import * as explain from './explain';
import { pySigned } from './format';
import type { Db } from './sqlite';
import { nowIso } from './time';

export const DEPTH = 18;
export const LINE_PLIES = 8;
const CENTRE = ['d4', 'e4', 'd5', 'e5'].map((s) => parseSquare(s)!);
export const OPENING_PLY = 24;
export const MATERIAL_COST_CP = 60;   // "wins material by force" only when your move also costs this much
export const VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS deviation_notes (
    key TEXT PRIMARY KEY,          -- position | your move | prep moves
    version INTEGER,
    data TEXT,                     -- Notes as JSON
    created_at TEXT
);
`;

const sq = (name: string) => parseSquare(name)!;
const MINOR_HOMES: Record<Color, Map<number, Role>> = {
  white: new Map([[sq('b1'), 'knight'], [sq('g1'), 'knight'], [sq('c1'), 'bishop'], [sq('f1'), 'bishop']]),
  black: new Map([[sq('b8'), 'knight'], [sq('g8'), 'knight'], [sq('c8'), 'bishop'], [sq('f8'), 'bishop']]),
};
const KNIGHT_SQUARES: Record<Color, Map<number, number[]>> = {
  white: new Map([[sq('g1'), [sq('f3')]], [sq('b1'), [sq('c3')]]]),
  black: new Map([[sq('g8'), [sq('f6')]], [sq('b8'), [sq('c6')]]]),
};

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

export interface Fact {
  good: boolean;
  text: string;
}

/** Field order matches the Python dataclass: saved as JSON in deviation_notes. */
export interface Notes {
  mine_san: string;
  prep_san: string;
  mine_cp: number;
  prep_cp: number;
  verdict: string;
  prep_does: string[];       // sentences
  mine_does: string[];
  punishment: string;        // what the opponent's reply does
  mine_line: string;
  prep_line: string;
}

export const cost = (n: Notes) => n.prep_cp - n.mine_cp;

const fromSq = (uci: string) => uci.charCodeAt(0) - 97 + 8 * (uci.charCodeAt(1) - 49);
const toSq = (uci: string) => uci.charCodeAt(2) - 97 + 8 * (uci.charCodeAt(3) - 49);

// ---------- board facts about one opening move ----------

function undeveloped(board: Board, color: Color): number {
  let n = 0;
  for (const [square, kind] of MINOR_HOMES[color]) {
    const p = board.pieceAt(square);
    if (p && p.color === color && p.role === kind) n += 1;
  }
  return n;
}

function centreHits(board: Board, color: Color): Set<number> {
  return new Set(CENTRE.filter((s) => {
    const p = board.pieceAt(s);
    return board.isAttackedBy(color, s) || (p !== undefined && p.color === color && p.role === 'pawn');
  }));
}

/** Did a piece arrive on this square earlier in the game (so moving it is a second move)? */
function movedBefore(board: Board, square: number): boolean {
  return board.moveStack.some((m) => m !== '0000' && toSq(m) === square);
}

/** What this move does in opening terms (board = position before it, with its history). */
export function principles(board: Board, move: string): Fact[] {
  const me = board.turn;
  const piece = board.pieceAt(fromSq(move));
  if (!piece) return [];
  const name = piece.role;
  const after = board.copy();
  after.push(move);
  const facts: Fact[] = [];
  const early = board.ply() < OPENING_PLY;
  const capture = board.isCapture(move);
  const from = fromSq(move);
  const to = toSq(move);

  if (board.isCastling(move)) {
    facts.push({ good: true, text: 'castles — the king is safe and a rook joins the game' });
  } else if ((piece.role === 'knight' || piece.role === 'bishop') && MINOR_HOMES[me].get(from) === piece.role) {
    facts.push({ good: true, text: `develops the ${name}` });
  } else if (early && ['knight', 'bishop', 'queen'].includes(piece.role) && !capture && !after.isCheck()
    && movedBefore(board, from)) {
    const waiting = undeveloped(board, me);
    facts.push({ good: false, text: waiting
      ? `moves the ${name} a second time — a lost tempo while ${waiting} minor piece(s) still wait at home`
      : `moves the ${name} a second time` });
  }
  if (piece.role === 'queen' && early && undeveloped(board, me) >= 2 && !capture) {
    facts.push({ good: false, text: 'brings the queen out before the minor pieces — it can be chased with tempo' });
  }
  if (piece.role === 'king' && !board.isCastling(move) && board.hasCastlingRights(me)) {
    facts.push({ good: false, text: 'moves the king and gives up castling' });
  }
  if (piece.role === 'rook' && board.hasCastlingRights(me) && board.castlingRights() !== after.castlingRights()) {
    facts.push({ good: false, text: 'gives up castling on that side' });
  }

  // standing in front of your own c/d/e pawn that hasn't moved (in front of the f-pawn, like Nf3, is normal)
  const [homeRank, step] = me === WHITE ? [1, 8] : [6, -8];
  const behind = to - step;
  const blocker = board.pieceAt(behind);
  if ([2, 3, 4].includes(squareFile(to)) && piece.role !== 'pawn' && behind >= 0 && behind < 64
    && squareRank(behind) === homeRank && blocker && blocker.color === me && blocker.role === 'pawn') {
    const file = 'cde'[squareFile(to) - 2];
    facts.push({ good: false, text: `stands in front of your ${file}-pawn, so it can't advance `
      + `(${file}${me === WHITE ? 4 : 5} is off for now)` });
  }

  // the centre
  const beforeC = centreHits(board, me);
  const gained = [...centreHits(after, me)].filter((s) => !beforeC.has(s)).map(squareName).sort();
  if (gained.length) facts.push({ good: true, text: `adds control of ${gained.join(' and ')} in the centre` });

  // a pawn on the square your undeveloped knight wants (f3 for the g1 knight, ...)
  if (piece.role === 'pawn' && !capture) {
    for (const [home, kind] of MINOR_HOMES[me]) {
      const p = board.pieceAt(home);
      if (kind === 'knight' && p && p.role === 'knight' && p.color === me && (KNIGHT_SQUARES[me].get(home) ?? []).includes(to)) {
        facts.push({ good: false, text: `takes the ${squareName(to)} square from your knight on ${squareName(home)} — its most natural square` });
      }
    }
    // an f-pawn push with the king still in the middle: the e1-h4 / e8-h5 diagonal opens
    const king = board.king(me);
    if (squareFile(from) === 5 && (king === sq('e1') || king === sq('e8')) && early) {
      facts.push({ good: false, text: 'weakens the diagonal to your king, which is still in the middle' });
    }
  }

  // flank pawn before development
  if (piece.role === 'pawn' && [0, 1, 6, 7].includes(squareFile(from)) && early && undeveloped(board, me) >= 3 && !capture) {
    facts.push({ good: false, text: 'is a flank pawn move while your pieces are still at home' });
  }

  // bishop pair
  const victim = board.pieceAt(to);
  if (capture && piece.role === 'bishop' && victim && victim.role === 'knight'
    && board.pieces('bishop', me).length === 2 && board.pieces('bishop', opposite(me)).length === 2) {
    facts.push({ good: false, text: 'gives up the bishop pair' });
  }

  for (const note of explain.scopeNotes(board, after, me, to)) {
    facts.push({ good: note.startsWith('it opens'), text: note.replace('it ', '') });
  }
  const hanging = explain.newlyHanging(board, after, me);
  if (hanging.length) facts.push({ good: false, text: `leaves your ${hanging[0]} loose` });
  const weak = explain.kingWeakening(board, move, me);
  if (weak) facts.push({ good: false, text: weak.replace('it ', '') });
  return facts;
}

// ---------- the comparison (engine) ----------

function fmt(cp: number): string {
  if (Math.abs(cp) >= Math.floor(MATE_CP / 2)) return cp > 0 ? 'a forced mate' : 'getting mated';
  return pySigned(cp / 100, 2).replaceAll('-', '−');
}

/** board: the position with its game history; mine: what you played; prep: your repertoire's move(s). */
export async function compare(engine: Engine, board: Board, mine: string, prep: string[]): Promise<Notes> {
  const me = board.turn;
  const roots = [...new Set([...prep, mine])];
  const lines = await engine.analyse(board, { depth: DEPTH }, roots.length, roots);
  const byMove = new Map<string, InfoLine>();
  for (const info of lines) if (info.pv.length) byMove.set(info.pv[0], info);
  const cpOf = (m: string) => scoreToCp(byMove.get(m)!.score, me);
  let bestPrep = prep[0];
  let found = false;
  for (const m of prep) {
    if (!byMove.has(m)) continue;
    if (!found || cpOf(m) > cpOf(bestPrep)) { bestPrep = m; found = true; }
  }
  const mineInfo = byMove.get(mine);
  const prepInfo = byMove.get(bestPrep);
  const mineCp = mineInfo ? scoreToCp(mineInfo.score, me) : 0;
  const prepCp = prepInfo ? scoreToCp(prepInfo.score, me) : 0;
  const mineSan = board.san(mine);
  const prepSan = board.san(bestPrep);
  const notes: Notes = { mine_san: mineSan, prep_san: prepSan, mine_cp: mineCp, prep_cp: prepCp, verdict: '',
    prep_does: [], mine_does: [], punishment: '', mine_line: '', prep_line: '' };

  const c = prepCp - mineCp;
  const numbers = `${prepSan} ${fmt(prepCp)}, ${mineSan} ${fmt(mineCp)}`;
  if (c >= 100) notes.verdict = `${mineSan} is a real mistake here — Stockfish: ${numbers}.`;
  else if (c >= 40) notes.verdict = `${mineSan} is clearly weaker than your prep move ${prepSan} — Stockfish: ${numbers}.`;
  else if (c >= 15) {
    notes.verdict = `${mineSan} is slightly weaker than ${prepSan} — not a mistake, but it gives away some `
      + `of your edge (Stockfish: ${numbers}).`;
  } else if (c > -15) {
    notes.verdict = `Stockfish rates ${mineSan} about the same as ${prepSan} (${numbers}) — a matter of `
      + 'taste. If you like it, add it to your repertoire instead.';
  } else {
    notes.verdict = `Stockfish actually prefers your ${mineSan} to your prep move ${prepSan} (${numbers}) — `
      + 'consider changing your repertoire.';
  }

  const prepFacts = principles(board, bestPrep);
  const mineFacts = principles(board, mine);
  const prepTexts = new Set(prepFacts.map((f) => f.text));
  const mineTexts = new Set(mineFacts.map((f) => f.text));
  // what your prep move achieves that yours doesn't, and yours' own problems
  notes.prep_does = prepFacts.filter((f) => f.good && !mineTexts.has(f.text)).map((f) => f.text).slice(0, 3);
  notes.mine_does = mineFacts.filter((f) => !f.good && !prepTexts.has(f.text)).map((f) => f.text).slice(0, 3);
  if (!notes.mine_does.length) notes.mine_does = mineFacts.filter((f) => f.good).map((f) => f.text).slice(0, 2);

  if (mineInfo) {
    const after = board.copy();
    after.push(mine);
    const pv = mineInfo.pv.slice(1, LINE_PLIES + 1);
    notes.mine_line = pv.length ? explain.line(after, pv, LINE_PLIES) : '';
    if (pv.length && after.isLegal(pv[0])) {
      const reply = pv[0];
      const feats = explain.moveFeatures(after, reply);
      const gets = explain.lineOutcome(after, pv, me);
      const opp = after.turn === WHITE ? 'White' : 'Black';
      const replySan = after.san(reply);
      // only what the evaluation backs up: material "won" in a line that
      // Stockfish still calls equal is only taken for a while
      if (gets <= -1 && c >= MATERIAL_COST_CP) {
        notes.punishment = `${opp}'s best answer ${replySan} wins ${explain.materialWords(-gets)} by force: ${notes.mine_line}.`;
      } else if (feats.length && c >= 15) {
        notes.punishment = `${opp}'s best answer ${replySan} ${feats.join(', ')}.`;
      } else {
        const good = principles(after, reply).filter((f) => f.good).map((f) => f.text.replaceAll('your ', 'their '));   // their move
        if (good.length && c >= 15) notes.punishment = `${opp} answers ${replySan}, which ${good[0]}.`;
      }
    }
  }
  if (prepInfo) {
    const after = board.copy();
    after.push(bestPrep);
    const pv = prepInfo.pv.slice(1, LINE_PLIES + 1);
    notes.prep_line = pv.length ? explain.line(after, pv, LINE_PLIES) : '';
  }
  return notes;
}

/** The commentary as a few short paragraphs. */
export function text(n: Notes): string {
  const parts = [n.verdict];
  if (n.prep_does.length) parts.push(`Your prep move ${n.prep_san} ${n.prep_does.join('; ')}.`);
  if (n.mine_does.length) parts.push(`${n.mine_san} ${n.mine_does.join('; ')}.`);
  if (n.punishment) parts.push(n.punishment);
  if (n.mine_line && cost(n) >= 15 && !n.punishment.includes(n.mine_line)) {
    parts.push(`Stockfish's line after ${n.mine_san}: ${n.mine_line}.`);
  }
  return parts.join('\n\n');
}

// ---------- cache ----------

function key(fen: string, mine: string, prep: string[]): string {
  return `${fen.split(/\s+/).slice(0, 4).join(' ')}|${mine}|${[...prep].sort().join(',')}`;
}

export function cached(conn: Db, fen: string, mine: string, prep: string[]): Notes | null {
  const row = conn.get('SELECT data FROM deviation_notes WHERE key = ? AND version = ?', [key(fen, mine, prep), VERSION]);
  return row ? (JSON.parse(row.data) as Notes) : null;
}

export function save(conn: Db, fen: string, mine: string, prep: string[], notes: Notes): void {
  conn.run('INSERT OR REPLACE INTO deviation_notes (key, version, data, created_at) VALUES (?, ?, ?, ?)',
    [key(fen, mine, prep), VERSION, JSON.stringify(notes), nowIso()]);
}

export { BLACK };
