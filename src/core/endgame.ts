/**
 * Endgame knowledge for the Coach (a web-app addition, from ENDGAME-EXPLAINER.md): what kind of ending
 * this is, the known draws and wins it can recognise exactly from the board, and the captures that would
 * trade into a pawn ending (the engine then judges them). Every claim here is read off the board — a
 * named position only when its exact conditions hold, and (where the engine's score is known) only when
 * that score agrees with the theory.
 */
import { Board, type Color, opposite, type Role, type Square } from './chess';

export interface EndgameNote { rule: string; weight: number; text: string }

const file = (sq: Square) => sq % 8;
const rank = (sq: Square) => sq >> 3;
const at = (f: number, r: number): Square => r * 8 + f;
const name = (sq: Square) => `${'abcdefgh'[file(sq)]}${rank(sq) + 1}`;
const light = (sq: Square) => (file(sq) + rank(sq)) % 2 === 1;
const relRank = (sq: Square, c: Color) => (c === 'white' ? rank(sq) : 7 - rank(sq));
const forward = (c: Color) => (c === 'white' ? 1 : -1);
const dist = (a: Square, b: Square) => Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)));
const FILES = 'abcdefgh';
const RANK_WORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

const PIECES: Role[] = ['knight', 'bishop', 'rook', 'queen'];
const count = (b: Board, c: Color, r: Role) => b.pieces(r, c).length;
const pieces = (b: Board, c: Color) => PIECES.reduce((n, r) => n + count(b, c, r), 0);
const pawnsOf = (b: Board, c: Color) => b.pieces('pawn', c);
const VALUE: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 };
const material = (b: Board, c: Color) => (['pawn', ...PIECES] as Role[]).reduce((n, r) => n + VALUE[r] * count(b, c, r), 0);

/** Passed: no enemy pawn ahead on its own or a neighbouring file. */
function passed(b: Board, c: Color): Square[] {
  const theirs = pawnsOf(b, opposite(c));
  return pawnsOf(b, c).filter((p) => !theirs.some((t) => Math.abs(file(t) - file(p)) <= 1 && relRank(t, c) > relRank(p, c)));
}

/** `c` has pawns on both wings (a–d and e–h): it could make passed pawns on each. */
const hasPawnsOnBothWings = (b: Board, c: Color) => pawnsOf(b, c).some((p) => file(p) <= 3) && pawnsOf(b, c).some((p) => file(p) >= 4);

// ---------- 1. what kind of ending ----------

export type Family = 'pawn' | 'rook' | 'queen' | 'knight' | 'bishop-same' | 'bishop-opposite' | 'bishop-knight' | 'rook-minor' | null;

/** The ending's family, when the pieces left make one (null: a mix, or not an ending yet). */
export function family(b: Board): Family {
  const w = { n: count(b, 'white', 'knight'), b: count(b, 'white', 'bishop'), r: count(b, 'white', 'rook'), q: count(b, 'white', 'queen') };
  const k = { n: count(b, 'black', 'knight'), b: count(b, 'black', 'bishop'), r: count(b, 'black', 'rook'), q: count(b, 'black', 'queen') };
  const total = (s: typeof w) => s.n + s.b + s.r + s.q;
  if (!total(w) && !total(k)) return 'pawn';
  const only = (s: typeof w, role: 'n' | 'b' | 'r' | 'q') => total(s) === s[role] && s[role] > 0;
  if (only(w, 'q') && only(k, 'q')) return 'queen';
  if (w.q || k.q) return null;
  if (only(w, 'r') && only(k, 'r') && w.r <= 2 && k.r <= 2) return 'rook';
  if (only(w, 'n') && only(k, 'n') && w.n === 1 && k.n === 1) return 'knight';
  if (w.b === 1 && k.b === 1 && total(w) === 1 && total(k) === 1) {
    return light(b.pieces('bishop', 'white')[0]) === light(b.pieces('bishop', 'black')[0]) ? 'bishop-same' : 'bishop-opposite';
  }
  if (total(w) === 1 && total(k) === 1 && w.b + k.b === 1 && w.n + k.n === 1) return 'bishop-knight';
  if (total(w) === 1 && total(k) === 1 && ((w.r === 1 && k.b + k.n === 1) || (k.r === 1 && w.b + w.n === 1))) return 'rook-minor';
  return null;
}

const FAMILY_TEXT: Record<Exclude<Family, null | 'pawn'>, string> = {
  rook: 'This is a rook ending: an active rook matters more than an extra pawn — attack pawns, give checks, cut their king off. Many rook endings a pawn up are still drawn.',
  queen: 'This is a queen ending: checks decide it — keep your king sheltered from a perpetual check before you push a passed pawn.',
  knight: 'This is a knight ending: much like a pawn ending — the active king and an outside passed pawn decide it, and knights struggle against a passer far away.',
  'bishop-same': 'A bishop ending with same-coloured bishops: keep your pawns off your bishop\'s colour, and attack the enemy pawns fixed on it.',
  'bishop-opposite': 'Opposite-coloured bishops: the bishops can never challenge each other, so the side behind has big drawing chances — the side ahead needs a second weakness, on the other wing.',
  'bishop-knight': 'Bishop against knight: with pawns on both wings the bishop is usually better; with all the pawns on one wing, the knight often holds.',
  'rook-minor': 'Rook against a minor piece: the rook\'s side wants to win pawns and keep the minor piece busy; the defender wants all the pawns on one wing and a fortress.',
};

// ---------- the notes ----------

/** Board-only endgame notes for `me`, plus the named positions when `cp` (your point of view, if known)
 *  agrees with the theory. */
export function endgameInsights(b: Board, me: Color, cp: number | null = null): EndgameNote[] {
  const out: EndgameNote[] = [];
  const fam = family(b);
  // an ending: at most two pieces a side, and no queens unless it's a queen ending (a bare king counts)
  const queens = count(b, 'white', 'queen') + count(b, 'black', 'queen');
  const isEnding = pieces(b, 'white') <= 2 && pieces(b, 'black') <= 2 && (!queens || fam === 'queen' || !pieces(b, 'white') || !pieces(b, 'black'));
  if (!isEnding) return out;
  if (fam !== null && fam !== 'pawn') out.push({ rule: 'endgame-family', weight: fam === 'bishop-opposite' ? 50 : 35, text: FAMILY_TEXT[fam] });
  if (fam === 'bishop-opposite') {
    const lead = material(b, me) - material(b, opposite(me));
    if (Math.abs(lead) >= 1 && Math.abs(lead) <= 2) {
      out.push({ rule: lead > 0 ? 'ocb-ahead' : 'ocb-behind', weight: 55, text: lead > 0
        ? `You're ${lead} pawn${lead > 1 ? 's' : ''} up, but with opposite-coloured bishops that is often still a draw: ${hasPawnsOnBothWings(b, me) ? 'aim for a passed pawn on each wing, or ' : 'look for '}a second weakness to attack, far from the first.`
        : `You're ${-lead} pawn${lead < -1 ? 's' : ''} down, but opposite-coloured bishops give you real drawing chances: put your bishop and pawns where their bishop can't attack them, and blockade on your bishop's colour.` });
    }
  }
  out.push(...squareNotes(b, me), ...cornerDraws(b, me), ...stalemateNotes(b, me, cp), ...rookPawnTheory(b, me, cp));
  return out;
}

/** The rule of the square, in a pawn ending: can the lone king catch the passed pawn? Exact for a king
 *  against a pawn with nothing in the way (pawn moves needed vs king moves to the promotion square). */
export function catches(b: Board, pawn: Square): boolean | null {
  const c = b.pieceAt(pawn)?.color;
  if (!c) return null;
  const o = opposite(c);
  const king = b.king(o);
  if (king === undefined) return null;
  const promo = at(file(pawn), c === 'white' ? 7 : 0);
  // the pawn's path must be empty (a piece in the way changes everything)
  for (let r = rank(pawn) + forward(c); r !== rank(promo) + forward(c); r += forward(c)) if (b.pieceAt(at(file(pawn), r))) return null;
  const n = Math.min(7 - relRank(pawn, c), 5);          // moves to promote (a pawn on its 2nd rank can go two)
  return dist(king, promo) <= n + (b.turn === o ? 1 : 0);
}

function squareNotes(b: Board, me: Color): EndgameNote[] {
  if (family(b) !== 'pawn') return [];
  const out: EndgameNote[] = [];
  for (const c of [me, opposite(me)]) {
    for (const p of passed(b, c)) {
      const caught = catches(b, p);
      if (caught === null) continue;
      const mine = c === me;
      const f = FILES[file(p)];
      if (!caught) {
        out.push({ rule: mine ? 'square-runs' : 'square-runs-theirs', weight: 75, text: mine
          ? `Their king is outside the square of your ${f}-pawn on ${name(p)}: it can't catch it on its own — check they have no faster pawn, then push.`
          : `Your king is outside the square of their ${f}-pawn on ${name(p)}: it can't catch it on its own — you need your own faster pawn, or another way to stop it.` });
      } else if (relRank(p, c) >= 3) {
        out.push({ rule: mine ? 'square-caught' : 'square-caught-theirs', weight: 35, text: mine
          ? `Their king is inside the square of your ${f}-pawn: pushing alone won't promote it — bring your king to escort it.`
          : `Your king is inside the square of their ${f}-pawn on ${name(p)}: you can catch it in time.` });
      }
    }
  }
  return out.slice(0, 2);
}

/** Rook-pawn and wrong-bishop corner draws: the defending king in the corner can't be driven out. */
function cornerDraws(b: Board, me: Color): EndgameNote[] {
  for (const c of ['white', 'black'] as Color[]) {
    const o = opposite(c);
    const ps = pawnsOf(b, c);
    if (!ps.length || pawnsOf(b, o).length || pieces(b, o)) continue;                 // the defender: a bare king
    const f = file(ps[0]);
    if ((f !== 0 && f !== 7) || ps.some((p) => file(p) !== f)) continue;                // every pawn on one rook file
    const bishops = b.pieces('bishop', c);
    const others = pieces(b, c) - bishops.length;
    if (others) continue;
    const promo = at(f, c === 'white' ? 7 : 0);
    const king = b.king(o)!;
    const inCorner = dist(king, promo) <= 1 && relRank(king, c) >= Math.max(...ps.map((p) => relRank(p, c)));
    if (!inCorner) continue;
    const mine = c === me;
    if (!bishops.length) {
      return [{ rule: mine ? 'rook-pawn-draw' : 'rook-pawn-draw-theirs', weight: 70, text: mine
        ? `A rook's pawn with their king in the corner is a draw: the king can't be pushed out of ${name(promo)} — don't spend moves hoping it can.`
        : `Your king in the corner holds the draw against their rook's pawn: just stay on ${name(promo)} and the square next to it.` }];
    }
    if (bishops.every((s) => light(s) !== light(promo))) {
      return [{ rule: mine ? 'wrong-bishop' : 'wrong-bishop-theirs', weight: 75, text: mine
        ? `The wrong bishop: yours can't control ${name(promo)}, the promotion square, so their king in the corner holds a draw however many pawns you have on that file.`
        : `The wrong bishop for them: theirs can't control ${name(promo)}, so your king in the corner holds the draw — stay there.` }];
    }
  }
  return [];
}

/** The side to move is winning and one of its moves would stalemate the other side. */
function stalemateNotes(b: Board, me: Color, cp: number | null): EndgameNote[] {
  if (b.turn !== me || cp === null || cp < 150) return [];
  for (const m of b.legalMoves()) {
    const after = b.copy();
    after.push(m);
    if (after.isStalemate()) {
      return [{ rule: 'stalemate-trap', weight: 85, text: `Careful: ${b.san(m)} would be stalemate — a draw from a winning position. Leave their king a move.` }];
    }
  }
  return [];
}

// ---------- 3. rook and pawn against rook: Lucena and Philidor ----------

export type RookPawnTheory = { kind: 'lucena' | 'philidor' | 'philidor-available'; attacker: Color; move?: string } | null;

/** Lucena / Philidor, only on an exact match: one rook each, one pawn (not a rook's pawn).
 *  Lucena: the pawn on its 7th rank, its king on the promotion square, the defending king cut off
 *  two or more files away. Philidor: the defending king in front of the pawn, the pawn not past its 5th
 *  rank, the defending rook on its own third rank (the attacker's 6th) holding the king out. */
export function rookPawnTheory(b: Board, me: Color, cp: number | null = null): EndgameNote[] {
  const t = rookPawnKind(b);
  if (!t) return [];
  const mine = t.attacker === me;
  const forAttacker = cp === null ? null : mine ? cp : -cp;
  if (t.kind === 'lucena') {
    if (forAttacker !== null && forAttacker < 300) return [];                  // the engine doesn't agree: say nothing
    return [{ rule: 'lucena', weight: 80, text: mine
      ? 'This is the Lucena position — a win. Build a bridge: bring your rook to the fourth rank, then walk your king out and block the side checks with the rook.'
      : 'This is the Lucena position — lost with best play, but they have to know the bridge (rook to the fourth rank). Keep checking and make them find it.' }];
  }
  if (forAttacker !== null && Math.abs(forAttacker) >= 150) return [];
  const third = RANK_WORD[2];
  if (t.kind === 'philidor') {
    return [{ rule: 'philidor', weight: 70, text: mine
      ? 'They have the Philidor defence set up: with correct play it\'s a draw. Don\'t expect to win by force — try to make them go wrong.'
      : `This is the Philidor defence — a draw: keep your rook on your ${third} rank until the pawn moves up, then check from behind.` }];
  }
  return [{ rule: 'philidor-available', weight: 75, text: mine
    ? 'Their king is in front of your pawn: if they get their rook to their third rank (the Philidor defence), it\'s a draw — hurry before it\'s set up.'
    : `Set up the Philidor defence: ${t.move ? `${t.move} puts` : 'put'} your rook on your ${third} rank with your king in front of the pawn — a known draw.` }];
}

export function rookPawnKind(b: Board): RookPawnTheory {
  for (const c of ['white', 'black'] as Color[]) {
    const o = opposite(c);
    if (count(b, c, 'rook') !== 1 || count(b, o, 'rook') !== 1 || pieces(b, c) !== 1 || pieces(b, o) !== 1) continue;
    if (pawnsOf(b, c).length !== 1 || pawnsOf(b, o).length) continue;
    const p = pawnsOf(b, c)[0];
    if (file(p) === 0 || file(p) === 7) continue;                             // rook's pawns follow other rules
    const ka = b.king(c)!;
    const kd = b.king(o)!;
    const promo = at(file(p), c === 'white' ? 7 : 0);
    if (relRank(p, c) === 6 && ka === promo && Math.abs(file(kd) - file(p)) >= 2) {
      // the defending king really cut off: the attacking rook on a file between it and the pawn
      const rook = b.pieces('rook', c)[0];
      const between = (file(rook) - file(p)) * (file(kd) - file(rook)) > 0;
      if (between) return { kind: 'lucena', attacker: c };
    }
    const inFront = Math.abs(file(kd) - file(p)) <= 1 && relRank(kd, c) > relRank(p, c) && relRank(kd, c) >= 6;
    if (relRank(p, c) <= 4 && inFront && relRank(ka, c) <= 4) {
      const thirdRank = c === 'white' ? 5 : 2;                                // the attacker's 6th = the defender's 3rd
      const rook = b.pieces('rook', o)[0];
      if (rank(rook) === thirdRank) return { kind: 'philidor', attacker: c };
      if (b.turn === o) {
        const m = b.legalMoves().find((u) => u.slice(0, 2) === name(rook) && Number(u[3]) - 1 === thirdRank);
        if (m) return { kind: 'philidor-available', attacker: c, move: b.san(m) };
      }
    }
  }
  return null;
}

// ---------- 2. trades into a pawn ending ----------

/** Captures by the side to move after which only kings and pawns are left — at once, or once the
 *  capturing piece is taken back (the engine then says whether that pawn ending is good). */
export function pawnEndingTrades(b: Board): string[] {
  const out: string[] = [];
  for (const m of b.legalMoves()) {
    if (!b.isCapture(m)) continue;
    const after = b.copy();
    after.push(m);
    const left = pieces(after, 'white') + pieces(after, 'black');
    if (left === 0) out.push(m);
    else if (left === 1) {
      const to = m.slice(2, 4);
      const mover = after.pieceAt(to.charCodeAt(0) - 97 + 8 * (Number(to[1]) - 1));
      if (mover && mover.role !== 'pawn' && mover.role !== 'king' && after.legalMoves().some((r) => r.slice(2, 4) === to)) out.push(m);
    }
  }
  return out;
}
