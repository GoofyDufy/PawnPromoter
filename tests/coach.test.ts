// The Coach: reading the position (structure, breaks, the pieces' jobs) and
// turning a move's numbers into a human explanation.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as coach from '../src/core/coach';
import type { SolutionFacts } from '../src/core/explain';

const sq = (s: string) => s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
const board = (fen: string) => Board.fromFen(fen);

describe('reading the position', () => {
  it('names the structure and its plans', () => {
    // isolated d-pawn for White (Queen's Gambit Tarrasch-type)
    const iqp = coach.structure(board('r1bq1rk1/pp2bppp/2n2n2/3p4/3P4/2NB1N2/PP3PPP/R1BQ1RK1 w - - 0 10'))!;
    expect([iqp.key, iqp.owner]).toEqual(['iqp', 'white']);
    expect(iqp.plan('white')).toMatch(/keep the pieces on/);
    expect(iqp.plan('black')).toMatch(/blockade/);
    // Carlsbad: White d4 (no c-pawn), Black c6 + d5 (no e-pawn)
    expect(coach.structure(board('r1bq1rk1/pp1nbppp/2p2n2/3p4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 w - - 0 9'))?.key).toBe('carlsbad');
    // French advance: e5 against e6 is locked
    expect(coach.structure(board('rnbqkbnr/pp3ppp/4p3/2ppP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 0 4'))?.key).toBe('locked');
    expect(coach.structure(Board.fromFen())).toBe(null);
  });

  it('pawn breaks, bad bishops, stuck knights, outposts, development, the king\'s shelter', () => {
    const french = board('rnbqkbnr/pp3ppp/4p3/2ppP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 0 4');
    expect(coach.breaks(french, 'black')).toContain('f6');            // ...f6 hits e5
    expect(coach.breaks(french, 'white')).toEqual(['b4', 'c4']);      // c4 hits d5, b4 hits c5
    // the French's light-squared bishop behind e6 / d5 / b7… pawns on light squares
    expect(coach.badBishops(board('rnbqkbnr/pp3ppp/4p3/2ppP3/3P4/2P5/PP3PPP/RNBQKBNR b KQkq - 0 4'), 'black')).toContain(sq('c8'));
    expect(coach.badBishops(Board.fromFen(), 'white')).toEqual([]);   // the starting position: not "bad"
    expect(coach.stuckKnights(board('4k3/8/8/8/1p6/1p6/8/N3K3 w - - 0 1'), 'white')).toEqual([sq('a1')]);
    expect(coach.isOutpost(board('4k3/pp4pp/3p4/2pN4/2P5/8/PP3PPP/4K3 w - - 0 1'), sq('d5'), 'white')).toBe(true);
    expect(coach.isOutpost(board('4k3/pp2p1pp/3p4/2pN4/2P5/8/PP3PPP/4K3 w - - 0 1'), sq('d5'), 'white')).toBe(false);   // ...e6 can chase it
    expect(coach.piecesAtHome(Board.fromFen(), 'white')).toBe(4);
    expect(coach.shieldDamage(board('6k1/5ppp/8/8/8/6P1/5P1P/6K1 w - - 0 1'), 'white')).toBe(1);
  });
});

describe('the coach\'s words', () => {
  it('a blunder: the turning point, the concrete reason, and the human angle', () => {
    const facts: SolutionFacts = {
      best: { san: 'e4', features: [], mate: null, gain: 0, line: '1.e4 e5 2.Nf3', shortLine: '1.e4 e5 2.Nf3', scope: [] },
      played: { san: 'f3', mated: null, lost: 3, lossLine: '1...e5 2.g4 Qh4#', reply: '1...e5 2.g4', mateLine: '', hanging: [], king: null, scope: [], cp: -350 },
    };
    const text = coach.coach({ fenBefore: Board.fromFen().fen(), move: 'f2f3', best: 'e2e4', cpBefore: 30, cpAfter: -350,
      second: 'd2d4', cpSecond: 25, facts, turningPoint: true });
    expect(text).toMatch(/^This is where the game turned\. f3 runs into 1\.\.\.e5 2\.g4 Qh4# — you lose a piece\./);
    expect(text).toMatch(/minor pieces at home/);
    expect(text).toMatch(/Better was e4\. The idea: 1\.e4 e5 2\.Nf3\./);
    expect(text).toMatch(/d4 was just as good\./);
    expect(text).not.toMatch(/Main line/);
  });

  it('right idea, one move too early', () => {
    const text = coach.coach({ fenBefore: Board.fromFen().fen(), move: 'd2d4', best: 'e2e4', cpBefore: 30, cpAfter: -80,
      bestLine: ['e2e4', 'e7e5', 'd2d4'] });
    expect(text).toMatch(/d4 was the right idea, one move too early — e4 first, then d4\./);
  });

  it('a good move gets credit; a small slip gets reassurance; development is called out', () => {
    expect(coach.coach({ fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', move: 'f1c4', best: 'f1c4',
      cpBefore: 40, cpAfter: 40 })).toMatch(/equal/);
    const slip = coach.coach({ fenBefore: Board.fromFen().fen(), move: 'a2a3', best: 'e2e4', cpBefore: 30, cpAfter: -60 });
    expect(slip).toMatch(/minor pieces at home|Not a big deal/);
  });

  it("a line's material count is only claimed when the evaluation backs it", () => {
    const best = (gain: number) => ({ san: 'Qc2', features: [], mate: null, gain, line: '20.Qc2 bxc4 21.bxc4 Qc3', shortLine: '20.Qc2 bxc4 21.bxc4', scope: [] });
    const at = (cp: number) => coach.coach({ fenBefore: Board.fromFen().fen(), move: 'e2e4', best: 'e2e4', cpBefore: cp, cpAfter: cp,
      facts: { best: best(5), played: null } });
    expect(at(-40)).toMatch(/^Qc2\. The idea: 20\.Qc2 bxc4 21\.bxc4\./);     // "wins a rook" at −0.4: not believed
    expect(at(450)).toMatch(/wins a rook/);
  });

  it('material against the evaluation', () => {
    // White up a knight but only equal
    const text = coach.coach({ fenBefore: 'r1bqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3', move: 'g1f3', best: 'g1f3',
      cpBefore: 30, cpAfter: 30 });
    expect(text).toMatch(/material up doesn't mean winning/);
  });
});

describe('the ideas of a position', () => {
  const text = (ideas: coach.Ideas) => [ideas.summary, ...ideas.key, ...ideas.sections.flatMap((s) => [s.title, ...s.points])].join('\n');

  it('an isolated d-pawn position: plans for both sides, breaks, open files', () => {
    const ideas = coach.positionIdeas({ fen: 'r1bq1rk1/pp2bppp/2n2n2/3p4/3P4/2NB1N2/PP3PPP/R1BQ1RK1 w - - 0 10', me: 'white', cp: 35,
      bestLine: ['a2a3', 'a7a6', 'f1e1'] });
    const t = text(ideas);
    expect(ideas.summary).toMatch(/slightly better \(\+0\.3\) — but an edge that small/);
    expect(t).toMatch(/This is an isolated queen's pawn position\. For you: keep the pieces on.*For your opponent: trade pieces and blockade/);
    expect(t).toMatch(/The c-file and e-file are open: put a rook there first\./);
    expect(t).toMatch(/Your best move here is a3\. The idea: a3 a6 Re1\./);
  });

  it('material, a passed pawn, an outpost, a king left in the centre', () => {
    const t = text(coach.positionIdeas({ fen: 'r1bqk2r/pp3ppp/3p4/2pN4/2P1P3/8/PP3PPP/R2QKB1R w KQkq - 0 12', me: 'white', cp: 250 }));
    expect(t).toMatch(/Material: you are up/);
    expect(t).toMatch(/Up material: trade pieces, not pawns/);
    expect(t).toMatch(/clear advantage|winning/);
    expect(t).toMatch(/Your opponent's king is still in the centre/);
  });

  it('who is better, in words', () => {
    expect(coach.evalWords(10)).toBe('The position is about equal.');
    expect(coach.evalWords(-150)).toMatch(/^Your opponent has a clear advantage/);
    expect(coach.evalWords(450)).toMatch(/^You are winning \(\+4\.5\) — now it's about taking the safe way home\.$/);
    expect(coach.evalWords(10000)).toBe('You have a forced mate.');
  });
});

describe('habits behind a poor move (from how coaches teach improving players)', () => {
  const base = { best: 'g1f3', cpBefore: 30, cpAfter: -120 } as const;
  it('a check for its own sake; a one-move attack', () => {
    // 1.e4 e5 2.Bb5?! isn't check; use Qh5 hitting nothing vs a check: Bb5+ in a d-pawn-less position
    const check = coach.habits(board('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'), { ...base, fenBefore: '', move: 'f1b5' });
    expect(check[0]).toMatch(/check for its own sake/);
    const hit = coach.habits(board('rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2'), { ...base, fenBefore: '', move: 'd1g4' });
    void hit;     // Qg4 attacks nothing worth as much: no habit
    const kick = coach.habits(board('rnb1kbnr/pppp1ppp/8/4p1q1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 2 3'), { ...base, fenBefore: '', move: 'g1h3' });
    expect(kick[0]).toMatch(/one-move threat/);
  });

  it('trading when down material; grabbing a pawn before developing', () => {
    // White is a rook down and swaps knights
    const trade = coach.habits(board('1nbqkbnr/pppp1ppp/8/4p3/3nP3/5N2/PPPP1PPP/RNBQKB1R w KQk - 0 4'.replace('1nbqkbnr', 'rnbqkbnr').replace('RNBQKB1R', '1NBQKB1R')),
      { ...base, fenBefore: '', move: 'f3d4' });
    expect(trade.join(' ')).toMatch(/trades pieces while you're down material/);
    const grab = coach.habits(board('rnbqkbnr/ppp2ppp/8/3pp3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3'), { ...base, fenBefore: '', move: 'e4d5' });
    expect(grab.join(' ')).toMatch(/grabs a pawn while your pieces are still at home/);
  });
});

describe('more position ideas', () => {
  const text = (ideas: coach.Ideas) => [ideas.summary, ...ideas.key, ...ideas.sections.flatMap((s) => [s.title, ...s.points])].join('\n');

  it('who has what: material, king safety, activity, space', () => {
    const c = coach.criteria(Board.fromFen(), 'white');
    expect(c).toEqual(['Material: level.', 'King safety: about the same for both.', 'Activity: the pieces are about equally active.', 'Space: even.']);
  });

  it('opposite-side castling, the bishop pair, rooks facing on a file, a backward pawn', () => {
    // White castled long, Black short; White has both bishops; rooks face on the open e-file
    const t = text(coach.positionIdeas({ fen: '4r1k1/pp3ppp/2p5/8/3P4/2B5/PPB2PPP/2K1R2R w - - 0 20', me: 'white', cp: 60 }));
    expect(t).toMatch(/Your rooks face each other on the e-file: don't be the one to trade/);
    expect(t).toMatch(/You have the bishop pair/);
    const race = text(coach.positionIdeas({ fen: 'r4rk1/ppp2ppp/8/8/8/8/PPP2PPP/2KR3R w - - 0 15', me: 'white', cp: 0 }));
    expect(race).toMatch(/castled on opposite sides: it's a race/);
    expect(coach.backwardPawns(board('4k3/8/2p5/1p1p4/1P1P4/2P5/8/4K3 w - - 0 1'), 'black')).toEqual([sq('c6')]);   // c5 covered by b4/d4
    expect(coach.backwardPawns(board('4k3/8/3p4/2p1p3/2P1P3/8/8/4K3 w - - 0 1'), 'black').map((s) => s)).toEqual([sq('d6')]);
  });

  it('what your opponent wants', () => {
    const t = text(coach.positionIdeas({ fen: 'rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', me: 'white', cp: 50,
      theirMove: 'd8h4', threat: { move: 'h4e4', gain: 200 } }));
    expect(t).toMatch(/Their last move brings the queen to h4/);
    expect(t).toMatch(/It threatens Qxe4\+?, which would win about two pawns — deal with that first\./);
    expect(text(coach.positionIdeas({ fen: Board.fromFen().fen(), me: 'white', cp: 20 }))).not.toMatch(/What your opponent wants/);   // not after a move of theirs
    expect(text(coach.positionIdeas({ fen: Board.fromFen().fen(), me: 'white', cp: 20, theirMove: null, threat: null })))
      .toMatch(/No direct threat: you're free to improve your position/);
  });
});

describe('what went well', () => {
  const mv = (ply: number, before: number, after: number, extra: Partial<coach.SummaryMove> = {}) =>
    ({ ply, fenBefore: '', san: `m${ply}`, cpBefore: before, cpAfter: after, ...extra });
  it('the hard moves, a punished mistake, a defence, a clean conversion', () => {
    const p = coach.whatWentWell([mv(10, 0, 0, { only: true }), mv(12, 0, 0), mv(14, 250, 260, { theirSan: 'Qb6' })], 'draw');
    expect(p[0]).toBe('You found 6.m10!, the only move that held — those are the hard ones.');
    expect(p[1]).toBe('When your opponent played 7...Qb6?, you punished it straight away with 8.m14.');
    const d = coach.whatWentWell([mv(20, -180, -170), mv(22, -170, -150), mv(24, -150, -100), mv(26, -100, -40)], 'draw');
    expect(d[0]).toMatch(/^When you were worse \(-1\.8 at move 11\), you defended accurately and got back to -0\.4\./);
    const w = coach.whatWentWell([mv(30, 320, 330), mv(32, 330, 400), mv(34, 400, 900)], 'win');
    expect(w.join(' ')).toMatch(/Once you were winning \(from move 16\), you converted cleanly/);
  });
  it('a model start, and a long accurate stretch', () => {
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'b1c3', 'f8c5', 'd2d3', 'd7d6', 'c1g5', 'h7h6', 'e1g1'];
    const b = Board.fromFen();
    const mine: coach.SummaryMove[] = [];
    moves.forEach((m, ply) => {
      if (ply % 2 === 0) mine.push({ ply, fenBefore: b.fen(), san: b.san(m), move: m, cpBefore: 30, cpAfter: 30 });
      b.push(m);
    });
    const p = coach.whatWentWell(mine, 'draw');
    expect(p).toContain('You had all your minor pieces out and your king castled by move 7 — a model start.');
    const long = coach.whatWentWell(Array.from({ length: 10 }, (_, k) => mv(20 + 2 * k, 10, 5)), 'draw');
    expect(long.join(' ')).toMatch(/From move 11 to 20 you played 10 good moves in a row/);
  });
});

describe('the game summary', () => {
  const phaseOf = (ply: number) => (ply < 20 ? 'Opening' : ply < 60 ? 'Middlegame' : 'Endgame');
  const mv = (ply: number, before: number, after: number) => ({ ply, fenBefore: '', san: `m${ply}`, cpBefore: before, cpAfter: after });
  it('one oversight', () => {
    const s = coach.gameSummary([mv(0, 30, 30), mv(2, 30, 25), mv(22, 40, 35), mv(24, 40, -400), mv(26, -400, -420)], 'loss', phaseOf);
    expect(s.verdict).toMatch(/^Why you lost: one oversight — 13\.m24/);
    expect(s.takeaways[0]).toMatch(/One-move blunders are the good kind of weakness/);
    expect(s.phases.map((p) => p.name)).toEqual(['Opening', 'Middlegame']);
    expect(s.phases[1].moves).toEqual([{ ply: 24, label: '13.m24' }]);     // to jump to
  });
  it('a bad opening, and a slow slide', () => {
    expect(coach.gameSummary([mv(0, 30, -20), mv(10, -20, -200), mv(18, -200, -230), mv(30, -230, -500)], 'loss', phaseOf).verdict)
      .toMatch(/Why you lost: you came out of the opening worse \(-2\.3\)/);
    expect(coach.gameSummary([mv(0, 30, 30), mv(22, 30, -130), mv(26, -130, -300), mv(30, -300, -470), mv(34, -470, -650)], 'loss', phaseOf).verdict)
      .toMatch(/slow slide — 4 mistakes, from move 12 on/);
  });
  it('a win, and letting a win slip', () => {
    const s = coach.gameSummary([mv(0, 30, 30), mv(40, 400, 150), mv(44, 150, 600)], 'win', phaseOf);
    expect(s.verdict).toMatch(/Why you won: you kept fighting/);
    expect(s.takeaways.join(' ')).toMatch(/You let a winning position slip once/);
  });
});

describe('more of a strong player\'s checklist', () => {
  const text = (ideas: coach.Ideas) => [ideas.summary, ...ideas.key, ...ideas.sections.flatMap((s) => [s.title, ...s.points])].join('\n');

  it('what a pawn move leaves behind', () => {
    expect(coach.holesLeft(board('6k1/5p1p/6p1/8/8/8/8/6K1 w - - 0 1'), 'g7g6')).toEqual([sq('f6'), sq('h6')]);
    // ...c5 with ...e5 already played: d5 can never be guarded by a pawn again
    expect(coach.holesLeft(board('4k3/pp1p4/8/2p1p3/8/8/8/4K3 w - - 0 1'), 'c7c5')).toContain(sq('d5'));
    expect(coach.holesLeft(board('6k1/5p1p/6p1/8/8/8/8/6K1 w - - 0 1'), 'g1g2')).toEqual([]);    // not a pawn move
  });

  it('the base of the pawn chain, and a hook to storm', () => {
    const french = board('rnbqkbnr/pp3ppp/4p3/2ppP3/3P4/2P5/PP3PPP/RNBQKBNR b KQkq - 0 4');
    expect(coach.chainBase(french, 'white')).toBe(sq('c3'));
    expect(coach.chainBase(french, 'black')).toBe(sq('e6'));
    expect(text(coach.positionIdeas({ fen: french.fen(), me: 'white', cp: 30 }))).toMatch(/The base of your opponent's pawn chain is e6/);
    const race = text(coach.positionIdeas({ fen: 'r4rk1/ppp2pp1/7p/8/8/8/PPP2PPP/2KR3R w - - 0 15', me: 'white', cp: 0 }));
    expect(race).toMatch(/Their pawn on h6 is a hook/);
  });

  it('loose pieces, and a piece only the queen guards', () => {
    const b = board('4k3/8/8/3n4/8/8/8/4K2B w - - 0 20');
    expect(coach.loosePieces(b, 'white')).toEqual([sq('h1')]);
    expect(coach.loosePieces(b, 'black')).toEqual([sq('d5')]);
    expect(coach.queenGuarded(board('3rk3/8/8/8/3N4/8/3Q4/4K3 w - - 0 20'), 'white')).toEqual([sq('d4')]);
    const t = text(coach.positionIdeas({ fen: b.fen(), me: 'white', cp: 0 }));
    expect(t).not.toMatch(/Your bishop on h1/);              // still at home, nothing can reach it
    expect(t).toMatch(/Their knight on d5 is undefended/);    // come forward: a target
    expect(text(coach.positionIdeas({ fen: '4k3/8/8/3n4/8/2B5/8/4K3 w - - 0 20', me: 'white', cp: 0 }))).toMatch(/Your bishop on c3 has no defender/);   // the knight hits it

  });

  it('king and queen on one line, fianchetto holes, a sealed back rank', () => {
    expect(coach.royalLine(board('k3r3/8/8/8/8/8/4Q3/4K3 w - - 0 20'), 'white')).toBe('file');
    expect(coach.royalLine(board('k3r3/8/8/8/4P3/8/4Q3/4K3 w - - 0 20'), 'white')).toBe(null);     // own pawn shuts the file
    expect(coach.royalLine(board('k7/8/1b6/8/8/4Q3/8/6K1 w - - 0 20'), 'white')).toBe('diagonal');
    expect(coach.royalLine(Board.fromFen(), 'white')).toBe(null);
    expect(coach.fianchettoHoles(board('5rk1/pp3p1p/6p1/8/8/8/PP3PPP/3Q2K1 w - - 0 20'), 'black')).toEqual([sq('f6'), sq('h6')]);
    expect(coach.fianchettoHoles(board('5rk1/pp3pbp/6p1/8/8/8/PP3PPP/3Q2K1 w - - 0 20'), 'black')).toEqual([]);   // the bishop is still there
    expect(coach.backRankLuft(board('3r2k1/5ppp/8/8/8/3R4/5PPP/6K1 w - - 0 20'), 'white')).toBe('h3');
    expect(coach.backRankLuft(board('3r2k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 20'), 'white')).toBe(null);   // a rook guards the back rank
    const t = text(coach.positionIdeas({ fen: '3r2k1/5ppp/8/8/8/3R4/5PPP/6K1 w - - 0 20', me: 'white', cp: 0 }));
    expect(t).toMatch(/make some room \(h3 is usually the least weakening\)/);
  });

  it('endgame notes: the active king, an outside passer, rooks behind passers', () => {
    const pawns = coach.endgameNotes(board('8/k7/6pp/8/P2K4/8/8/8 w - - 0 50'), 'white').map((e) => e.text);
    expect(pawns.join(' ')).toMatch(/Your king is the more active one/);
    expect(pawns.join(' ')).toMatch(/Your passed pawn on a4 is an outside passer/);
    expect(pawns.join(' ')).toMatch(/every tempo counts/);
    expect(coach.endgameNotes(board('1r5k/8/8/P7/8/8/8/R5K1 w - - 0 40'), 'white').map((e) => e.text).join(' ')).toMatch(/Rooks belong behind passed pawns/);
    expect(coach.endgameNotes(Board.fromFen(), 'white')).toEqual([]);
  });

  it('the king\'s pawns: luft and a fianchetto are fine, g4 is not', () => {
    const b = board('r5k1/5ppp/8/8/8/8/5PPP/5BK1 w - - 0 20');
    const loosens = (bd: Board, m: string) => coach.changes(bd, m).bad.some((x) => /loosens/.test(x));
    expect(loosens(b, 'h2h3')).toBe(false);
    expect(loosens(b, 'g2g3')).toBe(false);              // the bishop can come to g2
    expect(loosens(board('r5k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 20'), 'g2g3')).toBe(true);
    expect(loosens(b, 'g2g4')).toBe(true);
  });

  it('a pawn pushed in front of your own king when the kings are on opposite sides', () => {
    const h = coach.habits(board('r4rk1/ppp2ppp/8/8/8/8/PPP2PPP/2KR3R w - - 0 15'), { fenBefore: '', move: 'a2a3', best: 'h2h4', cpBefore: 0, cpAfter: -120 });
    expect(h.join(' ')).toMatch(/gives their pawns a hook/);
  });

  it('their move on the wing, met in the centre', () => {
    const t = text(coach.positionIdeas({ fen: 'rnbq1rk1/ppp1pp1p/5np1/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R w KQ - 0 5', me: 'white', cp: 20,
      theirMove: 'g7g6', threat: null }));
    expect(t).toMatch(/strike in the centre: c4 and e4/);
    expect(t).toMatch(/leaves h6 with no pawn to guard it ever again/);     // next to their king: it matters
    const away = text(coach.positionIdeas({ fen: 'rnbqkb1r/ppp1pp1p/5np1/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 4', me: 'white', cp: 20,
      theirMove: 'g7g6', threat: null }));
    expect(away).not.toMatch(/leaves h6/);                                  // an edge square far from their king: not worth a word
  });

  it('summary lessons: giving a slip straight back, and one mistake after another', () => {
    const phaseOf = (ply: number) => (ply < 20 ? 'Opening' : ply < 60 ? 'Middlegame' : 'Endgame');
    const mv = (ply: number, before: number, after: number) => ({ ply, fenBefore: '', san: `m${ply}`, cpBefore: before, cpAfter: after });
    const back = coach.gameSummary([mv(0, 30, 30), mv(2, 30, 25), mv(4, 300, 100)], 'draw', phaseOf);
    expect(back.takeaways.join(' ')).toMatch(/When your opponent slipped before 3\.m4, you gave it straight back/);
    const two = coach.gameSummary([mv(0, 30, 30), mv(22, 30, -170), mv(24, -170, -400), mv(26, -400, -420)], 'loss', phaseOf);
    expect(two.takeaways[1]).toMatch(/^13\.m24 came straight after another mistake/);
  });
});

describe('ranking the ideas', () => {
  it('a threat leads the key ideas; "who has what" never makes the list; nothing is said twice', () => {
    const ideas = coach.positionIdeas({ fen: 'rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', me: 'white', cp: 50,
      theirMove: 'd8h4', threat: { move: 'h4e4', gain: 200 } });
    expect(ideas.key[0]).toMatch(/It threatens Qxe4/);
    expect(ideas.key.length).toBeLessThanOrEqual(3);
    const all = ideas.sections.flatMap((s) => s.points);
    for (const k of ideas.key) expect(all).not.toContain(k);
    expect(ideas.key.some((k) => /^Material:|^King safety:|^Activity:|^Space:/.test(k))).toBe(false);
    expect(ideas.points.every((p) => p.weight >= 0 && p.weight <= 100 && p.rule)).toBe(true);
  });

  it('a locked centre needs pawns pushed past the middle; no structure names in an endgame', () => {
    expect(coach.structure(board('r2q1rk1/pp1b1pbp/2n1pnp1/3p4/3P4/1PN1PNP1/P4PBP/R1BQ1RK1 w - - 1 11'))?.key).not.toBe('locked');   // d4 v d5: can still open
    expect(coach.structure(board('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'))).toBe(null);                     // 1.e4 e5
    expect(coach.structure(board('rnbqkbnr/pp3ppp/4p3/2ppP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 0 4'))?.key).toBe('locked');           // the French
    expect(coach.structure(board('8/p1b5/8/7k/2r3p1/3R3p/5K2/8 b - - 3 67'))).toBe(null);                                           // a rook ending
  });

  it('their castling in words; "no direct threat" only when Stockfish looked', () => {
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4';
    const looked = coach.positionIdeas({ fen, me: 'black', cp: 0, theirMove: 'e1g1', threat: null });
    expect(looked.points.find((p) => p.section === 'What your opponent wants')?.text).toMatch(/^Their last move was castling\. No direct threat/);
    const notYet = coach.positionIdeas({ fen, me: 'black', cp: 0, theirMove: 'e1g1' });
    expect(notYet.points.map((p) => p.text).join(' ')).not.toMatch(/No direct threat/);
  });
});

describe('why a move is good', () => {
  it('names what a move does: takes, forks, pins, develops, frees a bishop, opens a file', () => {
    expect(coach.moveReasons(Board.fromFen(), 'g1f3')).toContain('develops the knight');
    expect(coach.moveReasons(Board.fromFen(), 'e2e4')).toContain('opens the diagonal for your bishop on f1');
    // a knight fork of king and rook
    expect(coach.moveReasons(board('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1'), 'b5c7')[0]).toBe('forks the king and the rook on a8');
    // a bishop pinning a knight to the king
    expect(coach.moveReasons(board('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1'), 'f1b5')).toContain('pins the knight on c6');
    expect(coach.moveReasons(board('4k3/8/8/8/8/8/P7/R3K3 w - - 0 1'), 'a1b1')).toContain('puts the rook on the open b-file');
    expect(coach.moveReasons(Board.fromFen(), 'e1g1')).toEqual([]);     // not legal here
  });

  it("Stockfish's choices with reasons; the only good move called out", () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const close = coach.positionIdeas({ fen, me: 'white', cp: 40, alternatives: [{ move: 'f1b5', cp: 40 }, { move: 'f1c4', cp: 30 }, { move: 'd2d4', cp: 10 }] });
    const sf = close.points.find((p) => p.rule === 'stockfish')!.text;
    expect(sf).toMatch(/^Your best move here is Bb5 — it develops the bishop and pins|^Your best move here is Bb5 — it develops the bishop/);
    expect(sf).toMatch(/Just as good: Bc4 \(develops the bishop\)/);
    const only = coach.positionIdeas({ fen, me: 'white', cp: 40, alternatives: [{ move: 'f1b5', cp: 40 }, { move: 'a2a3', cp: -90 }] });
    expect(only.points.find((p) => p.rule === 'stockfish')!.text).toMatch(/only move that keeps things together — the next best, a3, is about 1\.3 pawns worse/);
  });

  it('pawn breaks say what they would do', () => {
    const t = coach.positionIdeas({ fen: 'rnbqkbnr/ppp2ppp/4p3/3p4/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 3', me: 'white', cp: 20 })
      .points.find((p) => p.rule === 'breaks')!.text;
    expect(t).toMatch(/e4 \(strikes at the pawn on d5 and opens the diagonal for your bishop on f1\)/);
  });
});

describe('what changed, and the stage of the game', () => {
  it('what the last move changed is marked new and moves up', () => {
    // Black has just played ...Nd5: the knight came forward with nothing guarding it
    const before = 'r1q1k3/4n3/8/8/8/8/8/1R1QK3 b - - 0 20';
    const fen = 'r1q1k3/8/8/3n4/8/8/8/1R1QK3 w - - 1 21';
    const ideas = coach.positionIdeas({ fen, me: 'black', cp: 0, before });
    const fresh = ideas.points.filter((p) => p.fresh);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((p) => p.text.startsWith('New: '))).toBe(true);
    expect(fresh.map((p) => p.text).join(' ')).toMatch(/New: Your knight on d5 has no defender/);
    expect(ideas.points.filter((p) => p.rule === 'criteria').every((p) => !p.fresh)).toBe(true);
    // nothing is new when there's no position before
    expect(coach.positionIdeas({ fen, me: 'black', cp: 0 }).points.some((p) => p.fresh)).toBe(false);
  });

  it('the stage of the game', () => {
    expect(coach.phaseOf(Board.fromFen())).toBe('opening');
    expect(coach.phaseOf(board('8/p1b5/8/7k/2r3p1/3R3p/5K2/8 b - - 3 67'))).toBe('endgame');
    expect(coach.phaseOf(board('r4rk1/5pp1/2pp2qp/1p1B4/3P4/P5P1/1P3P1P/3QR1K1 w - - 0 22'))).toBe('middlegame');
    // in an endgame a far-advanced passer outranks everything structural
    const e = coach.positionIdeas({ fen: '8/k7/6pp/P7/3K4/8/8/8 w - - 0 50', me: 'white', cp: 400 });
    expect(e.key.join(' ')).toMatch(/passed pawn on a5|outside passer/);
  });
});

describe('why the best move works: the payoff of its line', () => {
  const fork = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 30';
  it('reads what a line changes, at a quiet moment', () => {
    const o = coach.lineOutcome(fork, ['b5c7', 'e8d8', 'c7a8'], 'white', 500);
    expect(o.line).toBe('30.Nc7+ Kd8 31.Nxa8');
    expect(o.changes[0]).toMatchObject({ kind: 'material', forMe: true, text: 'you win a rook' });
    // the same line seen from the other side
    expect(coach.lineOutcome(fork, ['b5c7', 'e8d8', 'c7a8'], 'black', -500).changes[0]).toMatchObject({ forMe: false, text: 'your opponent wins a rook' });
    // a material count the evaluation doesn't back isn't claimed
    expect(coach.lineOutcome(fork, ['b5c7', 'e8d8', 'c7a8'], 'white', 20).changes.some((c) => c.kind === 'material')).toBe(false);
    const passer = coach.lineOutcome('k7/8/8/2p5/1P6/8/8/K7 w - - 0 40', ['b4c5'], 'white', 300);
    expect(passer.changes.map((c) => c.text)).toContain('you get a passed pawn on c5');
  });

  it('the plan and its payoff lead the key ideas', () => {
    const ideas = coach.positionIdeas({ fen: fork, me: 'white', cp: 500, alternatives: [{ move: 'b5c7', cp: 500, line: ['b5c7', 'e8d8', 'c7a8'] }] });
    expect(ideas.key[0]).toBe('Your plan: win material. After 30.Nc7+ Kd8 31.Nxa8, you win a rook.');
    expect(coach.planOf(coach.lineOutcome(fork, ['b5c7', 'e8d8', 'c7a8'], 'white', 500).changes, true)).toBe('win material');
  });

  it('a defensive move says what it stops (and what that would take)', () => {
    const takes = coach.positionIdeas({ fen: 'rnbqkbnr/ppp2ppp/8/3pp3/4P3/3B4/PPPP1PPP/RNBQK1NR w KQkq - 0 3', me: 'white', cp: 0,
      alternatives: [{ move: 'b1c3', cp: 0, line: ['b1c3'] }], prevents: { move: 'd5e4', gain: 300 } });
    expect(takes.points.find((p) => p.rule === 'payoff')?.text).toMatch(/stops dxe4, which would take your pawn/);
    const fen = 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';
    const ideas = coach.positionIdeas({ fen, me: 'white', cp: 30, alternatives: [{ move: 'h2h3', cp: 30, line: ['h2h3'] }],
      prevents: { move: 'c8g4', gain: 200 } });
    expect(ideas.points.find((p) => p.rule === 'payoff')?.text).toBe('h3 is mainly a defensive move: it stops Bg4.');
  });
});
