// The Coach's 💡 Ideas, shared by the screens: remembered on / off, the board's ideas at once,
// Stockfish's plan (and the evaluation) when the engine answers, nothing while it's off.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import { type Engine, PovScore, Score } from '../src/core/engine';
import type { DbClient } from '../src/data/client';
import { CoachIdeas } from '../src/ui/coachIdeas';

function fakeClient(settings: Record<string, string> = {}): DbClient {
  return {
    service: async (name: string, arg: Record<string, string> | string[]) => {
      if (name === 'getSettings') return Object.fromEntries((arg as string[]).map((k) => [k, settings[k]]));
      if (name === 'setSettings') Object.assign(settings, arg);
      return undefined;
    },
  } as unknown as DbClient;
}

const engine: Engine = {
  analyse: async (board: Board) => [{ pv: board.legalMoves().slice(0, 2), score: new PovScore(Score.cp(120), board.turn) }],
};

describe('CoachIdeas', () => {
  it('stays quiet while off, explains once on, and remembers the choice', async () => {
    const settings: Record<string, string> = {};
    let changes = 0;
    const c = new CoachIdeas(fakeClient(settings), 'puzzle_ideas', engine, () => { changes += 1; });
    await c.load();
    await c.explain({ fen: Board.fromFen().fen(), me: 'white' });
    expect(c.ideas).toBe(null);
    await c.set(true);
    expect(settings.puzzle_ideas).toBe('1');
    expect(c.ideas?.summary).toBe('You have a clear advantage (+1.2).');    // the evaluation from the engine's search
    expect(c.ideas?.points.map((p) => p.rule)).toContain('stockfish');
    expect(changes).toBeGreaterThan(0);
    await c.explain(null);
    expect(c.ideas).toBe(null);
  });

  it('uses the lines a screen already has instead of searching again', async () => {
    let asked = 0;                                  // the top-moves search (the short threat check still runs)
    const counting: Engine = { analyse: async (b: Board, limit, multipv) => { if ((multipv ?? 1) > 1) asked += 1; return engine.analyse(b, limit); } };
    const c = new CoachIdeas(fakeClient({ analysis_ideas: '1' }), 'analysis_ideas', counting, () => {});
    await c.load();
    await c.explain({ fen: Board.fromFen().fen(), me: 'white', cp: 30, bestLine: ['e2e4', 'e7e5'],
      alternatives: [{ move: 'e2e4', cp: 30 }, { move: 'd2d4', cp: 25 }] });
    expect(asked).toBe(0);
    expect(c.ideas?.points.find((p) => p.rule === 'stockfish')?.text).toMatch(/(Your best move here is|Several moves are fine here —|One move holds here:) e4/);
  });

  it('without an engine: the board\'s ideas only', async () => {
    const c = new CoachIdeas(fakeClient({ drill_ideas: '1' }), 'drill_ideas', null, () => {});
    await c.load();
    await c.explain({ fen: 'rnbqkbnr/pp3ppp/4p3/2ppP3/3P4/2P5/PP3PPP/RNBQKBNR b KQkq - 0 4', me: 'black' });
    expect(c.ideas?.summary).toBe('No evaluation for this position yet.');
    expect(c.ideas?.points.some((p) => p.section === 'Plans')).toBe(true);
  });
});
