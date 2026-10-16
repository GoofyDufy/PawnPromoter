// Port of the prototype's repertoire / Lichess explorer tests (test_core.py),
// plus tests for the network clients, profiles and engine ideas with fakes.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as chessCom from '../src/core/chessCom';
import * as db from '../src/core/db';
import { IdeasEngine, Idea, lineText } from '../src/core/engineIdeas';
import * as explorer from '../src/core/explorer';
import { makeGame } from '../src/core/models';
import { importPgnText } from '../src/core/openingImporter';
import { notesFor } from '../src/core/openingNotes';
import { type ProfileStorage, Profiles, type Registry } from '../src/core/profiles';
import * as gaps from '../src/core/repertoireGaps';
import { scoutLines } from '../src/core/scouting';
import { openMemoryDb } from '../src/core/sqlite';
import { FakeEngine } from './fakeEngine';

const freshConn = async () => db.initDb(await openMemoryDb());

const QG_PGN = `[Event "QG - Orthodox"]

1. d4 d5 2. c4 e6 3. Nc3 {note on Nc3} Nf6 *

[Event "QG - Slav"]

1. d4 d5 2. c4 c6 3. Nf3 Nf6 *
`;

const BLACK_REP = `[Event "Sicilian"]

1. e4 c5 2. Nf3 d6 *

[Event "QGD"]

1. d4 d5 2. c4 e6 *
`;

describe('opening import', () => {
  it('re-import updates notes without duplicates', async () => {
    const conn = await freshConn();
    importPgnText(QG_PGN, 'QG', 'white', conn);
    const before = conn.get('SELECT COUNT(*) AS n FROM opening_lines')!.n;
    const added = importPgnText(QG_PGN.replace('note on Nc3', 'new note'), 'QG', 'white', conn);
    expect([added, conn.get('SELECT COUNT(*) AS n FROM opening_lines')!.n]).toEqual([0, before]);
    expect(conn.get("SELECT notes FROM opening_lines WHERE move_uci='b1c3'")!.notes).toBe('new note');
  });

  it('variations become branches; comments become notes; illegal moves end the line', async () => {
    const conn = await freshConn();
    const added = importPgnText('[Event "V"]\n\n1. e4 e5 (1... c5 {the Sicilian} 2. Nf3) 2. Nf3 Ke3 3. Bc4 *\n', 'V', 'white', conn);
    expect(added).toBe(5);       // e4 e5 c5 Nf3(after c5) Nf3(after e5); Ke3 is illegal, so Bc4 is dropped
    expect(conn.get("SELECT notes FROM opening_lines WHERE move_san = 'c5'")!.notes).toBe('the Sicilian');
    const ends = conn.all('SELECT move_san FROM opening_lines WHERE is_line_end = 1 ORDER BY move_san').map((r) => r.move_san);
    expect(ends).toEqual(['Nf3', 'Nf3']);
  });
});

describe('repertoire gaps', () => {
  const addGame = (conn: any, moves: string, url: string) => db.saveGame(conn, makeGame({
    chess_com_url: url, pgn: `[Event "x"]\n[WhiteElo "1650"]\n\n${moves} *\n`, played_at: '2026-09-01T00:00:00',
    time_control: '900+10', my_color: 'white', opponent_username: 'opp', result: 'win',
  }));

  it("an opponent's deviation is a gap", async () => {
    const conn = await freshConn();
    importPgnText(QG_PGN, 'QG', 'white', conn);
    for (let i = 0; i < 3; i++) addGame(conn, '1. d4 Nf6 2. c4 e6', `a${i}`);
    const gap = gaps.compute(conn).gaps[0];
    expect([gap.prefix, gap.move, gap.by_opponent, gap.record.games]).toEqual([['d4'], 'Nf6', true, 3]);
  });

  it('a game inside the repertoire has no early gap', async () => {
    const conn = await freshConn();
    importPgnText(QG_PGN, 'QG', 'white', conn);
    for (let i = 0; i < 2; i++) addGame(conn, '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5', `b${i}`);
    expect(gaps.compute(conn).gaps.every((g) => g.prefix.length >= 6)).toBe(true);
  });

  it('gaps before the opening starts are marked', () => {
    const list = [new gaps.PopularGap('white', ['d4'], 'Nf6', 0.5, 1, 100, 0.5),
      new gaps.PopularGap('white', ['d4', 'd5', 'c4'], 'dxc4', 0.2, 0.5, 100, 0.5)];
    gaps.markInside(list, { white: [['d2d4', 'd7d5', 'c2c4']] });
    expect(list.map((g) => g.inside)).toEqual([false, true]);
  });

  it('gap PGN adds the suggested reply', () => {
    const g = new gaps.Gap('white', ['d4'], 'Nf6', true);
    expect(gaps.gapPgn(g, 'X')).toBeNull();
    g.suggestion = 'c4';
    expect(gaps.gapPgn(g, 'QG')).toBe('[Event "QG"]\n\n1. d4 Nf6 2. c4 *\n');
  });
});

function keyAfter(...sans: string[]): string {
  const b = Board.fromFen();
  for (const s of sans) b.pushSan(s);
  return gaps.positionKey(b.fen());
}

function fakeStats(table: Record<string, Record<string, number>>): gaps.StatsFor {
  return (fen) => {
    const moves = table[gaps.positionKey(fen)];
    if (!moves) return null;
    const ms = Object.entries(moves).map(([u, n]) => new explorer.MoveStat(u, u, n, Math.floor(n / 2), 0, n - Math.floor(n / 2)));
    return new explorer.PositionStats(Object.values(moves).reduce((a, b) => a + b, 0), ms);
  };
}

describe('Lichess explorer', () => {
  const table = () => ({
    [keyAfter()]: { e2e4: 700, d2d4: 250, c2c4: 50 },
    [keyAfter('e4', 'c5')]: { g1f3: 800, b1c3: 200 },
    [keyAfter('d4', 'd5')]: { c2c4: 900, g1f3: 100 },
  } as Record<string, Record<string, number>>);

  it('popular gaps are unanswered moves ranked by frequency', async () => {
    const conn = await freshConn();
    importPgnText(BLACK_REP, 'Black', 'black', conn);
    const found = gaps.popularGaps(conn, fakeStats(table()));
    // 1.c4 is only 5% (under the 8% bar); 2.Nc3 in the Sicilian and 2.Nf3 in the QGD are holes
    expect(found.map((g) => g.line)).toEqual(['1. e4 c5 2. Nc3', '1. d4 d5 2. Nf3']);
    expect(found[0].frequency).toBeCloseTo(0.7 * 0.2);
    expect(found.every((g) => g.color === 'black')).toBe(true);
  });

  it('line endings are not gaps', async () => {
    const conn = await freshConn();
    importPgnText(BLACK_REP, 'Black', 'black', conn);
    const t = table();
    t[keyAfter('e4', 'c5', 'Nf3', 'd6')] = { d2d4: 900, f1b5: 100 };
    const found = gaps.popularGaps(conn, fakeStats(t));
    expect(found.some((g) => g.prefix.slice(0, 4).join() === 'e4,c5,Nf3,d6')).toBe(false);
  });

  it('castling comes back in standard notation', () => {
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const s = explorer.parse({ white: 5, draws: 0, black: 5,
      moves: [{ uci: 'e1h1', san: 'O-O', white: 5, draws: 0, black: 5 }] }, fen);
    expect(s.moves[0].uci).toBe('e1g1');
    expect(s.share('e1g1')).toBe(1.0);
  });

  it('rating bands around your level', async () => {
    const conn = await freshConn();
    expect(explorer.ratingBands(conn)).toBe('1400,1600,1800');     // no games yet
    expect(explorer.describeBands('1600,1800')).toBe('rated 1600–2000');
  });

  it('downloads one position at a time, waits out a rate limit, and caches answers', async () => {
    const conn = await freshConn();
    const calls: string[] = [];
    let first = true;
    const fakeFetch = (async (url: string, init: any) => {
      calls.push(new URL(url).searchParams.get('fen')!);
      expect(init.headers.Authorization).toBe('Bearer tok');
      if (first) { first = false; return new Response('', { status: 429 }); }
      return Response.json({ white: 1, draws: 0, black: 1, moves: [] });
    }) as typeof fetch;
    const waits: number[] = [];
    const fens = [Board.fromFen().fen(), Board.fromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1').fen()];
    const [fetched, error] = await explorer.warm('tok', fens, '1600', (fen, data) => explorer.save(conn, fen, '1600', data),
      () => false, { fetchImpl: fakeFetch, sleep: async (s) => { waits.push(s); } });
    expect([fetched, error]).toEqual([2, null]);
    expect(waits).toEqual([explorer.RATE_LIMIT_WAIT_S, explorer.REQUEST_GAP_S, explorer.REQUEST_GAP_S]);
    expect(calls.length).toBe(3);
    expect(explorer.cached(conn, fens[0], '1600')!.games).toBe(2);
    expect(explorer.missing(conn, [...fens, fens[0]], '1600')).toEqual([]);
  });

  it('a bad token stops the download with a message', async () => {
    const fakeFetch = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const [fetched, error] = await explorer.warm('bad', [Board.fromFen().fen()], '1600', () => {}, () => false,
      { fetchImpl: fakeFetch, sleep: async () => {} });
    expect([fetched, error]).toEqual([0, "Lichess didn't accept the saved token."]);
  });
});

describe('chess.com client', () => {
  it('reads your games from your point of view', async () => {
    const month = {
      games: [
        { url: 'u1', pgn: '1. e4 *', end_time: 1760000000, time_control: '600',
          white: { username: 'GoofyDufy', result: 'win' }, black: { username: 'opp', result: 'resigned' } },
        { url: 'u2', pgn: '1. d4 *', end_time: 1760003600, time_control: '180+2',
          white: { username: 'opp2', result: 'win' }, black: { username: 'goofydufy', result: 'timeout' } },
        { url: 'u3', end_time: 1760007200, white: { username: 'x' }, black: { username: 'y' } },   // no PGN: skipped
      ],
    };
    const fakeFetch = (async (url: string) => Response.json(url.endsWith('/archives')
      ? { archives: ['https://api.chess.com/pub/player/goofydufy/games/2026/09', 'https://api.chess.com/pub/player/goofydufy/games/2026/10'] }
      : month)) as typeof fetch;
    const progress: number[][] = [];
    const games = await chessCom.fetchAllGames('GoofyDufy', 1, (d, t) => progress.push([d, t]), fakeFetch);
    expect(progress).toEqual([[1, 1]]);
    expect(games.map((g) => [g.chess_com_url, g.my_color, g.opponent_username, g.result, g.time_control]))
      .toEqual([['u1', 'white', 'opp', 'win', '600'], ['u2', 'black', 'opp2', 'loss', '180+2']]);
    expect(games[0].played_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);    // Python-style local time
  });
});

describe('scouting', () => {
  it("marks the opponent's lines your repertoire covers", async () => {
    const conn = await freshConn();
    importPgnText(BLACK_REP, 'Black', 'black', conn);
    const game = (url: string, moves: string) => makeGame({ chess_com_url: url, pgn: `[Event "x"]\n\n${moves} *`,
      played_at: '2026-09-01T00:00:00', time_control: '600', my_color: 'white', opponent_username: 'me', result: 'win' });
    const report = scoutLines(conn, [game('a', '1. e4 c5 2. Nf3 d6 3. d4 cxd4'), game('b', '1. e4 c5 2. Nf3 d6 3. d4 cxd4'),
      game('c', '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6'), game('d', '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6')]);
    expect(report.games).toBe(4);
    expect(report.white.map((l) => [l.line, l.covered_by_your_repertoire]))
      .toEqual([['1. e4 c5 2. Nf3 d6 3. d4 cxd4', false], ['1. e4 e5 2. Nf3 Nc6 3. Bb5 a6', false]]);
  });
});

describe('opening notes', () => {
  it('more specific families win', () => {
    expect(notesFor('Queens Gambit - Semi-Slav Defense')?.title).toBe('Semi-Slav Defense');
    expect(notesFor(null, 'Queen’s Gambit Accepted')?.title).toBe("Queen's Gambit Accepted");
    expect(notesFor('My random line')).toBeNull();
  });
});

describe('profiles', () => {
  const memoryStorage = (legacy = '', files: string[] = []) => {
    const s = { data: null as Registry | null };
    const storage: ProfileStorage = {
      load: () => (s.data ? structuredClone(s.data) : null),
      save: (d) => { s.data = structuredClone(d); },
      dbExists: (f) => files.includes(f),
      legacyUsername: () => legacy,
    };
    return { storage, s };
  };

  it('the original database becomes the first profile, named after its chess.com user', () => {
    const p = new Profiles(memoryStorage('GoofyDufy').storage);
    expect([p.list(), p.current(), p.dbFile('GoofyDufy')]).toEqual([['GoofyDufy'], 'GoofyDufy', 'chessprep.db']);
  });

  it('each new player gets their own database file', () => {
    const p = new Profiles(memoryStorage('', ['chessprep_anna.db']).storage);
    expect(p.add('  Anna ')).toBe('Anna');
    expect(p.dbFile('Anna')).toBe('chessprep_anna_2.db');     // chessprep_anna.db already exists
    expect(() => p.add('anna')).toThrow("A player called 'anna' already exists.");
    expect(() => p.add('  ')).toThrow('Enter a name.');
    expect(p.dbFile(p.add('Dé Dé!'))).toBe('chessprep_d_d.db');
    p.setCurrent('Anna');
    expect(p.current()).toBe('Anna');
    p.setCurrent('nobody');
    expect(p.current()).toBe('Anna');
  });
});

describe('engine ideas', () => {
  it('formats evaluations and lines', () => {
    expect(new Idea('e2e4', ['e2e4'], 35, null).evalText()).toBe('+0.35');
    expect(new Idea('e2e4', ['e2e4'], -125, null).evalText()).toBe('-1.25');
    expect(new Idea('e2e4', ['e2e4'], 10000, 3).evalText()).toBe('#3');
    expect(new Idea('e2e4', ['e2e4'], -10000, -2).evalText()).toBe('#-2');
    const b = Board.fromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(lineText(b, ['e7e5', 'g1f3', 'b8c6'])).toBe('1...e5 2.Nf3 Nc6');
  });

  it('works only on the newest position: quick answer, then deep', async () => {
    const start = Board.fromFen();
    const after = Board.fromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    const engine = new FakeEngine({
      [start.boardFen()]: [[['e2e4', 'e7e5'], 30], [['d2d4'], 25]],
      [after.boardFen()]: [[['e7e5'], -30], [['c7c5'], -40]],
    });
    const results: [string, number, string[]][] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const ideas = new IdeasEngine(engine, (fen, depth, list) => {
      results.push([fen, depth, list.map((i) => `${i.move} ${i.evalText()}`)]);
      if (fen === after.fen() && depth === 18) done();
    });
    ideas.analyse(start.fen());
    ideas.analyse(after.fen());          // queued before the first finished: start is dropped after its quick answer
    await finished;
    expect(results.at(-1)).toEqual([after.fen(), 18, ['e7e5 +0.30', 'c7c5 +0.40']]);
    expect(results.filter(([fen]) => fen === start.fen()).every(([, depth]) => depth === 12)).toBe(true);
  });
});
