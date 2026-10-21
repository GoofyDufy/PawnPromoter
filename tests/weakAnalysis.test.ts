// The weakness stats' engine pass on a real PGN: rows, book skipping, the F1
// checkmate sign, [%clk] reading, and searches in game order with a fresh hash.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import { type InfoLine, PovScore, Score } from '../src/core/engine';
import { clockLabel, makeGame } from '../src/core/models';
import { fillEvaluations, parseGame, searchGame, toSearch } from '../src/core/weak/analysis';
import { Book, epd } from '../src/core/weak/book';
import { Game, buildMoves, included } from '../src/core/weak/stats';

// Scholar's mate, with Chess.com-style clocks (3+2: the clock includes the increment)
const PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "me"]
[Black "them"]
[Result "1-0"]
[TimeControl "180+2"]

1. e4 {[%clk 0:03:01.5]} 1... e5 {[%clk 0:03:01]} 2. Bc4 {[%clk 0:03:00]} 2... Nc6 {[%clk 0:02:59]}
3. Qh5 {[%clk 0:02:58]} 3... Nf6 {[%clk 0:02:50]} 4. Qxf7# {[%clk 0:02:55]} 1-0`;

const game = makeGame({ chess_com_url: 'u', pgn: PGN, played_at: '2026-10-01T10:00:00', time_control: '180+2',
  my_color: 'white', opponent_username: 'them', result: 'win' });
// a tiny book: 1.e4 e5 2.Bc4 (three book positions)
const book = new Book([{ eco: 'C23', name: "Bishop's Opening", ucis: 'e2e4 e7e5 f1c4' }]);

class OrderEngine {
  seen: string[] = [];
  newGames = 0;
  async newGame() { this.newGames += 1; }
  async analyse(board: Board): Promise<InfoLine[]> {
    this.seen.push(epd(board.fen()));
    const best = board.legalMoves()[0];
    return [{ pv: [best], score: new PovScore(Score.cp(board.turn === 'white' ? 30 : -30), board.turn), depth: 14 }];
  }
}

describe('weakness analysis', () => {
  const parsed = parseGame(game, book)!;
  const [row, drafts] = parsed;

  it('stores one row per ply plus the start, each move leading to the next', () => {
    expect(drafts).toHaveLength(8);
    for (let p = 0; p < drafts.length - 1; p++) {
      const b = Board.fromFen(drafts[p].fen);
      b.push(drafts[p].move_uci!);
      expect(b.fen()).toBe(drafts[p + 1].fen);
    }
    expect(row.result).toBe(1);
    expect(row.opening_name).toBe("Bishop's Opening");
  });

  it('reads clocks with the increment included (F3)', () => {
    expect(drafts[0].clock_after_s).toBe(181.5);
    expect(row.clock_valid).toBe(1);
    expect(row.clock_coverage).toBe(1);
  });

  it('marks book moves by where they land (F2) and skips deep book positions', () => {
    expect(drafts.slice(0, 4).map((d) => d.is_book)).toEqual([1, 1, 1, 0]);   // 3...Nc6 leaves the book
    const keys = toSearch(drafts, new Set());
    expect(keys).not.toContain(drafts[1].key);         // book, and so is the next position
    expect(keys).toContain(drafts[3].key);             // the last book position: its move leaves the book
    expect(keys).not.toContain(drafts[7].key);         // checkmate: never searched
  });

  it('searches in game order on a fresh hash and scores the mate for White (F1)', async () => {
    const engine = new OrderEngine();
    const keys = toSearch(drafts, new Set());
    const evals = await searchGame(engine, keys);
    expect(engine.newGames).toBe(1);
    expect(engine.seen).toEqual(keys);
    const rows = fillEvaluations(drafts, evals);
    expect(rows[7]).toMatchObject({ terminal: 'checkmate', score_type: 'mate', cp_cap_white: 1000 });
    expect(rows[1].cp_cap_white).toBeNull();
    const g = new Game({ ...row }, rows);
    buildMoves(g);
    const mate = g.moves[6];
    expect(mate.wpl).toBe(0);
    expect(mate.cpl).toBeNull();
    expect(included(g.moves[0])).toBe(false);
  });

  it('refuses Chess960 and set-up positions (F4)', () => {
    const odd = makeGame({ ...game, pgn: `[Variant "Chess960"]\n[SetUp "1"]\n[FEN "${Board.fromFen().fen()}"]\n\n1. e4 e5 *` });
    expect(parseGame(odd, book)).toBeNull();
  });
});

describe('clockLabel', () => {
  it.each([['180+2', '3+2'], ['600', '10+0'], ['60+1', '1+1'], ['300', '5+0'], ['30', '½+0'], ['90+1', '1½+1'], ['15+0', '¼+0'],
    ['100+0', '1.7+0'], ['1/259200', '1/259200'], ['', '']])('%s → %s', (tc, label) => expect(clockLabel(tc)).toBe(label));
});
