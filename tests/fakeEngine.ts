// Stockfish stand-in, as in the prototype's tests: analyse() answers from a
// {board-fen: [[pv ucis, cp or ['mate', n]], ...]} table, scores from the side
// to move's point of view.
import type { Board } from '../src/core/chess';
import { type Engine, type InfoLine, PovScore, Score } from '../src/core/engine';

export type FakeLine = [string[], number | ['mate', number]];

export class FakeEngine implements Engine {
  constructor(readonly table: Record<string, FakeLine[]>) {}

  /** Board placement only (as the prototype's FakeEngine); TurnEngine adds the side to move. */
  protected key(board: Board): string {
    return board.boardFen();
  }

  async analyse(board: Board, _limit: unknown, multipv?: number, rootMoves?: string[]): Promise<InfoLine[]> {
    const all = this.table[this.key(board)];
    if (!all) throw new Error(`FakeEngine has no entry for ${board.fen()}`);
    const entries = rootMoves ? all.filter(([pv]) => rootMoves.includes(pv[0])) : all;
    const lines = entries.map(([pv, score]) => ({
      pv,
      score: new PovScore(Array.isArray(score) ? Score.mate(score[1]) : Score.cp(score), board.turn),
    }));
    return multipv ? lines : lines.slice(0, 1);
  }
}

/** Keyed by placement + side to move: a pass leaves the pieces where they are. */
export class TurnEngine extends FakeEngine {
  protected override key(board: Board): string {
    return board.fen().split(' ').slice(0, 2).join(' ');
  }
}
