// Which squares the Coach's text mentions (they light up on the board when you point at it).
import { describe, expect, it } from 'vitest';
import { refsIn, squaresIn } from '../src/ui/SquareText';

describe('squares in the Coach\'s text', () => {
  it('squares and moves, not words or numbers', () => {
    expect(squaresIn('Your pawn breaks: b4 and d5 — the moves that open lines.')).toEqual(['b4', 'd5']);
    expect(squaresIn('The idea: cxd4 Nxd4 O-O Be2.')).toEqual(['d4', 'e2']);
    expect(squaresIn('Qh5+ then e8=Q#, and Rxa1')).toEqual(['h5', 'e8', 'a1']);
    expect(squaresIn('You are slightly better (+1.2) — a pawn, the c-file.')).toEqual([]);
    expect(squaresIn('8...cxd4 9.Nxd4 O-O')).toEqual(['d4']);
  });
});

describe('moves in the Coach\'s text get arrows (refsIn)', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const arrows = (text: string, fen: string | null = START) => refsIn(text, fen).map((r) => (r.arrow ? `${r.arrow.from}-${r.arrow.to}` : r.square));

  it('a piece move and a pawn push, from where the piece stands', () => {
    expect(arrows('Develop with Nf3, then e4.')).toEqual(['g1-f3', 'e2-e4']);
  });

  it('Black\'s moves (marked …) with White to move', () => {
    expect(arrows('Watch for …e5 and …Nf6.')).toEqual(['e7-e5', 'g8-f6']);
  });

  it('a line is followed move by move', () => {
    expect(arrows('Stockfish wants 1.e4 e5 2.Nf3 Nc6.')).toEqual(['e2-e4', 'e7-e5', 'g1-f3', 'b8-c6']);
  });

  it('places stay highlights: "on", "hits", "to"…', () => {
    // French chain (1.e4 e6 2.d4 d5 3.e5 Ne7): …c5 is a move, d4 / e5 are targets
    const french = 'rnbqkb1r/ppp1nppp/4p3/3pP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 2 4';
    expect(arrows('break at the chain: …c5 hits d4 and …f6 hits e5', french)).toEqual(['c7-c5', 'd4', 'f7-f6', 'e5']);
    expect(arrows('put a knight on d5 — keep an eye on c3', START)).toEqual(['d5', 'c3']);
  });

  it('an impossible move, or no position, is just a square', () => {
    expect(arrows('Qh5 wins', START)).toEqual(['h5']);
    expect(arrows('Nf3 and e4', null)).toEqual(['f3', 'e4']);
  });
});
