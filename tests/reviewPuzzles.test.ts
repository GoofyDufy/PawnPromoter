// Game Review's additions: the wins / losses filter, which positions are
// puzzles, and making a puzzle from a position — kept when puzzles are rebuilt.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as db from '../src/core/db';
import { makeGame, type MoveEvaluation } from '../src/core/models';
import { openMemoryDb } from '../src/core/sqlite';
import { services } from '../src/data/services';

const PGN = `[Event "Live Chess"]
[White "me"]
[Black "them"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

function evals(gameId: string): MoveEvaluation[] {
  const b = Board.fromFen();
  const out: MoveEvaluation[] = [];
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'];
  moves.forEach((m, ply) => {
    if (ply % 2 === 0) {        // my moves (White): a fine one, then a 3-pawn blunder at ply 4
      out.push({ game_id: gameId, ply, fen_before: b.fen(), move_uci: m, best_move_uci: ply === 4 ? 'd2d4' : m,
        cp_before: 40, cp_after: ply === 4 ? -260 : 35, depth: 14, second_move_uci: null, cp_second: null, third_move_uci: null, cp_third: null });
    }
    b.push(m);
  });
  return out;
}

async function setup() {
  const conn = db.initDb(await openMemoryDb());
  const win = makeGame({ chess_com_url: 'https://www.chess.com/game/live/1', pgn: PGN, played_at: '2026-10-01T10:00:00',
    time_control: '600', my_color: 'white', opponent_username: 'them', result: 'win' });
  const loss = makeGame({ chess_com_url: 'https://www.chess.com/game/live/2', pgn: PGN, played_at: '2026-10-02T10:00:00',
    time_control: '600', my_color: 'white', opponent_username: 'other', result: 'loss' });
  for (const g of [win, loss]) {
    db.saveGame(conn, g);
    services.saveGameAnalysis(conn, g.id, evals(g.id), 150);
  }
  return { conn, win, loss };
}

describe('Game Review: results, puzzles', () => {
  it('filters the games by result', async () => {
    const { conn } = await setup();
    expect(services.reviewGames(conn, 'All games').length).toBe(2);
    expect(services.reviewGames(conn, 'All games', 'Wins').map((g) => g.label)).toEqual([expect.stringContaining('vs them')]);
    expect(services.reviewGames(conn, 'All games', 'Losses').map((g) => g.label)).toEqual([expect.stringContaining('vs other')]);
    expect(services.reviewGames(conn, 'All games', 'Draws')).toEqual([]);
  });

  it('flags the positions that are puzzles, makes one, keeps it through a rebuild, removes it', async () => {
    const { conn, win } = await setup();
    const game = services.reviewGame(conn, win.id)!;
    expect(Object.keys(game.puzzles)).toEqual(['4']);                 // the blunder became a puzzle
    expect(game.puzzles[4].pick).toBe(false);
    const made = services.makePick(conn, win.id, 2);
    expect(made.id).toMatch(/^pick-/);
    expect(made.puzzles[2]).toEqual({ id: made.id, pick: true, type: 'Self made' });
    expect(services.makePick(conn, win.id, 2).id).toBe(made.id);      // once
    services.regeneratePuzzles(conn, 150);                             // Apply blunder size
    expect(Object.keys(services.reviewGame(conn, win.id)!.puzzles).sort()).toEqual(['2', '4']);
    const queue = services.puzzleQueue(conn, { source: 'My games', type: 'All types', kind: 'All kinds', position: 'All positions', focus: 'All games' });
    expect(queue.queue.some((p) => p.id === made.id && p.puzzle_type === 'Self made')).toBe(true);
    services.removePick(conn, made.id);
    expect(Object.keys(services.reviewGame(conn, win.id)!.puzzles)).toEqual(['4']);
  });

  it('a puzzle made with tags is found by its tags; old "Your pick" puzzles become "Self made"', async () => {
    const { conn, win } = await setup();
    const made = services.makePick(conn, win.id, 2, ['Opening', 'Attacking']);
    const byTag = services.puzzleQueue(conn, { source: 'My games', type: 'Tag: Opening', kind: 'All kinds', position: 'All positions', focus: 'All games' });
    expect(byTag.queue.map((p) => p.id)).toEqual([made.id]);
    expect(services.pickTagOptions(conn).slice(0, 3)).toEqual(['Opening', 'Middlegame', 'Endgame']);
    conn.run("UPDATE puzzles SET puzzle_type = 'Your pick' WHERE id = ?", [made.id]);
    services.upgradePuzzles(conn);
    expect(conn.get('SELECT puzzle_type FROM puzzles WHERE id = ?', [made.id])!.puzzle_type).toBe('Self made');
    const types = services.puzzleQueue(conn, { source: 'My games', type: 'All types', kind: 'All kinds', position: 'All positions', focus: 'All games' }).typeOptions;
    expect(types).toContain('Self made');
  });

  it('notes on positions: saved, listed newest first, removed when empty, shown on a puzzle from there', async () => {
    const { conn, win, loss } = await setup();
    const game = services.reviewGame(conn, win.id)!;
    const fenAt4 = game.evals[4].fen_before;
    expect(services.saveNote(conn, win.id, 4, fenAt4, 'I rushed Bb5 here.')).toEqual({ 4: 'I rushed Bb5 here.' });
    services.saveNote(conn, loss.id, 0, Board.fromFen().fen(), 'Try 1.d4 next time');
    expect(services.reviewGame(conn, win.id)!.notes).toEqual({ 4: 'I rushed Bb5 here.' });
    const notes = services.allNotes(conn);
    expect(notes.map((n) => n.text).sort()).toEqual(['I rushed Bb5 here.', 'Try 1.d4 next time']);
    expect(notes.find((n) => n.ply === 4)!.label).toMatch(/vs them · after 2\.\.\.Nc6$/);
    // the blunder's puzzle (ply 4) shows the note
    const p = services.puzzleQueue(conn, { source: 'My games', type: 'All types', kind: 'All kinds', position: 'All positions', focus: 'All games' })
      .queue.find((q) => q.source_game_id === win.id && q.fen === fenAt4)!;
    expect(services.puzzleDetails(conn, p).note).toBe('I rushed Bb5 here.');
    services.saveNote(conn, win.id, 4, fenAt4, '   ');
    expect(services.reviewGame(conn, win.id)!.notes).toEqual({});
  });
});
