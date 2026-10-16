// Port of the prototype's AnalysisBoardTests (analysis_board.py): the shared
// analysis board's moves, without a screen or Stockfish.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import { Idea } from '../src/core/engineIdeas';
import { Analysis } from '../src/ui/analysis';
import { FakeEngine } from './fakeEngine';

describe('the shared analysis board', () => {
  it('ahead line, floor and branching', () => {
    const a = new Analysis(null);                       // no engine: the panel says so
    a.start(Board.fromFen(), ['e2e4', 'e7e5', 'g1f3']);
    expect(a.panel.header).toContain('Stockfish not found');
    expect(a.step(1)).toBe(true);
    expect(a.step(1)).toBe(true);
    expect(a.board.moveStack).toEqual(['e2e4', 'e7e5']);
    expect(a.step(-1)).toBe(true);
    expect(a.ahead).toEqual(['e7e5', 'g1f3']);          // ▶ plays it again
    expect(a.play('c7c5')).toBe(true);
    expect(a.ahead).toEqual([]);                        // a branch: the line's gone
    a.walk(-999);
    expect(a.board.moveStack).toEqual([]);
    expect(a.step(-1)).toBe(false);                     // not past the start
    expect(a.play('e2e5')).toBe(false);                 // illegal
  });

  it('following an idea', () => {
    const a = new Analysis(null);
    a.start(Board.fromFen());
    const pv = ['d2d4', 'd7d5', 'c2c4'];
    a.ideas = [new Idea(pv[0], pv, 30, null)];
    a.follow(0);
    expect(a.board.moveStack).toEqual(pv.slice(0, 1));
    expect(a.ahead).toEqual(pv.slice(1));
    a.stop();
    expect(a.step(1)).toBe(false);
  });

  it('keeps the moves already on the board, and floor stops ◀ there', () => {
    const b = Board.fromFen();
    b.push('e2e4');
    b.push('e7e5');
    const a = new Analysis(null);
    a.start(b, [], 2);
    expect(a.board.moveStack).toEqual(['e2e4', 'e7e5']);
    expect(a.step(-1)).toBe(false);
    a.play('g1f3');
    expect(a.step(-1)).toBe(true);
    expect(a.step(-1)).toBe(false);
    expect(b.moveStack).toEqual(['e2e4', 'e7e5']);       // the screen's own board is untouched
  });

  it("shows Stockfish's lines, arrows and evaluation for the position", async () => {
    const start = Board.fromFen();
    const engine = new FakeEngine({ [start.boardFen()]: [[['e2e4', 'e7e5'], 30], [['d2d4'], 25], [['g1f3'], 20]] });
    let changes = 0;
    const a = new Analysis(engine, { onChange: () => { changes += 1; } });
    a.start(start);
    await new Promise((r) => setTimeout(r, 10));
    expect(a.panel.title).toBe('Analysis — White to move');
    expect(a.panel.header).toMatch(/^Stockfish depth (12|18) · click a line, then ▶$/);
    expect(a.panel.rows).toEqual(['+0.30   1.e4 e5', '+0.25   1.d4', '+0.20   1.Nf3']);
    expect(a.arrows().map((x) => [x.from, x.to, x.brush])).toEqual([['g1', 'f3', 'grey'], ['d2', 'd4', 'blue'], ['e2', 'e4', 'green']]);
    expect(a.evalWhite).toBe(30);
    expect(a.step(1)).toBe(true);                        // ▶ with nothing ahead: Stockfish's best move
    expect(a.board.moveStack).toEqual(['e2e4']);
    expect(changes).toBeGreaterThan(2);
    a.dispose();
  });
});
