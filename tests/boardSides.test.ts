// The strips beside the board: captured pieces, material lead, and each side's clock at a move.
import { describe, expect, it } from 'vitest';
import { baseSecondsOf, captures, clockText, clocksAt } from '../src/core/boardSides';

describe('captures', () => {
  it('nothing at the start', () => {
    expect(captures('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toEqual({ white: [], black: [], diff: 0 });
  });

  it('a pawn won shows on the winner\'s side, with +1', () => {
    // 1.e4 d5 2.exd5: White has taken a pawn
    const c = captures('rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2');
    expect(c.white).toEqual(['pawn']);
    expect(c.black).toEqual([]);
    expect(c.diff).toBe(1);
  });

  it('trades show on both sides, pawns first, and the lead nets out', () => {
    // White is missing a knight; Black is missing a bishop and a pawn
    const c = captures('rn1qkbnr/ppp1pppp/8/8/8/8/PPPPPPPP/R1BQKBNR w KQkq - 0 5');
    expect(c.white).toEqual(['pawn', 'bishop']);
    expect(c.black).toEqual(['knight']);
    expect(c.diff).toBe(1);
  });

  it('a promoted pawn is not a captured pawn', () => {
    // White has two queens and seven pawns: one pawn promoted, none lost
    const c = captures('4k3/8/8/8/8/8/PPPPPPP1/Q2QK3 w - - 0 50');
    expect(c.black.filter((r) => r === 'pawn')).toEqual([]);
  });
});

describe('clocks', () => {
  const clocks = [178.5, 179, 175, null, 170, 160];        // after White's 1st, Black's 1st, …

  it('each side\'s last recorded time, the start time before its first move', () => {
    expect(clocksAt(clocks, 180, 0)).toEqual({ white: 180, black: 180 });
    expect(clocksAt(clocks, 180, 1)).toEqual({ white: 178.5, black: 180 });
    expect(clocksAt(clocks, 180, 4)).toEqual({ white: 175, black: 179 });   // Black's 2nd has no time: the one before
    expect(clocksAt(clocks, 180, 6)).toEqual({ white: 170, black: 160 });
  });

  it('no clock at all when the game has none', () => {
    expect(clocksAt([null, null], 180, 2)).toEqual({ white: null, black: null });
  });

  it('reads like a chess clock', () => {
    expect(clockText(180)).toBe('3:00');
    expect(clockText(59.9)).toBe('0:59');
    expect(clockText(7.43)).toBe('0:07.4');
    expect(clockText(3725)).toBe('1:02:05');
    expect(baseSecondsOf('180+2')).toBe(180);
    expect(baseSecondsOf('1/259200')).toBe(null);
  });
});
