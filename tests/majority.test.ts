// Converting a pawn majority (Downloads/Pawn Majority Conversion — Research Report.md): the king first, then the
// pawn that should lead — the candidate, or the exception. Positions from the report's verified suite (Lichess
// tablebase results quoted there), with Stockfish 19's top three lines at depth 20.
import { describe, expect, it } from 'vitest';
import * as coach from '../src/core/coach';

const P = {
  HEALTHY: { fen: '4k3/pp6/8/8/8/8/PPP5/4K3 w - - 0 1', lines: [
    { line: ['e1e2', 'e8e7', 'e2d3', 'e7d6', 'd3d4', 'd6c6', 'd4c4', 'a7a6', 'c4b4', 'b7b6', 'b4c4', 'c6d6', 'b2b3', 'd6e5', 'c4b4', 'e5d6'], cp: 444 },
    { line: ['e1f2', 'e8d7', 'f2e3', 'd7c6', 'e3d4', 'c6d6', 'd4c4', 'd6c6', 'a2a3', 'c6b6', 'c4d5', 'b6c7', 'd5c5', 'b7b6', 'c5b5', 'c7b7'], cp: 442 },
    { line: ['e1d2', 'e8e7', 'd2d3', 'e7d6', 'd3c4', 'd6c6', 'a2a3', 'c6b6', 'c4d5', 'b6c7', 'd5c5', 'b7b6', 'c5b5', 'c7b7', 'b5c4', 'b7c6'], cp: 436 },
  ] },
  SPLIT: { fen: '2k5/1p6/8/8/8/8/P1P5/4K3 w - - 0 1', lines: [
    { line: ['e1d2', 'c8c7', 'd2c3', 'c7b6', 'c3b4', 'b6a6', 'a2a3', 'a6b6', 'a3a4', 'b6a7', 'b4b5', 'a7b8', 'b5b6', 'b8a8', 'a4a5', 'a8b8'], cp: 625 },
    { line: ['e1e2', 'c8c7', 'e2d3', 'c7c6', 'd3c4', 'c6b6', 'c4b4', 'b6a6', 'a2a3', 'a6b6', 'a3a4', 'b6a7', 'b4b5', 'a7b8', 'b5b6', 'b8a8'], cp: 625 },
    { line: ['e1d1', 'c8c7', 'd1c1', 'c7b6', 'c1b2', 'b6b5', 'b2b3', 'b5a5', 'b3c4', 'a5a4', 'c4c5', 'a4a3', 'c5b6', 'a3a2', 'b6b7', 'a2a3'], cp: 9 },
  ] },
  BREAKTHROUGH: { fen: '4k3/pp6/8/PPP5/8/8/8/4K3 w - - 0 1', lines: [
    { line: ['e1f2', 'e8d8', 'f2e3', 'a7a6', 'b5b6', 'd8d7', 'e3d4', 'd7d8', 'd4e5', 'd8e7', 'c5c6', 'b7c6', 'b6b7', 'c6c5', 'e5d5', 'e7d7'], cp: 703 },
    { line: ['e1d2', 'e8d8', 'd2e3', 'a7a6', 'b5b6', 'd8d7', 'e3d3', 'd7d8', 'd3d4', 'd8e8', 'd4e4', 'e8d8', 'e4e5', 'd8d7', 'e5d5', 'd7e7'], cp: 696 },
    { line: ['e1e2', 'e8d8', 'e2d3', 'a7a6', 'b5b6', 'd8d7', 'd3e4', 'd7e8', 'e4d4', 'e8e7', 'd4e5', 'e7d7', 'e5d5', 'd7c8', 'd5e6', 'c8d8'], cp: 696 },
  ] },
  DOUBLED: { fen: '4k3/pp6/8/8/P7/P7/1P6/4K3 w - - 0 1', lines: [
    { line: ['e1d2', 'e8d7', 'd2c3', 'd7c6', 'c3c4', 'a7a5', 'b2b3', 'b7b6', 'c4d4', 'c6d6', 'b3b4', 'd6c6', 'b4b5', 'c6d6', 'd4e4', 'd6e6'], cp: 28 },
    { line: ['e1e2', 'e8d7', 'e2d3', 'd7c6', 'd3d4', 'c6d6', 'd4c4', 'd6c6', 'a4a5', 'c6d6', 'c4b5', 'd6d5', 'a3a4', 'd5d6', 'b5c4', 'd6c6'], cp: 27 },
    { line: ['e1d1', 'e8e7', 'd1c2', 'e7d6', 'c2c3', 'd6c5', 'b2b4', 'c5d5', 'a4a5', 'd5c6', 'c3d4', 'c6d6', 'd4c4', 'd6c6', 'a3a4', 'b7b6'], cp: 20 },
  ] },
  FIX_FIRST: { fen: '4k3/5p2/8/5PP1/8/8/8/4K3 w - - 0 1', lines: [
    { line: ['e1e2', 'e8d7', 'e2e3', 'd7e7', 'e3d3', 'e7d7', 'd3e4', 'd7e8', 'e4e5', 'e8e7', 'f5f6', 'e7d7', 'e5d5', 'd7c8', 'g5g6', 'f7g6'], cp: 3562 },
    { line: ['e1f2', 'e8d7', 'f2e3', 'd7c6', 'e3e4', 'c6d6', 'e4d4', 'd6e7', 'd4d5', 'e7d7', 'f5f6', 'd7c8', 'g5g6', 'f7g6', 'f6f7', 'c8c7'], cp: 3561 },
    { line: ['e1d2', 'e8d7', 'd2d3', 'd7c6', 'd3d4', 'c6b5', 'g5g6', 'f7g6', 'f5g6', 'b5a4', 'g6g7', 'a4a3', 'g7g8q', 'a3b2', 'g8c8', 'b2b3'], cp: 3526 },
  ] },
  FULL_BOARD: { fen: '8/pp2k1pp/8/8/8/8/PPP2PPP/4K3 w - - 0 1', lines: [
    { line: ['e1e2', 'e7d6', 'f2f4', 'd6c5', 'e2d3', 'a7a5', 'g2g3', 'a5a4', 'c2c3', 'h7h6', 'b2b3', 'h6h5', 'h2h3'], cp: 520 },
    { line: ['e1d2', 'e7d6', 'f2f4', 'd6d5', 'd2d3', 'b7b5', 'c2c3', 'h7h5', 'g2g3', 'h5h4', 'b2b3', 'd5c5', 'g3g4', 'g7g5', 'f4f5', 'c5d5'], cp: 517 },
    { line: ['f2f4', 'h7h5', 'e1e2', 'b7b5', 'e2e3', 'e7f6', 'e3e4', 'f6g6', 'c2c3', 'h5h4', 'g2g4'], cp: 514 },
  ] },
};

const ideas = (p: { fen: string; lines: { line: string[]; cp: number }[] }) => coach.positionIdeas({ fen: p.fen, me: 'white', cp: p.lines[0].cp,
  bestLine: p.lines[0].line, alternatives: p.lines.map((l) => ({ move: l.line[0], cp: l.cp, line: l.line })) });
const said = (p: Parameters<typeof ideas>[0], rule: string) => ideas(p).points.find((x) => x.rule === rule)?.text ?? '';

describe('converting a pawn majority', () => {
  it('3 against 2, kings far away (#1): the king first, then the candidate', () => {
    expect(said(P.HEALTHY, 'majority')).toMatch(/Bring your king up first \(Ke2\): the majority only works with the king behind it\. Then push the pawn with a clear road \(c2\)\./);
    expect(said(P.HEALTHY, 'stockfish')).toBe('Several moves are fine here — Ke2, Kf2 and Kd2, all king moves: the king comes first, the pawns after.');
  });

  it('split 2 against 1 (#3: only Kd2/Ke2 win, every pawn push draws): the king, and why', () => {
    const t = said(P.SPLIT, 'majority');
    expect(t).toMatch(/^You have a queenside pawn majority \(2 against 1\).*Bring your king up first \(Kd2/);
    expect(t).toMatch(/Your pawns are split: push one too early and their king catches it\.$/);
  });

  it('f5+g5 against f7 (#7: 1.f6! wins, the candidate push 1.g6 draws): the opposed pawn first', () => {
    expect(said(P.FIX_FIRST, 'majority')).toMatch(/Then push f5–f6 first, not the free pawn on g5 — it fixes their pawn on f7 and keeps your pawns together\./);
  });

  it('pawns on the 5th against home pawns (#5: 1.b6! wins, 1.a6 draws): the breakthrough', () => {
    expect(said(P.BREAKTHROUGH, 'majority')).toMatch(/go for the breakthrough b5–b6!: whichever pawn takes it, another of yours gets through/);
  });

  it('a doubled majority (#6, a draw): not counted as a majority', () => {
    expect(said(P.DOUBLED, 'majority')).toBe('');
  });

  it('a pawn ending: the static edge says king first, not "trade down"', () => {
    expect(said(P.HEALTHY, 'static-edge')).toMatch(/bring your king up first, then push\.$/);
    expect(said(P.FULL_BOARD, 'static-edge')).not.toMatch(/trade down/);
  });

  it('without Stockfish\'s lines: the king leads, then the candidate', () => {
    expect(coach.positionIdeas({ fen: P.HEALTHY.fen, me: 'white' }).points.find((x) => x.rule === 'majority')?.text)
      .toMatch(/The king leads, then the pawn with a clear road — c2 — and trade until one is passed\./);
  });
});
