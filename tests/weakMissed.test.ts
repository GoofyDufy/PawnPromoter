import { describe, expect, it } from 'vitest';
import { missedDetail } from '../src/core/weak/stats';

describe('missedDetail: the tactic you missed, and the piece that would have played it', () => {
  it('names a knight fork of king and rook', () => {
    expect(missedDetail('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7 e8d7 c7a8', false)).toEqual({ tactic: 'Fork', by: 'knight' });
  });
  it('is null when the best move wins nothing', () => {
    expect(missedDetail('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e2e4 e8e7', false)).toBeNull();
  });
  it('calls a missed mate a mate', () => {
    expect(missedDetail('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8', true)).toEqual({ tactic: 'Mate threat', by: 'rook' });
  });
  it('is null for an illegal line', () => {
    expect(missedDetail('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'a1a8', false)).toBeNull();
  });
});
