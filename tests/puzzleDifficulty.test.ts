// Puzzle difficulty as a Lichess rating: what the solution asks of you, and the backoff to a less specific kind.
import { describe, expect, it } from 'vitest';
import { estimate, features, keysFor } from '../src/core/puzzleDifficulty';

describe('puzzle difficulty', () => {
  it('reads what a puzzle asks: a knight fork, a mate in one', () => {
    expect(features('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7', 'e8d8', 'c7a8'])).toEqual({ moves: 2, first: 'check', motif: 'fork', sacrifice: false, mate: false });
    expect(features('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', ['d1d8'])).toMatchObject({ moves: 1, first: 'mate', mate: true });
  });

  it('backs off to a less specific kind when the exact one is rare', () => {
    const f = features('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7', 'e8d8', 'c7a8'])!;
    const [, , , general] = keysFor(f);
    const table = { table: { [general]: [1450, 500] as [number, number] }, overall: 1600, mae: 370, baseline_mae: 630 };
    expect(estimate(table, 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7', 'e8d8', 'c7a8'])).toBe(1450);
    expect(estimate({ ...table, table: {} }, 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7'])).toBe(1600);
    expect(estimate(null, 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7'])).toBeNull();
  });
});
