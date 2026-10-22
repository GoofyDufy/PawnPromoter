// Forked: the Coach names the fork, and when Stockfish's best move saves none of the pieces, the counterattack —
// you can't save everything, so hit back first. Positions from your puzzles; Stockfish 19 lines (depth 18) and
// the threat (depth 10), as CoachIdeas gathers them.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as coach from '../src/core/coach';
import { type Engine, PovScore, Score } from '../src/core/engine';
import type { DbClient } from '../src/data/client';
import { CoachIdeas } from '../src/ui/coachIdeas';

const P = {
  QUEEN_ROOK: {
    fen: 'r4rk1/pp1N1ppp/1qp1pb2/5n1Q/3P1P2/2B4P/PPP3P1/1RR3K1 b - - 7 21',
    threat: { move: 'd7b6', gain: 774, line: ['d7b6', 'a7b6', 'h5f3', 'a8a2', 'g1h2', 'f8d8'] },
    lines: [
      { line: ['f6d4', 'g1h2', 'b6c7', 'd7e5', 'a8d8', 'h5f3', 'f5h4', 'f3e4', 'd4c3', 'b2c3', 'd8d2', 'c1d1'], cp: 247 },
      { line: ['b6d8', 'd7f8', 'd8f8', 'h5f3', 'a8d8', 'c1d1', 'd8d5', 'c3e1', 'f5d4', 'f3f2', 'b7b6', 'c2c3'], cp: -113 },
      { line: ['b6c7', 'd7f6', 'g7f6', 'h5g4', 'g8h8', 'd4d5', 'c7e7', 'd5e6', 'f7e6', 'c1e1', 'f5g7', 'b1d1'], cp: -148 },
    ],
  },
  TWO_ROOKS: {
    fen: '2r1r1k1/p1q2pp1/b2N1n1p/8/4pP2/1B5P/PPP2QP1/3RR1K1 b - - 3 23',
    threat: { move: 'b3f7', gain: 382, line: ['b3f7', 'c7f7', 'd6f7', 'e4e3', 'e1e3', 'e8e3'] },
    lines: [
      { line: ['e4e3', 'e1e3', 'e8d8', 'b3f7', 'g8f8', 'e3e6', 'a6c4', 'e6f6', 'g7f6', 'f7c4', 'd8d6', 'c4d3'], cp: -178 },
      { line: ['e8f8', 'd6c8', 'f8c8', 'f2d4', 'c8e8', 'd4d6', 'c7a5', 'd6d2', 'a5c7', 'd2d4', 'f6h5', 'd4d6'], cp: -367 },
      { line: ['e8e7', 'd6c8', 'a6c8', 'f2d2', 'e7d7', 'd2e3', 'd7d1', 'e1d1', 'c8a6', 'd1d2', 'f6h5', 'd2f2'], cp: -376 },
    ],
  },
  QUEEN_ROOK_W: {
    fen: 'r2r2k1/2p3p1/1p2p1Qp/p1n5/P3bBNq/2P1P3/5PP1/1R1R2K1 w - - 2 25',
    threat: { move: 'd8d1', gain: 384, line: ['d8d1', 'b1d1', 'e4g6', 'g4e5', 'g6e8', 'd1d4'] },
    lines: [
      { line: ['f4g3', 'e4b1', 'd1b1', 'h4g5', 'g6g5', 'h6g5', 'g3c7', 'd8c8', 'c7d6', 'c5a4', 'b1b5', 'a4c3'], cp: -389 },
      { line: ['g4h6', 'h4h6', 'g6h6', 'g7h6', 'b1a1', 'd8d7', 'f2f3', 'e4c6', 'd1d4', 'g8f7', 'd4d7', 'c5d7'], cp: -439 },
      { line: ['d1d8', 'a8d8', 'g4h6', 'h4h6', 'g6h6', 'g7h6', 'b1a1', 'd8d7', 'f2f3', 'e4c2', 'e3e4', 'd7d1'], cp: -483 },
    ],
  },
};

type Pos = (typeof P)[keyof typeof P];
// a puzzle's start: your move after theirs, the move itself unknown (theirMove: null)
const key = (p: Pos) => coach.positionIdeas({ fen: p.fen, me: Board.fromFen(p.fen).turn, cp: p.lines[0].cp, theirMove: null, threat: p.threat,
  bestLine: p.lines[0].line, alternatives: p.lines.map((l) => ({ move: l.line[0], cp: l.cp, line: l.line })) }).key;

describe('forked, and the counterattack', () => {
  it('the fork in the threat, then the counterattack with check', () => {
    const k = key(P.QUEEN_ROOK);
    expect(k[0]).toBe('Their knight on d7 forks your queen on b6 and rook on f8: it threatens Nxb6, which wins your queen (a rook in all, after the recaptures) — deal with that first.');
    expect(k[1]).toMatch(/^You can't save both, so hit back first: Bxd4\+ gives check\. In Stockfish's line 21\.\.\.Bxd4\+ .*, you come out a pawn up\.$/);
  });

  it('a fork of two rooks, met by attacking the queen', () => {
    const k = key(P.TWO_ROOKS);
    expect(k).toContain('Their knight on d6 forks your rook on c8 and rook on e8.');
    expect(k.join(' ')).toMatch(/You can't save both, so hit back first: e3 attacks the queen on f2\..*you lose only two pawns instead of your rook\./);
  });

  it('a bishop forking queen and rook, met by attacking their queen', () => {
    expect(key(P.QUEEN_ROOK_W).join(' ')).toMatch(/Their bishop on e4 forks your queen on g6 and rook on b1\..*hit back first: Bg3 attacks the queen on h4\..*you lose only a pawn instead of your queen\./);
  });

  it('a fork you escape by moving a forked piece is not a counterattack', () => {
    // Bxd4+ replaced by a queen move: it saves the queen, so no "hit back"
    const p = P.QUEEN_ROOK;
    const ideas = coach.positionIdeas({ fen: p.fen, me: 'black', cp: 0, theirMove: null, bestLine: ['b6d8'], alternatives: [{ move: 'b6d8', cp: 0 }] });
    expect(ideas.points.some((x) => x.rule === 'counterattack')).toBe(false);
    expect(ideas.points.find((x) => x.rule === 'forked')?.text).toBe('Their knight on d7 forks your queen on b6 and rook on f8.');
  });

  it('a check that also hits a piece is said as a check', () => {
    expect(coach.forkOn(Board.fromFen('rn5k/pp3rp1/2pp1NQp/4pp2/2P5/5q2/PP2N3/R5RK w - - 0 22'), 'white')?.targets.length).toBe(2);
    const t = coach.positionIdeas({ fen: 'rn5k/pp3rp1/2pp1NQp/4pp2/2P5/5q2/PP2N3/R5RK w - - 0 22', me: 'white', theirMove: null })
      .points.find((x) => x.rule === 'forked')?.text;
    expect(t).toBe('Their queen on f3 gives check and hits your knight on e2 at the same time.');
  });
});

describe("a puzzle's start: your move after theirs", () => {
  it("the threat is looked for even when their move itself isn't known", async () => {
    let passes = 0;
    const engine: Engine = { analyse: async (b: Board) => { if (b.turn !== Board.fromFen(P.QUEEN_ROOK.fen).turn) passes += 1;
      return [{ pv: b.legalMoves().slice(0, 1), score: new PovScore(Score.cp(0), b.turn) }]; } };
    const client = { service: async (n: string) => (n === 'getSettings' ? { puzzle_ideas: '1' } : undefined) } as unknown as DbClient;
    const c = new CoachIdeas(client, 'puzzle_ideas', engine, () => {});
    await c.load();
    await c.explain({ fen: P.QUEEN_ROOK.fen, me: 'black', theirMove: null });
    expect(passes).toBeGreaterThan(0);                          // their move searched (the threat)
    expect(c.ideas?.sections.some((s) => s.title === 'What your opponent wants') || c.ideas?.key.some((k) => /forks/.test(k))).toBe(true);
  });
});

describe('their other tactics', () => {
  const ideas = (fen: string, extra: Partial<Parameters<typeof coach.positionIdeas>[0]> = {}) =>
    coach.positionIdeas({ fen, me: Board.fromFen(fen).turn, theirMove: null, ...extra });
  const rule = (fen: string, r: string, extra = {}) => ideas(fen, extra).points.find((x) => x.rule === r)?.text;

  it('a skewer: your queen in front, a loose rook behind', () => {
    expect(rule('k7/8/8/b7/8/2Q5/8/4R1K1 w - - 0 1', 'skewered'))
      .toBe('Their bishop on a5 skewers your queen and the rook on e1 behind it: when the queen moves, the rook falls.');
  });

  it('a pin they can win (from your puzzles)', () => {
    expect(rule('2r1r1k1/5p1p/R1p3p1/1p6/n2P4/b1P1P2P/qBQ1BPP1/1R4K1 w - - 7 26', 'pinned-win'))
      .toBe('Their queen on a2 pins your bishop on b2 to your queen — if the bishop moves, the queen goes, and more of their pieces hit it than guard it.');
  });

  it('an even trade is not a pin worth a word', () => {
    // Bb4 against your Bd2, which the king defends: Bxd2+ Kxd2 is just a trade
    expect(ideas('4k3/8/8/8/1b6/8/3B4/4K3 w - - 0 1').points.some((x) => x.rule.startsWith('pinned'))).toBe(false);
  });

  it('the threat named by its motif: a back-rank mate, a discovered attack', () => {
    expect(rule('3r2k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1', 'threat', { threat: { move: 'd8d1', gain: 10000 } }))
      .toBe('It threatens Rd1#, which is a back-rank mate — deal with that first.');
    expect(rule('k7/1b6/8/3n4/8/8/8/K6Q w - - 0 1', 'threat', { threat: { move: 'd5c3', gain: 900 } }))
      .toMatch(/^It threatens Nc3, which uncovers an attack by the bishop on b7 on your queen on h1/);
  });

  it("hitting back instead of defending a piece (from your puzzles): Bxd2+ is coming, Nxc8+ first", () => {
    const fen = 'r1b4r/pp2kppp/2pN1n2/q1n1p3/1b1pP3/1B1P4/PPPB1PPP/R2QK1NR w KQ - 11 13';
    const lines = [{ line: ['d6c8', 'a8c8', 'g1f3', 'b4d2', 'f3d2', 'a5c7', 'e1g1', 'a7a5', 'a2a4', 'c5b3', 'c2b3', 'e7e8'], cp: 37 },
      { line: ['d6c4', 'b4d2', 'c4d2', 'a5c7', 'g1e2', 'a7a5', 'f2f4', 'c8g4'], cp: 7 }];
    const t = rule(fen, 'counterattack', { cp: 37, threat: { move: 'b4d2', gain: 473, line: ['b4d2', 'd1d2', 'a5d2', 'e1d2'] }, bestLine: lines[0].line,
      alternatives: lines.map((l) => ({ move: l.line[0], cp: l.cp, line: l.line })) });
    expect(t).toMatch(/^You don't have to defend against Bxd2\+: hit back first: Nxc8\+ /);
  });

  it('a quiet "threat" is no reason to ignore it, and neither is mate', () => {
    // the same position, but the threat is a mate: never "you don't have to defend"
    const fen = 'r1b4r/pp2kppp/2pN1n2/q1n1p3/1b1pP3/1B1P4/PPPB1PPP/R2QK1NR w KQ - 11 13';
    expect(rule(fen, 'counterattack', { cp: 37, threat: { move: 'b4d2', gain: 10000 }, bestLine: ['d6c8', 'a8c8'], alternatives: [{ move: 'd6c8', cp: 37 }] })).toBeUndefined();
  });
});
