// src/core/chess.ts must answer exactly like python-chess on real games.
// Fixtures: tools/golden_chess.py (built from your own games, so gitignored);
// the test is skipped when they haven't been generated.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLACK, Board, SQUARES, WHITE } from '../src/core/chess';
import { readGame } from '../src/core/pgn';

const FIXTURE = new URL('./golden/chess.json', import.meta.url);
const games = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : [];

const digest = (parts: string[]) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);

function facts(board: Board) {
  const attackers = SQUARES.flatMap((sq) => [WHITE, BLACK].map((c) => board.attackers(c, sq).sort((a, b) => a - b).join(',')));
  const attacks = SQUARES.map((sq) => board.attacks(sq).sort((a, b) => a - b).join(','));
  const mobility = [...board.pieceMap()].sort(([a], [b]) => a - b)
    .filter(([, p]) => p.role === 'bishop' || p.role === 'rook' || p.role === 'queen')
    .map(([sq]) => `${sq}:${board.sliderMobility(sq)}`).join(';');
  return {
    attackers: digest(attackers), attacks: digest(attacks), mobility,
    legal: board.legalMoves().sort(), check: board.isCheck(), mate: board.isCheckmate(), over: board.isGameOver(),
  };
}

describe.skipIf(games.length === 0)('chess.ts matches python-chess on real games', () => {
  it(`replays ${games.length} games position by position`, () => {
    let positions = 0;
    for (const g of games) {
      const parsed = readGame(g.pgn)!;
      expect(parsed.startFen).toBe(g.start);
      expect(parsed.mainline).toEqual(g.plies.map((p: any) => p.uci));
      const board = Board.fromFen(parsed.startFen, parsed.chess960);
      for (const p of g.plies) {
        const where = `${g.id} ${p.fen} ${p.uci}`;
        expect(board.fen(), where).toBe(p.fen);
        expect(facts(board), where).toEqual({
          attackers: p.attackers, attacks: p.attacks, mobility: p.mobility,
          legal: p.legal, check: p.check, mate: p.mate, over: p.over,
        });
        expect([board.san(p.uci), board.isCapture(p.uci), board.isEnPassant(p.uci), board.isCastling(p.uci),
          board.givesCheck(p.uci)], where).toEqual([p.san, p.capture, p.ep, p.castling, p.gives_check]);
        expect(board.parseSan(p.san), where).toBe(p.uci);
        board.push(p.uci);
        positions++;
      }
      expect(board.fen()).toBe(g.final_fen);
      expect(facts(board)).toEqual(g.final);
    }
    expect(positions).toBeGreaterThan(1000);
  });

  it('pop() restores the previous position', () => {
    const b = Board.fromFen();
    const fens = [b.fen()];
    for (const uci of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1']) { b.push(uci); fens.push(b.fen()); }
    for (let i = fens.length - 2; i >= 0; i--) { b.pop(); expect(b.fen()).toBe(fens[i]); }
  });
});
