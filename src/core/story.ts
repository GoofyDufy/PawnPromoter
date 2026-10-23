/**
 * Deep coach's 📖 story: Stockfish's line told as what happens — the scene, the blow (a few beats, the other
 * side's answers only when they're forced or matter), the aftermath in a line, and how it ends — instead of
 * what each move does. Every move stays in the brackets, numbered, so the board can still draw them.
 */
import { MATE_CP } from './analyzer';
import { Board, type Color, opposite, type Role, type Square } from './chess';
import { deepChanges, material, moveReasons } from './coach';
import { materialWords } from './explain';

const STORY_PLIES = 16;                       // the deep coach's line (DEEP_PLIES)
const MAX_BEATS = 3;                          // the blow, in at most this many sentences

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
const name = (sq: Square) => `${'abcdefgh'[sq % 8]}${(sq >> 3) + 1}`;
const parse = (s: string): Square => s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const VERB: Record<Role, string[]> = {
  knight: ['jumps to', 'leaps to', 'hops to'], bishop: ['slides to', 'swoops to', 'cuts across to'], rook: ['swings to', 'lands on', 'slides to'],
  queen: ['comes to', 'swoops to', 'lands on'], pawn: ['pushes to', 'marches to', 'steps to'], king: ['steps to', 'walks to', 'heads for'],
};
const PROMOTED: Record<string, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };

interface Ply {
  uci: string;
  san: string;
  number: number;
  white: boolean;
  role: Role;
  from: Square;
  to: Square;
  taken: Role | null;
  /** Where the piece it takes stands now, at the start of the line (it may have moved there during the line). */
  takenFrom: Square | null;
  check: boolean;
  mate: boolean;
  only: boolean;                              // no other legal move
  inCheck: boolean;                           // played out of check
  reasons: string[];
  mat: number;                                // material after this ply, from the side to move at the start
}

/** A phrasing that changes from position to position (always the same for the same position). */
function chooser(fen: string) {
  let h = 0;
  for (const ch of fen) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <T>(options: T[], salt = 0): T => options[(h + salt * 7) % options.length];
}

function play(fen: string, line: string[]): { plies: Ply[]; start: number } {
  const b = Board.fromFen(fen);
  const mover = b.turn;
  const start = material(b, mover);
  const plies: Ply[] = [];
  // each piece followed by where it stood at the start, so a piece taken later is named where it is on the board now
  const origin = new Map<Square, Square>();
  for (const sq of b.pieceMap().keys()) origin.set(sq, sq);
  for (const m of line.slice(0, STORY_PLIES)) {
    if (!b.isLegal(m)) break;
    const from = parse(m.slice(0, 2));
    const to = parse(m.slice(2, 4));
    const piece = b.pieceAt(from)!;
    const taken = b.pieceAt(to)?.role ?? (b.isEnPassant(m) ? 'pawn' : null);
    const victim = b.isEnPassant(m) ? to + (piece.color === 'white' ? -8 : 8) : to;
    const takenFrom = taken ? origin.get(victim) ?? null : null;
    const mover0 = origin.get(from) ?? from;
    if (b.isCastling(m)) {
      const kingside = to > from;
      const rook = kingside ? from + 3 : from - 4;
      const rookTo = kingside ? from + 1 : from - 1;
      const kingTo = kingside ? from + 2 : from - 2;
      const r0 = origin.get(rook) ?? rook;
      origin.delete(rook); origin.delete(from);
      origin.set(rookTo, r0); origin.set(kingTo, mover0);
    } else {
      origin.delete(victim);
      origin.delete(from);
      origin.set(to, mover0);
    }
    const only = b.legalMoves().length === 1;
    const inCheck = b.isCheck();
    const reasons = moveReasons(b, m, b.turn === mover ? 'your' : 'their');
    const number = b.fullmoveNumber;
    const white = b.turn === 'white';
    const san = b.san(m);
    b.push(m);
    plies.push({ uci: m, san, number, white, role: piece.role, from, to, taken: taken === 'king' ? null : taken, takenFrom, check: b.isCheck(),
      mate: b.isCheckmate(), only, inCheck, reasons, mat: material(b, mover) });
  }
  return { plies, start };
}

/** Moves in brackets, numbered so the board can follow them. */
function moves(plies: Ply[]): string {
  if (!plies.length) return '';
  return `(${plies.map((p, k) => (p.white ? `${p.number}.${p.san}` : k === 0 ? `${p.number}...${p.san}` : p.san)).join(' ')})`;
}

/** Who's better at the end, in a few words (cp: your point of view). */
function verdict(cp: number): string {
  if (cp >= MATE_CP / 2) return 'there\'s a forced mate for you';
  if (cp <= -MATE_CP / 2) return 'there\'s a forced mate for your opponent';
  const a = Math.abs(cp);
  const you = cp > 0;
  if (a < 50) return 'it\'s about level';
  if (a < 150) return you ? 'you\'re a bit better' : 'your opponent is a bit better';
  if (a < 300) return you ? 'you\'re clearly better' : 'your opponent is clearly better';
  return you ? 'you should win' : 'your opponent should win';
}

/** How much better, without the subject ("clearly better"), for a sentence that's already about that side. */
function better(cp: number): string {
  const a = Math.abs(cp);
  return a >= MATE_CP / 2 ? 'mating' : a >= 300 ? 'winning' : a >= 150 ? 'clearly better' : 'a bit better';
}

export interface StoryLine { line: string[]; cp: number | null }   // cp: your point of view

const NEAR = 60;                              // a line this close to the best is as good (in cp) …
const NEAR_WINNING = 150;                     // … or this close, when the best is already winning
const ONLY_MOVE = 150;                        // the best move this much better than the next: a critical moment

/** Deep coach's story from Stockfish's top lines (best first): the first good line with a tactic in it — a tactic
 *  is the story, even when Stockfish's first choice is a quiet move that's just as good — or else the best line,
 *  told as a critical moment when it's the only good move and as a plan when it isn't. */
export function deepStory(fen: string, lines: StoryLine[], me: Color): string | null {
  if (!lines.length) return null;
  const board = Board.fromFen(fen);
  const pov = (cp: number | null) => (cp === null ? null : board.turn === me ? cp : -cp);
  const best = pov(lines[0].cp);
  const near = best !== null && best >= 300 ? NEAR_WINNING : NEAR;
  const good = lines.filter((l) => best === null || (pov(l.cp) ?? -Infinity) >= best - near);
  for (const [k, l] of good.entries()) {
    // (another line only for a real tactic — a pawn grab isn't worth leaving Stockfish's first choice for)
    const story = lineStory(fen, l.line, me, l.cp, { tacticalOnly: k === 0 ? 'any' : 'big' });
    if (!story) continue;
    if (k === 0 || !board.isLegal(lines[0].line[0])) return story;
    const first = `${board.fullmoveNumber}${board.turn === 'white' ? '.' : '...'}${board.san(lines[0].line[0])}`;
    return `${story} (Stockfish's first choice, ${first}, is about as good — but this is the line with the idea in it.)`;
  }
  const second = lines.length > 1 ? pov(lines[1].cp) : null;
  const critical = best !== null && second !== null && best - second >= ONLY_MOVE;
  return lineStory(fen, lines[0].line, me, lines[0].cp, { critical });
}

/** The story of a line from `fen` (Stockfish's, played by the side to move). me: whose side "you" are;
 *  cp: the evaluation, your point of view. critical: the line's first move is the only good one;
 *  tacticalOnly: null unless the line has a tactic in it. null when there's no line worth telling. */
export function lineStory(fen: string, line: string[], me: Color, cp: number | null,
  opts: { critical?: boolean; tacticalOnly?: 'any' | 'big' } = {}): string | null {
  const mover = Board.fromFen(fen).turn;
  const pick = chooser(fen);
  const { plies, start } = play(fen, line);
  if (plies.length < 2) return null;
  const mine = mover === me;
  const actor = mine ? 'you' : 'your opponent';
  const other = mine ? 'your opponent' : 'you';
  const ours = mine ? 'your' : 'their';
  const theirs = mine ? 'their' : 'your';
  const s = (you: string, them: string) => (mine ? you : them);       // verb agreement for the side to move
  const o = (you: string, them: string) => (mine ? them : you);       // … and for the other side
  const meCp = cp;                                                    // (your point of view already)
  const moverCp = cp === null ? null : mine ? cp : -cp;
  const sideName = (c: Color) => (c === 'white' ? 'White' : 'Black');

  // ---- the shape of the line: mate, where the material settles, and when it's won ----
  const mateAt = plies.findIndex((p) => p.mate);
  const told = mateAt >= 0 ? plies.slice(0, mateAt + 1) : plies;
  const at = (k: number) => (k < 0 ? start : told[k].mat) - start;
  const quietAfter = (k: number) => k + 1 >= told.length || !told[k + 1].taken;
  // the material at the last calm moment (not in the middle of a trade)
  let settled = told.length - 1;
  while (settled > 0 && (!quietAfter(settled) || told[settled].taken && settled === told.length - 1)) settled--;
  const gain = mateAt >= 0 ? 0 : at(settled);
  // sacrifices: a move that gives up two points or more once it's answered
  const sacs = new Set<number>();
  for (let k = 0; k + 1 < told.length; k += 2) {
    const a = told[k];
    const r = told[k + 1];
    const back = k + 2 < told.length ? at(k + 2) : null;                // (not won straight back on the next move)
    if (back !== null && back <= at(k - 1) - 2 && at(k + 1) <= at(k - 1) - 2 && r.to === a.to && VALUE[a.role] > VALUE[a.taken ?? 'king']) sacs.add(k);
  }
  const lastChecks = told.slice(-6).filter((p) => p.check);
  const perpetual = moverCp !== null && Math.abs(moverCp) < 60 && lastChecks.length >= 2;
  const checker: 'mover' | 'other' = lastChecks.filter((p) => p.white === (mover === 'white')).length * 2 >= lastChecks.length ? 'mover' : 'other';
  const forcedMate = moverCp !== null && moverCp >= MATE_CP / 2;
  const tactical = mateAt >= 0 || forcedMate || gain >= 1 || sacs.size > 0 || perpetual;
  if (opts.tacticalOnly && !tactical) return null;
  if (opts.tacticalOnly === 'big' && !(mateAt >= 0 || forcedMate || perpetual || sacs.size > 0 || gain >= 3)) return null;
  const critical = !tactical && !!opts.critical;
  if (!tactical && !critical) return quietStory();
  const mating = mateAt >= 0 || forcedMate;

  // where the blow ends: mate, the moment the gain is in the bag (calm), or the end of the checks
  let blowEnd = told.length;
  if (mateAt < 0 && gain >= 1) {
    for (let k = 1; k < told.length; k += 2) if (at(k) >= gain && quietAfter(k)) { blowEnd = k + 1; break; }
  } else if (critical) {
    // the only good move: the first few moves of the line, to a calm moment
    blowEnd = Math.min(told.length, 10);
    for (let k = 5; k < Math.min(told.length, 10); k += 2) if (quietAfter(k)) { blowEnd = k + 1; break; }
  } else if (mateAt < 0 && !perpetual) {
    let k = 0;
    while (k < told.length && (told[k].taken || told[k].check || told[k].inCheck || sacs.has(k))) k++;
    blowEnd = Math.min(told.length, Math.max(2, k + (k % 2)));
  }

  const out: string[] = [];

  // ---- the scene ----
  const firstTakes = told[0].taken !== null;
  const startMat = start * (mine ? 1 : -1);
  const balance = firstTakes ? '' : startMat === 0 ? 'Material is level' : `${startMat > 0 ? 'You are' : 'Your opponent is'} ${materialWords(Math.abs(startMat)).replace(/^the queen$/, 'a queen')} up`;
  const won = target();
  let scene: string;
  if (mateAt >= 0 || forcedMate) {
    scene = `${sideName(opposite(mover))}'s king ${pick(['looks safe enough', 'seems tucked away', 'looks fine at first sight'])}, but it's ${pick(['short of defenders', 'about to be hunted down', 'in more danger than it looks'])}`;
  } else if (perpetual && checker === 'mover') {
    scene = `${cap(ours)} position ${pick(['looks like it\'s in trouble', 'is under pressure'])}, but ${sideName(opposite(mover))}'s king has no shelter`;
  } else if (perpetual) {
    scene = `${cap(actor)} can grab material, but ${ours} own king is ${pick(['wide open', 'short of cover'])}`;
  } else if (won?.role === 'pawn') {
    scene = pick([`There's a pawn to be won on ${name(won.sq)}`, `The pawn on ${name(won.sq)} is weaker than it looks`]);
  } else if (won) {
    scene = `${theirs === 'their' ? 'Their' : 'Your'} ${won.role} on ${name(won.sq)} is ${pick(['more exposed than it looks', 'standing on a dangerous square', 'about to get into trouble'])}`;
  } else if (critical) {
    scene = moverCp !== null && moverCp > 50 ? `Only one move keeps ${ours} edge here — everything else lets ${mine ? 'them' : 'you'} off the hook`
      : `Only one move holds ${ours} position together here`;
  } else scene = `${cap(actor)} ${s('have', 'has')} ${pick(['a chance to strike', 'a forcing idea here', 'a way to break through'])}`;
  out.push(`${balance ? `${balance}, but ${scene.charAt(0).toLowerCase()}${scene.slice(1)}` : scene}.`);
  if ([...sacs].some((k) => k < blowEnd)) out.push(mine ? pick(['It takes nerve, though: you have to give something first.', 'The catch: you have to invest material first.']) : 'And they\'re willing to give material to get there.');

  // ---- the blow: a clause per pair that matters, at most MAX_BEATS sentences ----
  const clauses: { text: string; plies: Ply[]; checks?: number; roles?: Set<Role>; folded?: boolean }[] = [];
  let carry: Ply[] = [];                                 // quiet pairs, folded into the next clause's brackets
  for (let k = 0; k < blowEnd; k += 2) {
    const a = told[k];
    const r = k + 1 < blowEnd ? told[k + 1] : undefined;
    const matters = a.taken || a.check || a.mate || sacs.has(k) || a.uci.length === 5 || r?.taken || r?.check || a.reasons.some((x) => /^(forks|pins|traps|uncovers|gives|attacks)/.test(x));
    const pair = r ? [a, r] : [a];
    // a run of checks that chase the king: one beat ("your rooks keep giving check, driving the king to f2")
    const chase = a.check && !a.mate && !sacs.has(k) && r?.role === 'king' && !r.taken;
    const prev = clauses[clauses.length - 1];
    if (chase && prev?.checks && !carry.length) {
      prev.plies.push(...pair);
      prev.checks += 1;
      prev.roles!.add(a.role);
      const who = prev.roles!.size === 1 ? `${ours} ${[...prev.roles!][0]}${a.role === 'pawn' ? '' : 's'}` : `${ours} pieces`;
      prev.text = `${prev.text.split(' — ')[0]} — and ${who} keep giving check, driving the king to ${name(r!.to)}`;
      continue;
    }
    if (chase) {
      clauses.push({ text: `${carry.length ? `${pick(['after a quiet move', 'after a calm move'], k)}, ` : ''}${action(k)}${reaction(r!, a, k)}`,
        plies: [...carry, ...pair], checks: 1, roles: new Set([a.role]) });
      carry = [];
      continue;
    }
    if (!matters && k > 0) { carry.push(...pair); continue; }
    const quietBefore = carry.length > 0;
    clauses.push({ text: `${quietBefore ? `${pick(['after a quiet move', 'after a calm move'], k)}, ` : ''}${action(k)}${r ? reaction(r, a, k) : ''}`, plies: [...carry, ...pair] });
    carry = [];
  }
  if (carry.length && clauses.length) clauses[clauses.length - 1].plies.push(...carry);
  let beats = clauses;
  if (beats.length > MAX_BEATS) {
    // the first, the biggest moment in between, and the last; the rest folded into the next one kept
    let best = 1;
    const score = (b: (typeof beats)[number]) => (b.checks && b.checks > 1 ? 6 + b.checks * (mating ? 3 : 1) : drama(b.plies));
    for (let k = 1; k < beats.length - 1; k++) if (score(beats[k]) > score(beats[best])) best = k;
    const keep = new Set([0, best, beats.length - 1]);
    const kept: typeof beats = [];
    let folded: Ply[] = [];
    const later = ['after a few more forcing moves', 'a couple of moves later'];
    for (const [k, b] of beats.entries()) {
      if (!keep.has(k)) { folded.push(...b.plies); continue; }
      kept.push(folded.length ? { text: `${later.shift() ?? 'soon after'}, ${b.text.replace(/^after a (quiet|calm) move, /, '')}`, plies: [...folded, ...b.plies], folded: true } : b);
      folded = [];
    }
    beats = kept;
  }
  const leads = [['', 'First, '], ['Then, ', 'Next, ', 'Now, '], ['Finally, ', 'And then, ', 'At last, ']];
  for (const [k, beat] of beats.entries()) {
    // (a beat that already says when — "a couple of moves later" — needs no "Then")
    const lead = beats.length === 1 || beat.folded || /^after a (quiet|calm) move/.test(beat.text) ? '' : k === 0 ? pick(leads[0]) : k === beats.length - 1 ? pick(leads[2], k) : pick(leads[1], k);
    out.push(`${cap(`${lead}${beat.text}`)} ${moves(beat.plies)}.`);
  }

  // ---- the aftermath and the ending ----
  const rest = told.slice(blowEnd);
  if (mateAt >= 0) out.push(mine ? pick(['There\'s no way out — checkmate.', 'And that\'s mate.', 'Game over: it\'s mate.']) : 'And that would be mate — this is the danger to stop.');
  else if (perpetual) {
    const escapes = checker === 'mover' ? other : actor;
    out.push(`${cap(escapes)} can't escape the checks${rest.length ? ` ${moves(rest)}` : ''}, so it ends in a draw by perpetual check.`);
  }
  else if (forcedMate) out.push(`${rest.length ? `${cap(other)} ${o('hold', 'holds')} on for a while ${moves(rest)}, but ` : 'From here '}the net keeps closing — Stockfish sees a forced mate.`);
  else {
    const finalMat = (start + gain) * (mine ? 1 : -1);                // your point of view, at the calm moment
    const words = (n: number) => materialWords(Math.abs(n)).replace(/^the queen$/, 'a whole queen');
    const exch = exchangeUp(fen, told.slice(0, settled + 1));
    const ahead2 = (c: Color | null) => (c === null ? '' : c === me ? 'you are' : 'your opponent is');
    const net = Math.abs(finalMat) === 2 && exch ? `${ahead2(exch)} the exchange up`
      : finalMat >= 1 ? `you are ${words(finalMat)} up` : finalMat <= -1 ? `your opponent is ${words(finalMat)} up` : 'material is level';
    const end = meCp === null ? '' : verdict(meCp);
    const agrees = meCp === null || finalMat === 0 || (finalMat > 0) === (meCp > 50);
    const ahead = moverCp === null || moverCp >= 0;
    const after = rest.length ? (ahead ? `${cap(other)} ${o('try', 'tries')} to regroup ${moves(rest)}, but ` : `The game goes on ${moves(rest)}, and `) : '';
    const sentence = gain <= -1 && moverCp !== null && moverCp > 50
      ? `${after}${actor} ${s('are', 'is')} ${words(gain)} down for it and still better — the initiative is worth more than the material`
      : `${after}${pick(['when the dust settles', 'once the smoke clears', 'at the end of it'])}, ${net}${meCp === null ? ''
        : agrees && finalMat !== 0 && Math.abs(meCp) >= 50 ? ` and ${better(meCp)}` : ` ${agrees ? 'and' : 'but'} ${end}`}`;
    out.push(`${cap(sentence)}.`);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();

  /** How big a moment a beat is: a fork or a sacrifice, then the biggest piece taken, then checks. */
  function drama(ps: Ply[]): number {
    return Math.max(0, ...ps.map((p) => (p.reasons.some((x) => /^(forks|traps|gives double)/.test(x)) ? 12 : 0) + (sacs.has(told.indexOf(p)) ? 11 : 0)
      + (p.white === (mover === 'white') && p.taken && !(mating && p.role === 'king') ? VALUE[p.taken] : 0) + (p.check ? (mating ? 4 : 1) : 0)));
  }

  /** The piece the blow wins: the biggest one taken and not traded back (with where it stands now — not where it's
   *  taken, which it may only reach during the line). */
  function target(): { role: Role; sq: Square } | null {
    if (gain < 1) return null;
    const taken: { role: Role; sq: Square }[] = [];
    for (let k = 0; k < blowEnd; k += 2) {
      const a = told[k];
      const r = told[k + 1];
      if (!a.taken) continue;
      if (r && r.to === a.to && r.taken && VALUE[a.role] >= VALUE[a.taken]) continue;          // traded
      taken.push({ role: a.taken, sq: a.takenFrom ?? a.to });
    }
    return taken.sort((x, y) => VALUE[y.role] - VALUE[x.role])[0] ?? null;
  }

  /** The side to move's move at ply k, told as an action. */
  function action(k: number): string {
    const p = told[k];
    const r = told[k + 1];
    const piece = `${ours} ${p.role}`;
    const sq = name(p.to);
    const verb = pick(VERB[p.role], k);
    const find = (re: RegExp) => p.reasons.find((x) => re.test(x));
    if (p.mate) return `${piece} ${verb} ${sq}`;
    if (p.uci.length === 5) return `the pawn reaches ${sq} and becomes a ${PROMOTED[p.uci[4]]}`;
    if (p.role === 'king' && Math.abs(p.from - p.to) === 2) return `${actor} ${s('castle', 'castles')}`;
    if (sacs.has(k)) {
      return p.taken ? `${piece} crashes in on ${sq}, giving itself up for the ${p.taken}${p.check ? ' with check' : ''}`
        : `${piece} ${verb} ${sq}${p.check ? ' with check' : ''} — ${pick(['right where it can be taken', 'a sacrifice', 'offered up on purpose'], k)}`;
    }
    if (find(/^gives double check/)) return `${piece} ${verb} ${sq} with double check`;
    const disc = find(/^gives a discovered check/);
    if (disc) return `${piece} steps aside to ${sq}, and suddenly there's ${disc.replace(/^gives /, '')}`;
    const fork = find(/^forks/);
    if (fork) return `${piece} ${p.taken ? `takes on ${sq}` : `${verb} ${sq}`}${p.check ? ' with check' : ''}, hitting ${fork.replace(/^forks /, '').replace(/ and the /, ' and the ')} at once`;
    const uncovers = find(/^uncovers/);
    if (uncovers) return `${piece} ${p.taken ? `takes on ${sq}` : `moves to ${sq}`} and ${uncovers.replace(/^uncovers an attack by the (\w+) on (\w+) on the (\w+) on (\w+)$/, 'opens up the $1 on $2 against the $3 on $4')}`;
    const pin = find(/^pins/);
    if (pin) return `${piece} ${p.taken ? `takes on ${sq}` : `${verb} ${sq}`} and ${pin}`;
    const trap = find(/^traps/);
    if (trap) return `${piece} ${verb} ${sq}, and the ${trap.replace(/^traps the /, '')} is trapped`;
    if (p.taken) {
      const swap = r && r.to === p.to && r.taken && VALUE[r.taken] === VALUE[p.taken];
      if (swap) return `${actor} ${s('swap', 'swaps')} ${p.taken === p.role ? `${p.role}s` : `the ${p.role} for the ${p.taken}`} on ${sq}`;
      const free = !r || r.to !== p.to;
      return `${piece} ${free ? pick(['grabs', 'picks off', 'snaps up'], k) : 'takes'} the ${p.taken} on ${sq}${p.check ? ' with check' : ''}`;
    }
    if (p.check) return `${piece} ${verb} ${sq} with check`;
    const attack = find(/^attacks/);
    if (attack) return `${piece} ${verb} ${sq}, ${pick(['going after', 'hitting', 'eyeing'], k)} ${attack.replace(/^attacks /, '')}`;
    const why = p.reasons.find((x) => !/^(develops|takes space)/.test(x));
    return `${piece} ${verb} ${sq}${k === 0 && why ? `, which ${why.replace(/\byour\b/g, ours)}` : ''}`;
  }

  /** The other side's answer — only when it's forced or matters; otherwise nothing. */
  function reaction(r: Ply, a: Ply, k: number): string {
    if (r.mate) return `, but ${other} ${o('answer', 'answers')} with mate`;
    if (r.taken && r.to === a.to && a.taken) return pick([`, and ${other} ${o('take', 'takes')} back`, `, and ${other} ${o('recapture', 'recaptures')}`], k);
    if (r.taken && r.to === a.to) return pick([`, and ${other} ${o('take', 'takes')} the bait`, `, and ${other} ${o('grab', 'grabs')} it`], k);
    if (r.inCheck && r.role === 'king') return r.taken ? ', and the king has to take' : r.only ? `, and the king's only square is ${name(r.to)}` : pick([`, and the king has to run to ${name(r.to)}`, `, and the king is chased to ${name(r.to)}`], k);
    if (r.inCheck) return `, and ${other} ${o('have', 'has')} to block with the ${r.role}`;
    if (r.only) return `, and ${other} ${o('have', 'has')} only one move`;
    if (r.check && r.taken) return `, but ${other} ${o('take', 'takes')} the ${r.taken} on ${name(r.to)} with check`;
    if (r.check) return `, but ${other} ${o('hit', 'hits')} back with a check`;
    if (r.taken) return `, and ${other} ${o('grab', 'grabs')} the ${r.taken} on ${name(r.to)}${a.taken ? ' in return' : ''}`;
    if (r.reasons.some((x) => /^brings the attacked/.test(x))) return `, and the ${r.role} ${pick(['runs to', 'escapes to'], k)} ${name(r.to)}`;
    return '';
  }

  /** No tactic in the line: the plan, told as what happens over the next few moves. */
  function quietStory(): string | null {
    const themes = (deepChanges(fen, line, (c) => (c === me ? 'your' : 'their')) ?? []).slice().sort((x, y) => y.weight - x.weight).slice(0, 3)
      .sort((x, y) => x.ply - y.ply);
    const out2: string[] = [pick(['No fireworks here — this one is a slow story.', 'There\'s no tactic to find; it\'s about a plan.', 'Nothing is hanging, so this is about where the pieces belong.'])];
    if (!themes.length) out2.push(`Over the next few moves ${actor} ${s('improve', 'improves')} ${ours} pieces step by step ${moves(plies)}.`);
    else {
      const steps = themes.length === 1 ? ['Over the next few moves'] : themes.length === 2 ? ['First', 'then'] : ['First', 'then', 'and finally'];
      const parts: string[] = [];
      let from = 0;
      for (const [k, t] of themes.entries()) {
        const upto = k === themes.length - 1 ? plies.length : Math.max(from + 2, Math.min(plies.length, t.ply + 2 - (t.ply % 2)));
        parts.push(`${steps[k]} ${actor} ${mine ? t.text : thirdPerson(t.text)} ${moves(plies.slice(from, upto))}`);
        from = upto;
      }
      out2.push(`${parts.join(', ')}.`);
    }
    if (moverCp !== null && meCp !== null) {
      out2.push(moverCp > -50 && moverCp < 50 ? 'It stays about level, but the pieces end up where they belong.'
        : mine ? (moverCp >= 50 ? `Your opponent can't stop all of it, and by the end ${verdict(meCp)}.` : `It's the best you have: even so, by the end ${verdict(meCp)}.`)
        : moverCp >= 50 ? `That's what you need to stop — left alone, by the end ${verdict(meCp)}.` : `It's the best they have: even so, by the end ${verdict(meCp)}.`);
    }
    return out2.join(' ').replace(/\s+/g, ' ').replace(/ \(\)/g, '').trim();
  }
}

/** Who's the exchange up (a rook against a knight or bishop) after these plies, if anyone. */
function exchangeUp(fen: string, plies: Ply[]): Color | null {
  const b = Board.fromFen(fen);
  for (const p of plies) b.push(p.uci);
  const count = (role: Role, c: Color) => b.pieces(role, c).length;
  const rooks = count('rook', 'white') - count('rook', 'black');
  const minors = count('knight', 'white') + count('bishop', 'white') - count('knight', 'black') - count('bishop', 'black');
  if (rooks === 1 && minors === -1) return 'white';
  if (rooks === -1 && minors === 1) return 'black';
  return null;
}

/** "take the d-file" → "takes the d-file" (the opponent's plan, told in the third person: the first word only). */
function thirdPerson(text: string): string {
  return text.replace(/^(\w+)/, (w) => (/(s|sh|ch|x)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`));
}
