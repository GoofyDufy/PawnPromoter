// Which squares the Coach's text mentions (they light up on the board when you point at it).
import { describe, expect, it } from 'vitest';
import { squaresIn } from '../src/ui/SquareText';

describe('squares in the Coach\'s text', () => {
  it('squares and moves, not words or numbers', () => {
    expect(squaresIn('Your pawn breaks: b4 and d5 — the moves that open lines.')).toEqual(['b4', 'd5']);
    expect(squaresIn('The idea: cxd4 Nxd4 O-O Be2.')).toEqual(['d4', 'e2']);
    expect(squaresIn('Qh5+ then e8=Q#, and Rxa1')).toEqual(['h5', 'e8', 'a1']);
    expect(squaresIn('You are slightly better (+1.2) — a pawn, the c-file.')).toEqual([]);
    expect(squaresIn('8...cxd4 9.Nxd4 O-O')).toEqual(['d4']);
  });
});
