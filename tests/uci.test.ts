// The browser engine's UCI conversation, against a scripted stand-in for the
// Stockfish worker (the real one runs in tests/e2e in a browser).
import { describe, expect, it } from 'vitest';
import { scoreToCp } from '../src/core/analyzer';
import { Board } from '../src/core/chess';
import { runPool } from '../src/engine/pool';
import { UciEngine, type WorkerLike } from '../src/engine/uci';

/** Answers like Stockfish: uci/isready handshakes, and a scripted search per "go". */
class FakeStockfish implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  constructor(private readonly searches: string[][]) {}

  postMessage(cmd: string): void {
    this.sent.push(cmd);
    const reply = (...lines: string[]) => queueMicrotask(() => lines.forEach((l) => this.onmessage?.({ data: l })));
    if (cmd === 'uci') reply('id name Stockfish 19 Lite', 'uciok');
    else if (cmd === 'isready') reply('readyok');
    else if (cmd.startsWith('go')) reply(...(this.searches.shift() ?? ['bestmove (none)']));
  }
}

describe('UCI engine', () => {
  it('handshakes, sets options, and reads MultiPV lines at the final depth', async () => {
    const fake = new FakeStockfish([[
      'info depth 13 multipv 1 score cp 20 pv e2e4 e7e5',
      'info depth 14 seldepth 18 multipv 1 score cp 31 nodes 1000 pv e2e4 e7e5 g1f3',
      'info depth 14 seldepth 18 multipv 2 score cp 25 nodes 1000 pv d2d4 d7d5',
      'info depth 14 seldepth 18 multipv 3 score cp 22 nodes 1000 pv c2c4',
      'bestmove e2e4 ponder e7e5',
    ]]);
    const engine = new UciEngine(fake, { Hash: 16 });
    const lines = await engine.analyse(Board.fromFen(), { depth: 14 }, 3);
    expect(engine.name).toBe('Stockfish 19 Lite');
    expect(lines.map((l) => [l.pv[0], scoreToCp(l.score, 'white'), l.depth])).toEqual([['e2e4', 31, 14], ['d2d4', 25, 14], ['c2c4', 22, 14]]);
    expect(fake.sent).toEqual(['uci', 'setoption name Hash value 16', 'isready', 'setoption name MultiPV value 3',
      'position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'go depth 14']);
  });

  it("scores are the side to move's, mates included; bounds are skipped", async () => {
    const black = Board.fromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    const fake = new FakeStockfish([[
      'info depth 10 multipv 1 score cp -40 lowerbound pv e7e5',
      'info depth 10 multipv 1 score cp -25 pv c7c5',
      'bestmove c7c5',
    ], [
      'info depth 5 multipv 1 score mate 2 pv d8h4',
      'bestmove d8h4',
    ]]);
    const engine = new UciEngine(fake);
    const [line] = await engine.analyse(black, { depth: 10 });
    expect([line.pv[0], scoreToCp(line.score, 'black'), scoreToCp(line.score, 'white')]).toEqual(['c7c5', -25, 25]);
    const [mate] = await engine.analyse(black, { time: 0.3 });
    expect(scoreToCp(mate.score, 'black')).toBe(10000);
    expect(fake.sent.at(-1)).toBe('go movetime 300');
  });

  it('searches only the moves asked for, and runs one search at a time', async () => {
    const fake = new FakeStockfish([
      ['info depth 12 multipv 1 score cp 10 pv g1f3', 'info depth 12 multipv 2 score cp 5 pv b1c3', 'bestmove g1f3'],
      ['info depth 12 multipv 1 score cp 0 pv a2a3', 'bestmove a2a3'],
    ]);
    const engine = new UciEngine(fake);
    const [a, b] = await Promise.all([
      engine.analyse(Board.fromFen(), { depth: 12 }, 2, ['g1f3', 'b1c3']),
      engine.analyse(Board.fromFen(), { depth: 12 }),
    ]);
    expect(a.map((l) => l.pv[0])).toEqual(['g1f3', 'b1c3']);
    expect(b.map((l) => l.pv[0])).toEqual(['a2a3']);
    expect(fake.sent.filter((c) => c.startsWith('go'))).toEqual(['go depth 12 searchmoves g1f3 b1c3', 'go depth 12']);
  });

  it('a finished game has nothing to analyse', async () => {
    const mated = Board.fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
    const engine = new UciEngine(new FakeStockfish([['info depth 0 score mate 0', 'bestmove (none)']]));
    expect(await engine.analyse(mated, { depth: 10 })).toEqual([]);
  });

  it('a pool shares the jobs between engines and keeps every result', async () => {
    const make = (tag: string) => new UciEngine(new FakeStockfish(Array.from({ length: 5 },
      () => [`info depth 1 multipv 1 score cp 0 pv ${tag}`, `bestmove ${tag}`])));
    const engines = [make('e2e4'), make('d2d4')];
    const done: [number, string][] = [];
    const n = await runPool(engines, [1, 2, 3, 4, 5], async (engine) => (await engine.analyse(Board.fromFen(), { depth: 1 }))[0].pv[0],
      (job, move) => { done.push([job, move]); });
    expect(n).toBe(5);
    expect(done.map(([job]) => job).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(done.map(([, m]) => m))).toEqual(new Set(['e2e4', 'd2d4']));   // both engines worked
  });
});
