// Stockfish stand-in, as in the prototype's tests: analyse() answers from a
// {board-fen: [[pv ucis, cp or ['mate', n]], ...]} table, scores from the side
// to move's point of view.
import type { Board } from '../src/core/chess';
import { type Engine, type InfoLine, PovScore, Score } from '../src/core/engine';

export type FakeLine = [string[], number | ['mate', number]];

export class FakeEngine implements Engine {
  constructor(readonly table: Record<string, FakeLine[]>) {}

  async analyse(board: Board, _limit: unknown, multipv?: number): Promise<InfoLine[]> {
    const entries = this.table[board.boardFen()];
    if (!entries) throw new Error(`FakeEngine has no entry for ${board.fen()}`);
    const lines = entries.map(([pv, score]) => ({
      pv,
      score: new PovScore(Array.isArray(score) ? Score.mate(score[1]) : Score.cp(score), board.turn),
    }));
    return multipv ? lines : lines.slice(0, 1);
  }
}
