// Puzzle Review's logic (puzzle_tab.py's attempt flow) without a screen:
// the controller over the real services on an in-memory database, Lichess
// puzzles (their solutions are known, so no engine is needed).
import { describe, expect, it } from 'vitest';
import * as db from '../src/core/db';
import * as lichess from '../src/core/lichessPuzzles';
import { openMemoryDb } from '../src/core/sqlite';
import type { DbClient } from '../src/data/client';
import { LICHESS, services } from '../src/data/services';
import { lineText, PuzzleController, REPLY_DELAY_MS } from '../src/ui/puzzleController';
import { Board } from '../src/core/chess';

const CSV = `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
0000D,5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27,d3d6 f8d8 d6d8 f6d8,1529,74,96,37506,advantage endgame short,https://lichess.org/F8M8OS71#53,
0000H,r4rk1/pp3ppp/8/2bqp2b/3N4/P2Bn2P/1PPN1P2/R1BQ1RK1 w - - 1 15,d1h5 d5g2,1554,73,100,5011,mate mateIn1 middlegame oneMove,https://lichess.org/EwHRkfas#29,French_Defense French_Defense_Tarrasch_Variation
`;

async function setup() {
  const conn = db.initDb(await openMemoryDb());
  await lichess.download(1000, 2000, 10, new Set(), (b) => lichess.save(conn, b), () => false, lichess.csvRows(CSV));
  services.setSettings(conn, { puzzle_source: LICHESS });
  const client = {
    service: async (name: keyof typeof services, ...args: unknown[]) => (services[name] as (...a: unknown[]) => unknown)(conn, ...args),
  } as unknown as DbClient;
  const levels: number[] = [];
  const c = new PuzzleController(client, null, (l) => levels.push(l.totalXp));
  await c.init();
  const at = async (rating: number) => {
    await c.loadAt(c.queue.findIndex((p) => p.rating === rating));
    return c.puzzle!;
  };
  return { c, at, levels };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Puzzle Review', () => {
  it('numbers a line from the puzzle position', () => {
    expect(lineText(['Rd8', 'Qxd8+', 'Bxd8'], Board.fromFen('3r2k1/1p3ppp/pq1Q1b2/8/8/1P3N2/P4PPP/3R2K1 b - - 3 27')))
      .toBe('27... Rd8 28. Qxd8+ Bxd8');
  });

  it('a multi-move Lichess puzzle: your move, the reply, your move', async () => {
    const { c, at, levels } = await setup();
    expect(c.queue.length).toBe(2);
    const p = await at(1529);
    expect(c.orientation).toBe('black');
    expect(c.status.text).toBe('Opponent played Qd6. Find the best move for Black.');
    expect(c.board.moveStack.at(-1)).toBe('d3d6');           // the set-up move is the last move shown
    await c.onMove('f8d8');
    expect(c.state).toBe('reply');
    expect(c.status.text).toBe('✓ Rd8 — keep going.');
    expect(c.records[p.id]).toEqual({ correct: 1, near_best: 0, missed: 0 });
    expect(levels.length).toBe(1);
    await sleep(REPLY_DELAY_MS + 50);
    expect(c.status.text).toBe('Opponent played Qxd8+. Your move.');
    await c.onMove('f6d8');
    expect(c.state).toBe('done');
    expect(c.status.text).toMatch(/^Correct — the whole line: 27\.\.\. Rd8 28\. Qxd8\+ Bxd8!( {2}Sharp position: \+\d+ XP bonus\.)?$/);
    expect(c.solvedIds.has(p.id)).toBe(true);
    expect(c.rowLabel(c.index)).toMatch(/^✓ /);
    // ◀ ▶ step through the line
    expect(c.lineVisible).toBe(true);
    c.stepLine(-3);
    expect(c.status.text).toBe('Main line (0/3): the puzzle position …');
    c.stepLine(1);
    expect(c.status.text).toBe('Main line (1/3): 27... Rd8 …');
    c.dispose();
  });

  it('a wrong move: retry never changes the saved first try; Show answer', async () => {
    const { c, at } = await setup();
    const p = await at(1554);
    await c.onMove('d5d4');
    expect(c.state).toBe('wrong');
    expect(c.status.text).toBe("Not quite — Qxd4 isn't the best move here.");
    expect(c.retryVisible).toBe(true);
    expect(c.records[p.id]).toEqual({ correct: 0, near_best: 0, missed: 1 });
    c.retry();
    expect(c.state).toBe('solving');
    expect(c.board.moveStack.at(-1)).toBe('d1h5');
    await c.onMove('d5g2');
    expect(c.state).toBe('done');
    expect(c.status.text).toBe('Correct — Qg2#!  (Found with retries — only a clean first run counts.)');
    expect(c.records[p.id]).toEqual({ correct: 0, near_best: 0, missed: 1 });
    expect(c.solvedIds.has(p.id)).toBe(false);
    await c.next();
    await c.reveal();
    expect(c.status.text).toMatch(/^The solution: |^The best move was /);
    expect(c.retryVisible).toBe(false);
    c.dispose();
  });

  it('tags: yours are added and removed, and show in the Type filter', async () => {
    const { c, at } = await setup();
    await at(1529);
    await c.setTag('  back   rank ', true);
    expect(c.details!.userTags).toEqual(['back rank']);
    expect(c.typeOptions).toContain('Tag: back rank');
    await c.setTag('back rank', false);
    expect(c.details!.userTags).toEqual([]);
    expect(c.typeOptions.some((t) => t.startsWith('Tag: '))).toBe(false);
    c.dispose();
  });
});
