// Port of the prototype's drill and opening-tree tests (test_core.py:
// OpeningImportAndDrillTests, OpeningTreeTests, and the Lichess-weighted drill
// tests). Random picks use a seeded generator, as the Python tests seed random.
import { describe, expect, it } from 'vitest';
import { Board, parseSquare } from '../src/core/chess';
import * as db from '../src/core/db';
import { OpeningDrillSession, formatMoveList } from '../src/core/drill';
import * as explorer from '../src/core/explorer';
import { importPgnText } from '../src/core/openingImporter';
import * as tree from '../src/core/openingTree';
import * as gaps from '../src/core/repertoireGaps';
import { openMemoryDb } from '../src/core/sqlite';

/** mulberry32: a small seeded random generator for repeatable tests. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QG_PGN = `[Event "QG - Orthodox"]

1. d4 d5 2. c4 e6 3. Nc3 {note on Nc3} Nf6 *

[Event "QG - Slav"]

1. d4 d5 2. c4 c6 3. Nf3 Nf6 *
`;

const OTHER_PGN = `[Event "Other - QGD Exchange"]

1. d4 d5 2. c4 e6 3. cxd5 exd5 *
`;

const BLACK_REP = `[Event "Sicilian"]

1. e4 c5 2. Nf3 d6 *

[Event "QGD"]

1. d4 d5 2. c4 e6 *
`;

async function qgConn() {
  const conn = db.initDb(await openMemoryDb());
  importPgnText(QG_PGN, 'QG', 'white', conn);
  return conn;
}

describe('opening drill', () => {
  it('stays on the chosen line and is strict', async () => {
    const conn = await qgConn();
    const slav = db.rootLines(conn, 'QG', 'white').find((r) => r.line_name === 'QG - Slav')!;
    const s = new OpeningDrillSession(conn, 'QG', 'white');
    expect(s.start(slav.id)).toBe(true);
    expect(s.attemptMyMove('d2d4').correct).toBe(true);
    s.playOpponentMove();
    expect(s.attemptMyMove('c2c4').correct).toBe(true);
    expect(s.playOpponentMove()).toBe('c6');                 // never drifts onto the Orthodox line
    const wrong = s.attemptMyMove('b1c3');                   // book in the OTHER line, not this one
    expect(wrong.correct).toBe(false);
    expect(s.board.moveStack.length).toBe(4);                // nothing pushed on a miss
  });

  it('book elsewhere is informational, across separate imports', async () => {
    const conn = await qgConn();
    importPgnText(OTHER_PGN, 'QG', 'white', conn);
    const orthodox = db.rootLines(conn, 'QG', 'white').find((r) => r.line_name === 'QG - Orthodox')!;
    const s = new OpeningDrillSession(conn, 'QG', 'white');
    s.start(orthodox.id);
    for (const uci of ['d2d4', null, 'c2c4', null]) uci ? s.attemptMyMove(uci) : s.playOpponentMove();
    const result = s.attemptMyMove('c4d5');                  // the Exchange line's move
    expect(result.correct).toBe(false);
    expect(result.in_book).toBe(true);
  });

  it('restart replays the same line', async () => {
    const conn = await qgConn();
    const s = new OpeningDrillSession(conn, 'QG', 'white', null, seeded(7));
    s.start();
    const line = s.target_path.map((n) => n.id);
    while (!s.isFinished()) {
      s.revealAndAdvance();
      s.playOpponentMove();
    }
    s.restart();
    expect([s.target_path.map((n) => n.id), s.path_index, s.board.moveStack.length]).toEqual([line, 0, 0]);
  });

  it('move note after reveal', async () => {
    const conn = await qgConn();
    const orthodox = db.rootLines(conn, 'QG', 'white').find((r) => r.line_name === 'QG - Orthodox')!;
    const s = new OpeningDrillSession(conn, 'QG', 'white');
    s.start(orthodox.id);
    for (let i = 0; i < 2; i++) {
      s.revealAndAdvance();
      s.playOpponentMove();
    }
    expect(s.revealAndAdvance()).toBe('Nc3');
    expect(s.lastMoveNote()).toBe('note on Nc3');
    expect(formatMoveList(s.fullLineSan())).toBe('1. d4 d5 2. c4 e6 3. Nc3 Nf6');
  });
});

describe('drill weighted by real-world frequency', () => {
  const keyAfter = (...sans: string[]) => {
    const b = Board.fromFen();
    for (const s of sans) b.pushSan(s);
    return gaps.positionKey(b.fen());
  };
  const statsFor = (table: Record<string, Record<string, number>>) => (fen: string) => {
    const moves = table[gaps.positionKey(fen)];
    if (!moves) return null;
    const ms = Object.entries(moves).map(([u, n]) => new explorer.MoveStat(u, u, n, Math.floor(n / 2), 0, n - Math.floor(n / 2)));
    return new explorer.PositionStats(Object.values(moves).reduce((a, b) => a + b, 0), ms);
  };

  it('lines are picked as often as real players lead into them', async () => {
    const conn = db.initDb(await openMemoryDb());
    importPgnText(BLACK_REP, 'Black', 'black', conn);
    const stats = statsFor({
      [keyAfter()]: { e2e4: 700, d2d4: 250, c2c4: 50 },
      [keyAfter('e4', 'c5')]: { g1f3: 800, b1c3: 200 },
      [keyAfter('d4', 'd5')]: { c2c4: 900, g1f3: 100 },
    });
    const share = (fen: string, uci: string) => stats(fen)?.share(uci) ?? null;
    const random = seeded(1);
    const counts: Record<string, number> = { e4: 0, d4: 0 };
    for (let i = 0; i < 600; i++) {
      const s = new OpeningDrillSession(conn, 'Black', 'black', share, random);
      s.start();
      counts[s.target_path[0].move_san] += 1;
    }
    // only White's first move is a split: 1.e4 vs 1.d4 among the replies covered = .7/(.7+.25) ≈ 74% vs 26%
    expect(counts.e4).toBeGreaterThan(2 * counts.d4);
    expect(counts.d4).toBeGreaterThan(90);
  });

  it('long lines are not penalised for their length', async () => {
    const conn = db.initDb(await openMemoryDb());
    importPgnText('[Event "Short"]\n\n1. e4 c5 *\n\n[Event "Long"]\n\n1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7 5. Bg2 Be7 *\n',
      'Mix', 'black', conn);
    const random = seeded(3);
    const counts: Record<string, number> = { e4: 0, d4: 0 };
    for (let i = 0; i < 400; i++) {
      const s = new OpeningDrillSession(conn, 'Mix', 'black', () => 0.3, random);
      s.start();
      counts[s.target_path[0].move_san] += 1;
    }
    expect(Math.min(counts.e4, counts.d4)).toBeGreaterThan(150);   // about 50/50, not 99/1
  });

  it('no data falls back to uniform', async () => {
    const conn = db.initDb(await openMemoryDb());
    importPgnText(BLACK_REP, 'Black', 'black', conn);
    expect(new OpeningDrillSession(conn, 'Black', 'black', () => null).start()).toBe(true);
  });
});

describe('opening tree', () => {
  it('lines merge until they differ', async () => {
    const t = tree.build(await qgConn(), 'QG', 'white');
    expect(t.leaves.length).toBe(2);
    const trunk = t.branches.filter((b) => b.parent === null);
    expect(trunk.length).toBe(1);                                 // 1.d4 d5 2.c4 shared
    expect(trunk[0].nodes.map((n) => n.move!.move_san)).toEqual(['d4', 'd5', 'c4']);
    expect(trunk[0].children.map((c) => c.nodes[0].move!.move_san).sort()).toEqual(['c6', 'e6']);
    expect(trunk[0].lines).toBe(2);
  });

  it('layout puts leaves on top and knots over their leaves', async () => {
    const t = tree.layout(tree.build(await qgConn(), 'QG', 'white'), 400, 420);
    const leaves = t.branches.filter((b) => !b.children.length);
    expect(leaves.every((b) => b.end.y === tree.TOP)).toBe(true);
    const knot = t.branches.find((b) => b.parent === null)!.end;
    expect(knot.x).toBeCloseTo(leaves.reduce((s, b) => s + b.end.x, 0) / leaves.length);
    expect(t.root.y).toBeGreaterThan(knot.y);                     // grows upward from the root
    expect(t.nodeForPath(['d2d4', 'd7d5', 'c2c4', 'e7e6'])!.lines()[0][0]).toBe('QG - Orthodox');
  });

  it('the opening start defaults to the shared trunk and can move', async () => {
    const conn = await qgConn();
    const t = tree.build(conn, 'QG', 'white');
    const start = tree.startNode(conn, t, 'QG', 'white');
    expect(start.path.map((m) => m.move_san)).toEqual(['d4', 'd5', 'c4']);   // where both lines agree
    const early = t.nodeForPath(['d2d4'])!;
    expect(tree.isInside(early, start)).toBe(false);
    expect(tree.isInside(t.nodeForPath(['d2d4', 'd7d5', 'c2c4', 'e7e6']), start)).toBe(true);
    tree.setStart(conn, 'QG', 'white', early);                                // move it earlier
    expect(tree.startNode(conn, t, 'QG', 'white')).toBe(early);
    tree.setStart(conn, 'QG', 'white', null);                                 // back to the default
    expect(tree.startPath(conn, 'QG', 'white')).toEqual(['d2d4', 'd7d5', 'c2c4']);
  });

  it('all repertoires grow from their first moves, and focus hides the rest', async () => {
    const conn = await qgConn();
    importPgnText('[Event "E"]\n\n1. c4 e5 2. Nc3 *\n', 'English', 'white', conn);
    const t = tree.layout(tree.build(conn, null, 'white'), 400, 420);
    const firsts = Object.fromEntries(t.root.children.map((c) => [c.move!.move_san, c]));
    expect(new Set(Object.keys(firsts))).toEqual(new Set(['d4', 'c4']));
    // each first move sits on its own square of the mini board
    expect([firsts.d4.x, firsts.d4.y]).toEqual(t.board!.center(parseSquare('d4')!));
    expect(t.board!.ranks).toEqual([0, 1, 2, 3]);                             // ranks 1-4
    expect(t.hidden.size).toBe(0);
    tree.layout(t, 400, 420, firsts.d4);
    expect(t.hidden.size).toBeGreaterThan(0);                                 // the 1.c4 tree is hidden
    expect(t.firstMoveOf(t.nodeForPath(['d2d4', 'd7d5', 'c2c4']))).toBe(firsts.d4);
  });

  it('deleting a branch leaves no stub and keeps other lines', async () => {
    const conn = await qgConn();
    // a separately imported line that branches off the Slav at move 3
    importPgnText('[Event "QG - Slav 3.Nc3"]\n\n1. d4 d5 2. c4 c6 3. Nc3 *\n', 'QG', 'white', conn);
    const before = conn.get('SELECT COUNT(*) AS n FROM opening_lines')!.n;
    let t = tree.build(conn, 'QG', 'white');
    const node = t.nodeForPath(['d2d4', 'd7d5', 'c2c4', 'c7c6', 'b1c3'])!;
    const rows = node.lines().map(([, path]) => path[node.ply - 1].id);
    // the whole separately imported game goes (its first four moves were only a stub now)
    expect(db.deleteBranch(conn, rows)).toBe(5);
    expect(conn.get('SELECT COUNT(*) AS n FROM opening_lines')!.n).toBe(before - 5);
    t = tree.build(conn, 'QG', 'white');
    expect(t.leaves.map(([name]) => name).sort()).toEqual(['QG - Orthodox', 'QG - Slav']);
  });

  it('deleting inside a line shortens it', async () => {
    const conn = await qgConn();
    let t = tree.build(conn, 'QG', 'white');
    const node = t.nodeForPath(['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3'])!;      // 3.Nc3 in the Orthodox
    db.deleteBranch(conn, node.lines().map(([, path]) => path[node.ply - 1].id));
    t = tree.build(conn, 'QG', 'white');
    expect(t.nodeForPath(['d2d4', 'd7d5', 'c2c4', 'e7e6', 'b1c3'])).toBeNull();
    expect(t.nodeForPath(['d2d4', 'd7d5', 'c2c4', 'c7c6', 'g1f3', 'g8f6'])).not.toBeNull();   // Slav intact
  });

  it('many lines make the tree wider than the view', async () => {
    const conn = await qgConn();
    const pgn = ['e5', 'c5', 'e6', 'c6', 'd5', 'd6', 'Nf6', 'g6', 'b6', 'a6', 'Nc6', 'b5']
      .map((m, i) => `[Event "L${i}"]\n\n1. e4 ${m} *\n\n`).join('');
    importPgnText(pgn, 'Wide', 'white', conn);
    const t = tree.layout(tree.build(conn, 'Wide', 'white'), 300, 420);
    expect(t.leaves.length).toBe(12);
    expect(t.width).toBeGreaterThan(300);
  });
});
