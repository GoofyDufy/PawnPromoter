// Port of the prototype's tests for Lichess's tactic bar, What's the threat?,
// amazing moves / missed sacrifices, Sacrifice!!, "real alternatives" and the
// shared engine (67e3b53).
import { describe, expect, it } from 'vitest';
import * as amazing from '../src/core/amazing';
import * as analyzer from '../src/core/analyzer';
import { Board, STARTING_FEN } from '../src/core/chess';
import * as db from '../src/core/db';
import type { Engine, InfoLine } from '../src/core/engine';
import { PovScore, Score } from '../src/core/engine';
import { Idea, worthShowing } from '../src/core/engineIdeas';
import { NoStockfish, SharedEngine } from '../src/core/engineService';
import type { MoveEvaluation } from '../src/core/models';
import * as progression from '../src/core/progression';
import * as puzzleKind from '../src/core/puzzleKind';
import * as sac from '../src/core/sac';
import * as spot from '../src/core/spot';
import { openMemoryDb } from '../src/core/sqlite';
import * as threat from '../src/core/threat';
import { FakeEngine, TurnEngine } from './fakeEngine';

const START = STARTING_FEN;
const freshConn = async () => db.initDb(await openMemoryDb());
const HANGING = 'rnb1kbnr/ppp1pppp/8/3q4/8/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 3';
const passedKey = (fen: string) => { const b = Board.fromFen(fen); b.pushNull(); return b.boardFen(); };

describe("Lichess's tactic bar", () => {
  it('+2 or better, and only one first move', async () => {
    expect(spot.winsByForce(9, 1, 900, null)).toBe(true);          // only one line: an only move
    expect(spot.winsByForce(1, 1, 150, -300)).toBe(false);         // not +2
    expect(spot.winsByForce(3, 1, 400, 250)).toBe(false);          // 2nd best wins too
    expect(spot.winsByForce(3, 1, 400, -100)).toBe(true);
    expect(analyzer.winChances(0)).toBeCloseTo(0.0);
    // Nxd5 wins the queen, but if another move is nearly as good it isn't a tactic
    const board = Board.fromFen(HANGING);
    const two = new FakeEngine({ [board.boardFen()]: [[['c3d5', 'c7c6', 'd5c3'], 900], [['f1b5', 'c7c6', 'b5e2'], 700]],
      [passedKey(HANGING)]: [[[], 900]] });
    expect((await puzzleKind.classify(two, HANGING, 'c3d5')).kind).not.toBe('Attacking');
  });
});

describe("What's the threat?", () => {
  // White to move; ...Bxc3 would win the knight
  const FEN = 'rnbqk1nr/pppp1ppp/8/4p3/1b2P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 3';
  const key = (b: Board) => b.fen().split(' ').slice(0, 2).join(' ');
  const engine = (gain: number) => {
    const board = Board.fromFen(FEN);
    // you: +0.2 with Nf3; if you passed, their best move gains them `gain`
    return new TurnEngine({ [key(board)]: [[['g1f3'], 20]], [key(threat.passed(board))]: [[['b4c3'], gain - 20], [['g8f6'], 0]] });
  };

  it('a real threat and a calm position', async () => {
    const board = Board.fromFen(FEN);
    const a = (await threat.assess(engine(300), board))!;
    expect(a.has_threat).toBe(true);
    expect(a.threats[0].move).toBe('b4c3');
    expect(threat.describe(board, a.threats[0])).toContain('taking your knight');
    expect((await threat.assess(engine(30), board))!.has_threat).toBe(false);
    expect(await threat.assess(engine(100), board)).toBeNull();             // a small threat: not used
  });

  it('scored and counted', async () => {
    const conn = await freshConn();
    threat.record(conn, FEN, true, true, false);
    threat.record(conn, FEN, false, true, true);
    const s = threat.summary(conn);
    expect([s.rounds, s.found, s.calm_right, s.answers_ok]).toEqual([2, 1, 1, 1]);
    expect(threat.xp(conn)).toBe(2 * threat.FOUND_XP + threat.ANSWER_XP);
    expect(progression.totalXp(conn)).toBe(threat.xp(conn));
  });
});

describe('amazing moves and missed sacrifices', () => {
  // Greek gift: Bxh7+ takes a pawn and gives the bishop (the king can take it): 3 - 1
  const GREEK = 'r1bq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R2QK2R w KQ - 0 8';

  it('a piece offered soundly is amazing', () => {
    expect(amazing.offered(Board.fromFen(GREEK), 'd3h7')).toBe(2);
    expect(amazing.isAmazing(GREEK, 'd3h7', 120, 110)).toBe(2);
    expect(amazing.isAmazing(GREEK, 'd3h7', 120, -200)).toBe(0);     // it doesn't work: not amazing
    expect(amazing.isAmazing(GREEK, 'd3h7', 700, 690)).toBe(0);      // already winning big
    expect(amazing.isAmazing(GREEK, 'a2a3', 120, 110)).toBe(0);      // nothing offered
  });

  it('a missed sacrifice becomes a puzzle', () => {
    // best was Bxh7+ (a sacrifice, +1.2); you castled instead (+0.2): missed, though under the blunder size
    expect(amazing.missedSacrifice(GREEK, 'e1g1', 'd3h7', 120, 20)).toBe(2);
    expect(amazing.missedSacrifice(GREEK, 'e1g1', 'd3h7', 120, 110)).toBe(0);   // about as good
    expect(amazing.missedSacrifice(GREEK, 'e1g1', 'd3h7', 700, 300)).toBe(0);   // already winning
    const ev: MoveEvaluation = { game_id: 'g1', ply: 14, fen_before: GREEK, move_uci: 'e1g1', best_move_uci: 'd3h7',
      cp_before: 120, cp_after: 20, depth: 14, second_move_uci: null, cp_second: null, third_move_uci: null, cp_third: null };
    expect(analyzer.puzzlesFromEvaluations([ev], 150).map((p) => [p.puzzle_type, p.correct_move_san]))
      .toEqual([['Missed Sacrifice', 'Bxh7+']]);
  });

  it('a trade is no sacrifice', () => {
    // Bxf6: takes a knight, gets taken back — even
    expect(amazing.offered(Board.fromFen('rnbqkb1r/pppp1ppp/5n2/4p1B1/4P3/8/PPPP1PPP/RN1QKBNR w KQkq - 2 3'), 'g5f6')).toBe(0);
  });

  it('accuracy, the way Lichess combines it', () => {
    expect(Math.abs(amazing.moveAccuracy(30, 30) - 100)).toBeLessThan(0.5);
    expect(amazing.moveAccuracy(30, -400)).toBeLessThan(30);
    const good = [{ cp_before: 30, cp_after: 30 }, { cp_before: 20, cp_after: 15 }];
    expect(amazing.gameAccuracy(good)!).toBeGreaterThan(95);
    expect(amazing.gameAccuracy([...good, { cp_before: 20, cp_after: -600 }])!).toBeLessThan(60);   // the harmonic half punishes it
  });

  it('saved scan finds them once per game', async () => {
    const conn = await freshConn();
    db.saveGame(conn, { id: 'g', chess_com_url: 'u', pgn: '', played_at: '2026-10-01T10:00:00', time_control: '600',
      my_color: 'white', opponent_username: 'o', result: 'win', is_analyzed: true, analyzed_at: null, my_accuracy: null, opp_accuracy: null });
    db.saveGameEvaluations(conn, 'g', [
      { game_id: 'g', ply: 14, fen_before: GREEK, move_uci: 'd3h7', best_move_uci: 'd3h7', cp_before: 120, cp_after: 110, depth: 14,
        second_move_uci: null, cp_second: null, third_move_uci: null, cp_third: null },
    ]);
    expect(amazing.findAll(conn).map((a) => [a.san, a.offered])).toEqual([['Bxh7+', 2]]);
    expect(conn.get('SELECT COUNT(*) AS n FROM sac_scanned')!.n).toBe(1);
    expect(amazing.findAll(conn).length).toBe(1);                     // from the saved scan
    expect(amazing.findMissed(conn)).toEqual([]);
  });
});

describe('Sacrifice!!', () => {
  it('only sacrifices that work, and scoring', async () => {
    const a = (cpAfter: number, gid: string): amazing.Amazing => ({ game_id: gid, ply: 20, san: 'Bxh7+', offered: 2,
      cp_before: 100, cp_after: cpAfter, fen: START, uci: 'e2e4' });
    const cands = sac.ownCandidates([a(50, 'g1'), a(-200, 'g2')]);
    expect(cands.map((c) => c.game_id)).toEqual(['g1']);               // you're worse after g2's: left out
    const conn = await freshConn();
    sac.record(conn, cands[0], 3, 0);
    sac.record(conn, cands[0], 3, 2);
    expect(sac.summary(conn)).toEqual([2, 1]);
    expect(sac.xp(conn)).toBe(sac.CLEAN_XP + sac.DONE_XP);
    expect(progression.totalXp(conn)).toBe(sac.xp(conn));
    expect(sac.seen(conn).has(cands[0].key)).toBe(true);
  });

  it('judging your follow-up', async () => {
    const board = Board.fromFen();
    const s = new sac.Step(false, '', 'e2e4', 80);
    expect(await sac.judge(null, board, 'e2e4', s)).toEqual([true, 80]);
    let after = board.copy(); after.push('d2d4');
    const close = new FakeEngine({ [after.boardFen()]: [[['d7d5'], -70]] });   // their view: you're +0.7
    expect((await sac.judge(close, board, 'd2d4', s))[0]).toBe(true);
    after = board.copy(); after.push('a2a3');
    const poor = new FakeEngine({ [after.boardFen()]: [[['e7e5'], 150]] });    // you're −1.5: lets them off the hook
    expect((await sac.judge(poor, board, 'a2a3', s))[0]).toBe(false);
  });
});

describe('analysis lines worth showing', () => {
  it('only real alternatives are shown', () => {
    const ideas = (...cps: number[]) => cps.map((cp) => new Idea('e2e4', ['e2e4'], cp, null));
    const cps = (shown: Idea[]) => shown.map((i) => i.cp_white);
    expect(cps(worthShowing(ideas(150, 90, -100), 'white'))).toEqual([150, 90]);             // 3rd loses
    expect(cps(worthShowing(ideas(350, 120, 60), 'white'))).toEqual([350, 120, 60]);         // within 3
    expect(cps(worthShowing(ideas(450, 120), 'white'))).toEqual([450]);                      // 3.3 behind
    expect(cps(worthShowing(ideas(500, 150, 210), 'white'))).toEqual([500, 210]);            // 3.5 behind
    expect(cps(worthShowing(ideas(-120, -40, 60), 'black'))).toEqual([-120, -40]);           // Black's view
    expect(cps(worthShowing(ideas(-50, -200, -320), 'white'))).toEqual([-50, -200, -320]);   // all bad, close
    expect(cps(worthShowing(ideas(0, -80), 'white'))).toEqual([0, -80]);                     // equal best
    expect(cps(worthShowing(ideas(100_000, 400), 'white'))).toEqual([100_000]);              // mate vs not
  });
});

describe('the shared engine', () => {
  it('starts once, runs one search at a time, and survives a failed search', async () => {
    let started = 0;
    let running = 0;
    let maxRunning = 0;
    const calls: number[] = [];
    const real: Engine = {
      async analyse(_board, limit): Promise<InfoLine[]> {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        if (limit.depth === 99) throw new Error('engine crashed');
        calls.push(limit.depth!);
        return [{ pv: ['e2e4'], score: new PovScore(Score.cp(limit.depth!), 'white') }];
      },
    };
    const shared = new SharedEngine(async () => { started += 1; return real; });
    const board = Board.fromFen();
    const results = await Promise.allSettled([1, 2, 99, 3].map((d) => shared.analyse(board, { depth: d })));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
    expect(calls).toEqual([1, 2, 3]);                // in order, never two at once
    expect(maxRunning).toBe(1);
    expect(started).toBe(2);                          // restarted after the crash
    shared.shutdown();
    await expect(shared.analyse(board, { depth: 4 })).rejects.toBeInstanceOf(NoStockfish);
  });

  it('restart: lets queued searches finish, closes the engine, starts a new one', async () => {
    const quits: number[] = [];
    let started = 0;
    const make = (n: number): Engine & { quit(): void } => ({
      async analyse(_b, limit) {
        await new Promise((r) => setTimeout(r, 5));
        return [{ pv: ['e2e4'], score: new PovScore(Score.cp(n * 100 + limit.depth!), 'white') }];
      },
      quit: () => quits.push(n),
    });
    const shared = new SharedEngine(async () => make(++started));
    const board = Board.fromFen();
    const first = shared.analyse(board, { depth: 1 });
    shared.restart();
    const second = shared.analyse(board, { depth: 2 });
    expect((await first)[0].score.relative.score()).toBe(101);   // the old engine finished its search
    expect((await second)[0].score.relative.score()).toBe(202);  // then the new one took over
    expect(quits).toEqual([1]);
  });
});
