/**
 * Plain-English explanations for puzzle moves — port of explain.py — grounded
 * in real analysis: Stockfish's actual follow-up lines (short fresh searches)
 * plus concrete board facts: material won/lost along the line, forks, checks,
 * pieces left hanging, king-side pawn weakening, and how much scope a
 * bishop/rook/queen gains or loses ("blocks your bishop on c1: 6 squares → 1").
 *
 * Nothing here is guessed: every sentence comes from a computed fact. Without
 * an engine the explanations fall back to the board facts only.
 */
import { MATE_CP } from './analyzer';
import { Board, type Color, type Role, WHITE, opposite, squareDistance, squareFile, squareName } from './chess';
import type { Engine, PovScore } from './engine';
import { pySigned } from './format';

export const THINK_SECONDS = 0.3;
export const LINE_PLIES = 6;          // how far to follow an engine line when counting material
export const SCOPE_DIFF = 3;          // squares of mobility difference worth mentioning
export const VALUES: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
const MATERIAL_WORDS: Record<number, string> = {
  1: 'a pawn', 2: 'two pawns', 3: 'a piece', 4: 'a piece and a pawn', 5: 'a rook',
  6: 'a rook and a pawn', 8: 'a rook and a piece', 9: 'the queen',
};
const PROMOTION_ROLES: Record<string, Role> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };

const sq = (uci: string, offset: 0 | 2) => uci.charCodeAt(offset) - 97 + 8 * (uci.charCodeAt(offset + 1) - 49);

// ---------- board facts ----------

function balance(board: Board, color: Color): number {
  let total = 0;
  for (const p of board.pieceMap().values()) total += VALUES[p.role] * (p.color === color ? 1 : -1);
  return total;
}

function materialWords(n: number): string {
  return MATERIAL_WORDS[n] ?? `${n} points of material`;
}

function side(color: Color): string {
  return color === WHITE ? 'White' : 'Black';
}

function pieceOn(board: Board, square: number): string {
  const piece = board.pieceAt(square);
  return piece ? `${piece.role} on ${squareName(square)}` : '?';
}

/** Numbered SAN from this position, e.g. '14...Nxe4 15.Nxe4 Qxb2'. */
export function line(board: Board, moves: string[], plies = 4): string {
  const b = board.copy();
  const parts: string[] = [];
  for (const [i, move] of moves.slice(0, plies).entries()) {
    if (!b.isLegal(move)) break;
    if (b.turn === WHITE) parts.push(`${b.fullmoveNumber}.${b.san(move)}`);
    else parts.push(i === 0 ? `${b.fullmoveNumber}...${b.san(move)}` : b.san(move));
    b.push(move);
  }
  return parts.join(' ');
}

/** Like line(), but with what the FIRST move does in brackets right after it:
 *  '21...Bxc3+ (takes the knight, gives check) 22.Qxc3 Rh1+'.
 *  losing=true: the line wins material for the mover, so a capture is never
 *  called a 'trade'. */
function lineNoted(board: Board, moves: string[], plies = 4, losing = false): string {
  const tokens = line(board, moves, plies).split(' ');
  if (!moves.length || !tokens[0]) return '';
  let notes = moveFeatures(board, moves[0]);
  if (losing) notes = notes.map((n) => n.replace(/^trades (\w+)s$/, 'takes the $1'));
  if (notes.length) tokens[0] += ` (${notes.join(', ')})`;
  return tokens.join(' ');
}

function mobility(board: Board, square: number): number {
  return board.pieceAt(square) ? board.sliderMobility(square) : 0;
}

/** Long-range pieces (other than the one that moved) whose scope changed a lot. */
function scopeNotes(before: Board, after: Board, color: Color, movedTo: number): string[] {
  const notes: string[] = [];
  for (const [square, piece] of before.pieceMap()) {
    if (piece.color !== color || !['bishop', 'rook', 'queen'].includes(piece.role)) continue;
    const now = after.pieceAt(square);
    if (square === movedTo || !now || now.role !== piece.role || now.color !== piece.color) continue;
    const a = mobility(before, square);
    const b = mobility(after, square);
    if (b <= a - SCOPE_DIFF) notes.push(`it blocks your ${pieceOn(before, square)} (${a} squares → ${b})`);
    else if (b >= a + SCOPE_DIFF) notes.push(`it opens up your ${pieceOn(before, square)} (${a} squares → ${b})`);
  }
  return notes;
}

/** Your pieces (any but the king) that were safe before the move and are
 *  attacked-but-undefended after it. */
function newlyHanging(before: Board, after: Board, color: Color): string[] {
  const out: string[] = [];
  for (const [square, piece] of after.pieceMap()) {
    if (piece.color !== color || piece.role === 'king') continue;
    const hangingNow = after.isAttackedBy(opposite(color), square) && !after.isAttackedBy(color, square);
    const was = before.pieceAt(square);
    const wasHanging = !!was && was.role === piece.role && was.color === piece.color
      && before.isAttackedBy(opposite(color), square) && !before.isAttackedBy(color, square);
    if (hangingNow && !wasHanging) out.push(pieceOn(after, square));
  }
  return out;
}

/** Pushing a pawn in front of your castled king. */
function kingWeakening(before: Board, move: string, color: Color): string | null {
  const from = sq(move, 0);
  const piece = before.pieceAt(from);
  const king = before.king(color);
  if (!piece || piece.role !== 'pawn' || king === undefined) return null;
  if (Math.abs(squareFile(from) - squareFile(king)) <= 1
    && squareDistance(from, king) <= 2 && [0, 1, 2, 5, 6, 7].includes(squareFile(king))) {
    return 'it loosens the pawn cover in front of your king';
  }
  return null;
}

/** What a single move does immediately: capture, check, fork, threat. */
function moveFeatures(board: Board, move: string): string[] {
  const mover = board.turn;
  const notes: string[] = [];
  const to = sq(move, 2);
  const captured = board.isCastling(move) ? undefined : board.pieceAt(to);
  if (board.isEnPassant(move)) {
    notes.push('captures a pawn en passant');
  } else if (captured) {
    const moverPiece = board.pieceAt(sq(move, 0))!;
    const recapturable = board.copy();
    recapturable.push(move);
    if (captured.role === moverPiece.role && recapturable.isAttackedBy(opposite(mover), to)) {
      notes.push(`trades ${captured.role}s`);
    } else {
      notes.push(`takes the ${captured.role}`);
    }
  }
  if (move.length === 5) notes.push(`promotes to a ${PROMOTION_ROLES[move[4]]}`);
  if (board.isCastling(move)) notes.push('castles the king to safety');
  const after = board.copy();
  after.push(move);
  if (after.isCheckmate()) return ['checkmate'];
  if (after.isCheck()) notes.push('gives check');
  // fork: the moved piece hits two valuable enemy pieces (king counts)
  const landed = after.pieceAt(to)!;
  const moverValue = VALUES[landed.role];
  const valuable: string[] = [];
  const threats: string[] = [];
  for (const target of after.attacks(to)) {
    const p = after.pieceAt(target);
    if (!p || p.color === mover) continue;
    if (p.role === 'king' || VALUES[p.role] >= 3) valuable.push(p.role);
    // a real threat: the target is undefended or worth more than the attacker
    if (p.role !== 'king' && VALUES[p.role] >= 3
      && (!after.isAttackedBy(opposite(mover), target) || VALUES[p.role] > moverValue)) {
      threats.push(`${p.role} on ${squareName(target)}`);
    }
  }
  if (valuable.length >= 2) {
    const [a, b] = valuable;
    notes.push(a === b ? `forks both ${a}s` : `forks the ${a} and ${b}`);
  } else if (threats.length && !captured) {
    notes.push(`attacks the ${threats[0]}`);
  }
  return notes;
}

// ---------- engine lines ----------

async function engineLine(engine: Engine | null, board: Board): Promise<[string[], PovScore | null]> {
  if (!engine || board.isGameOver()) return [[], null];
  const [info] = await engine.analyse(board, { time: THINK_SECONDS });
  return [info.pv.slice(0, LINE_PLIES), info.score ?? null];
}

/** Material change for `me` after playing the line. */
function lineOutcome(board: Board, pv: string[], me: Color): number {
  const b = board.copy();
  const start = balance(board, me);
  for (const move of pv) {
    if (!b.isLegal(move)) break;
    b.push(move);
  }
  return balance(b, me) - start;
}

function mateFor(score: PovScore | null, color: Color): number | null {
  if (!score) return null;
  const pov = score.pov(color);
  const mate = pov.mate();
  return pov.isMate() && mate !== null && mate > 0 ? mate : null;
}

// ---------- public ----------

/** Why a wrong try fails — WITHOUT naming the best move, so the puzzle can
 *  still be retried. Returns the text, the engine's refutation (moves from the
 *  position after the attempt, for drawing the reply) and the eval for you. */
export async function explainAttempt(fen: string, attempt: string, engine: Engine | null = null)
  : Promise<{ text: string; pv: string[]; cp: number | null }> {
  const before = Board.fromFen(fen);
  const me = before.turn;
  const after = before.copy();
  after.push(attempt);
  const san = before.san(attempt);
  const sentences: string[] = [];

  const [pv, score] = await engineLine(engine, after);
  const opp = side(opposite(me));
  if (pv.length) {
    const reply = lineNoted(after, pv, 4, lineOutcome(after, pv, me) <= -1);
    const mate = mateFor(score, opposite(me));
    const change = lineOutcome(after, pv, me);
    if (mate) {
      sentences.push(`After ${san}, ${opp} has a forced mate in ${mate}: ${reply}.`);
    } else if (change <= -1) {
      sentences.push(`After ${san}, ${opp} answers ${reply} and you lose ${materialWords(-change)}.`);
    } else {
      const cp = score ? score.pov(me).score(MATE_CP) : null;
      const evaluation = cp !== null ? ` (evaluation ${pySigned(cp / 100, 1)})` : '';
      sentences.push(`After ${san}, ${opp}'s best answer is ${reply}${evaluation} — you miss something stronger here.`);
    }
  }

  const facts = newlyHanging(before, after, me);
  if (facts.length) sentences.push(`${san} leaves your ${facts[0]} undefended.`);
  const extra = [kingWeakening(before, attempt, me), ...scopeNotes(before, after, me, sq(attempt, 2))]
    .filter((n): n is string => !!n);
  if (extra.length) sentences.push(`Also, ${extra[0]}.`);
  if (!sentences.length) sentences.push(`${san} lets ${opp} off the hook — look for a more forcing move.`);
  const cpMe = score ? score.pov(me).score(MATE_CP) : null;
  return { text: sentences.slice(0, 3).join(' '), pv, cp: cpMe };
}

/** What the best move achieves, and why the move actually played in your game went wrong. */
export async function explainSolution(fen: string, best: string, gameMove: string | null,
  engine: Engine | null = null): Promise<string> {
  const before = Board.fromFen(fen);
  const me = before.turn;
  const bestSan = before.san(best);
  const sentences: string[] = [];

  const afterBest = before.copy();
  afterBest.push(best);
  const features = moveFeatures(before, best);
  const [pv, score] = await engineLine(engine, afterBest);
  const mate = mateFor(score, me);
  const change = pv.length ? lineOutcome(before, [best, ...pv], me) : lineOutcome(before, [best], me);
  const keyLine = line(before, [best, ...pv], 5);
  const what = features.length ? `${bestSan} ${features.join(', ')}` : bestSan;
  if (mate) {
    sentences.push(`${what}, and it forces mate: ${keyLine}.`);
  } else if (change >= 1) {
    sentences.push(`${what}. The key line ${keyLine} wins ${materialWords(change)}.`);
  } else {
    const scope = scopeNotes(before, afterBest, me, sq(best, 2));
    const detail = scope.length ? ` — ${scope[0]}` : '';
    sentences.push(`${what}${detail}. Main line: ${keyLine}.`);
  }

  if (gameMove !== null && gameMove !== best && before.isLegal(gameMove)) {
    const afterGame = before.copy();
    afterGame.push(gameMove);
    const gameSan = before.san(gameMove);
    const [gpv, gscore] = await engineLine(engine, afterGame);
    const gchange = gpv.length ? lineOutcome(afterGame, gpv, me) : 0;
    const opp = side(opposite(me));
    if (mateFor(gscore, opposite(me))) {
      sentences.push(`Your game move ${gameSan} allowed a forced mate: ${line(afterGame, gpv, 4)}.`);
    } else if (gpv.length && gchange <= -1) {
      sentences.push(`In the game, ${gameSan} ran into ${lineNoted(afterGame, gpv, 4, true)}, `
        + `losing ${materialWords(-gchange)}.`);
    } else {
      const notes = newlyHanging(before, afterGame, me);
      const why = notes.length ? [`left your ${notes[0]} undefended`] : [];
      const weak = kingWeakening(before, gameMove, me);
      if (weak) why.push(weak);
      why.push(...scopeNotes(before, afterGame, me, sq(gameMove, 2)));
      if (why.length) {
        sentences.push(`In the game, ${gameSan} ${why[0].replace('it ', '')}.`);
      } else if (gpv.length) {
        const cp = gscore ? gscore.pov(me).score(MATE_CP) : null;
        const evaluation = cp !== null ? `, leaving you at ${pySigned(cp / 100, 1)}` : '';
        sentences.push(`In the game, ${gameSan} let ${opp} play ${line(afterGame, gpv, 3)}${evaluation}.`);
      }
    }
  }
  return sentences.slice(0, 3).join(' ');
}

/** Exposed for tests and the puzzle tab: what one move does. */
export { moveFeatures, newlyHanging, scopeNotes, kingWeakening };
