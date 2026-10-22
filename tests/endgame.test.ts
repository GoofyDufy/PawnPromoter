// The Coach's endgame knowledge (ENDGAME-EXPLAINER.md): the ending's family, the rule of the square,
// corner draws, stalemate traps, Lucena / Philidor on exact matches only, and trades into pawn endings.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as coach from '../src/core/coach';
import { catches, endgameInsights, family, pawnEndingTrades, rookPawnKind } from '../src/core/endgame';

const rules = (fen: string, me: 'white' | 'black' = 'white', cp: number | null = null) => endgameInsights(Board.fromFen(fen), me, cp).map((n) => n.rule);

describe('the kind of ending', () => {
  it('names the family from the pieces left', () => {
    expect(family(Board.fromFen('8/5pk1/6p1/8/8/6P1/r4PK1/3R4 w - - 0 40'))).toBe('rook');
    expect(family(Board.fromFen('8/5pk1/6p1/8/8/6P1/5PK1/8 w - - 0 40'))).toBe('pawn');
    expect(family(Board.fromFen('8/5pk1/6p1/2b5/8/6PP/4BPK1/8 w - - 0 40'))).toBe('bishop-opposite');
    expect(family(Board.fromFen('8/5pk1/6p1/2b5/8/4B1PP/5PK1/8 w - - 0 40'))).toBe('bishop-same');
    expect(family(Board.fromFen('r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))).toBe(null);
  });

  it('opposite-coloured bishops a pawn up: a warning that it may be a draw', () => {
    const r = rules('8/5pk1/6p1/2b5/8/6PP/4BPK1/8 w - - 0 40', 'white');
    expect(r).toContain('endgame-family');
    expect(r).toContain('ocb-ahead');
  });
});

describe('the rule of the square', () => {
  it('who moves first decides', () => {
    expect(catches(Board.fromFen('8/8/8/P3k3/8/8/8/K7 w - - 0 50'), 32)).toBe(false);   // a5 runs
    expect(catches(Board.fromFen('8/8/8/P3k3/8/8/8/K7 b - - 0 50'), 32)).toBe(true);    // Black steps into the square
  });

  it('a pawn on its second rank counts its double step', () => {
    expect(catches(Board.fromFen('8/8/5k2/8/8/8/P7/K7 w - - 0 50'), 8)).toBe(true);
  });

  it('says so in a pawn ending', () => {
    expect(rules('8/8/8/P3k3/8/8/8/K7 w - - 0 50')).toContain('square-runs');
    expect(rules('8/8/8/P3k3/8/8/8/K7 b - - 0 50')).toContain('square-caught');
  });
});

describe('corner draws', () => {
  it('a rook\'s pawn with the king in the corner', () => {
    expect(rules('k7/8/8/P7/8/8/8/4K3 w - - 0 50')).toContain('rook-pawn-draw');
  });

  it('the wrong bishop — and not with the right one', () => {
    expect(rules('7k/8/8/7P/8/8/4B3/4K3 w - - 0 50')).toContain('wrong-bishop');     // light bishop, dark h8
    expect(rules('7k/8/8/7P/8/8/3B4/4K3 w - - 0 50')).not.toContain('wrong-bishop');  // dark bishop controls h8
  });
});

describe('stalemate traps', () => {
  it('warns the winning side before a move that stalemates', () => {
    expect(rules('7k/8/6Q1/8/8/8/8/K7 w - - 0 50', 'white', 2000)).toContain('stalemate-trap');
    expect(rules('7k/8/6Q1/8/8/8/8/K7 w - - 0 50', 'white', null)).not.toContain('stalemate-trap');
  });
});

describe('Lucena and Philidor — exact matches only', () => {
  it('Lucena: pawn on the 7th, king in front, the other king cut off by the rook', () => {
    expect(rookPawnKind(Board.fromFen('1K6/1P2k3/8/8/8/8/r7/2R5 w - - 0 1'))).toEqual({ kind: 'lucena', attacker: 'white' });
    expect(rules('1K6/1P2k3/8/8/8/8/r7/2R5 w - - 0 1', 'white', 800)).toContain('lucena');
    expect(rules('1K6/1P2k3/8/8/8/8/r7/2R5 w - - 0 1', 'white', 50)).not.toContain('lucena');   // the engine disagrees: silent
    // the defending king one file away (a6): not cut off, not Lucena
    expect(rookPawnKind(Board.fromFen('1K6/1P6/k7/8/8/8/r7/2R5 w - - 0 1'))).toBe(null);
  });

  it('Philidor: king in front, rook on its third rank', () => {
    expect(rookPawnKind(Board.fromFen('4k3/R7/1r6/4P3/4K3/8/8/8 w - - 0 1'))).toEqual({ kind: 'philidor', attacker: 'white' });
    expect(rules('4k3/R7/1r6/4P3/4K3/8/8/8 w - - 0 1', 'black', 0)).toContain('philidor');
  });

  it('Philidor available: names the rook move that sets it up', () => {
    const t = rookPawnKind(Board.fromFen('4k3/R7/8/4P3/4K3/8/8/1r6 b - - 0 1'));
    expect(t).toEqual({ kind: 'philidor-available', attacker: 'white', move: 'Rb6' });
    const text = endgameInsights(Board.fromFen('4k3/R7/8/4P3/4K3/8/8/1r6 b - - 0 1'), 'black', 0).find((n) => n.rule === 'philidor-available')!.text;
    expect(text).toMatch(/Rb6 puts your rook on your third rank/);
  });

  it('a rook\'s pawn is never called Lucena', () => {
    expect(rookPawnKind(Board.fromFen('K7/P2k4/8/8/8/8/r7/1R6 w - - 0 1'))).toBe(null);
  });
});

describe('trading into a pawn ending', () => {
  it('finds the capture that leaves only kings and pawns after the recapture', () => {
    expect(pawnEndingTrades(Board.fromFen('8/5p2/6p1/4k3/3r4/6P1/5PK1/3R4 w - - 0 40'))).toEqual(['d1d4']);
    // an undefended rook: winning it isn't a trade
    expect(pawnEndingTrades(Board.fromFen('8/5pk1/6p1/8/3r4/6P1/5PK1/3R4 w - - 0 40'))).toEqual([]);
  });

  it('the Coach warns against a bad trade and recommends a winning one', () => {
    const fen = '8/5p2/6p1/4k3/3r4/6P1/5PK1/3R4 w - - 0 40';
    const bad = coach.positionIdeas({ fen, me: 'white', cp: 150, bestLine: ['d1e1'], pawnTrades: [{ move: 'd1d4', cp: -150 }] });
    expect(bad.points.find((p) => p.rule === 'pawn-trade-bad')?.text).toMatch(/Don't trade into the pawn ending with Rxd4: that pawn ending is worse for you \(-1.5\)/);
    const good = coach.positionIdeas({ fen, me: 'white', cp: 400, pawnTrades: [{ move: 'd1d4', cp: 395 }] });
    expect(good.points.find((p) => p.rule === 'pawn-trade-good')?.text).toMatch(/Rxd4 trades into a pawn ending that's winning for you/);
  });
});
