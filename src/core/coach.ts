/**
 * The Coach (a web-app addition): reads a position the way a strong human
 * explains it, then says why a move was good or bad in plain words — engine
 * facts turned into human reasons. Rules only (no AI): everything it says
 * comes from the board and Stockfish's numbers.
 *
 * The order it reasons in (from our notes on how top players explain games):
 *  1. the pawn structure, and the plans that come with it;
 *  2. the move and *why*: what it does to the pieces' jobs (a bishop walled in,
 *     a knight with no squares, an outpost given away), king safety,
 *     development, tempo (the right idea one move early), plus the tactics;
 *  3. the human alternative — and whether the engine's move is one a person
 *     would find;
 *  4. the practical view: small edges aren't wins, material isn't the
 *     evaluation, take the safe way when winning;
 *  5. credit, or reassurance for a small slip.
 * One turning point gets the spotlight; small inaccuracies aren't nagged about.
 */
import { MATE_CP, MIN_CHANCES_LOST, winChances } from './analyzer';
import { Board, type Color, opposite, type Role, type Square } from './chess';
import { materialWords, type SolutionFacts } from './explain';
import { pySigned } from './format';
import { endgameInsights } from './endgame';
import { clockText } from './boardSides';

// ---------- squares ----------

const file = (sq: Square) => sq % 8;
const rank = (sq: Square) => sq >> 3;
const at = (f: number, r: number): Square => r * 8 + f;
const name = (sq: Square) => `${'abcdefgh'[file(sq)]}${rank(sq) + 1}`;
const parse = (s: string): Square => s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
const light = (sq: Square) => (file(sq) + rank(sq)) % 2 === 1;
const forward = (c: Color) => (c === 'white' ? 1 : -1);
/** A rank counted from `c`'s side (0 = its back rank). */
const relRank = (sq: Square, c: Color) => (c === 'white' ? rank(sq) : 7 - rank(sq));

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

function pawnsOf(board: Board, c: Color): Square[] {
  return board.pieces('pawn', c);
}

/** Squares an enemy pawn attacks. */
function pawnAttacks(board: Board, c: Color): Set<Square> {
  const out = new Set<Square>();
  for (const p of pawnsOf(board, c)) {
    const r = rank(p) + forward(c);
    if (r < 0 || r > 7) continue;
    if (file(p) > 0) out.add(at(file(p) - 1, r));
    if (file(p) < 7) out.add(at(file(p) + 1, r));
  }
  return out;
}

export function material(board: Board, c: Color): number {
  let total = 0;
  for (const p of board.pieceMap().values()) total += VALUE[p.role] * (p.color === c ? 1 : -1);
  return total;
}

// ---------- 1. the pawn structure ----------

export interface Structure {
  key: 'iqp' | 'carlsbad' | 'maroczy' | 'boleslavsky' | 'french' | 'locked' | 'open' | 'hanging';
  name: string;
  owner: Color | null;           // whose pawns make it (the IQP's side, …)
  plan(c: Color): string;        // the plan for side c
}

const hasPawn = (board: Board, c: Color, f: number) => pawnsOf(board, c).some((p) => file(p) === f);
const pawnOn = (board: Board, c: Color, s: string) => board.pieceAt(parse(s))?.role === 'pawn' && board.pieceAt(parse(s))?.color === c;
/** A square named from White's side ("d5"), as seen from `c`'s side (Black's d5 is d4). */
const mirror = (c: Color, s: string) => (c === 'white' ? s : `${s[0]}${9 - Number(s[1])}`);
/** Whether `c` has a pawn that could be pushed to square `sq` (named from the board, e.g. "b5"): a pawn of
 *  its own on that file, behind the square, with no pawn of either side in the way. Plans only name
 *  pawn moves that pass this — never a push for a pawn that isn't there. */
export function canReach(board: Board, c: Color, sq: string): boolean {
  const target = parse(sq);
  const f = file(target);
  return pawnsOf(board, c).some((p) => {
    if (file(p) !== f || relRank(p, c) >= relRank(target, c)) return false;
    for (let r = rank(p) + forward(c); ; r += forward(c)) {
      if (board.pieceAt(at(f, r))?.role === 'pawn') return false;
      if (r === rank(target)) return true;
    }
  });
}
/** Whether `c` has a piece of this kind on the board — advice never names a piece that isn't there. */
const has = (board: Board, c: Color, role: Role) => board.pieces(role, c).length > 0;
/** `c` has a bishop on the light squares. */
const lightBishop = (board: Board, c: Color) => board.pieces('bishop', c).some(light);
/** "a and b" / "a, b and c" (for the plans). */
const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** A pawn move by `c` as written in prose: Black's moves get the "…". */
const by = (c: Color, sq: string) => (c === 'black' ? `…${sq}` : sq);
/** Closed centres (a pawn chain): plans on the wings, knights over bishops. */
export const isClosed = (s: Structure | null) => s?.key === 'locked' || s?.key === 'french';

/** The named structure on the board, if it's one worth naming (not in an endgame: with the queens off
 *  and a rook and minor piece or less each, it's about kings and passed pawns instead). */
export function structure(board: Board): Structure | null {
  const queensOff = !board.pieces('queen', 'white').length && !board.pieces('queen', 'black').length;
  if (queensOff && pieceMaterial(board, 'white') <= 13 && pieceMaterial(board, 'black') <= 13) return null;
  for (const c of ['white', 'black'] as Color[]) {
    const d = hasPawn(board, c, 3);
    // isolated d-pawn: a d-pawn with no c- or e-pawn beside it
    if (d && !hasPawn(board, c, 2) && !hasPawn(board, c, 4)) {
      const dp = pawnsOf(board, c).filter((p) => file(p) === 3).sort((a, b) => relRank(b, c) - relRank(a, c))[0];
      const next = relRank(dp, c) < 6 ? name(dp + 8 * forward(c)) : null;
      const push = next && canReach(board, c, next) ? ` and ${by(c, next)} is your break` : '';
      return { key: 'iqp', name: "an isolated queen's pawn position", owner: c,
        plan: (me) => (me === c ? `keep the pieces on and play actively — the d-pawn gives you space${push}`
          : `trade pieces and blockade the pawn with ${has(board, opposite(c), 'knight') ? 'a knight' : 'a piece'} in front of it — in the endgame it becomes a weakness`) };
    }
    // hanging pawns: c- and d-pawns side by side with no b- or e-pawns
    const cd = pawnsOf(board, c).filter((p) => file(p) === 2 || file(p) === 3);
    if (cd.length === 2 && rank(cd[0]) === rank(cd[1]) && !hasPawn(board, c, 1) && !hasPawn(board, c, 4)) {
      return { key: 'hanging', name: 'hanging pawns', owner: c,
        plan: (me) => (me === c ? 'keep them side by side and use the space; pushing one at the right moment opens lines'
          : `pressure them with ${has(board, opposite(c), 'rook') ? 'rooks on the c- and d-files' : 'your pieces'} and make one of them advance — then the other is weak`) };
    }
  }
  // Carlsbad: White d4 with no c-pawn; Black c6 + d5 with no e-pawn (or the mirror)
  for (const c of ['white', 'black'] as Color[]) {
    const o = opposite(c);
    const [d4, c6, d5] = c === 'white' ? ['d4', 'c6', 'd5'] : ['d5', 'c3', 'd4'];
    if (pawnOn(board, c, d4) && !hasPawn(board, c, 2) && pawnOn(board, o, c6) && pawnOn(board, o, d5) && !hasPawn(board, o, 4)) {
      const b5 = mirror(c, 'b5');
      return { key: 'carlsbad', name: 'a Carlsbad structure', owner: c,
        plan: (me) => (me === c ? (canReach(board, c, b5) ? `the minority attack: push your b-pawn to ${b5} to make a weakness on ${c6}`
          : `put pressure on ${c6}${has(board, c, 'rook') || has(board, c, 'queen') ? ' down the c-file' : ' with your pieces'} — it's the target in this structure`)
          : `play on the kingside${has(board, o, 'knight') ? `, and get a knight to ${mirror(o, 'e4')} / ${mirror(o, 'e5')}` : ''}`) };
    }
  }
  // Maroczy bind: c- and e-pawns on the 4th, the d-pawn traded for the opponent's c-pawn, and the
  // opponent's d-pawn behind (…d6 or …d7) — both of its breaks, …d5 and …b5, are bottled up
  for (const c of ['white', 'black'] as Color[]) {
    const o = opposite(c);
    const [c4, e4, d6, d7, e5] = ['c4', 'e4', 'd6', 'd7', 'e5'].map((x) => mirror(c, x));
    if (pawnOn(board, c, c4) && pawnOn(board, c, e4) && !hasPawn(board, c, 3) && !hasPawn(board, o, 2)
      && (pawnOn(board, o, d6) || pawnOn(board, o, d7)) && !pawnOn(board, o, e5)) {
      const [d5, b5, a4] = ['d5', 'b5', 'a4'].map((x) => mirror(c, x));
      const theirBreaks = [b5, d5].filter((x) => canReach(board, o, x)).map((x) => by(o, x));
      const stopB = canReach(board, o, b5) && canReach(board, c, a4) ? `, and ${by(c, a4)} stops ${by(o, b5)}` : '';
      return { key: 'maroczy', name: 'a Maroczy bind', owner: c,
        plan: (me) => (me === c ? `squeeze: your c- and e-pawns stop ${by(o, d5)}${stopB} — ${has(board, c, 'knight') ? `put a knight on ${d5}, ` : ''}improve your pieces behind the pawns and expand slowly`
          : `you're cramped, so trade pieces (minor pieces especially) and keep everything solid${theirBreaks.length ? ` — prepare ${theirBreaks.join(' or ')}: once a break lands, the cramp is gone` : ''}`) };
    }
  }
  // Boleslavsky hole: an open Sicilian where the side without a c-pawn has played …e5 with …d6 —
  // d5 can never be covered by a pawn again, and the d-pawn behind it is backward ("owner" = the side
  // that owns the hole: its pieces can sit there)
  for (const c of ['white', 'black'] as Color[]) {
    const o = opposite(c);
    const [e4, e5, d6, d5] = ['e4', 'e5', 'd6', 'd5'].map((x) => mirror(c, x));
    const oneD = pawnsOf(board, o).filter((p) => file(p) === 3).length === 1;      // …d6 is its only d-pawn (no …d4 wedge)
    if (pawnOn(board, c, e4) && !hasPawn(board, c, 3) && pawnOn(board, o, e5) && pawnOn(board, o, d6) && oneD && !hasPawn(board, o, 2)) {
      return { key: 'boleslavsky', name: `a Sicilian with a hole on ${d5} (the Boleslavsky hole)`, owner: c,
        plan: (me) => (me === c ? `put ${has(board, c, 'knight') ? 'a knight' : 'a piece'} on ${d5} — no pawn can ever chase it away — keep ${by(o, d5)} from happening, and press the backward pawn on ${d6}`
          : `the hole on ${d5} is the price of your active pieces: fight for ${d5} with pieces, ${has(board, o, 'rook') || has(board, o, 'queen') ? 'use the open c-file ' : ''}and expand on the queenside — and if you can ever play ${by(o, d5)} safely, the hole and the backward pawn both disappear`) };
    }
  }
  // the French chain: d4 + e5 against d5 + e6 — the chain points at the kingside
  for (const c of ['white', 'black'] as Color[]) {
    const o = opposite(c);
    const [d4, e5, d5, e6, c5, f6] = ['d4', 'e5', 'd5', 'e6', 'c5', 'f6'].map((x) => mirror(c, x));
    if (pawnOn(board, c, d4) && pawnOn(board, c, e5) && pawnOn(board, o, d5) && pawnOn(board, o, e6)) {
      const hits = [[c5, d4], [f6, e5]].filter(([x]) => canReach(board, o, x)).map(([x, t]) => `${by(o, x)} hits ${t}`);
      return { key: 'french', name: 'a French pawn chain', owner: c,
        plan: (me) => (me === c ? `your pawns point at the kingside, so play there: keep ${d4} and ${e5} supported and attack the king`
          : `${hits.length ? `break at the chain: ${and(hits)}` : `pile up on ${d4} with your pieces — it's the chain's weak link`}${lightBishop(board, o) ? ' — and free your light-squared bishop (or trade it)' : ''}, because a French that never breaks gets squeezed`) };
    }
  }
  // locked centre: pawns blocking each other on the d- and e-files, or on one of them with a pawn chain
  // behind (1.e4 e5 alone isn't locked — the d-pawns can still open it)
  // (only pawns pushed past the middle lock anything: d4 against d5 can still be opened by c4 / e4)
  const blocked = [3, 4].filter((f) => pawnsOf(board, 'white').some((p) => file(p) === f && rank(p) !== 3
    && board.pieceAt(at(f, rank(p) + 1))?.role === 'pawn' && board.pieceAt(at(f, rank(p) + 1))?.color === 'black'));
  if (blocked.length === 2 || (blocked.length === 1 && (chainBase(board, 'white') !== null || chainBase(board, 'black') !== null))) {
    return { key: 'locked', name: 'a locked centre', owner: null,
      plan: () => "with the centre closed, play on the wing your pawns point to, and attack the base of your opponent's pawn chain" };
  }
  if (!hasPawn(board, 'white', 3) && !hasPawn(board, 'white', 4) && !hasPawn(board, 'black', 3) && !hasPawn(board, 'black', 4)) {
    return { key: 'open', name: 'an open centre', owner: null,
      plan: () => 'with the centre open, it\'s about active pieces, the open files and king safety' };
  }
  return null;
}

// ---------- 2. the pieces' jobs ----------

/** Pawn pushes that would hit an enemy pawn: a side's "breaks", as moves (uci). */
export function breakMoves(board: Board, c: Color): string[] {
  const out: string[] = [];
  const view = board.turn === c ? board : passTurn(board);      // a pinned pawn, or a side in check, has no break
  const theirs = new Set(pawnsOf(board, opposite(c)));
  for (const p of pawnsOf(board, c)) {
    const steps = relRank(p, c) === 1 ? [1, 2] : [1];
    for (const n of steps) {
      const to = p + 8 * forward(c) * n;
      if (to < 0 || to > 63 || board.pieceAt(to) || (n === 2 && board.pieceAt(p + 8 * forward(c)))) break;
      const r = rank(to) + forward(c);
      const hits = [file(to) - 1, file(to) + 1].some((f) => f >= 0 && f <= 7 && r >= 0 && r <= 7 && theirs.has(at(f, r)));
      if (hits && (!view || view.isLegal(name(p) + name(to)))) out.push(name(p) + name(to));
    }
  }
  return out;
}

/** Pawn pushes that would hit an enemy pawn: a side's "breaks" (the squares they go to). */
export function breaks(board: Board, c: Color): string[] {
  return breakMoves(board, c).map((m) => m.slice(2, 4));
}

const worth = (r: Role) => (r === 'king' ? 100 : VALUE[r]);
const ROLE_DIRS: Partial<Record<Role, number[][]>> = {
  bishop: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  rook: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  queen: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

/** Enemy pieces the slider on `sq` pins to their king or queen (a piece in front, a bigger one behind). */
function pinsFrom(board: Board, sq: Square): Square[] {
  const me = board.pieceAt(sq);
  if (!me) return [];
  const out: Square[] = [];
  for (const [df, dr] of ROLE_DIRS[me.role] ?? []) {
    const hit: Square[] = [];
    for (let f = file(sq) + df, r = rank(sq) + dr; f >= 0 && f <= 7 && r >= 0 && r <= 7 && hit.length < 2; f += df, r += dr) {
      if (board.pieceAt(at(f, r))) hit.push(at(f, r));
    }
    const [front, back] = hit.map((h) => board.pieceAt(h)!);
    if (hit.length === 2 && front.color !== me.color && back.color !== me.color && front.role !== 'king'
      && (back.role === 'king' || (back.role === 'queen' && front.role !== 'queen'))) out.push(hit[0]);
  }
  return out;
}

/** What a move does, in a few words each, most telling first ("takes the knight", "forks the rook and
 *  queen", "opens the diagonal for your bishop on c1"…) — the reasons a coach gives for a move.
 *  whose: how to name the mover's own pieces ("your", or "their" for the opponent's moves). */
export function moveReasons(before: Board, uci: string, whose = 'your'): string[] {
  if (!before.isLegal(uci)) return [];
  const me = before.turn;
  const o = opposite(me);
  const after = before.copy();
  after.push(uci);
  const from = parse(uci.slice(0, 2));
  const to = parse(uci.slice(2, 4));
  const piece = before.pieceAt(from)!;
  const out: string[] = [];
  if (after.isCheckmate()) return ['mates'];
  if (before.isCastling(uci)) return ['castles: the king gets safe and the rook comes into play'];
  const taken = before.pieceAt(to) ?? (before.isEnPassant(uci) ? { role: 'pawn' as Role, color: o } : undefined);
  if (taken) out.push(`takes the ${taken.role}`);
  // what it now attacks: bigger pieces, or ones nothing defends (a fork when there are two)
  const targets = after.attacks(to).filter((t) => {
    const p = after.pieceAt(t);
    return p && p.color === o && p.role !== 'pawn' && (p.role === 'king' || VALUE[p.role] > VALUE[piece.role] || !after.attackers(o, t).length);
  }).sort((a, b) => worth(after.pieceAt(b)!.role) - worth(after.pieceAt(a)!.role));      // the king first, then the biggest
  const named = (t: Square) => after.pieceAt(t)!.role === 'king' ? 'king' : `${after.pieceAt(t)!.role} on ${name(t)}`;
  // checks: double, discovered (from a piece that didn't move), or plain
  const theirKing = after.king(o);
  const checkers = after.isCheck() && theirKing !== undefined ? after.attackers(me, theirKing) : [];
  const discovered = checkers.find((c) => c !== to);
  if (checkers.length >= 2) out.push('gives double check — the king has to move');
  else if (discovered !== undefined) out.push(`gives a discovered check from the ${after.pieceAt(discovered)!.role} on ${name(discovered)}`);
  if (targets.length >= 2) out.push(`forks the ${named(targets[0])} and the ${named(targets[1])}`);
  else if (checkers.length === 1 && discovered === undefined) out.push('gives check');
  else if (targets.length && after.pieceAt(targets[0])!.role !== 'king') out.push(`attacks the ${named(targets[0])}`);
  // a discovered attack: a long-range piece that didn't move now hits something it didn't before
  if (!checkers.length) {
    const uncovered = [...after.pieceMap()].flatMap(([sq, p]) => (p.color !== me || sq === to || !['bishop', 'rook', 'queen'].includes(p.role) ? []
      : after.attacks(sq).filter((t) => {
        const q = after.pieceAt(t);
        return q && q.color === o && q.role !== 'pawn' && !before.attacks(sq).includes(t)
          && (VALUE[q.role] > VALUE[p.role] || !after.attackers(o, t).length);
      }).map((t) => [sq, t] as [Square, Square])))[0];
    if (uncovered) out.push(`uncovers an attack by the ${after.pieceAt(uncovered[0])!.role} on ${name(uncovered[0])} on the ${after.pieceAt(uncovered[1])!.role} on ${name(uncovered[1])}`);
  }
  // removing the defender: what it took was the only guard of something you attack
  if (taken) {
    const exposed = [...after.pieceMap()].find(([sq, p]) => p.color === o && p.role !== 'king' && p.role !== 'pawn'
      && before.attackers(o, sq).includes(to) && before.attackers(o, sq).length === 1 && after.attackers(me, sq).length > 0 && !after.attackers(o, sq).length);
    if (exposed) out.push(`removes the only defender of the ${exposed[1].role} on ${name(exposed[0])}`);
  }
  // a trapped piece: attacked, and nowhere safe to go
  const trapped = [...after.pieceMap()].find(([sq, p]) => {
    if (p.color !== o || !['knight', 'bishop', 'rook', 'queen'].includes(p.role) || !after.attackers(me, sq).length) return false;
    if (before.attackers(me, sq).length) return false;                    // it's this move that does it
    const threatened = after.attackers(me, sq).some((a) => VALUE[after.pieceAt(a)!.role] < VALUE[p.role]) || !after.attackers(o, sq).length;
    if (!threatened) return false;
    const exits = after.legalMoves().filter((m) => parse(m.slice(0, 2)) === sq);
    return exits.every((m) => {                                          // every square it can reach is covered, and taking there doesn't pay for it
      const t = parse(m.slice(2, 4));
      const cap = after.pieceAt(t);
      return after.isAttackedBy(me, t) && (!cap || VALUE[cap.role] < VALUE[p.role]);
    });
  });
  if (trapped) out.push(`traps the ${trapped[1].role} on ${name(trapped[0])}`);
  for (const pinned of pinsFrom(after, to).slice(0, 1)) out.push(`pins the ${after.pieceAt(pinned)!.role} on ${name(pinned)}`);
  // a piece that was in trouble steps away
  const inDanger = (b: Board, sq: Square, role: Role) => b.attackers(o, sq).some((a) => VALUE[b.pieceAt(a)!.role] < VALUE[role]) || (b.attackers(o, sq).length > 0 && !b.attackers(me, sq).length);
  if (piece.role !== 'pawn' && piece.role !== 'king' && !taken && inDanger(before, from, piece.role) && !after.attackers(o, to).length) out.push(`brings the attacked ${piece.role} to safety`);
  // own pieces it now guards that were hanging
  const saved = [...after.pieceMap()].find(([sq, p]) => sq !== to && p.color === me && p.role !== 'king' && p.role !== 'pawn'
    && inDanger(before, sq, p.role) && after.attacks(to).includes(sq) && !before.attackers(me, sq).length);
  if (saved) out.push(`defends ${whose} ${saved[1].role} on ${name(saved[0])}`);
  // development and the centre
  const homeRank = me === 'white' ? 0 : 7;
  if ((piece.role === 'knight' || piece.role === 'bishop') && rank(from) === homeRank && before.fullmoveNumber <= 15) out.push(`develops the ${piece.role}`);
  else if (piece.role === 'knight' && file(to) >= 2 && file(to) <= 5 && rank(to) >= 2 && rank(to) <= 5 && !(file(from) >= 2 && file(from) <= 5 && rank(from) >= 2 && rank(from) <= 5)) out.push('brings the knight to the centre');
  if (piece.role === 'knight' && isOutpost(after, to, me)) out.push('takes an outpost no pawn can chase it from');
  // pawns: hitting their pawns, freeing your bishops, running
  if (piece.role === 'pawn') {
    const r = rank(to) + forward(me);
    const hit = [file(to) - 1, file(to) + 1].filter((f) => f >= 0 && f <= 7 && r >= 0 && r <= 7).map((f) => at(f, r))
      .find((t) => after.pieceAt(t)?.role === 'pawn' && after.pieceAt(t)?.color === o);
    if (hit !== undefined && !taken) out.push(`strikes at the pawn on ${name(hit)}`);
    const freed = before.pieces('bishop', me).find((b) => after.sliderMobility(b) - before.sliderMobility(b) >= 2);
    if (freed !== undefined && !out.some((x) => x.startsWith(`uncovers an attack by the bishop on ${name(freed)}`))) out.push(`opens the diagonal for ${whose} bishop on ${name(freed)}`);
    if (passedPawns(after, me).includes(to) && relRank(to, me) >= 4) out.push('pushes the passed pawn');
    if (!out.length && file(to) >= 2 && file(to) <= 5 && relRank(to, me) >= 3 && relRank(from, me) <= 2) out.push('takes space in the centre');
  }
  // rooks: open files and the 7th rank
  if (piece.role === 'rook' || piece.role === 'queen') {
    const mineOn = pawnsOf(after, me).some((p) => file(p) === file(to));
    const theirsOn = pawnsOf(after, o).some((p) => file(p) === file(to));
    if (piece.role === 'rook' && file(from) !== file(to) && !mineOn) out.push(`puts the rook on the ${theirsOn ? 'half-open' : 'open'} ${fileName(file(to))}`);
    if (relRank(to, me) === 6 && relRank(from, me) !== 6) out.push(`gets the ${piece.role} to the 7th rank`);
  }
  return out;
}

/** A bishop walled in by its own pawns on its colour (few squares to go to): three or more of
 *  them on its colour, at least two already advanced (so the starting position doesn't count). */
export function badBishops(board: Board, c: Color): Square[] {
  const pawns = pawnsOf(board, c);
  return board.pieces('bishop', c).filter((b) => {
    const same = pawns.filter((p) => light(p) === light(b));
    return same.length >= 3 && same.filter((p) => relRank(p, c) >= 2).length >= 2 && board.sliderMobility(b) <= 3;
  });
}

/** Safe squares a knight can go to (not taken by its own pieces or covered by enemy pawns). */
function knightSquares(board: Board, sq: Square, c: Color): number {
  const covered = pawnAttacks(board, opposite(c));
  return board.attacks(sq).filter((t) => board.pieceAt(t)?.color !== c && !covered.has(t)).length;
}

/** Knights with at most one safe square to go to. */
export function stuckKnights(board: Board, c: Color): Square[] {
  return board.pieces('knight', c).filter((n) => knightSquares(board, n, c) <= 1);
}

/** A square in the opponent's half that your pawn guards and no enemy pawn can ever attack. */
export function isOutpost(board: Board, sq: Square, c: Color): boolean {
  if (relRank(sq, c) < 3 || relRank(sq, c) > 5) return false;
  if (!pawnAttacks(board, c).has(sq)) return false;
  const o = opposite(c);
  return !pawnsOf(board, o).some((p) => Math.abs(file(p) - file(sq)) === 1 && (c === 'white' ? rank(p) > rank(sq) : rank(p) < rank(sq)));
}

/** Knights and bishops still on their starting squares. */
export function piecesAtHome(board: Board, c: Color): number {
  const home = c === 'white' ? ['b1', 'g1', 'c1', 'f1'] : ['b8', 'g8', 'c8', 'f8'];
  const roles: Role[] = ['knight', 'knight', 'bishop', 'bishop'];
  return home.filter((s, i) => board.pieceAt(parse(s))?.role === roles[i] && board.pieceAt(parse(s))?.color === c).length;
}

/** Pawns missing or pushed in front of a castled king (0 = intact shield). */
export function shieldDamage(board: Board, c: Color): number {
  const k = board.king(c);
  if (k === undefined || relRank(k, c) !== 0 || (file(k) > 2 && file(k) < 6)) return 0;     // not castled-looking
  const files = file(k) >= 6 ? [5, 6, 7] : [0, 1, 2];
  return files.filter((f) => !board.pieceAt(at(f, c === 'white' ? 1 : 6)) || board.pieceAt(at(f, c === 'white' ? 1 : 6))?.role !== 'pawn').length;
}

// ---------- the move ----------

export interface CoachInput {
  fenBefore: string;
  move: string;                    // what was played (uci)
  best: string | null;             // Stockfish's move
  cpBefore: number;                // the mover's point of view
  cpAfter: number | null;          // after the move played
  second?: string | null;          // Stockfish's 2nd choice
  cpSecond?: number | null;
  bestLine?: string[];             // Stockfish's line starting with `best`, if known
  /** What the best move achieves and what went wrong with the move played (explain.solutionFacts):
   *  `facts.best` is about the move played when it was the best one. */
  facts?: SolutionFacts;
  /** More reasons the move was poor, from elsewhere (opening principles: "gives up castling …"). */
  extraBad?: string[];
  /** This was the game's turning point. */
  turningPoint?: boolean;
  /** Say the structure even if this move didn't change it (the first time it's shown). */
  showStructure?: boolean;
}

export type Verdict = 'blunder' | 'mistake' | 'inaccuracy' | 'good' | 'best' | 'fine';

const clamp = (cp: number) => Math.max(-MATE_CP, Math.min(MATE_CP, cp));
/** Lichess's winning chances, -1..1. */
const chances = (cp: number) => 2 / (1 + Math.exp(-0.00368208 * clamp(cp))) - 1;

export function verdictOf(i: CoachInput): Verdict {
  if (i.cpAfter === null) return 'fine';
  const loss = Math.max(0, clamp(i.cpBefore) - clamp(i.cpAfter));
  if (loss >= 300) return 'blunder';
  if (loss >= 150) return 'mistake';
  if (loss >= 80) return 'inaccuracy';
  if (i.best && i.move === i.best) return 'best';
  return loss <= 20 ? 'good' : 'fine';
}

/** Human reasons a move made things worse (or better), from what it changed on the board. */
export function changes(before: Board, move: string): { bad: string[]; good: string[] } {
  const me = before.turn;
  const after = before.copy();
  after.push(move);
  const bad: string[] = [];
  const good: string[] = [];
  const from = parse(move.slice(0, 2));
  const to = parse(move.slice(2, 4));
  const piece = before.pieceAt(from)!;
  // a bishop walled in by this move
  const badBefore = new Set(badBishops(before, me));
  for (const b of badBishops(after, me)) if (!badBefore.has(b) && b !== to) bad.push(`walls in your own bishop on ${name(b)} behind your pawns`);
  if (piece.role === 'bishop' && badBishops(after, me).includes(to) && !badBefore.has(from)) bad.push(`puts the bishop on ${name(to)}, where it has almost no squares`);
  // a knight sent where it has no squares
  if (piece.role === 'knight' && stuckKnights(after, me).includes(to)) bad.push(`puts the knight on ${name(to)}, where it has nowhere to go`);
  if (piece.role === 'knight' && isOutpost(after, to, me)) good.push(`puts the knight on ${name(to)}, a square no pawn can ever chase it from`);
  // a pawn move that gives the opponent a permanent square
  if (piece.role === 'pawn') {
    const o = opposite(me);
    for (const n of after.pieces('knight', o)) {
      for (const t of after.attacks(n)) {
        if (isOutpost(after, t, o) && !isOutpost(before, t, o) && !after.pieceAt(t)) {
          bad.push(`gives your opponent's knight a permanent home on ${name(t)}`);
          break;
        }
      }
      if (bad.length && bad[bad.length - 1].includes('permanent home')) break;
    }
  }
  // the king's shelter: the middle pawn (g / b) and two-square pushes loosen it; a one-square f- or
  // h-pawn move is mostly harmless (luft), and g3 / g6 with the bishop still there is a fianchetto —
  // unless pieces are already bearing down on the king
  if (piece.role === 'pawn' && shieldDamage(after, me) > shieldDamage(before, me)) {
    const k = before.king(me)!;
    const middle = file(from) === (file(k) >= 6 ? 6 : 1);
    const fianchetto = middle && Math.abs(rank(to) - rank(from)) === 1
      && before.pieces('bishop', me).some((b) => light(b) === light(from));
    const pressed = kingPressure(after, me).attackers >= 2;
    if (pressed || (middle && !fianchetto) || Math.abs(rank(to) - rank(from)) === 2) bad.push("loosens the pawns in front of your castled king");
  }
  // development
  const home = piecesAtHome(before, me);
  if (before.fullmoveNumber <= 15 && home >= 3 && piece.role !== 'knight' && piece.role !== 'bishop' && !before.isCapture(move) && !before.isCastling(move)) {
    bad.push(`leaves ${home} minor pieces at home — get them out first`);
  }
  if (before.isCastling(move)) good.push('gets your king safe and your rook into the game');
  // material
  // a capture: "takes" — whether it *wins* anything depends on the recapture (the engine line says that)
  const taken = before.pieceAt(to);
  if (taken && taken.color !== me) good.push(`takes the ${taken.role} on ${name(to)}`);
  return { bad, good };
}

/** The habit behind a poor move, when it's a recognisable one (from how coaches teach
 *  improving players): a check for its own sake, a one-move attack, trading when down,
 *  trading queens in your own attack, grabbing a pawn before developing. */
export function habits(before: Board, i: CoachInput): string[] {
  const me = before.turn;
  const o = opposite(me);
  const out: string[] = [];
  const from = parse(i.move.slice(0, 2));
  const to = parse(i.move.slice(2, 4));
  const piece = before.pieceAt(from)!;
  const taken = before.pieceAt(to);
  const after = before.copy();
  after.push(i.move);
  if (before.givesCheck(i.move) && !taken) out.push('is a check for its own sake — it just helps their king to a better square');
  else if (!taken && piece.role !== 'pawn') {
    // a one-move attack: it hits something worth as much or more, which can simply step away
    const hits = after.attacks(to).map((t) => after.pieceAt(t)).filter((p) => p && p.color === o && p.role !== 'pawn' && p.role !== 'king'
      && VALUE[p.role] >= VALUE[piece.role]);
    if (hits.length) out.push(`attacks the ${hits[0]!.role}, but that's a one-move threat — it just steps away, and your ${piece.role} isn't doing much there`);
  }
  if (taken && material(before, me) <= -2 && VALUE[taken.role] === VALUE[piece.role] && taken.role !== 'pawn') {
    out.push('trades pieces while you\'re down material — every trade helps your opponent; keep pieces on and look for counterplay');
  }
  if (taken?.role === 'queen' && piece.role === 'queen' && i.cpBefore > 50 && (shieldDamage(before, o) >= 2 || !castledLike(before, o))) {
    out.push("trades queens in your own attack — your queen was your best attacker; don't trade it while their king is weak");
  }
  if (taken?.role === 'pawn' && before.fullmoveNumber <= 15 && piecesAtHome(before, me) >= 2) {
    out.push("grabs a pawn while your pieces are still at home — don't cash in too quickly; it gives your opponent time");
  }
  // kings on opposite wings: a pawn pushed in front of your own king gives their storm something to hit
  const kMe = before.king(me);
  const kThem = before.king(o);
  if (piece.role === 'pawn' && !taken && kMe !== undefined && kThem !== undefined && castledLike(before, me) && castledLike(before, o)
    && (file(kMe) >= 6) !== (file(kThem) >= 6) && (file(kMe) >= 6 ? file(from) >= 5 : file(from) <= 2)) {
    out.push("pushes a pawn in front of your own king while the kings are on opposite sides — it gives their pawns a hook to hit and opens lines toward you");
  }
  return out;
}

/** Is the engine's move one a person rarely finds? A quiet move that's much better than anything else. */
export function computerMove(before: Board, i: CoachInput): boolean {
  if (!i.best || i.cpSecond === null || i.cpSecond === undefined) return false;
  const quiet = !before.isCapture(i.best) && !before.givesCheck(i.best);
  return quiet && chances(i.cpBefore) - chances(i.cpSecond) >= 0.25;
}

const san = (board: Board, uci: string) => (board.isLegal(uci) ? board.san(uci) : uci);
const side = (c: Color) => (c === 'white' ? 'White' : 'Black');

/** What a mistake did to the evaluation, in words. */
function edgeText(before: number, after: number): string {
  if (before >= 150 && after < 50) return 'and your advantage is gone';
  if (before >= 300) return 'and part of your winning advantage slips away';
  if (Math.abs(before) < 100 && after <= -100) return "and now you're the one who's worse";
  if (before <= -100) return 'which makes a difficult position harder';
  return `which costs you about ${pySigned((before - after) / 100, 1).replace('+', '')} pawns`;
}

/** A line's material count is only believed when the evaluation agrees (a short line can stop
 *  in the middle of a trade): about 0.8 pawns of evaluation per point claimed, up to a rook. */
const backed = (points: number, cp: number) => points >= 1 && cp >= 80 * Math.min(points, 5);

/** "Better was d5 — it gains space. The idea: 8.d5 O-O 9.Qd2." cp: the evaluation after it, your side. */
function bestText(b: SolutionFacts['best'], lead: string, cp: number): string {
  const what = b.features.length ? `${b.san} — it ${b.features.join(' and ')}` : b.san;
  if (b.mate) return `${lead}${what}, and it forces mate: ${b.line}.`;
  if (backed(b.gain, cp)) return `${lead}${what}: ${b.line} wins ${materialWords(b.gain)}.`;
  const plus = b.scope.filter((n) => !/blocks|shuts|locks/.test(n));
  if (plus.length) return `${lead}${what}, which ${plus[0].replace(/^it /, '')}. The idea: ${b.shortLine}.`;
  return `${lead}${what}. The idea: ${b.shortLine}.`;
}

/** What went wrong with the move played, from the engine's reply. */
function playedText(p: NonNullable<SolutionFacts['played']>, i: CoachInput, opp: string): string {
  if (p.mated) return `${p.san} allows a forced mate: ${p.mateLine}.`;
  if (p.lossLine && backed(p.lost, i.cpBefore - (i.cpAfter ?? p.cp ?? i.cpBefore))) return `${p.san} runs into ${p.lossLine} — you lose ${materialWords(p.lost)}.`;
  if (p.hanging.length) return `${p.san} leaves your ${p.hanging[0]} hanging.`;
  if (p.king) return `${p.san} ${p.king.replace(/^it /, '')}.`;
  const after = i.cpAfter ?? p.cp ?? i.cpBefore;
  if (p.reply) return `${p.san} lets ${opp} play ${p.reply}, ${edgeText(i.cpBefore, after)}.`;
  return `${p.san} ${edgeText(i.cpBefore, after)}.`.replace(/ and /, ' — ');
}

/** The Coach's take on one move, in a few short sentences. */
export function coach(i: CoachInput): string {
  const before = Board.fromFen(i.fenBefore);
  const me = before.turn;
  const after = before.copy();
  after.push(i.move);
  const played = san(before, i.move);
  const bestSan = i.best ? san(before, i.best) : null;
  const v = verdictOf(i);
  const mistake = v === 'blunder' || v === 'mistake' || v === 'inaccuracy';
  const lines: string[] = [];
  const { bad: boardBad, good } = changes(before, i.move);
  const bad = [...(mistake ? habits(before, i) : []), ...boardBad, ...(i.extraBad ?? [])];

  // 1. the structure, when this move made it, at the turning point, or when asked for
  const s0 = structure(before);
  const s1 = structure(after);
  if (s1 && (i.showStructure || i.turningPoint || s1.key !== s0?.key)) lines.push(`This is ${s1.name}: for you, ${s1.plan(me)}.`);

  // 2. the move, and why
  if (mistake) {
    const lead = i.turningPoint ? 'This is where the game turned. ' : '';
    const early = i.bestLine && i.bestLine.indexOf(i.move) === 2 && bestSan;
    if (early) lines.push(`${lead}${played} was the right idea, one move too early — ${bestSan} first, then ${played}.`);
    else if (i.facts?.played) lines.push(lead + playedText(i.facts.played, i, side(opposite(me))));
    else if (bestSan) lines.push(`${lead}${played} lets things slip.`);
    if (bad.length) lines.push(`On top of that, ${played} ${bad.slice(0, 2).join('; ').replace(/^it /, '')}.`);
    if (!early && i.facts) lines.push(bestText(i.facts.best, 'Better was ', i.cpBefore));
    else if (!early && bestSan) lines.push(`Better was ${bestSan}.`);
  } else if (v === 'best' || v === 'good') {
    if (i.facts) lines.push(bestText(i.facts.best, '', i.cpBefore));
    else if (good.length) lines.push(`${played} ${good.slice(0, 2).join(' and ')}.`);
    if (bad.length) lines.push(`One thing to keep an eye on: it ${bad[0].replace(/^it /, '')}.`);
  } else if (good.length || bad.length) {
    lines.push(good.length ? `${played} ${good[0]}.` : `${played} is playable, but it ${bad[0].replace(/^it /, '')}.`);
  }

  // 3. the human alternative
  if (mistake && i.best && computerMove(before, i)) {
    lines.push(`${bestSan} is a very computer-like move, though — hard to find over the board.`
      + (i.second && i.second !== i.move ? ` A more human choice was ${san(before, i.second)}.` : ''));
  } else if (mistake && i.second && i.second !== i.move && i.cpSecond !== null && i.cpSecond !== undefined
    && chances(i.cpBefore) - chances(i.cpSecond) < 0.08) {
    lines.push(`${san(before, i.second)} was just as good.`);
  } else if (v === 'best' && computerMove(before, i)) {
    lines.push("That's a move many strong players would miss — nicely found.");
  }

  // 4. the practical view
  const now = i.cpAfter ?? i.cpBefore;
  const mat = material(after, me);
  if (mat <= -2 && now >= 100 && Math.abs(now) < MATE_CP / 2) lines.push("You're down material but better: your pieces are doing the work, so keep them active.");
  else if (mat >= 2 && now <= 50 && Math.abs(now) < MATE_CP / 2) lines.push("Being material up doesn't mean winning here — the other side has enough activity for it.");
  if (mistake && i.cpBefore >= 300 && i.cpBefore < MATE_CP / 2) lines.push("When you're winning, take the safe way: trade pieces and keep it simple.");
  else if (!mistake && i.cpBefore <= -300 && i.cpBefore > -MATE_CP / 2) lines.push("When you're worse, don't try to be a hero — aim for a position you can hold.");
  else if (!mistake && Math.abs(now) <= 40 && v !== 'fine') lines.push("Objectively it's about equal — a perfectly playable game.");

  // 5. credit or reassurance (a small slip with nothing else wrong)
  const crossed = (i.cpAfter ?? 0) <= -100 && i.cpBefore > -100 || i.cpBefore >= 150 && (i.cpAfter ?? 0) < 50;
  if (v === 'inaccuracy' && !i.turningPoint && !crossed && !bad.length && !(i.facts?.played && (i.facts.played.lost >= 1 || i.facts.played.hanging.length))) {
    lines.push("Not a big deal — engines are picky here.");
  }
  return lines.join(' ');
}

// ---------- the ideas of a position (Game Review → 💡 Ideas) ----------

/** Passed pawns: no enemy pawn ahead on its own or a neighbouring file. */
export function passedPawns(board: Board, c: Color): Square[] {
  const theirs = pawnsOf(board, opposite(c));
  return pawnsOf(board, c).filter((p) => !theirs.some((t) => Math.abs(file(t) - file(p)) <= 1 && relRank(t, c) > relRank(p, c)));
}

export interface Majority { color: Color; wing: 'queenside' | 'kingside'; mine: number; theirs: number; candidate: Square }

const WINGS: ['queenside' | 'kingside', number[]][] = [['queenside', [0, 1, 2]], ['kingside', [4, 5, 6, 7]]];

/** Healthy pawn majorities: more pawns on a wing (a–c, or e–h) than the opponent, counted on different
 *  files (doubled pawns don't make a passer — one enemy pawn holds two), with no passed pawn there yet.
 *  The candidate is the pawn with no enemy pawn ahead on its own file, the furthest advanced. */
export function majorities(board: Board): Majority[] {
  const out: Majority[] = [];
  for (const c of ['white', 'black'] as Color[]) {
    const o = opposite(c);
    for (const [wing, files] of WINGS) {
      const mine = pawnsOf(board, c).filter((p) => files.includes(file(p)));
      const theirs = pawnsOf(board, o).filter((p) => files.includes(file(p)));
      const distinct = new Set(mine.map(file)).size;
      if (!theirs.length || distinct <= theirs.length) continue;
      if (passedPawns(board, c).some((p) => files.includes(file(p)))) continue;
      const free = mine.filter((p) => !theirs.some((t) => file(t) === file(p) && relRank(t, c) > relRank(p, c)))
        .sort((a, b) => relRank(b, c) - relRank(a, c));
      if (!free.length) continue;
      out.push({ color: c, wing, mine: mine.length, theirs: theirs.length, candidate: free[0] });
    }
  }
  return out;
}

/** Pawns with no friendly pawn on a neighbouring file. */
export function isolatedPawns(board: Board, c: Color): Square[] {
  const mine = pawnsOf(board, c);
  return mine.filter((p) => !mine.some((q) => Math.abs(file(q) - file(p)) === 1));
}

/** Files where `c` has two or more pawns. */
export function doubledFiles(board: Board, c: Color): number[] {
  const count = new Map<number, number>();
  for (const p of pawnsOf(board, c)) count.set(file(p), (count.get(file(p)) ?? 0) + 1);
  return [...count].filter(([, n]) => n >= 2).map(([f]) => f);
}

/** Files with no pawns at all. */
export function openFiles(board: Board): number[] {
  const pawns = [...pawnsOf(board, 'white'), ...pawnsOf(board, 'black')];
  return [0, 1, 2, 3, 4, 5, 6, 7].filter((f) => !pawns.some((p) => file(p) === f));
}

/** Empty outpost squares for `c` in the centre (c- to f-file) that one of its knights could use. */
export function outpostSquares(board: Board, c: Color): Square[] {
  if (!board.pieces('knight', c).length) return [];
  const out: Square[] = [];
  for (let f = 2; f <= 5; f++) {
    for (let r = 0; r < 8; r++) {
      const sq = at(f, r);
      if (!board.pieceAt(sq) && isOutpost(board, sq, c)) out.push(sq);
    }
  }
  return out;
}

/** Space: pawns past the 4th rank in the centre (c- to f-file). */
export function space(board: Board, c: Color): number {
  return pawnsOf(board, c).filter((p) => file(p) >= 2 && file(p) <= 5 && relRank(p, c) >= 4).length;
}

const castledLike = (board: Board, c: Color) => {
  const k = board.king(c);
  return k !== undefined && relRank(k, c) === 0 && (file(k) >= 6 || file(k) <= 2);
};
const fileName = (f: number) => `${'abcdefgh'[f]}-file`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Who's better, in words a human would use (cp: your point of view). */
export function evalWords(cp: number): string {
  if (cp >= MATE_CP / 2) return 'You have a forced mate.';
  if (cp <= -MATE_CP / 2) return 'Your opponent has a forced mate.';
  const p = Math.abs(cp) / 100;
  const who = cp > 0 ? 'you' : 'your opponent';
  if (p < 0.3) return 'The position is about equal.';
  if (p < 0.8) return `${cap(who)} ${cp > 0 ? 'are' : 'is'} slightly better (${pySigned(cp / 100, 1)}) — but an edge that small isn't something a human converts easily.`;
  if (p < 2) return `${cap(who)} ${cp > 0 ? 'have' : 'has'} a clear advantage (${pySigned(cp / 100, 1)}).`;
  return `${cap(who)} ${cp > 0 ? 'are' : 'is'} winning (${pySigned(cp / 100, 1)})${cp > 0 ? ' — now it\'s about taking the safe way home' : ''}.`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface IdeasInput {
  fen: string;
  me: Color;                     // whose side "you" is (your colour in the game)
  cp?: number | null;            // the evaluation, your point of view
  bestLine?: string[];           // Stockfish's line for the side to move
  /** Your opponent just moved: their move, and what it threatens (their best move if they
   *  could move again, and what it would gain them in centipawns). */
  theirMove?: string | null;
  threat?: { move: string; gain: number; line?: string[] } | null;
  /** Stockfish's top moves for the side to move, best first (cp: your point of view; line: its line). */
  alternatives?: { move: string; cp: number | null; line?: string[] }[];
  /** What the side to move would face if it passed (the other side's best move, and what it would gain
   *  them in centipawns), when the best move stops it: its prophylaxis. */
  prevents?: { move: string; gain: number } | null;
  /** The position just before (the last move undone): what's new here gets said first. */
  before?: string;
  /** Their last move took back on the square your move before it captured on (a recapture). */
  recapture?: boolean;
  /** Captures that trade into a pawn ending, with Stockfish's score for each (your point of view). */
  pawnTrades?: { move: string; cp: number | null }[];
}

/** One thing the Coach could say about a position: which rule said it, and how much it matters
 *  (0–100: a threat to deal with ~100, a background fact ~20). */
export interface IdeaPoint {
  section: string;
  rule: string;
  weight: number;
  text: string;
  /** Not true in the position before: the last move changed this. */
  fresh?: boolean;
}

export interface Ideas {
  summary: string;
  /** The few things that matter most here (shown first). */
  key: string[];
  /** Everything else, by topic (the key points aren't repeated here). */
  sections: { title: string; points: string[] }[];
  /** Every point with its rule and weight (for tuning and tests). */
  points: IdeaPoint[];
}

const squaresNamed = (text: string) => text.match(/\b[a-h][1-8]\b/g) ?? [];

/** The squares Stockfish's lines move on (their first plies): a fact about squares no line touches isn't the
 *  point of this position — Gotham's "abstract, not concrete". */
function lineSquares(fen: string, lines: (string[] | undefined)[], plies = 6): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    if (!line) continue;
    const b = Board.fromFen(fen);
    for (const m of line.slice(0, plies)) {
      if (!b.isLegal(m)) break;
      out.add(m.slice(0, 2));
      out.add(m.slice(2, 4));
      b.push(m);
    }
  }
  return out;
}

const nonPawnPieces = (b: Board) => (['knight', 'bishop', 'rook', 'queen'] as Role[]).reduce((n, r) => n + b.pieces(r, 'white').length + b.pieces(r, 'black').length, 0);

/** Points that are concrete by construction (read from the engine or exact theory): always eligible as key ideas. */
const CONCRETE = new Set(['threat', 'pawn-trade-bad', 'pawn-trade-good', 'pawn-trade-bad-theirs', 'pawn-trade-good-theirs', 'stalemate-trap',
  'lucena', 'philidor', 'philidor-available', 'square-runs', 'square-runs-theirs', 'wrong-bishop', 'wrong-bishop-theirs', 'rook-pawn-draw',
  'rook-pawn-draw-theirs', 'compensation', 'not-winning', 'race', 'down-keep', 'up-trade', 'intermezzo', 'dynamic-comp', 'dynamic-comp-theirs', 'static-edge']);
/** Never a key idea on their own (background, or said by the decision / plan already). */
const NOT_KEY = new Set(['criteria', 'stockfish', 'payoff', 'last-move', 'no-threat', 'material', 'space', 'breaks', 'breaks-theirs',
  'endgame-family', 'king-safety-off']);
const SECTIONS = ['What your opponent wants', 'Who has what', 'The situation', 'Plans', 'The pieces', 'Kings and weaknesses', 'The endgame', 'What Stockfish wants'];
const KEY_COUNT = 3;                   // key ideas shown first
const FRESH_BONUS = 15;                // something the last move changed counts for more
// points about what a move did, not the position: never "new"
// (and advice that hangs on the evaluation, or wording that shifts every move like the pawn breaks)
const NOT_FRESH = new Set(['criteria', 'stockfish', 'payoff', 'last-move', 'no-threat', 'threat', 'flank-centre', 'holes-left',
  'compensation', 'not-winning', 'up-trade', 'down-keep', 'breaks', 'breaks-theirs']);
// what matters more (or less) by the stage of the game
const PHASE_SHIFT: Record<'opening' | 'endgame', Record<string, number>> = {
  opening: { development: 10, 'development-them': 10, 'king-centre': 10, 'king-centre-theirs': 10, 'flank-centre': 5,
    passer: -10, 'passer-theirs': -10, isolated: -10, 'isolated-theirs': -10, doubled: -5, 'doubled-theirs': -5, 'open-file': -10 },
  endgame: { passer: 10, 'passer-theirs': 10, 'outside-passer': 10, 'outside-passer-theirs': 10, 'active-king': 10, 'passive-king': 10,
    'rook-behind': 10, structure: -10, space: -10, 'bishop-pair': -10, 'bishop-pair-theirs': -10, outpost: -10, 'outpost-theirs': -10 },
};

/** The stage of the game, for what to stress: the opening (move 12 or so, pieces still coming out),
 *  the endgame (queens off, a rook and minor piece or less each), or the middlegame. */
export function phaseOf(board: Board): 'opening' | 'middlegame' | 'endgame' {
  const queensOff = !board.pieces('queen', 'white').length && !board.pieces('queen', 'black').length;
  if (queensOff && pieceMaterial(board, 'white') <= 13 && pieceMaterial(board, 'black') <= 13) return 'endgame';
  if (board.fullmoveNumber <= 12 && piecesAtHome(board, 'white') + piecesAtHome(board, 'black') >= 1) return 'opening';
  return 'middlegame';
}
const KEY_MIN = 40;                    // weaker points never make the key list
const SECTION_MAX = 5;                 // points per section, most important first

/** The ideas of a position: the situation, the plans, the pieces, the kings and weaknesses,
 *  and what Stockfish wants — "you" being `me`. The most important few come first as key ideas. */
export function positionIdeas(i: IdeasInput): Ideas {
  const board = Board.fromFen(i.fen);
  const me = i.me;
  const them = opposite(me);
  const you = (c: Color) => (c === me ? 'you' : 'your opponent');
  const your = (c: Color) => (c === me ? 'your' : "your opponent's");
  const points: IdeaPoint[] = [];
  let section = '';
  const add = (rule: string, weight: number, text: string) => { points.push({ section, rule, weight, text }); };
  const attackedBy = (c: Color, sq: Square) => board.attackers(c, sq).length > 0;

  // what your opponent wants — before anything else, when it's your move after theirs
  if (i.theirMove !== undefined && board.turn === me) {
    section = 'What your opponent wants';
    const prev = i.theirMove;
    const last = prev ? lastMoveNote(board, prev, i.before ? Board.fromFen(i.before) : null, !!i.recapture) : null;
    if (i.threat && i.threat.gain >= THREAT_CP) {
      const passed = passTurn(board);
      const san = passed && passed.isLegal(i.threat.move) ? passed.san(i.threat.move) : i.threat.move;
      // their idea as a plan: the threat, and the move it sets up (their next move in that line)
      let follow = '';
      const tl = i.threat.line;
      if (passed && tl && tl.length >= 3 && tl[0] === i.threat.move) {
        const b2 = passed.copy();
        // only a forcing follow-up (a capture or a check) is part of the plan; a quiet move there is noise
        if (b2.isLegal(tl[0])) { b2.push(tl[0]); if (b2.isLegal(tl[1])) { b2.push(tl[1]); if (b2.isLegal(tl[2]) && (b2.isCapture(tl[2]) || b2.givesCheck(tl[2]))) follow = b2.san(tl[2]); } }
      }
      add('threat', 100, `${last ? `${last} ` : ''}It threatens ${san}${follow ? ` (with ${follow} to follow)` : ''}${i.threat.gain >= MATE_CP / 2 ? ', with mate' : `, which would win about ${materialWords(Math.max(1, Math.round(i.threat.gain / 100)))}`} — deal with that first.`);
    } else {
      if (i.threat === null) add('no-threat', 15, `${last ? `${last} ` : ''}No direct threat: you're free to improve your position — bring out the piece that isn't playing yet.`);
      else if (last) add('last-move', 10, last);           // Stockfish hasn't looked: no claim either way
      // a move on the wing is best met in the centre
      const central = breaks(board, me).filter((b) => b.charCodeAt(0) >= 99 && b.charCodeAt(0) <= 102);
      if (prev && board.pieceAt(parse(prev.slice(2, 4)))?.role === 'pawn' && [0, 1, 6, 7].includes(file(parse(prev.slice(2, 4)))) && central.length) {
        add('flank-centre', 45, `They've just played on the wing — the classic answer is a strike in the centre: ${list(central.slice(0, 2))}.`);
      }
    }
    // every pawn move leaves something behind
    const holes = prev ? holesLeft(board, prev) : [];
    const kThem = board.king(them);
    const nearKing = holes.some((h) => kThem !== undefined && Math.max(Math.abs(file(h) - file(kThem)), Math.abs(rank(h) - rank(kThem))) <= 2);
    if (holes.length && (nearKing || holes.some((h) => file(h) >= 2 && file(h) <= 5))) add('holes-left', nearKing ? 55 : 40, `Their pawn move leaves ${list(holes.map(name))} with no pawn to guard ${holes.length > 1 ? 'them' : 'it'} ever again — ${holes.length > 1 ? 'squares' : 'a square'} for your pieces.`);
  }

  // the four things that decide a position: material, king safety, activity, space
  section = 'Who has what';
  for (const c of criteria(board, me)) add('criteria', 5, c);

  // the situation
  section = 'The situation';
  const mat = material(board, me);
  const cp = i.cp ?? null;
  if (mat !== 0) add('material', 30, `Material: ${you(mat > 0 ? me : them)} ${mat > 0 ? 'are' : 'is'} up ${materialWords(Math.abs(mat))}.`);
  // static vs dynamic (Silman): material lasts; activity, a loose king and development have to be used now
  const dynamicFacts = (side: Color) => {
    const other = opposite(side);
    const facts: string[] = [];
    if (activity(board, side) - activity(board, other) > 3) facts.push(`${side === me ? 'your' : 'their'} pieces are more active`);
    const queensOn = board.pieces('queen', 'white').length + board.pieces('queen', 'black').length > 0;
    const danger = (c: Color) => shieldDamage(board, c) + (castledLike(board, c) ? 0 : 1) + Math.max(0, kingPressure(board, c).attackers - kingPressure(board, c).defenders);
    if (queensOn && danger(other) - danger(side) >= 2) facts.push(`${side === me ? 'their' : 'your'} king is the less safe one`);
    if (board.fullmoveNumber <= 20 && piecesAtHome(board, other) - piecesAtHome(board, side) >= 2) facts.push(`${side === me ? 'you are' : 'they are'} ahead in development`);
    return facts;
  };
  let dynamic = false;
  if (cp !== null && Math.abs(cp) < MATE_CP / 2) {
    const mine = mat <= -1 && cp >= mat * 100 + 150 ? dynamicFacts(me) : [];
    const theirs = mat >= 1 && cp <= mat * 100 - 150 ? dynamicFacts(them) : [];
    if (mine.length) {
      dynamic = true;
      add('dynamic-comp', 70, `Your compensation for ${materialWords(-mat)} is dynamic: ${list(mine)}. Keep the initiative — every quiet move gives them time to consolidate, and then the material counts.`);
    } else if (theirs.length) {
      dynamic = true;
      add('dynamic-comp-theirs', 70, `Their compensation for ${materialWords(mat)} is dynamic: ${list(theirs)}. Consolidate — king safe, pieces developed, trade an active attacker — and your extra material will count.`);
    } else if (mat >= 1 && cp >= 80) {
      dynamic = true;
      add('static-edge', 45, `Your edge is static: you're up ${materialWords(mat)}, and that doesn't go away. No need to hurry — keep everything safe, improve your pieces, then trade down.`);
    }
  }
  if (cp !== null && Math.abs(cp) < MATE_CP / 2 && !dynamic) {
    if (mat <= -2 && cp >= -30) add('compensation', 70, "You're down material but doing fine — your pieces are compensating, so keep them active and avoid trades.");
    else if (mat >= 2 && cp <= 50) add('not-winning', 65, "You're up material, but it isn't winning yet — your opponent has activity for it. Trading pieces helps you.");
    else if (mat >= 2) add('up-trade', 45, 'Up material: trade pieces, not pawns — every trade makes your extra material count more.');
    else if (mat <= -2) add('down-keep', 50, 'Down material: keep pieces on the board and look for chances — trades help your opponent.');
  }
  const home = { [me]: piecesAtHome(board, me), [them]: piecesAtHome(board, them) } as Record<Color, number>;
  if (board.fullmoveNumber <= 15 && Math.abs(home[me] - home[them]) >= 2) {
    const behind = home[me] > home[them] ? me : them;
    add(behind === me ? 'development' : 'development-them', behind === me ? 75 : 60,
      `${cap(you(behind))} ${behind === me ? 'are' : 'is'} behind in development (${home[behind]} minor pieces still at home)${behind === me ? ' — get them out before anything else' : ' — a good moment to open the position'}.`);
  }

  // structure and plans
  section = 'Plans';
  const s = structure(board);
  if (s) {
    const mine = s.plan(me);
    const theirs = s.plan(them);
    add('structure', 40, mine === theirs ? `This is ${s.name}. For both sides: ${mine}.` : `This is ${s.name}. For you: ${mine}. For your opponent: ${theirs}.`);
  }
  // a locked centre: name the base of their chain, and the push that hits it
  const base = isClosed(s) ? chainBase(board, them) : null;
  if (base !== null) {
    const hit = breaks(board, me).find((b) => [file(parse(b)) - 1, file(parse(b)) + 1].some((f) => f >= 0 && f <= 7
      && at(f, rank(parse(b)) + forward(me)) === base));
    add('chain-base', hit ? 55 : 45, `The base of your opponent's pawn chain is ${name(base)} — undermine it and the whole chain gets weak${hit ? ` (${hit} hits it)` : ''}.`);
  }
  for (const c of [me, them]) {
    const moves = breakMoves(board, c).slice(0, 2);
    if (!moves.length) continue;
    // what each break would do, read with that side to move
    const view = board.turn === c ? board : passTurn(board);
    const said = moves.map((m) => {
      const why = view ? moveReasons(view, m, c === me ? 'your' : 'their').filter((r) => !/^(takes|gives check)/.test(r)).slice(0, 2) : [];
      return `${m.slice(2, 4)}${why.length ? ` (${why.join(' and ')})` : ''}`;
    });
    add(c === me ? 'breaks' : 'breaks-theirs', c === me ? 30 : 20, `${cap(your(c))} pawn break${moves.length > 1 ? 's' : ''}: ${list(said)}${c === me ? ' — pawn moves that open lines for your pieces' : ' — watch for them'}.`);
  }
  const sp = space(board, me) - space(board, them);
  if (Math.abs(sp) >= 1) add('space', 20, sp > 0 ? 'You have more space in the centre: keep it, and give your opponent no easy pawn breaks.'
    : 'Your opponent has more space: free your position with a pawn break, or trade pieces — cramped positions get easier with fewer pieces.');
  for (const c of [me, them]) {
    const passed = passedPawns(board, c).filter((p) => relRank(p, c) >= 3);
    if (passed.length) {
      const far = passed.sort((a, b) => relRank(b, c) - relRank(a, c))[0];
      const w = 40 + 8 * (relRank(far, c) - 3);       // the further it's gone, the more it matters
      add(c === me ? 'passer' : 'passer-theirs', w, c === me ? `Your passed pawn on ${name(far)} is a real asset: push it when it's safe, with your pieces behind it.`
        : `Your opponent's passed pawn on ${name(far)} needs watching: blockade it with a piece in front of it.`);
    }
  }
  // a healthy pawn majority on a wing: a passed pawn in the making — once the queens are off (before
  // that, the structure's own plan is the story: in a Carlsbad the minority attack is aimed at it)
  const queensOff = !board.pieces('queen', 'white').length && !board.pieces('queen', 'black').length;
  if (queensOff && s?.key !== 'carlsbad') {
    const endgame = phaseOf(board) === 'endgame';
    for (const m of majorities(board)) {
      const mine = m.color === me;
      const qs = m.wing === 'queenside';
      const weight = (qs ? (endgame ? 50 : 40) : 25) - (mine ? 0 : 5);
      const why = qs
        ? (endgame ? 'with the kings far away on the other wing, a passed pawn there is hard to stop' : 'it gets stronger as pieces come off — trades favour the side with it')
        : "it's worth less than a queenside one, because the kings are already on that wing to stop it";
      add(mine ? 'majority' : 'majority-theirs', weight, mine
        ? `You have a ${m.wing} pawn majority (${m.mine} against ${m.theirs}): ${why}. Push the pawn with a clear road first — ${name(m.candidate)} — and trade until one is passed.`
        : `Your opponent has a ${m.wing} pawn majority (${m.mine} against ${m.theirs}): ${why}. Blockade the pawn with a clear road (${name(m.candidate)}) and keep active elsewhere.`);
    }
  }
  // kings castled on opposite wings: a race
  const kw = board.king('white');
  const kb = board.king('black');
  if (kw !== undefined && kb !== undefined && castledLike(board, 'white') && castledLike(board, 'black') && (file(kw) >= 6) !== (file(kb) >= 6)) {
    add('race', 65, "The kings are castled on opposite sides: it's a race. Throw your pawns at their king — pawns first, a queen alone won't break in — and keep the centre closed.");
    // a hook: one of their king's pawns pushed a square, with a pawn of yours ready to march at it
    const hook = hooks(board, them).find((h) => pawnsOf(board, me).some((p) => Math.abs(file(p) - file(h)) === 1 && relRank(p, me) < relRank(h, me) - 1));
    if (hook !== undefined) add('hook', 55, `Their pawn on ${name(hook)} is a hook: march a pawn at it, and when they touch a file opens toward their king.`);
  }
  const pair = (c: Color) => board.pieces('bishop', c).length >= 2;
  if (pair(me) && !pair(them)) add('bishop-pair', 30, 'You have the bishop pair: open the position with pawn trades — bishops love open lines.');
  else if (pair(them) && !pair(me)) add('bishop-pair-theirs', 25, 'Your opponent has the bishop pair: keep the position closed so their bishops stay quiet.');

  // the pieces
  section = 'The pieces';
  // a piece tied to a job (Hikaru's "octopus knight that can't leave"): the only guard of something attacked
  for (const c of [me, them]) {
    const o = opposite(c);
    let tied: { guard: Square; unit: Square } | null = null;
    for (const [sq, pc] of board.pieceMap()) {
      if (pc.color !== c || pc.role === 'king' || !board.attackers(o, sq).length) continue;
      const guards = board.attackers(c, sq);
      if (guards.length !== 1) continue;
      const g = board.pieceAt(guards[0]);
      if (!g || g.role === 'king' || g.role === 'pawn') continue;
      if (!tied || VALUE[pc.role] > VALUE[board.pieceAt(tied.unit)!.role]) tied = { guard: guards[0], unit: sq };
    }
    if (!tied) continue;
    const g = board.pieceAt(tied.guard)!.role;
    const u = board.pieceAt(tied.unit)!.role;
    const minor = u === 'pawn' ? 10 : 0;                // a pawn's guard matters less than a piece's
    add(c === me ? 'tied' : 'tied-theirs', (c === me ? 50 : 55) - minor, c === me
      ? `Your ${g} on ${name(tied.guard)} is tied down: it's the only guard of your ${u} on ${name(tied.unit)}, which is attacked — if it moves, the ${u} on ${name(tied.unit)} falls.`
      : `Their ${g} on ${name(tied.guard)} is the only guard of their ${u} on ${name(tied.unit)}: attack the ${u} again, or lure the ${g} away.`);
  }
  for (const c of [me, them]) {
    for (const b of badBishops(board, c)) {
      // a "bad" bishop that guards a pawn under attack is doing a real job
      const guards = board.attacks(b).filter((t) => board.pieceAt(t)?.role === 'pawn' && board.pieceAt(t)?.color === c && attackedBy(opposite(c), t));
      if (c === me && guards.length) add('bad-bishop-guard', 35, `Your bishop on ${name(b)} looks bad, but it's guarding your pawn on ${name(guards[0])} — a bad bishop that holds your pawns together is doing an important job, so don't rush to trade it.`);
      else if (c === me) add('bad-bishop', 35, `Your bishop on ${name(b)} is walled in by your own pawns — look to trade it, or move the pawns off its colour.`);
      else add('bad-bishop-theirs', 25, `Your opponent's bishop on ${name(b)} is bad (stuck behind its own pawns) — don't trade it off; keep the pawns fixed.`);
    }
    for (const n of stuckKnights(board, c)) {
      add(c === me ? 'stuck-knight' : 'stuck-knight-theirs', c === me ? 45 : 25, c === me ? `Your knight on ${name(n)} has nowhere to go — find it a better square.`
        : `Your opponent's knight on ${name(n)} has no good squares — keep it that way.`);
    }
  }
  const posts = outpostSquares(board, me);
  if (posts.length) add('outpost', 45, `${list(posts.slice(0, 2).map(name))} ${posts.length > 1 ? 'are outposts for your knights — squares no pawn can chase them from' : 'is an outpost for your knight — a square no pawn can chase it from'}.`);
  const theirPosts = outpostSquares(board, them);
  if (theirPosts.length) add('outpost-theirs', 35, `Your opponent would love a knight on ${name(theirPosts[0])}: keep an eye on it.`);
  const open = openFiles(board);
  if (open.length) {
    const rooksOn = board.pieces('rook', me).filter((r) => open.includes(file(r)));
    if (rooksOn.length) add('open-file-rook', 25, `Your rook already controls the open ${fileName(file(rooksOn[0]))} — use it to get to the 7th rank.`);
    else if (has(board, me, 'rook')) add('open-file', 35, `The ${list(open.slice(0, 2).map(fileName))} ${open.length > 1 ? 'are' : 'is'} open: put a rook there first.`);
  }
  // rooks facing each other on an open file: don't be the one to take
  const facing = open.find((f) => board.pieces('rook', me).some((r) => file(r) === f) && board.pieces('rook', them).some((r) => file(r) === f));
  if (facing !== undefined) add('rooks-facing', 40, `Your rooks face each other on the ${fileName(facing)}: don't be the one to trade — that hands your opponent the file. Reinforce it instead.`);
  // loose pieces: nothing guards them, or only the queen does (and she can be chased off) — counted when
  // they're under attack or have come forward where they can be hit, not a rook still in its corner
  if (board.fullmoveNumber >= 8) {
    // (in an endgame most pieces stand alone: only an attacked one is worth a word)
    const endgame = !board.pieces('queen', 'white').length && !board.pieces('queen', 'black').length;
    const exposed = (sq: Square) => attackedBy(opposite(board.pieceAt(sq)!.color), sq) || (!endgame && relRank(sq, board.pieceAt(sq)!.color) >= 3);
    const mine = loosePieces(board, me).filter(exposed)[0];
    const qg = queenGuarded(board, me)[0];
    const theirs = loosePieces(board, them).filter(exposed)[0];
    if (mine !== undefined) add('loose', attackedBy(them, mine) ? 85 : 40, `Your ${board.pieceAt(mine)!.role} on ${name(mine)} has no defender — loose pieces are what tactics hit first, so keep an eye on it every move.`);
    else if (qg !== undefined) add('queen-guarded', 70, `Your ${board.pieceAt(qg)!.role} on ${name(qg)} is attacked and only your queen guards it — the queen is a poor guard, because she can be chased away.`);
    if (theirs !== undefined) add('loose-theirs', attackedBy(me, theirs) ? 70 : 35, `Their ${board.pieceAt(theirs)!.role} on ${name(theirs)} is undefended.`);
  }

  // kings and weaknesses
  section = 'Kings and weaknesses';
  for (const c of [me, them]) {
    const k = board.king(c);
    const centreOpen = [3, 4].some((f) => !hasPawn(board, c, f));     // its own d- or e-pawn gone: a line toward it
    if (k !== undefined && !castledLike(board, c) && relRank(k, c) <= 1 && file(k) >= 3 && file(k) <= 4 && board.fullmoveNumber >= 8 && centreOpen
      && board.pieces('queen', opposite(c)).length) {     // (with the queens off, a central king is a good thing)
      add(c === me ? 'king-centre' : 'king-centre-theirs', c === me ? 75 : 60, c === me ? 'Your king is still in the centre with lines open — castle soon.' : "Your opponent's king is still in the centre: open the centre files and go after it.");
    }
    // (when nothing bears down on it, the "weakness on paper" note below says so instead)
    if (shieldDamage(board, c) >= 2 && kingPressure(board, c).attackers > kingPressure(board, c).defenders) {
      add(c === me ? 'shield' : 'shield-theirs', 50, c === me ? "The pawns in front of your king are loosened — be careful about opening lines there." : "Your opponent's king shelter is weakened — a target for your pieces.");
    }
    const iso = isolatedPawns(board, c).filter((p) => (file(p) !== 3 || s?.key !== 'iqp') && !passedPawns(board, c).includes(p)
      && !pawnsOf(board, opposite(c)).some((e) => file(e) === file(p) && relRank(e, c) > relRank(p, c)));
    if (iso.length) add(c === me ? 'isolated' : 'isolated-theirs', 30, `${cap(your(c))} isolated pawn on ${name(iso[0])} ${c === me ? 'needs a piece to protect it' : 'is a target: attack it and blockade the square in front'}.`);
    const dbl = doubledFiles(board, c);
    if (dbl.length) add(c === me ? 'doubled' : 'doubled-theirs', 25, `${cap(your(c))} doubled pawns on the ${fileName(dbl[0])} ${c === me ? 'are a long-term weakness — avoid endgames where they matter' : 'are a long-term target, especially in the endgame'}.`);
  }
  // the Rule of +2: is a weakened king *concretely* in danger? (two more attackers than defenders)
  for (const c of [them, me]) {
    const { attackers, defenders } = kingPressure(board, c);
    if (attackers >= defenders + 2 && attackers >= 3) {
      add(c === them ? 'plus-two' : 'plus-two-mine', c === them ? 85 : 90, c === them ? `${attackers} of your pieces bear down on their king against ${defenders} defenders — two more attackers than defenders is when a breakthrough works.`
        : `${attackers} enemy pieces bear down on your king against ${defenders} defenders — bring a defender, or trade off an attacker.`);
    } else if (shieldDamage(board, c) >= 2 && attackers <= defenders && board.pieces('queen', opposite(c)).length) {
      add('paper-king', 20, c === me ? 'Your king looks loose, but nothing is actually attacking it yet — a weakness on paper, not a real one. Ask who could get at it.'
        : "Their king looks loose, but you don't have the attackers there yet — bring more pieces before going for it.");
    }
  }
  // weak squares of one colour: the bishop of that colour is gone and the pawns sit on the other colour
  for (const c of [me, them]) {
    for (const lightSq of [true, false]) {
      const hasBishop = board.pieces('bishop', c).some((b) => light(b) === lightSq);
      const pawns = pawnsOf(board, c);
      const onOther = pawns.filter((p) => light(p) !== lightSq).length;
      if (!hasBishop && pawns.length >= 5 && onOther / pawns.length >= 0.7 && board.pieces('bishop', opposite(c)).some((b) => light(b) === lightSq)) {
        const colour = lightSq ? 'light' : 'dark';
        add(c === me ? 'colour-complex' : 'colour-complex-theirs', 45, c === me ? `Your ${colour} squares are weak: your ${colour}-squared bishop is gone and your pawns are on the other colour — your opponent's pieces will use those holes.`
          : `Their ${colour} squares are weak (no ${colour}-squared bishop, pawns on the other colour): aim your pieces at those holes.`);
      }
    }
  }
  // backward pawns: no neighbour can come to protect it, and an enemy pawn controls the square in front
  for (const c of [them, me]) {
    const bp = backwardPawns(board, c);
    if (bp.length) add(c === them ? 'backward-theirs' : 'backward', 30, c === them ? `Their pawn on ${name(bp[0])} is backward: put a piece on the square in front of it and attack it — it can't be protected by a pawn.`
      : `Your pawn on ${name(bp[0])} is backward — it can't be protected by another pawn, so keep a piece on it.`);
  }
  for (const c of [me, them]) {
    // king and queen on one open line: pins and skewers
    const line = royalLine(board, c);
    if (line) add(c === me ? 'royal-line' : 'royal-line-theirs', c === me ? 60 : 55, c === me ? `Your king and queen are on the same ${line} — that's how pins and skewers happen; step one of them off it when you can.`
      : `Their king and queen are on the same ${line} — look for a way to pin or skewer them.`);
    // the fianchetto bishop gone: holes next to the king
    const holes = fianchettoHoles(board, c);
    if (holes.length) add(c === me ? 'fianchetto-holes' : 'fianchetto-holes-theirs', 50, c === me ? `Your fianchetto bishop is gone, so ${list(holes.map(name))} next to your king ${holes.length > 1 ? 'are holes' : 'is a hole'} — keep pieces covering ${holes.length > 1 ? 'them' : 'it'}.`
      : `Their fianchetto bishop is gone: ${list(holes.map(name))} next to their king ${holes.length > 1 ? 'are holes' : 'is a hole'} — aim your queen and pieces there.`);
    // a sealed back rank with nothing to guard it
    const luft = backRankLuft(board, c);
    if (luft) add(c === me ? 'back-rank' : 'back-rank-theirs', c === me ? 45 : 40, c === me ? `Your king has no escape square off the back rank — when you have a quiet move, make some room (${luft} is usually the least weakening).`
      : 'Their king has no escape square off the back rank — keep back-rank tricks in mind.');
  }

  // the endgame: the king becomes a fighter, and passed pawns decide
  section = 'The endgame';
  for (const e of endgameInsights(board, me, i.cp ?? null)) add(e.rule, e.weight, e.text);
  // trading into a pawn ending: only as good as that pawn ending (Stockfish's score for the trade)
  const bestCp = i.cp ?? null;
  const topMove = i.bestLine?.[0] ?? i.alternatives?.[0]?.move;
  /** A pawn ending's verdict in a few words, your point of view: "winning for you (+3.2)". */
  const outlook = (v: number) => (v >= MATE_CP / 2 ? 'a forced mate for you' : v <= -MATE_CP / 2 ? 'a forced mate for your opponent'
    : Math.abs(v) < 50 ? `about level (${pySigned(v / 100, 1)})`
      : `${v >= 200 ? 'winning for you' : v <= -200 ? 'lost for you' : v > 0 ? 'better for you' : 'worse for you'} (${pySigned(v / 100, 1)})`);
  for (const t of i.pawnTrades ?? []) {
    if (t.cp === null || bestCp === null || !board.isLegal(t.move)) continue;
    const mover = board.turn;
    const pov = (v: number) => (mover === me ? v : -v);                  // the trading side's point of view
    const lost = winChances(pov(bestCp)) - winChances(pov(t.cp));
    const sanT = board.san(t.move);
    if (lost >= MIN_CHANCES_LOST) {
      add(mover === me ? 'pawn-trade-bad' : 'pawn-trade-bad-theirs', mover === me ? 75 : 40, mover === me
        ? `Don't trade into the pawn ending with ${sanT}: that pawn ending is ${outlook(t.cp)} — keep the pieces on${topMove && board.isLegal(topMove) ? ` (Stockfish prefers ${board.san(topMove)})` : ''}.`
        : `If they trade into the pawn ending with ${sanT}, it's ${outlook(t.cp)} — they should keep the pieces on.`);
      break;
    }
    if (lost < 0.05 && pov(t.cp) >= 300) {
      add(mover === me ? 'pawn-trade-good' : 'pawn-trade-good-theirs', mover === me ? 70 : 60, mover === me
        ? `${sanT} trades into a pawn ending that's ${outlook(t.cp)} — when the pawn ending is won, trading is the simplest way.`
        : `Watch out: ${sanT} would trade into a pawn ending that's ${outlook(t.cp)}.`);
      break;
    }
  }
  for (const e of endgameNotes(board, me)) {
    // an outside passer says more than the plain "passed pawn" note about the same pawn: keep one
    const dup = points.findIndex((p) => (p.rule === 'passer' || p.rule === 'passer-theirs') && e.rule.startsWith('outside-passer')
      && squaresNamed(p.text).some((sq) => e.text.includes(sq)));
    if (dup >= 0) points.splice(dup, 1);
    add(e.rule, e.weight, e.text);
  }

  // what Stockfish wants here
  section = 'What Stockfish wants';
  let decision: 'only' | 'several' | 'normal' | null = null;
  const bestLine = i.bestLine?.length ? i.bestLine : i.alternatives?.length ? (i.alternatives[0].line ?? [i.alternatives[0].move]) : undefined;
  if (bestLine && board.isLegal(bestLine[0])) {
    const mover = board.turn;
    const move = bestLine[0];
    const why = (m: string) => {
      const r = moveReasons(board, m, mover === me ? 'your' : 'their').slice(0, 2);
      return r.length ? r.join(' and ') : changes(board, m).good[0] ?? '';
    };
    const b = board.copy();
    const sans: string[] = [];
    for (const m of bestLine.slice(0, 4)) {
      if (!b.isLegal(m)) break;
      sans.push(b.san(m));
      b.push(m);
    }
    const r = why(move);
    // the other good moves, or how much better the best one is
    const alts = (i.alternatives ?? []).filter((a) => a.move !== move && board.isLegal(a.move));
    const best = i.alternatives?.find((a) => a.move === move)?.cp ?? null;
    const gap = (a: { cp: number | null }) => (best === null || a.cp === null ? null : (mover === me ? best - a.cp : a.cp - best));
    const close = alts.filter((a) => { const g = gap(a); return g !== null && g <= 40; }).slice(0, 2);
    const next = alts[0];
    const nextGap = next ? gap(next) : null;
    const forMover = mover === me;
    const whose = forMover ? 'Your' : "Your opponent's";
    const decided = best !== null && Math.abs(best) >= MATE_CP / 2;
    // the decision this position asks for (Hikaru: reduce it to its one question)
    decision = close.length ? 'several' : next && nextGap !== null && nextGap >= 100 && !decided ? 'only' : 'normal';
    const isBreak = breakMoves(board, mover).includes(move);
    let text: string;
    if (decision === 'several') {
      text = `Several moves are fine here — ${list([`${sans[0]}${r ? ` (${r})` : ''}`, ...close.map((a) => { const w = why(a.move); return `${board.san(a.move)}${w ? ` (${w})` : ''}`; })])} — so the plan matters more than one exact move.`;
    } else if (decision === 'only') {
      text = `${forMover ? 'One move holds here' : 'Your opponent has one good move here'}: ${sans[0]}${r ? ` — it ${r}` : ''}. The next best, ${board.san(next!.move)}, is about ${pySigned(nextGap! / 100, 1).replace('+', '')} pawns worse`;
      // and what goes wrong after it (the contrast is the reason)
      const after = next!.line?.length ? lineOutcome(i.fen, next!.line, me, next!.cp) : null;
      const wrong = after?.changes.find((c) => c.forMe !== forMover);
      text += wrong ? `: after ${after!.line}, ${wrong.text}.` : '.';
    } else {
      text = `${whose} best move here is ${sans[0]}${r ? ` — it ${r}` : ''}.${sans.length > 1 ? ` The idea: ${sans.join(' ')}.` : ''}`;
    }
    if (isBreak && decision !== 'several') text += ` ${sans[0]} is the pawn break this position turns on.`;
    // Hikaru's safe way home: when winning, an equally good move that trades pieces is the practical choice
    if (forMover && best !== null && best >= 150 && !decided) {
      const trades = (line: string[] | undefined) => {
        if (!line?.length) return 0;
        const b2 = board.copy();
        const n0 = nonPawnPieces(b2);
        for (const m of line.slice(0, 4)) { if (!b2.isLegal(m)) break; b2.push(m); }
        return n0 - nonPawnPieces(b2);
      };
      const simpler = close.find((a) => trades(a.line) >= 2 && trades(bestLine) < 2);
      if (simpler) text += ` Simpler: ${board.san(simpler.move)} is just as good and trades pieces — when you're winning, that's the safe way home.`;
    }
    add('stockfish', decision === 'only' ? 70 : decision === 'several' ? 50 : 45, text);
    // an in-between move: they just took on a square, and Stockfish plays a forcing move before taking back
    const prior2 = i.before && i.theirMove ? Board.fromFen(i.before) : null;
    if (prior2 && forMover && prior2.isLegal(i.theirMove!) && prior2.isCapture(i.theirMove!)) {
      const sq = i.theirMove!.slice(2, 4);
      const forcing = board.givesCheck(move) || board.isCapture(move) || moveReasons(board, move).some((x) => /^(attacks|forks)/.test(x));
      const lb = board.copy();
      let retake = -1;
      for (const [k, m] of bestLine.slice(0, 5).entries()) {
        if (!lb.isLegal(m)) break;
        if (k > 0 && k % 2 === 0 && m.slice(2, 4) === sq && lb.isCapture(m)) { retake = k; break; }
        lb.push(m);
      }
      if (move.slice(2, 4) !== sq && forcing && retake > 0) {
        add('intermezzo', 80, `Don't take back on ${sq} yet: ${sans[0]} first — an in-between move${r ? ` (it ${r})` : ''} — and you still recapture after.`);
      }
    }

    // why it works: what the line changes, and the plan behind it
    const outcome = lineOutcome(i.fen, bestLine, me, best ?? cp);
    const gains = outcome.changes.filter((c) => c.forMe === forMover).slice(0, 2);
    // prophylaxis is only claimed for a quiet move, and not in the middle of a trade (the "threat" would just
    // be the recapture)
    const quiet = !board.isCapture(move) && !board.givesCheck(move);
    const prior = i.before && i.theirMove ? Board.fromFen(i.before) : null;
    const midTrade = !!prior && prior.isLegal(i.theirMove!) && prior.isCapture(i.theirMove!);
    const passed = i.prevents && i.prevents.gain >= THREAT_CP && quiet && !midTrade ? passTurn(board) : null;
    // (named by what it does, not by the swing in the evaluation — a free extra move exaggerates that)
    const stopped = passed && passed.isLegal(i.prevents!.move) ? i.prevents!.move : null;
    const stopsTakes = stopped ? passed!.pieceAt(parse(stopped.slice(2, 4))) : undefined;
    const stops = stopped ? `${passed!.san(stopped)}${i.prevents!.gain >= MATE_CP / 2 ? ', which would mate'
      : stopsTakes ? `, which would take ${forMover ? 'your' : 'their'} ${stopsTakes.role}` : ''}` : null;
    const whoseMove = forMover ? 'Your' : "Your opponent's";
    if (gains.length && outcome.line) {
      // the plan says it already: drop the plain "passed pawn" note for the same side
      if (gains[0].kind === 'passer' || gains[0].kind === 'push-passer') {
        const dup = points.findIndex((p) => p.rule === (forMover ? 'passer' : 'passer-theirs'));
        if (dup >= 0) points.splice(dup, 1);
      }
      // forced, or Stockfish's likely line: every move of the mover's a check or a capture, or not
      const fb = board.copy();
      let forced = true;
      for (const [k, m] of bestLine.slice(0, 6).entries()) {
        if (!fb.isLegal(m)) break;
        if (k % 2 === 0 && !(fb.givesCheck(m) || fb.isCapture(m))) { forced = false; break; }
        fb.push(m);
      }
      const plies = outcome.line.split(' ').length;
      add('payoff', 75, `${whoseMove} plan: ${planOf(outcome.changes, forMover)}`
        + (forced ? `, and it's forced: ${walkThrough(i.fen, bestLine.slice(0, plies), gains, me)}` : `. Stockfish's likely line: ${outcome.line} — ${list(gains.map((g) => g.text))}.`)
        + (stops ? ` ${sans[0]} also stops ${stops}.` : ''));
    } else if (stops) {
      add('payoff', 70, `${sans[0]} is mainly a defensive move: it stops ${stops}.`);
    }
  }

  // what the last move changed comes first; the stage of the game shifts what matters
  if (i.before && i.before !== i.fen) {
    const was = new Set(positionIdeas({ fen: i.before, me }).points.map((p) => `${p.rule}|${p.text}`));
    for (const p of points) {
      if (NOT_FRESH.has(p.rule) || was.has(`${p.rule}|${p.text}`)) continue;
      p.fresh = true;
      p.weight = Math.min(100, p.weight + FRESH_BONUS);
      p.text = `New: ${p.text}`;
    }
  }
  const phase = phaseOf(board);
  if (phase !== 'middlegame') for (const p of points) p.weight = Math.max(0, Math.min(100, p.weight + (PHASE_SHIFT[phase][p.rule] ?? 0)));

  // the key ideas. With Stockfish's lines: the coach's order — what they want (Gotham), the decision this
  // position asks for (Hikaru's one question), what's urgent, the plan behind the best move, and one fact the
  // lines actually use (a concrete weakness, not an abstract one). Without them: the strongest few.
  let ranked: IdeaPoint[];
  if (decision !== null) {
    const touched = lineSquares(i.fen, [bestLine, i.alternatives?.[1]?.line]);
    const passedB = i.threat?.line?.length ? passTurn(board) : null;
    if (passedB) for (const sq of lineSquares(passedB.fen(), [i.threat!.line])) touched.add(sq);
    const named = (p: IdeaPoint) => squaresNamed(p.text);
    const grounded = (p: IdeaPoint) => CONCRETE.has(p.rule) || (named(p).length > 0 && named(p).some((sq) => touched.has(sq)));
    const pick = (rule: string) => points.find((p) => p.rule === rule);
    const used = new Set<IdeaPoint>();
    const take = (p: IdeaPoint | undefined) => { if (p && !used.has(p)) used.add(p); };
    take(pick('threat'));
    take(pick('stockfish'));
    for (const p of points.filter((x) => CONCRETE.has(x.rule) && x.weight >= 75).sort((a, b) => b.weight - a.weight)) take(p);
    take(pick('payoff'));
    const fact = points.filter((p) => !used.has(p) && !NOT_KEY.has(p.rule) && p.weight >= KEY_MIN && grounded(p))
      .sort((a, b) => b.weight - a.weight)[0];
    take(fact);
    ranked = [...used].slice(0, KEY_COUNT);
  } else {
    ranked = points.map((p, k) => ({ p, k })).filter(({ p }) => p.section !== 'Who has what' && p.weight >= KEY_MIN)
      .sort((a, b) => b.p.weight - a.p.weight || a.k - b.k).slice(0, KEY_COUNT).map(({ p }) => p);
  }
  const sections = SECTIONS.map((title) => ({
    title,
    points: points.filter((p) => p.section === title && !ranked.includes(p))
      .map((p, k) => ({ p, k })).sort((a, b) => b.p.weight - a.p.weight || a.k - b.k).slice(0, SECTION_MAX).map(({ p }) => p.text),
  })).filter((x) => x.points.length);
  const reason = cp !== null ? mainReason(board, me, cp) : null;
  const summary = cp !== null ? `${evalWords(cp)}${reason ? ` ${reason}` : ''}` : 'No evaluation for this position yet.';
  return { summary, key: ranked.map((p) => p.text), sections, points };
}

/** Pieces aimed at the squares around `c`'s king (attackers) against `c`'s pieces covering them (defenders). */
export function kingPressure(board: Board, c: Color): { attackers: number; defenders: number } {
  const k = board.king(c);
  if (k === undefined) return { attackers: 0, defenders: 0 };
  const zone = new Set([k, ...board.attacks(k)]);
  let attackers = 0;
  let defenders = 0;
  for (const [sq, p] of board.pieceMap()) {
    if (p.role === 'king' || p.role === 'pawn') continue;
    const hits = board.attacks(sq).some((t) => zone.has(t));
    if (!hits) continue;
    if (p.color === c) defenders += 1;
    else attackers += 1;
  }
  return { attackers, defenders };
}

/** Pawns no neighbouring pawn can ever protect (they're all further up the board), with the
 *  square in front controlled by an enemy pawn. */
export function backwardPawns(board: Board, c: Color): Square[] {
  const mine = pawnsOf(board, c);
  const covered = pawnAttacks(board, opposite(c));
  return mine.filter((p) => {
    const neighbours = mine.filter((q) => Math.abs(file(q) - file(p)) === 1);
    if (!neighbours.length) return false;                       // isolated, not backward
    if (neighbours.some((q) => relRank(q, c) <= relRank(p, c))) return false;
    const front = p + 8 * forward(c);
    return front >= 0 && front < 64 && covered.has(front) && relRank(p, c) <= 3;
  });
}

/** Can a pawn of `c` ever guard `sq` again (one on a neighbouring file, further back)? */
const coverable = (board: Board, sq: Square, c: Color) =>
  pawnsOf(board, c).some((p) => Math.abs(file(p) - file(sq)) === 1 && relRank(p, c) < relRank(sq, c));

/** Squares a pawn move just gave up for good (board: after the move): the pawn guarded them from where
 *  it stood, and no pawn of its side can ever guard them again. Only squares in its own half count. */
export function holesLeft(board: Board, move: string): Square[] {
  const from = parse(move.slice(0, 2));
  const p = board.pieceAt(parse(move.slice(2, 4)));
  if (p?.role !== 'pawn') return [];
  // where it stood, and (after a two-square push) the square it skipped
  const stood = Math.abs(rank(parse(move.slice(2, 4))) - rank(from)) === 2 ? [from, from + 8 * forward(p.color)] : [from];
  const guarded = stood.flatMap((s) => [file(s) - 1, file(s) + 1].filter((f) => f >= 0 && f <= 7).map((f) => at(f, rank(s) + forward(p.color))));
  return guarded.filter((s) => relRank(s, p.color) >= 2 && relRank(s, p.color) <= 4 && board.pieceAt(s)?.color !== p.color && !coverable(board, s, p.color));
}

/** The base of `c`'s pawn chain in a locked centre: from its most advanced blocked centre pawn, walk back
 *  diagonally along its own pawns (pawns still on their starting squares don't count). */
export function chainBase(board: Board, c: Color): Square | null {
  const mine = new Set(pawnsOf(board, c));
  const theirs = new Set(pawnsOf(board, opposite(c)));
  const blocked = pawnsOf(board, c).filter((p) => (file(p) === 3 || file(p) === 4) && theirs.has(p + 8 * forward(c)))
    .sort((a, b) => relRank(b, c) - relRank(a, c));
  if (!blocked.length) return null;
  let cur = blocked[0];
  let length = 1;
  for (;;) {
    const back = [file(cur) - 1, file(cur) + 1].filter((f) => f >= 0 && f <= 7).map((f) => at(f, rank(cur) - forward(c)))
      .find((s) => mine.has(s) && relRank(s, c) >= 2);
    if (back === undefined) break;
    cur = back;
    length += 1;
  }
  return length >= 2 ? cur : null;
}

/** Pawns of `c`'s castled king pushed one square: hooks for an enemy pawn storm. */
export function hooks(board: Board, c: Color): Square[] {
  const k = board.king(c);
  if (k === undefined || !castledLike(board, c)) return [];
  const files = file(k) >= 6 ? [5, 6, 7] : [0, 1, 2];
  return pawnsOf(board, c).filter((p) => files.includes(file(p)) && relRank(p, c) === 2);
}

/** Minor pieces and rooks nothing defends, most valuable first — what tactics hit first. (A queen
 *  usually has no defender; that's normal, so it isn't counted.) */
export function loosePieces(board: Board, c: Color): Square[] {
  return [...board.pieceMap()].filter(([sq, p]) => p.color === c && p.role !== 'pawn' && p.role !== 'king' && p.role !== 'queen' && !board.attackers(c, sq).length)
    .sort(([, a], [, b]) => VALUE[b.role] - VALUE[a.role]).map(([sq]) => sq);
}

/** Pieces under attack whose only guard is their own queen. */
export function queenGuarded(board: Board, c: Color): Square[] {
  return [...board.pieceMap()].filter(([sq, p]) => {
    if (p.color !== c || p.role === 'pawn' || p.role === 'king' || p.role === 'queen') return false;
    const guards = board.attackers(c, sq);
    return guards.length === 1 && board.pieceAt(guards[0])?.role === 'queen' && board.attackers(opposite(c), sq).length > 0;
  }).map(([sq]) => sq);
}

/** `c`'s king and queen on one file or diagonal with nothing between them, the line open beyond the
 *  queen, and an enemy piece that moves along it: the set-up for pins and skewers. */
export function royalLine(board: Board, c: Color): 'file' | 'diagonal' | null {
  const k = board.king(c);
  const q = board.pieces('queen', c)[0];
  if (k === undefined || q === undefined) return null;
  const df = file(q) - file(k);
  const dr = rank(q) - rank(k);
  const kind = df === 0 ? 'file' : Math.abs(df) === Math.abs(dr) ? 'diagonal' : null;
  if (!kind) return null;
  const step = Math.sign(dr) * 8 + Math.sign(df);
  for (let s = k + step; s !== q; s += step) if (board.pieceAt(s)) return null;
  // beyond the queen: the first piece met must not be one of c's own
  for (let s = q + step, f = file(q) + Math.sign(df); s >= 0 && s < 64 && f >= 0 && f <= 7; s += step, f += Math.sign(df)) {
    const p = board.pieceAt(s);
    if (p) {
      if (p.color === c) return null;
      break;
    }
  }
  const o = opposite(c);
  const slider = board.pieces('queen', o).length > 0
    || (kind === 'file' ? board.pieces('rook', o).length > 0 : board.pieces('bishop', o).some((b) => light(b) === light(k)));
  return slider ? kind : null;
}

/** Holes next to `c`'s king (castled short) when its g-pawn has moved up one and the bishop that went with
 *  it is gone — and the opponent has a piece that can use squares of that colour. */
export function fianchettoHoles(board: Board, c: Color): Square[] {
  const k = board.king(c);
  if (k === undefined || !castledLike(board, c) || file(k) < 5) return [];
  const g = at(6, c === 'white' ? 2 : 5);
  if (!pawnOn(board, c, name(g))) return [];
  const colour = !light(g);                                  // the squares beside g3 / g6 (f3, h3 / f6, h6)
  if (board.pieces('bishop', c).some((b) => light(b) === colour)) return [];
  const o = opposite(c);
  if (!board.pieces('queen', o).length && !board.pieces('bishop', o).some((b) => light(b) === colour)) return [];
  return [at(5, rank(g)), at(7, rank(g))].filter((s) => !pawnOn(board, c, name(s)));
}

/** The luft move (h3 / h6 / a3 / a6) when `c`'s castled king is sealed in by its own pawns, no rook or
 *  queen of its own is on the back rank, and the opponent has one. */
export function backRankLuft(board: Board, c: Color): string | null {
  const k = board.king(c);
  if (k === undefined || !castledLike(board, c)) return null;
  const r = rank(k) + forward(c);
  const sealed = [file(k) - 1, file(k), file(k) + 1].filter((f) => f >= 0 && f <= 7).every((f) => pawnOn(board, c, name(at(f, r))));
  if (!sealed) return null;
  const heavy = (col: Color) => [...board.pieces('rook', col), ...board.pieces('queen', col)];
  if (heavy(c).some((s) => rank(s) === rank(k)) || !heavy(opposite(c)).length) return null;
  return `${file(k) >= 6 ? 'h' : 'a'}${c === 'white' ? 3 : 6}`;
}

/** How far a square is from the centre (1 = d4/e4/d5/e5, 7 = a corner). */
const offCentre = (sq: Square) => Math.max(Math.abs(2 * file(sq) - 7), Math.abs(2 * rank(sq) - 7));
const pieceMaterial = (board: Board, c: Color) =>
  [...board.pieceMap().values()].filter((p) => p.color === c && p.role !== 'pawn' && p.role !== 'king').reduce((n, p) => n + VALUE[p.role], 0);

/** Endgame points ("you" = me): king activity, an outside passed pawn, rooks behind passers, counting tempi. */
export function endgameNotes(board: Board, me: Color): { rule: string; weight: number; text: string }[] {
  const them = opposite(me);
  if (board.pieces('queen', 'white').length || board.pieces('queen', 'black').length) return [];
  if (pieceMaterial(board, me) > 8 || pieceMaterial(board, them) > 8) return [];
  const out: { rule: string; weight: number; text: string }[] = [];
  const km = board.king(me);
  const kt = board.king(them);
  if (km !== undefined && kt !== undefined) {
    const d = offCentre(kt) - offCentre(km);
    if (d >= 4) out.push({ rule: 'active-king', weight: 50, text: 'Your king is the more active one — in the endgame it is a fighting piece, so use it.' });
    else if (d <= -4) out.push({ rule: 'passive-king', weight: 60, text: "Your opponent's king is more active — bring yours toward the centre before anything else." });
  }
  // an outside passed pawn: a passer on a wing file, two files or more from any enemy pawn
  for (const c of [me, them]) {
    const enemy = pawnsOf(board, opposite(c));
    const outside = passedPawns(board, c).find((p) => [0, 1, 6, 7].includes(file(p)) && enemy.length > 0
      && enemy.every((e) => Math.abs(file(e) - file(p)) >= 2));
    if (outside === undefined) continue;
    out.push({ rule: c === me ? 'outside-passer' : 'outside-passer-theirs', weight: 65, text: c === me ? `Your passed pawn on ${name(outside)} is an outside passer: it drags their king away while yours goes after the pawns on the other side.`
      : `Their passed pawn on ${name(outside)} is an outside passer — it will pull your king away, so keep that in mind before trading pieces.` });
  }
  const rooks = board.pieces('rook', me).length > 0 && board.pieces('rook', them).length > 0;
  const runner = [...passedPawns(board, me), ...passedPawns(board, them)].some((p) => relRank(p, board.pieceAt(p)!.color) >= 3);
  if (rooks && runner) out.push({ rule: 'rook-behind', weight: 40, text: 'Rooks belong behind passed pawns — behind your own to push it, behind theirs to stop it.' });
  if (!pieceMaterial(board, me) && !pieceMaterial(board, them)) out.push({ rule: 'pawn-ending', weight: 45, text: 'In a pawn ending every tempo counts: count the moves before you push, and keep a spare pawn move if you can.' });
  return out;
}

export const THREAT_CP = 150;          // a threat worth naming: about a pawn and a half

/** The position with the other side to move (a "pass"), to see what they threaten. */
export function passTurn(board: Board): Board | null {
  if (board.isCheck()) return null;
  const parts = board.fen().split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  try {
    return Board.fromFen(parts.join(' '));
  } catch {
    return null;
  }
}

/** Their last move in a few words ("Their last move, Nf5, attacks your queen."). */
/** What their last move did, in words. before: the position before it (to see a capture); recapture: your
 *  move before it captured on the same square. */
function lastMoveNote(board: Board, move: string, before: Board | null = null, recapture = false): string | null {
  const to = parse(move.slice(2, 4));
  const p = board.pieceAt(to);
  if (!p) return null;
  if (p.role === 'king' && Math.abs(file(to) - file(parse(move.slice(0, 2)))) === 2) return 'Their last move was castling.';
  const targets = board.attacks(to).map((t) => board.pieceAt(t)).filter((q) => q && q.color !== p.color && q.role !== 'pawn');
  const check = board.isCheck() ? ' with check' : '';
  const took = before && before.isLegal(move) && before.isCapture(move)
    ? (before.isEnPassant(move) ? 'pawn' : before.pieceAt(to)?.role ?? null) : null;
  if (took) {
    return `Their last move ${recapture ? 'recaptures' : 'captures'} your ${took} on ${name(to)}${check}`
      + `${targets.length ? `, and now attacks your ${targets[0]!.role}` : ''}.`;
  }
  const what = targets.length ? `attacks your ${targets[0]!.role}` : `brings the ${p.role} to ${name(to)}`;
  return `Their last move ${what}${check}.`;
}

/** Mobility of the pieces (not pawns or king): squares they reach that aren't taken by their own side. */
function activity(board: Board, c: Color): number {
  let n = 0;
  for (const [sq, p] of board.pieceMap()) {
    if (p.color !== c || p.role === 'pawn' || p.role === 'king') continue;
    n += board.attacks(sq).filter((t) => board.pieceAt(t)?.color !== c).length;
  }
  return n;
}

/** Why the evaluation is what it is, in one sentence: the one of Gotham's four criteria (material, king safety,
 *  activity, space) that favours the side Stockfish prefers — or nothing, when none clearly does. */
export function mainReason(board: Board, me: Color, cp: number): string | null {
  if (Math.abs(cp) < 50 || Math.abs(cp) >= MATE_CP / 2) return null;
  const them = opposite(me);
  const side = cp > 0 ? me : them;
  const sign = side === me ? 1 : -1;
  const yours = side === me ? 'your' : 'their';
  const mat = material(board, me) * sign;
  if (mat >= 1) return `The main reason: the extra material${mat >= 3 ? '' : ` (${materialWords(mat)})`}.`;
  const act = (activity(board, me) - activity(board, them)) * sign;
  if (act > 3) return `The main reason: ${yours} pieces are more active.`;
  const queensOff = !board.pieces('queen', 'white').length && !board.pieces('queen', 'black').length;
  const danger = (c: Color) => shieldDamage(board, c) + (castledLike(board, c) ? 0 : 1) + Math.max(0, kingPressure(board, c).attackers - kingPressure(board, c).defenders);
  if (!queensOff && (danger(opposite(side)) - danger(side)) >= 2) return `The main reason: ${side === me ? 'your opponent\'s' : 'your'} king is less safe.`;
  if ((space(board, me) - space(board, them)) * sign >= 2) return `The main reason: ${yours === 'your' ? 'you have' : 'they have'} more space.`;
  return null;
}

/** The four things a coach weighs (material, king safety, activity, space), each in a line. */
export function criteria(board: Board, me: Color): string[] {
  const them = opposite(me);
  const out: string[] = [];
  const mat = material(board, me);
  out.push(mat === 0 ? 'Material: level.' : `Material: ${mat > 0 ? 'you are' : 'your opponent is'} up ${materialWords(Math.abs(mat))}.`);
  const danger = (c: Color) => shieldDamage(board, c) + (castledLike(board, c) ? 0 : 1) + Math.max(0, kingPressure(board, c).attackers - kingPressure(board, c).defenders);
  const queensOff = !board.pieces('queen', 'white').length && !board.pieces('queen', 'black').length;
  const dMe = danger(me);
  const dThem = danger(them);
  out.push(queensOff ? 'King safety: with the queens off, it matters much less — kings can come out and fight.'
    : dMe === dThem ? 'King safety: about the same for both.'
      : `King safety: ${dMe < dThem ? 'your king is safer' : "your opponent's king is safer"}.`);
  const aMe = activity(board, me);
  const aThem = activity(board, them);
  out.push(Math.abs(aMe - aThem) <= 3 ? 'Activity: the pieces are about equally active.'
    : `Activity: ${aMe > aThem ? 'your pieces are more active' : "your opponent's pieces are more active"} (${Math.max(aMe, aThem)} squares to ${Math.min(aMe, aThem)}).`);
  const sMe = space(board, me);
  const sThem = space(board, them);
  out.push(sMe === sThem ? 'Space: even.' : `Space: ${sMe > sThem ? 'you have more' : 'your opponent has more'} in the centre.`);
  return out;
}

// ---------- the game as a whole: what happened, and why you won or lost ----------

export interface SummaryMove {
  ply: number;
  fenBefore: string;
  san: string;
  move?: string;                 // uci (for what it did on the board)
  cpBefore: number;              // your point of view
  cpAfter: number | null;
  only?: boolean;                // ! the only move that kept your position
  amazing?: boolean;             // !! a sound sacrifice
  /** Your opponent's move just before this one (san), to name a mistake you punished. */
  theirSan?: string;
  /** Seconds this move took, and your clock after it (from the game's [%clk]; null without one). */
  spent?: number | null;
  left?: number | null;
}

export interface GameSummary {
  /** What went well, about the chess (most specific first). */
  praise: string[];
  verdict: string;
  /** moves: the mistakes named, to jump to (ply = moves played before it). */
  phases: { name: string; text: string; moves: { ply: number; label: string }[] }[];
  takeaways: string[];
  /** How the clock went with your mistakes (rushed, or in time trouble); empty without clock data. */
  clock: string[];
}

const moveNo = (ply: number) => `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '...'}`;

/** A post-game review the way a coach gives it: praise first, phase by phase, one line on why
 *  the game was won or lost (one oversight, or a slow slide, or the opening), then 1–2 lessons. */
export function gameSummary(moves: SummaryMove[], result: string, phaseOf: (ply: number, fen: string) => string,
  leftPrepAt: number | null = null, baseSeconds: number | null = null): GameSummary {
  const mine = moves.filter((m) => m.cpAfter !== null);
  const lossOf = (m: SummaryMove) => Math.max(0, clamp(m.cpBefore) - clamp(m.cpAfter!));
  const drop = (m: SummaryMove) => chances(m.cpBefore) - chances(m.cpAfter!);
  const bad = mine.filter((m) => lossOf(m) >= 150);
  const worst = [...mine].sort((a, b) => drop(b) - drop(a))[0];
  const phases: GameSummary['phases'] = [];
  for (const name of ['Opening', 'Middlegame', 'Endgame']) {
    const these = mine.filter((m) => phaseOf(m.ply, m.fenBefore) === name);
    if (!these.length) continue;
    const errs = these.filter((m) => lossOf(m) >= 150);
    const slips = these.filter((m) => lossOf(m) >= 80 && lossOf(m) < 150);
    const end = these[these.length - 1].cpAfter!;
    let text = errs.length ? `${errs.length} mistake${errs.length > 1 ? 's' : ''}`
      : slips.length ? `${slips.length} small slip${slips.length > 1 ? 's' : ''}, nothing serious` : 'clean';
    if (name === 'Opening' && leftPrepAt !== null) text += `; you left your prep at move ${Math.floor(leftPrepAt / 2) + 1}`;
    text += ` — ${Math.abs(end) >= MATE_CP / 2 ? (end > 0 ? 'and you had a forced mate' : 'and you were getting mated') : `ending at ${pySigned(end / 100, 1)}`}.`;
    phases.push({ name, text, moves: errs.slice(0, 4).map((m) => ({ ply: m.ply, label: `${moveNo(m.ply)}${m.san}` })) });
  }
  const opening = mine.filter((m) => phaseOf(m.ply, m.fenBefore) === 'Opening');
  const outOfOpening = opening.length ? opening[opening.length - 1].cpAfter! : 0;
  let verdict: string;
  const takeaways: string[] = [];
  if (result === 'loss') {
    // put the loss down to where it started: worse out of the opening means the opening, whatever came later
    if (outOfOpening <= -150) {
      verdict = `Why you lost: you came out of the opening worse (${pySigned(outOfOpening / 100, 1)}) and the pressure built from there — the later mistakes grew out of that.`;
      takeaways.push("Learn this opening's plans: can you explain what you're aiming for after move 10 without notes?");
    } else if (worst && drop(worst) >= 0.3 && bad.length <= 2) {
      verdict = `Why you lost: one oversight — ${moveNo(worst.ply)}${worst.san} (${pySigned(worst.cpBefore / 100, 1)} → ${pySigned(worst.cpAfter! / 100, 1)}). The rest held up.`;
      takeaways.push("One-move blunders are the good kind of weakness — they're avoidable. Before every move: what does their last move want, and what are their checks and captures?");
    } else {
      verdict = `Why you lost: not one blunder but a slow slide — ${bad.length} mistakes${bad.length ? `, from move ${Math.floor(bad[0].ply / 2) + 1} on` : ''}. The position got harder a little at a time.`;
      takeaways.push('That usually means playing one move at a time: have a plan — what is each piece doing, and what does your opponent want?');
    }
  } else if (result === 'win') {
    verdict = bad.length ? `Why you won: you kept fighting and took your chances — even after ${bad.length} mistake${bad.length > 1 ? 's' : ''} of your own.`
      : `Why you won: a clean game — no real mistakes, so your opponent had to find something and couldn't.`;
    if (bad.length) takeaways.push('Look at your own mistakes too — a win with them is a lesson for free.');
  } else {
    verdict = `A draw${worst && drop(worst) >= 0.3 ? `: the big moment was ${moveNo(worst.ply)}${worst.san}, where an edge slipped away` : ' — a balanced game'}.`;
  }
  const winningSlips = mine.filter((m) => m.cpBefore >= 300 && m.cpBefore < MATE_CP / 2 && lossOf(m) >= 150);
  if (winningSlips.length) takeaways.push(`You let a winning position slip ${winningSlips.length === 1 ? 'once' : `${winningSlips.length} times`}: when you're winning, simplify — trade pieces, not pawns, and keep it safe.`);
  // your opponent slipped and you gave it straight back
  const missed = mine.find((m, k) => k > 0 && m.cpBefore - mine[k - 1].cpAfter! >= 200 && lossOf(m) >= 150 && Math.abs(m.cpBefore) < MATE_CP / 2);
  if (missed) takeaways.push(`When your opponent slipped before ${moveNo(missed.ply)}${missed.san}, you gave it straight back. When the evaluation swings your way, slow down: their last move changed something — look for the move that punishes it.`);
  // one mistake straight after another
  const pair = mine.findIndex((m, k) => k > 0 && lossOf(m) >= 150 && lossOf(mine[k - 1]) >= 150);
  if (pair > 0) takeaways.push(`${moveNo(mine[pair].ply)}${mine[pair].san} came straight after another mistake. After a slip, stop and take stock: work out what you actually lost — it's usually less than it feels — then look for the best practical chance.`);
  const byPhase = phases.map((p) => ({ name: p.name, n: mine.filter((m) => phaseOf(m.ply, m.fenBefore) === p.name && lossOf(m) >= 150).length }))
    .sort((a, b) => b.n - a.n)[0];
  if (byPhase && byPhase.n >= 2 && takeaways.length < 2) takeaways.push(`Most of your mistakes came in the ${byPhase.name.toLowerCase()} — that's the part of your game to work on.`);
  return { praise: whatWentWell(mine, result), verdict, phases, takeaways: takeaways.slice(0, 2), clock: clockNotes(mine, lossOf, baseSeconds) };
}

const secs = (s: number) => (s < 60 ? `${Math.round(s)}s` : clockText(s));

/** Your mistakes and the clock: ones played much quicker than you usually move while time was there
 *  (rushed), and ones made with the clock nearly gone (time trouble — a different lesson). Says nothing
 *  without clock data, so no time claim is ever made up. */
export function clockNotes(mine: SummaryMove[], lossOf: (m: SummaryMove) => number, baseSeconds: number | null): string[] {
  const timed = mine.filter((m) => m.spent != null && m.left != null);
  if (baseSeconds === null || timed.length < 10) return [];
  const thinking = timed.filter((m) => m.ply >= 16);                     // past the opening's quick book moves
  const pool = (thinking.length >= 5 ? thinking : timed).map((m) => m.spent!).sort((a, b) => a - b);
  const typical = pool[Math.floor(pool.length / 2)];
  const low = Math.max(20, baseSeconds * 0.1);
  const errs = timed.filter((m) => lossOf(m) >= 150);
  const label = (m: SummaryMove) => `${moveNo(m.ply)}${m.san}`;
  const out: string[] = [];
  // half your usual time or less, past the opening (quick book moves there are memory, not haste)
  const rushed = errs.filter((m) => m.ply >= 16 && m.left! >= low && m.spent! <= typical * 0.5);
  if (rushed.length) {
    const which = rushed.length === errs.length ? (errs.length === 1 ? 'Your mistake' : `All ${errs.length} of your mistakes`)
      : `${rushed.length} of your ${errs.length} mistakes`;
    const named = rushed.slice(0, 3).map((m, k) => `${label(m)} (${secs(m.spent!)}${k === 0 ? `, with ${clockText(m.left!)} left` : ''})`);
    out.push(`Too fast: ${which} came in a few seconds — ${list(named)}. You usually take about ${secs(typical)} a move, and the time was there. `
      + 'Before any capture, check or move that leaves something undefended, take ten seconds for a blunder check: what does it leave hanging, and what are their checks and captures?');
  }
  const trouble = errs.filter((m) => m.left! < low);
  if (trouble.length) {
    const longest = [...timed].sort((a, b) => b.spent! - a.spent!)[0];
    const named = trouble.slice(0, 3).map((m) => `${label(m)} (${clockText(m.left!)} left)`);
    out.push(`Time trouble: ${list(named)} came with the clock nearly gone — that's the clock, not your chess.`
      + (longest.spent! >= Math.max(30, baseSeconds * 0.1) && !trouble.includes(longest) ? ` Your longest think was ${secs(longest.spent!)} on ${label(longest)}; budget your time so the big moments don't arrive with an empty clock.` : ' Budget your time so the big moments don\'t arrive with an empty clock.'));
  }
  return out;
}

/** Up to three things that went well, about the chess itself — not a count of good moves. */
export function whatWentWell(mine: SummaryMove[], result: string): string[] {
  const lossOf = (m: SummaryMove) => Math.max(0, clamp(m.cpBefore) - clamp(m.cpAfter!));
  const label = (m: SummaryMove) => `${moveNo(m.ply)}${m.san}`;
  const out: string[] = [];
  // the hard ones: an only move, a sound sacrifice
  const sac = mine.find((m) => m.amazing);
  const only = mine.filter((m) => m.only && !m.amazing);
  if (sac) out.push(`You found the sacrifice ${label(sac)}!! — and it was sound.`);
  if (only.length) out.push(`You found ${label(only[0])}!, the only move that held${only.length > 1 ? ` (and ${only.length - 1} more like it)` : ''} — those are the hard ones.`);
  // punished their mistake: the evaluation jumped your way after their move and you kept it
  for (let k = 1; k < mine.length; k++) {
    const prev = mine[k - 1];
    const m = mine[k];
    if (m.cpBefore - prev.cpAfter! >= 150 && lossOf(m) < 50 && m.theirSan && Math.abs(prev.cpAfter!) < MATE_CP / 2) {
      out.push(`When your opponent played ${moveNo(m.ply - 1)}${m.theirSan}?, you punished it straight away with ${label(m)}.`);
      break;
    }
  }
  // defended a worse position
  for (let k = 0; k + 3 < mine.length; k++) {
    const m = mine[k];
    if (m.cpBefore > -150 || m.cpBefore < -MATE_CP / 2) continue;
    const next = mine.slice(k, k + 4);
    const end = next[next.length - 1].cpAfter!;
    if (next.every((x) => lossOf(x) < 60) && end - m.cpBefore >= 100) {
      out.push(`When you were worse (${pySigned(m.cpBefore / 100, 1)} at move ${Math.floor(m.ply / 2) + 1}), you defended accurately and got back to ${pySigned(end / 100, 1)}.`);
      break;
    }
  }
  // converted a win cleanly
  const winAt = mine.findIndex((m) => m.cpBefore >= 300);
  if (result === 'win' && winAt >= 0 && mine.slice(winAt).every((m) => lossOf(m) < 150 || m.cpAfter! >= 300)) {
    out.push(`Once you were winning (from move ${Math.floor(mine[winAt].ply / 2) + 1}), you converted cleanly — no chances for a comeback.`);
  }
  // the position's character: open for your bishops, closed for your knights
  let openForBishops = 0;
  let closedForKnights = 0;
  let outpost: string | null = null;
  for (const m of mine) {
    if (!m.move || lossOf(m) >= 80) continue;
    const b = Board.fromFen(m.fenBefore);
    if (!b.isLegal(m.move)) continue;
    const me = b.turn;
    const after = b.copy();
    after.push(m.move);
    const s = structure(after);
    const bishops = (c: Color) => after.pieces('bishop', c).length;
    const knights = (c: Color) => after.pieces('knight', c).length;
    if (bishops(me) === 2 && bishops(opposite(me)) < 2 && !isClosed(s)) openForBishops += 1;
    if (knights(me) > bishops(me) && bishops(opposite(me)) > knights(opposite(me)) && isClosed(s)) closedForKnights += 1;
    if (!outpost && changes(b, m.move).good.some((g) => g.includes('no pawn can ever chase'))) outpost = `${label(m)} put your knight on an outpost — a square no pawn could chase it from.`;
  }
  if (openForBishops >= 6) out.push('Good job keeping the position open while you had the two bishops — that\'s exactly where they shine.');
  if (closedForKnights >= 6) out.push('Good job keeping the position closed — with the centre locked, your knights were better than their bishops.');
  if (outpost) out.push(outpost);
  // a good start: developed and castled early, or out of the opening with an edge
  for (const m of mine) {
    if (!m.move || Math.floor(m.ply / 2) + 1 > 12) break;
    const b = Board.fromFen(m.fenBefore);
    if (!b.isLegal(m.move)) break;
    const me = b.turn;
    b.push(m.move);
    if (castledLike(b, me) && piecesAtHome(b, me) === 0) {
      out.push(`You had all your minor pieces out and your king castled by move ${Math.floor(m.ply / 2) + 1} — a model start.`);
      break;
    }
  }
  // a long accurate stretch
  let best: [number, number] = [0, 0];
  let start = 0;
  for (let k = 0; k <= mine.length; k++) {
    if (k === mine.length || lossOf(mine[k]) >= 50) {
      if (k - start > best[1] - best[0]) best = [start, k];
      start = k + 1;
    }
  }
  if (best[1] - best[0] >= 8) {
    out.push(`From move ${Math.floor(mine[best[0]].ply / 2) + 1} to ${Math.floor(mine[best[1] - 1].ply / 2) + 1} you played ${best[1] - best[0]} good moves in a row — steady, careful chess.`);
  }
  return out.slice(0, 3);
}

// ---------- why the best move works: what its line changes ----------

/** What matters in a position, side by side: the things a coach compares before and after a line. */
interface Snapshot {
  material: number;                                   // White's point of view
  attackers: Record<Color, number>;                   // pieces bearing down on that side's king
  defenders: Record<Color, number>;
  shield: Record<Color, number>;
  activity: Record<Color, number>;
  passed: Record<Color, Square[]>;
  weak: Record<Color, string[]>;                      // "an isolated pawn on e6"
  outposts: Record<Color, Square[]>;                  // knights standing on outposts
  seventh: Record<Color, number>;                     // rooks and queens on the 7th rank
  openFiles: Record<Color, number[]>;                 // files with a rook of theirs and no pawn of their own
  home: Record<Color, number>;
  castled: Record<Color, boolean>;
  pieces: number;                                     // all pieces' material (trades)
}

/** No pawn of `c` on file f: a file c's rooks can use against what stands there. */
const halfOpenFor = (board: Board, c: Color, f: number) => !pawnsOf(board, c).some((p) => file(p) === f);

function snapshot(board: Board): Snapshot {
  const both = <T>(f: (c: Color) => T) => ({ white: f('white'), black: f('black') });
  return {
    material: material(board, 'white'),
    attackers: both((c) => kingPressure(board, c).attackers),
    defenders: both((c) => kingPressure(board, c).defenders),
    shield: both((c) => shieldDamage(board, c)),
    activity: both((c) => activity(board, c)),
    passed: both((c) => passedPawns(board, c)),
    // weak pawns the other side can get at: on a file with no pawn of theirs (doubled pawns always count)
    weak: both((c) => [
      ...isolatedPawns(board, c).filter((p) => halfOpenFor(board, opposite(c), file(p))).map((p) => `an isolated pawn on ${name(p)}`),
      ...backwardPawns(board, c).filter((p) => halfOpenFor(board, opposite(c), file(p))).map((p) => `a backward pawn on ${name(p)}`),
      ...doubledFiles(board, c).map((f) => `doubled pawns on the ${fileName(f)}`),
    ]),
    outposts: both((c) => board.pieces('knight', c).filter((n) => isOutpost(board, n, c))),
    seventh: both((c) => [...board.pieces('rook', c), ...board.pieces('queen', c)].filter((s) => relRank(s, c) === 6).length),
    openFiles: both((c) => board.pieces('rook', c).map(file).filter((f) => !pawnsOf(board, c).some((p) => file(p) === f))),
    home: both((c) => piecesAtHome(board, c)),
    castled: both((c) => castledLike(board, c)),
    pieces: pieceMaterial(board, 'white') + pieceMaterial(board, 'black'),
  };
}

export type ChangeKind = 'mate' | 'material' | 'king' | 'passer' | 'push-passer' | 'stop-passer' | 'weakness' | 'outpost' | 'rook' | 'activity' | 'development' | 'trade' | 'castle';

/** One thing a line changes, from `me`'s point of view: good for you or for your opponent. */
export interface LineChange {
  kind: ChangeKind;
  forMe: boolean;
  weight: number;
  text: string;
}

export interface LineOutcome {
  /** The moves of the line that were played, numbered ("32...Bd4 33.Qxd6 Qxf2+ 34.Kh2"). */
  line: string;
  changes: LineChange[];
}

const LINE_PLIES = 6;                  // how far the payoff is read …
const LINE_MAX = 10;                   // … carried on while the last move was a capture or a check

/** What a line changes, read at a quiet moment (not in the middle of a trade). cp: the evaluation at the
 *  end of the line, your point of view — a material gain is only claimed when it backs it. */
const PROMOTED: Record<string, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };

/** A forced line talked through move by move, the way a coach walks a tactic at the board: what each
 *  of the mover's moves does, why the reply is the one they have to play, and what's left at the end —
 *  "30.Nc7+ forks the king and the rook on a8. The king has to move (30...Kd8), and 31.Nxa8 takes the
 *  rook — you come out a rook up." Each move keeps its number, so it still gets its arrow. */
export function walkThrough(fen: string, line: string[], gains: LineChange[], me: Color | null = null): string {
  const b = Board.fromFen(fen);
  const mover = b.turn;
  const [they, their] = me !== null && me !== mover ? ['you', 'your'] : ['they', 'the'];   // who answers
  const clauses: string[] = [];
  let mated = false;
  let took = false;                      // the mover's last move was a capture (so the reply can take back)
  for (const [k, m] of line.entries()) {
    if (!b.isLegal(m)) break;
    const n = b.fullmoveNumber;
    const san = b.turn === 'white' ? `${n}.${b.san(m)}` : `${n}...${b.san(m)}`;
    const to = parse(m.slice(2, 4));
    if (b.turn === mover) {
      took = b.isCapture(m);
      const why = moveReasons(b, m);
      const taken = b.pieceAt(to) ?? (b.isEnPassant(m) ? { role: 'pawn' as Role } : undefined);
      const pick = (re: RegExp) => why.find((r) => re.test(r));
      let what: string;
      if (why[0] === 'mates') { what = 'is mate'; mated = true; }
      else if (pick(/^gives double check/)) what = 'is double check';
      else if (pick(/^gives a discovered check/)) what = `is ${pick(/^gives a discovered check/)!.replace(/^gives /, '')}`;
      else if (pick(/^forks/)) what = `${taken ? `takes the ${taken.role} and ` : ''}${pick(/^forks/)}`;
      else if (pick(/^removes the only defender/)) what = `${taken ? `takes the ${taken.role} and ` : ''}${pick(/^removes/)}`;
      else if (pick(/^uncovers/)) what = pick(/^uncovers/)!;
      else if (pick(/^traps/)) what = pick(/^traps/)!;
      else if (taken) what = `takes the ${taken.role}${b.givesCheck(m) ? ' with check' : ''}`;
      else if (b.givesCheck(m)) what = 'is check';
      else if (m.length === 5) what = `promotes to a ${PROMOTED[m[4]]}`;
      else what = why.find((r) => !/^(develops|brings the knight|takes space)/.test(r)) ?? '';
      clauses.push(what ? `${san} ${what}` : k === 0 ? san : `then ${san}`);
    } else {
      // the reply: why it's the one they have to play
      const checked = b.isCheck();
      const only = b.legalMoves().length === 1;
      const piece = b.pieceAt(parse(m.slice(0, 2)))!;
      const prev = line[k - 1];
      let reply: string;
      if (prev && m.slice(2, 4) === prev.slice(2, 4) && b.isCapture(m) && took) reply = `${they} take back (${san})`;
      else if (only) reply = `${checked ? 'the only way out is' : 'the only move is'} ${san}`;
      else if (checked && piece.role === 'king') reply = `${their} king has to ${b.isCapture(m) ? 'take' : 'move'} (${san})`;
      else if (checked && !b.isCapture(m)) reply = `${they} have to block (${san})`;
      else if (b.isCapture(m)) reply = `${they} take the ${b.pieceAt(to)?.role ?? 'pawn'} (${san})`;
      else reply = `${they} play ${san}`;
      clauses.push(reply);
    }
    b.push(m);
  }
  // mover's move, then "reply, and next move", and so on
  let text = '';
  for (const [k, c] of clauses.entries()) {
    if (k === 0) text = c;
    else if (k % 2 === 1) text += `. ${c[0].toUpperCase()}${c.slice(1)}`;
    else text += `, and ${c}`;
  }
  const g = gains[0];
  const won = g && g.kind === 'material' && g.forMe === true && /^you win (.+)$/.exec(g.text);
  const end = mated ? '' : won && !/points/.test(won[1]) ? `you come out ${won[1].replace(/^the queen$/, 'a queen')} up` : list(gains.map((x) => x.text));
  return `${text}${end ? ` — ${end}` : ''}.`;
}

export function lineOutcome(fen: string, line: string[], me: Color, cp: number | null = null): LineOutcome {
  const start = Board.fromFen(fen);
  const b = start.copy();
  const sans: string[] = [];
  for (const m of line) {
    if (sans.length >= LINE_MAX || !b.isLegal(m)) break;
    const quiet = !b.isCapture(m) && !b.givesCheck(m);
    if (sans.length >= LINE_PLIES && quiet) break;
    const n = b.fullmoveNumber;
    sans.push(b.turn === 'white' ? `${n}.${b.san(m)}` : sans.length ? b.san(m) : `${n}...${b.san(m)}`);
    b.push(m);
  }
  const them = opposite(me);
  const s0 = snapshot(start);
  const s1 = snapshot(b);
  const out: LineChange[] = [];
  const add = (kind: ChangeKind, forMe: boolean, weight: number, text: string) => out.push({ kind, forMe, weight, text });
  const who = (c: Color) => (c === me ? 'you' : 'your opponent');
  const whose = (c: Color) => (c === me ? 'your' : 'their');
  if (b.isCheckmate()) {
    add('mate', b.turn !== me, 100, b.turn === me ? 'your opponent mates' : 'it ends in mate');
    return { line: sans.join(' '), changes: out };
  }
  // material, when the evaluation agrees
  const gained = (me === 'white' ? 1 : -1) * (s1.material - s0.material);
  if (gained !== 0 && (cp === null || (gained > 0 ? backed(gained, cp) : backed(-gained, -cp)))) {
    add('material', gained > 0, 90, `${who(gained > 0 ? me : them)} ${gained > 0 ? 'win' : 'wins'} ${materialWords(Math.abs(gained))}`);
  }
  for (const c of [them, me]) {
    // a king coming under fire
    const att = s1.attackers[c];
    const def = s1.defenders[c];
    if (att >= def + 2 && att - def > s0.attackers[c] - s0.defenders[c]) {
      add('king', c !== me, 80, `${c === me ? 'your king comes under fire' : 'their king comes under fire'} (${att} attackers against ${def} defender${def === 1 ? '' : 's'})`);
    } else if (s1.shield[c] > s0.shield[c] && att > def) {
      add('king', c !== me, 65, `${c === me ? 'the pawns around your king' : 'the pawns around their king'} get torn open`);
    }
    if (s1.castled[c] && !s0.castled[c]) add('castle', c === me, 40, `${who(c)} ${c === me ? 'get' : 'gets'} ${whose(c)} king to safety`);
    // passed pawns: a new one, or one going a long way
    const fresh = s1.passed[c].filter((p) => !s0.passed[c].includes(p) && relRank(p, c) >= 3)
      .sort((a, b2) => relRank(b2, c) - relRank(a, c))[0];
    // (three different plans: making one, pushing one you have, getting rid of theirs)
    if (fresh !== undefined && s1.passed[c].length >= s0.passed[c].length) {
      if (s0.passed[c].length === s1.passed[c].length) add('push-passer', c === me, 70, `${whose(c)} passed pawn reaches ${name(fresh)}`);
      else add('passer', c === me, 70, `${who(c)} ${c === me ? 'get' : 'gets'} a passed pawn on ${name(fresh)}`);
    } else if (s1.passed[c].length < s0.passed[c].length) {
      add('stop-passer', c !== me, 60, `${c === me ? 'your' : 'their'} passed pawn is gone`);
    }
    // pawn weaknesses left behind
    const weak = s1.weak[c].filter((w) => !s0.weak[c].includes(w));
    if (weak.length) add('weakness', c !== me, 38, `${c === me ? 'you are left with' : 'they are left with'} ${weak[0]}`);
    // a knight on an outpost, rooks on the 7th and open files
    const post = s1.outposts[c].find((n) => !s0.outposts[c].includes(n));
    if (post !== undefined) add('outpost', c === me, 50, `${whose(c)} knight lands on ${name(post)}, an outpost no pawn can chase it from`);
    if (s1.seventh[c] > s0.seventh[c]) add('rook', c === me, 45, `${whose(c)} heavy pieces reach the 7th rank`);
    const took = s1.openFiles[c].find((f) => !s0.openFiles[c].includes(f));
    if (took !== undefined && s1.seventh[c] <= s0.seventh[c]) add('rook', c === me, 40, `${who(c)} ${c === me ? 'take' : 'takes'} the ${fileName(took)} with a rook`);
    if (start.fullmoveNumber <= 15 && s0.home[c] - s1.home[c] >= 2) add('development', c === me, 40, `${who(c)} ${c === me ? 'get' : 'gets'} ${whose(c)} pieces out`);
  }
  // trading down when ahead
  const ahead = (me === 'white' ? 1 : -1) * s0.material;
  if (Math.abs(ahead) >= 2 && s0.pieces - s1.pieces >= 6) {
    add('trade', ahead > 0, 50, `${who(ahead > 0 ? me : them)} ${ahead > 0 ? 'trade' : 'trades'} pieces while ahead, so the extra material counts for more`);
  }
  // the pieces coming alive (or being shut down)
  const swing = (s1.activity[me] - s1.activity[them]) - (s0.activity[me] - s0.activity[them]);
  if (Math.abs(swing) >= 8) add('activity', swing > 0, 35, swing > 0 ? 'your pieces get much more active' : "your opponent's pieces get much more active");
  return { line: sans.join(' '), changes: out.sort((x, y) => y.weight - x.weight) };
}

const PLAN_WORDS: Record<ChangeKind, string> = {
  mate: 'go for mate', material: 'win material', king: 'attack the king', passer: 'create a passed pawn and push it',
  'push-passer': 'push the passed pawn', 'stop-passer': 'get rid of the enemy passed pawn',
  weakness: 'leave their pawns weak', outpost: 'plant a knight on an outpost', rook: 'take the open lines with the rooks',
  activity: 'activate the pieces', development: 'finish developing', trade: 'trade down while ahead', castle: 'get the king safe',
};

/** The plan a line carries out, in a few words, from its biggest change for the side playing it. */
export function planOf(changes: LineChange[], forMe: boolean): string | null {
  const top = changes.find((c) => c.forMe === forMe);
  return top ? PLAN_WORDS[top.kind] : null;
}
