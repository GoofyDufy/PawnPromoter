// Port of the prototype's b483c26 tests (Counterattack kind, relabelling,
// Lichess puzzles, tags), plus the pack loader that replaces the desktop's
// streaming download.
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as analyzer from '../src/core/analyzer';
import { Board, STARTING_FEN } from '../src/core/chess';
import * as db from '../src/core/db';
import * as lichess from '../src/core/lichessPuzzles';
import type { MoveEvaluation } from '../src/core/models';
import * as progression from '../src/core/progression';
import * as puzzleKind from '../src/core/puzzleKind';
import * as tags from '../src/core/puzzleTags';
import { openMemoryDb } from '../src/core/sqlite';

const freshConn = async () => db.initDb(await openMemoryDb());
const ev = (fen: string, move: string, best: string, before: number, after: number): MoveEvaluation => ({
  game_id: 'g1', ply: 0, fen_before: fen, move_uci: move, best_move_uci: best, cp_before: before, cp_after: after,
  depth: 14, second_move_uci: null, cp_second: null, third_move_uci: null, cp_third: null,
});

const LICHESS_CSV = `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1811,76,95,10282,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,
0000D,5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27,d3d6 f8d8 d6d8 f6d8,1529,74,96,37506,advantage endgame short,https://lichess.org/F8M8OS71#53,
0000H,r4rk1/pp3ppp/8/2bqp2b/3N4/P2Bn2P/1PPN1P2/R1BQ1RK1 w - - 1 15,d1h5 d5g2,1554,223,100,11,mate mateIn1 middlegame oneMove,https://lichess.org/EwHRkfas#29,French_Defense French_Defense_Tarrasch_Variation
`;

const download = (conn: any, low = 1000, high = 2000, count = 10, skip: Iterable<string> = []) =>
  lichess.download(low, high, count, new Set(skip), (b) => lichess.save(conn, b), () => false, lichess.csvRows(LICHESS_CSV));

describe('Counterattack vs Defensive', () => {
  it('hitting back is a counterattack, quiet is defensive', () => {
    // Black's queen on d5 is attacked by Nc3; the answer hits back or just steps away
    const board = Board.fromFen('4k3/8/8/3q4/8/2N5/8/4K3 b - - 0 1');
    expect(puzzleKind.answerKind(board, 'd5e5')).toBe('Counterattack');   // check
    expect(puzzleKind.answerKind(board, 'd5c4')).toBe('Counterattack');   // hits c3
    expect(puzzleKind.answerKind(board, 'd5d8')).toBe('Defensive');       // quiet
  });

  it('relabelling splits saved defensive puzzles', async () => {
    const conn = await freshConn();
    const fen = 'rnb1kbnr/ppp1pppp/8/3q4/8/2N5/PPPP1PPP/R1BQKBNR b KQkq - 1 3';
    const [a] = analyzer.puzzlesFromEvaluations([ev(fen, 'd5d4', 'd5e5', 0, -900)], 150);
    db.replacePuzzlesForGames(conn, ['g1'], [a]);
    puzzleKind.save(conn, a.id, new puzzleKind.Result(['d5e5'], 'Defensive'));
    expect(puzzleKind.relabelDefensive(conn)).toBe(1);
    expect(db.allPuzzles(conn)[0].kind).toBe('Counterattack');
  });
});

describe('Lichess puzzles', () => {
  it('parse plays the setup move', () => {
    const row = LICHESS_CSV.split('\n')[1].split(',');
    const p = lichess.parse(row)!;
    const board = Board.fromFen(row[1]);
    board.push('f2g3');
    expect(p.fen).toBe(board.fen());
    expect(p.setup_uci).toBe('f2g3');
    expect(p.solution_ucis).toBe('e6e7 b2b1 b3c1 b1c1 h6c1');
    expect(lichess.parse(['bad', 'not a fen', 'e2e4 e7e5', '1', '1', '1', '1', '', ''])).toBeNull();
  });

  it('import filters rating and quality, and skips existing ones', async () => {
    const conn = await freshConn();
    // 0000H has too few plays / too wide a rating deviation
    expect(await download(conn)).toBe(2);
    expect(lichess.count(conn)).toBe(2);
    expect(await download(conn, 1000, 2000, 10, lichess.ids(conn))).toBe(0);   // nothing new
    expect(await download(await freshConn(), 1600)).toBe(1);                    // only 00008 (1811)
  });

  it('kept apart from your puzzles, with type, kind and solution', async () => {
    const conn = await freshConn();
    await download(conn);
    const p = new Map(lichess.load(conn).map((q) => [q.id, q])).get('00008')!;
    expect([p.puzzle_type, p.kind, p.solution_moves, p.correct_move_uci]).toEqual(['Hanging Piece', 'Attacking', 3, 'e6e7']);
    expect(db.allPuzzles(conn)).toEqual([]);                                     // not among your games' puzzles
    db.recordAttempt(conn, lichess.ITEM_TYPE, p.id, true, 'correct');
    expect(progression.totalXp(conn)).toBe(progression.PUZZLE_XP.correct);
    expect(db.puzzleRecords(conn).size).toBe(0);
    expect(db.puzzleRecords(conn, lichess.ITEM_TYPE).get('00008')!.correct).toBe(1);
    lichess.removeAll(conn);
    expect(lichess.count(conn)).toBe(0);
  });

  it('tags: motifs first, and yours survive a rebuild', async () => {
    const conn = await freshConn();
    await download(conn);
    const p = new Map(lichess.load(conn).map((q) => [q.id, q])).get('00008')!;
    expect(tags.autoTags(p, false, false)).toEqual(['Attacking', 'Hanging piece', 'Crushing', '3 moves', 'Middlegame']);
    const [own] = analyzer.puzzlesFromEvaluations([ev(STARTING_FEN, 'e2e4', 'd2d4', 30, -200)], 150);
    db.replacePuzzlesForGames(conn, ['g1'], [own]);
    tags.add(conn, own, '  Opening   trap ');
    const [rebuilt] = analyzer.puzzlesFromEvaluations([ev(STARTING_FEN, 'e2e4', 'd2d4', 30, -200)], 150);
    expect(rebuilt.id).not.toBe(own.id);                                         // new id, same position
    expect(tags.userTags(conn, rebuilt)).toEqual(['Opening trap']);
    expect(tags.allUserTags(conn)).toEqual(new Map([['Opening trap', new Set([tags.key(own)])]]));
    tags.remove(conn, rebuilt, 'Opening trap');
    expect(tags.userTags(conn, own)).toEqual([]);
  });

  it('small helpers: theme names, default range, CSV quoting', () => {
    expect(lichess.niceThemes('crushing hangingPiece long')).toBe('crushing, hanging piece, long');
    expect(tags.themeName('xRayAttack')).toBe('X-ray attack');
    expect(tags.themeName('discoveredAttack')).toBe('Discovered attack');
    expect(lichess.defaultRange(null)).toEqual([1200, 1800]);
    expect(lichess.defaultRange(400)).toEqual([400, 900]);
    expect(lichess.parseCsv('a,"b,c","d ""e"""\r\nf,,g\n')).toEqual([['a', 'b,c', 'd "e"'], ['f', '', 'g']]);
  });
});

describe('Lichess puzzle packs', () => {
  it("merges the range's packs by id, so the first good ones match the file's order", async () => {
    const header = LICHESS_CSV.split('\n')[0];
    const [r8, rD, rH] = LICHESS_CSV.trim().split('\n').slice(1);
    const files: Record<string, Uint8Array> = {
      'puzzles-1500.csv.gz': gzipSync(`${header}\n${rD}\n${rH}\n`),
      'puzzles-1800.csv.gz': gzipSync(`${header}\n${r8}\n`),
    };
    const manifest = { built: '2026-10-15', band: 100, per_band: 3000, packs: [
      { band: 1500, file: 'puzzles-1500.csv.gz', count: 2 }, { band: 1800, file: 'puzzles-1800.csv.gz', count: 1 },
    ] };
    const requested: string[] = [];
    const fakeFetch = (async (url: string) => {
      const name = url.split('/').pop()!;
      requested.push(name);
      return name === 'manifest.json' ? Response.json(manifest) : new Response(files[name] as unknown as BodyInit);
    }) as typeof fetch;

    const rows = await lichess.packRows(1000, 2000, '/lichess', fakeFetch);
    expect(rows.map((r) => r[0])).toEqual(['00008', '0000D', '0000H']);         // by id, across packs
    const conn = await freshConn();
    expect(await lichess.download(1000, 2000, 10, new Set(), (b) => lichess.save(conn, b), () => false, rows)).toBe(2);

    requested.length = 0;
    await lichess.packRows(1500, 1599, '/lichess/', fakeFetch);
    expect(requested).toEqual(['manifest.json', 'puzzles-1500.csv.gz']);         // only the packs it needs
  });
});
