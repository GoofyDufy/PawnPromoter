// Port of the prototype's tests/test_core.py (puzzles, weak spots, helpers,
// progression, Spot the Tactic). Each test uses a fresh in-memory database.
// No Stockfish needed: engine output is supplied directly or by FakeEngine.
import { describe, expect, it } from 'vitest';
import * as analyzer from '../src/core/analyzer';
import { Board, STARTING_FEN } from '../src/core/chess';
import * as db from '../src/core/db';
import { PovScore, Score } from '../src/core/engine';
import { pyFixed, pyPercent, pySigned } from '../src/core/format';
import { type MoveEvaluation, ReviewState, timeClass } from '../src/core/models';
import * as progression from '../src/core/progression';
import * as spot from '../src/core/spot';
import { openMemoryDb } from '../src/core/sqlite';
import { Record } from '../src/core/stats';
import { fromIso, isoformat } from '../src/core/time';
import { FakeEngine } from './fakeEngine';

const START = STARTING_FEN;

const freshConn = async () => db.initDb(await openMemoryDb());

function ev(ply: number, fen: string, move: string, best: string, before: number, after: number | null,
  second: number | null = null): MoveEvaluation {
  return {
    game_id: 'g1', ply, fen_before: fen, move_uci: move, best_move_uci: best, cp_before: before, cp_after: after,
    depth: 14, second_move_uci: null, cp_second: second, third_move_uci: null, cp_third: null,
  };
}

describe('puzzle generation', () => {
  it('threshold filters cached evaluations', () => {
    const evals = [ev(0, START, 'e2e4', 'd2d4', 30, -200)];     // 2.3-pawn swing
    expect(analyzer.puzzlesFromEvaluations(evals, 150)).toHaveLength(1);
    expect(analyzer.puzzlesFromEvaluations(evals, 300)).toHaveLength(0);
  });

  it('best move played is never a puzzle', () => {
    expect(analyzer.puzzlesFromEvaluations([ev(0, START, 'e2e4', 'e2e4', 30, -500)], 100)).toEqual([]);
  });

  it('decisive position skipped', () => {
    // cp_after null = second engine call skipped (already decisive)
    expect(analyzer.puzzlesFromEvaluations([ev(0, START, 'e2e4', 'd2d4', 800, null)], 100)).toEqual([]);
  });

  it('puzzle fields', () => {
    const [p] = analyzer.puzzlesFromEvaluations([ev(0, START, 'e2e4', 'd2d4', 30, -200)], 150);
    expect([p.correct_move_san, p.played_move_san, p.eval_swing_cp]).toEqual(['d4', 'e4', 230]);
  });

  it('evaluates a game move by move with the engine (decisive positions skip the 2nd call)', async () => {
    const pgn = '[Event "x"]\n\n1. e4 e5 2. Qh5 Nc6 *';
    const b = Board.fromFen();
    const fens: string[] = [];
    for (const uci of ['e2e4', 'e7e5', 'd1h5', 'b8c6']) { fens.push(b.boardFen()); b.push(uci); }
    const after = (i: number) => { const x = Board.fromFen(); for (const u of ['e2e4', 'e7e5', 'd1h5', 'b8c6'].slice(0, i)) x.push(u); return x.boardFen(); };
    const engine = new FakeEngine({
      [fens[0]]: [[['e2e4'], 30], [['d2d4'], 25], [['c2c4'], 20]],
      [after(1)]: [[['e7e5'], -30]],
      [fens[2]]: [[['g1f3'], 700], [['b1c3'], 650]],               // already decisive: no 2nd call
    });
    const game = { id: 'g', pgn, my_color: 'white' } as any;
    const evals = await analyzer.evaluateGame(game, engine);
    expect(evals.map((e) => [e.ply, e.move_uci, e.best_move_uci, e.cp_before, e.cp_after, e.second_move_uci, e.third_move_uci]))
      .toEqual([[0, 'e2e4', 'e2e4', 30, 30, 'd2d4', 'c2c4'], [2, 'd1h5', 'g1f3', 700, null, 'b1c3', null]]);
    expect(analyzer.countMyMoves(game)).toBe(2);
  });

  it('stops when asked, keeping nothing half-done', async () => {
    const game = { id: 'g', pgn: '1. e4 e5 *', my_color: 'white' } as any;
    await expect(analyzer.evaluateGame(game, new FakeEngine({}), undefined, () => true))
      .rejects.toBeInstanceOf(analyzer.AnalysisStopped);
  });
});

describe('weak spots', () => {
  it('weak until solved twice', async () => {
    const conn = await freshConn();
    db.recordAttempt(conn, 'puzzle', 'p1', false);
    expect(db.weakItemIds(conn, 'puzzle').has('p1')).toBe(true);
    db.recordAttempt(conn, 'puzzle', 'p1', true);
    expect(db.weakItemIds(conn, 'puzzle').has('p1')).toBe(true);       // one clean solve isn't enough
    db.recordAttempt(conn, 'puzzle', 'p1', true);
    expect(db.weakItemIds(conn, 'puzzle').has('p1')).toBe(false);
    db.recordAttempt(conn, 'puzzle', 'p2', true);
    expect(db.weakItemIds(conn, 'puzzle').has('p2')).toBe(false);      // never missed = never weak
  });
});

describe('small helpers', () => {
  it('time class buckets', () => {
    expect(['60', '180+2', '600', '900+10', '1/86400'].map(timeClass))
      .toEqual(['Bullet', 'Blitz', 'Rapid', 'Rapid', 'Daily']);
  });

  it('record score', () => {
    const r = new Record();
    for (const res of ['win', 'draw', 'loss', 'win']) r.add(res);
    expect(r.score).toBeCloseTo(0.625);
  });

  it('formats numbers like Python f-strings (ties round to even)', () => {
    expect(pyPercent(0.625)).toBe('62%');
    expect(pyPercent(0.635)).toBe('64%');      // 0.635 is just above the tie in binary
    expect(pySigned(1.25, 1)).toBe('+1.2');
    expect(pySigned(-0.05, 1)).toBe('-0.1');   // -0.05 is just below the tie in binary
    expect(pyFixed(-0.04, 1)).toBe('-0.0');
    expect(pyFixed(2.5, 0)).toBe('2');
    expect(pyFixed(3.5, 0)).toBe('4');
  });

  it('stores dates the way Python does (naive local ISO)', () => {
    expect(isoformat(new Date(2026, 9, 14, 21, 34, 1, 123))).toBe('2026-10-14T21:34:01.123000');
    expect(isoformat(new Date(2026, 9, 14, 9, 5, 0, 0))).toBe('2026-10-14T09:05:00');
    expect(fromIso('2026-10-14T21:34:01.123456').getMilliseconds()).toBe(123);
    expect(fromIso('2026-10-01').getDate()).toBe(1);
  });

  it('spaced repetition follows SM-2', () => {
    const rs = new ReviewState('p');
    const now = new Date(2026, 9, 1, 12, 0, 0);
    rs.record_attempt(5, now);
    expect([rs.interval_days, rs.repetitions, rs.due_date]).toEqual([1, 1, '2026-10-02T12:00:00']);
    rs.record_attempt(5, now);
    expect(rs.interval_days).toBe(6);
    rs.record_attempt(4, now);
    expect(rs.interval_days).toBe(Math.round(6 * 2.7));    // ease grew to 2.7 after two 5s
    rs.record_attempt(0, now);
    expect([rs.interval_days, rs.repetitions, rs.consecutive_wrong]).toEqual([1, 0, 1]);
  });
});

function addAttempt(conn: any, itemId: string, correct: boolean, outcome: string | null, when: string,
  itemType = 'puzzle', sharp = 0) {
  conn.run('INSERT INTO attempts (item_type, item_id, correct, attempted_at, outcome, sharp) VALUES (?, ?, ?, ?, ?, ?)',
    [itemType, itemId, correct ? 1 : 0, when, outcome, sharp]);
}

describe('progression', () => {
  it('level curve starts 10, 25, 100 then grows', () => {
    expect(progression.LEVEL_COSTS.slice(0, 3)).toEqual([10, 25, 100]);
    const later = progression.LEVEL_COSTS.slice(3);
    expect(later.every((b, i) => i === 0 || b > later[i - 1])).toBe(true);
    expect(progression.LEVEL_COSTS.length).toBe(progression.LEVEL_NAMES.length - 1);
  });

  it('level boundaries', () => {
    expect(progression.levelFor(0).name).toBe('Pawn I');
    expect(progression.levelFor(9).name).toBe('Pawn I');
    const lvl = progression.levelFor(10);
    expect([lvl.name, lvl.xp_into_level, lvl.xp_for_level]).toEqual(['Pawn II', 0, 25]);
    expect(progression.levelFor(35).name).toBe('Pawn III');
    const top = progression.levelFor(10 ** 6);
    expect([top.name, top.xp_for_level, top.progress]).toEqual(['King III', null, 1.0]);
  });

  it('XP by outcome', async () => {
    const conn = await freshConn();
    addAttempt(conn, 'a', true, 'correct', '2026-10-01T10:00:00');
    addAttempt(conn, 'b', false, 'near_best', '2026-10-01T10:01:00');
    addAttempt(conn, 'c', false, 'revealed', '2026-10-01T10:02:00');
    addAttempt(conn, 'd', false, null, '2026-10-01T10:03:00');        // old row: plain miss
    addAttempt(conn, 'L', true, null, '2026-10-01T10:04:00', 'line');
    expect(progression.totalXp(conn)).toBe(10 + 5 + 0 + 2 + 15);
  });

  it('sharp bonus only for correct', async () => {
    const conn = await freshConn();
    addAttempt(conn, 'a', true, 'correct', '2026-10-01T10:00:00', 'puzzle', 1);
    addAttempt(conn, 'b', false, 'near_best', '2026-10-01T10:01:00', 'puzzle', 1);
    addAttempt(conn, 'c', false, 'missed', '2026-10-01T10:02:00', 'puzzle', 1);
    expect(progression.totalXp(conn)).toBe(10 + progression.SHARP_BONUS_XP + 5 + 2);
  });

  it('same puzzle pays once per day', async () => {
    const conn = await freshConn();
    addAttempt(conn, 'a', true, 'correct', '2026-10-01T10:00:00');
    addAttempt(conn, 'a', true, 'correct', '2026-10-01T11:00:00');
    expect(progression.totalXp(conn)).toBe(10);
    addAttempt(conn, 'a', true, 'correct', '2026-10-02T09:00:00');
    expect(progression.totalXp(conn)).toBe(20);
  });

  it('clearing a weak spot pays a bonus', async () => {
    const conn = await freshConn();
    addAttempt(conn, 'a', false, 'missed', '2026-10-01T10:00:00');
    addAttempt(conn, 'a', true, 'correct', '2026-10-02T10:00:00');
    addAttempt(conn, 'a', true, 'correct', '2026-10-03T10:00:00');   // cleared here
    expect(progression.totalXp(conn)).toBe(2 + 10 + 10 + progression.WEAK_SPOT_CLEARED_XP);
    expect(db.weakItemIds(conn, 'puzzle').has('a')).toBe(false);
  });

  it('puzzle records and outcome upgrade', async () => {
    const conn = await freshConn();
    db.recordAttempt(conn, 'puzzle', 'a', true);
    const row = db.recordAttempt(conn, 'puzzle', 'a', false);
    db.recordAttempt(conn, 'puzzle', 'a', false, 'revealed');
    expect(db.puzzleRecords(conn).get('a')).toEqual({ correct: 1, near_best: 0, missed: 2 });
    db.setAttemptOutcome(conn, row, 'near_best');
    expect(db.puzzleRecords(conn).get('a')).toEqual({ correct: 1, near_best: 1, missed: 1 });
  });
});

describe('Spot the Tactic', () => {
  // White to move, Black's queen on d5 can be taken by the knight on c3
  const HANGING = 'rnb1kbnr/ppp1pppp/8/3q4/8/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 3';

  it('a material win is a tactic, counted after the reply', async () => {
    const board = Board.fromFen(HANGING);
    const eng = new FakeEngine({ [board.boardFen()]: [[['c3d5', 'c7c6', 'd5c3'], 900], [['d2d4'], -400]] });
    const v = await spot.classify(eng, board);
    expect([v.is_tactic, v.reason, v.gain]).toEqual([true, 'material', 9]);
    expect(v.describe(board)).toContain('forcing sequence that wins a queen');
  });

  it('mate, quiet, and sharp-but-not-tactical', async () => {
    const board = Board.fromFen();
    const key = board.boardFen();
    expect((await spot.classify(new FakeEngine({ [key]: [[['e2e4'], ['mate', 3]], [['d2d4'], 0]] }), board)).reason).toBe('mate');
    expect((await spot.classify(new FakeEngine({ [key]: [[['e2e4'], ['mate', 9]], [['d2d4'], 0]] }), board)).reason)
      .toBe('unclear');                                    // too long to count as a tactic
    // only one good move, but nothing forcing: not a tactic, and not quiet either -> skipped
    expect((await spot.classify(new FakeEngine({ [key]: [[['e2e4'], 150], [['d2d4'], 0]] }), board)).reason).toBe('unclear');
    const quiet = await spot.classify(new FakeEngine({ [key]: [[['e2e4'], 30], [['d2d4'], 20]] }), board);
    expect([quiet.is_tactic, quiet.reason]).toEqual([false, 'quiet']);
  });

  it('material won by a quiet move is not a tactic', () => {
    const board = Board.fromFen(HANGING);
    expect(spot.forcingGain(board, ['a2a3', 'a7a6', 'c3d5', 'c7c6'])).toBe(0);
    expect(spot.forcingGain(board, ['c3d5', 'c7c6'])).toBe(9);
  });

  it('winning back what was just taken is not a tactic', () => {
    const board = Board.fromFen(HANGING);
    const line = ['c3d5', 'c7c6'];
    expect(spot.forcingGain(board, line, 0)).toBe(9);
    expect(spot.forcingGain(board, line, 9)).toBe(0);     // they'd just taken your queen
    expect(spot.forcingGain(board, line, 3)).toBe(6);     // ...or a knight: still +6
  });

  it('quiet positions start after five moves each', async () => {
    expect(spot.usableAsQuiet({ game_id: 'g', ply: 9, fen: START, played_uci: 'e2e4' })).toBe(false);
    expect(spot.usableAsQuiet({ game_id: 'g', ply: 10, fen: START, played_uci: 'e2e4' })).toBe(true);
    const conn = await freshConn();
    conn.run(`INSERT INTO games (id, chess_com_url, pgn, played_at, time_control, my_color,
              opponent_username, result) VALUES ('g', 'u', '', '2026-01-01', '600', 'white', 'x', 'win')`);
    for (const ply of [2, 8, 12]) {
      conn.run(`INSERT INTO move_evaluations (game_id, ply, fen_before, move_uci, best_move_uci,
                cp_before, cp_after, depth, second_move_uci, cp_second, third_move_uci, cp_third)
                VALUES ('g', ?, ?, 'e2e4', 'e2e4', 20, 20, 14, 'd2d4', 15, 'c2c4', 10)`, [ply, `fen${ply}`]);
    }
    expect(spot.candidates(conn, true, new Set()).map((c) => c.ply)).toEqual([12]);
  });

  it('the solution stops at the winning move', () => {
    const board = Board.fromFen(HANGING);
    const pv = ['c3d5', 'c7c6', 'd5c3', 'e7e5'];
    const score = new PovScore(Score.cp(900), 'white');
    // the queen is won by the first move; the line ends there, with your move
    expect(spot.solutionFor(board, pv, score)).toEqual(pv.slice(0, 1));
    expect(spot.forcingWin(board, pv)).toEqual([9, 1]);
  });

  it('multi-move solution and mate line', () => {
    // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7# — a mate in one from the position before it
    const board = Board.fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
    const pv = ['h5f7'];
    const mate = new PovScore(Score.mate(1), 'white');
    expect(spot.solutionFor(board, pv, mate)).toEqual(pv);
    expect(spot.mateLine(board, [...pv, 'a7a6'])).toEqual(pv);   // stops at mate
    // Qa4 attacks the undefended queen (a threat), the king steps aside, Qxb5: two of your moves
    const fork = Board.fromFen('4k3/8/8/1q6/8/8/8/3QK3 w - - 0 1');
    const line = ['d1a4', 'e8e7', 'a4b5'];
    const cp = new PovScore(Score.cp(900), 'white');
    expect(spot.solutionFor(fork, [...line, 'e7e6'], cp)).toEqual(line);
  });

  it('forcing moves: checks, captures, threats', () => {
    expect(spot.isForcing(Board.fromFen(), 'e2e4')).toBe(false);
    // Bb5 attacks the knight on c6? no - the knight is defended and worth the same: not a threat
    const ruy = Board.fromFen('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    expect(spot.isForcing(ruy, 'f1b5')).toBe(false);
    // d4-d5 attacks the knight on c6 with a pawn: a new threat (knight worth more than the pawn)
    const push = Board.fromFen('r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 1 3');
    expect(spot.isForcing(push, 'd4d5')).toBe(true);
    // attacking a defended pawn of equal value isn't a threat; a capture always is forcing
    const four = Board.fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 4 4');
    expect(spot.isForcing(four, 'd2d4')).toBe(false);
    expect(spot.isForcing(four, 'f3e5')).toBe(true);
  });

  it('trivial recapture and check are skipped', () => {
    // 1.e4 d5 2.exd5 — Black recaptures on d5 with the queen
    const board = Board.fromFen('rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2');
    expect(spot.isTrivial(board, 'd8d5', 'e4d5', 1)).toBe(true);
    expect(spot.isTrivial(board, 'g8f6', 'e4d5', 1)).toBe(false);
    const inCheck = Board.fromFen('rnb1kbnr/pppp1ppp/8/4p3/5PPq/8/PPPPP2P/RNBQKBNR w KQkq - 1 3');
    expect(spot.isTrivial(inCheck, 'g2g3', null, 0)).toBe(true);
  });

  it('judging moves', async () => {
    const board = Board.fromFen(HANGING);
    const v = new spot.Verdict(true, 'material', 'c3d5', 900, -400);
    expect(await spot.judgeMove(null, board, v, 'c3d5')).toEqual([true, 0]);
    const after = board.copy(); after.push('d2d4');
    const eng = new FakeEngine({ [after.boardFen()]: [[[], 400]] });    // Black to move, +4 for Black
    expect(await spot.judgeMove(eng, board, v, 'd2d4')).toEqual([false, 1300]);
  });

  it('a tactic needs the best move; quiet allows half a pawn', async () => {
    const board = Board.fromFen();
    const after = board.copy(); after.push('d2d4');
    const eng = new FakeEngine({ [after.boardFen()]: [[[], -130]] });   // Black to move: White +1.30
    const tactic = new spot.Verdict(true, 'only_move', 'e2e4', 150, 0);
    const quiet = new spot.Verdict(false, 'quiet', 'e2e4', 150, 140);
    expect(await spot.judgeMove(eng, board, tactic, 'd2d4')).toEqual([false, 20]);
    expect(await spot.judgeMove(eng, board, quiet, 'd2d4')).toEqual([true, 20]);
  });

  it('scoring and summary', async () => {
    const conn = await freshConn();
    const tactic = new spot.Verdict(true, 'only_move', 'e2e4', 150, 0);
    const quiet = new spot.Verdict(false, 'quiet', 'e2e4', 20, 10);
    spot.record(conn, 'f1', tactic, true, true);      // spotted, good move
    spot.record(conn, 'f2', quiet, true, true);       // false alarm, good move
    spot.record(conn, 'f3', tactic, false, false);    // missed it, bad move
    const s = spot.summary(conn);
    expect([s.rounds, s.spotted, s.tactics, s.false_alarms, s.quiet, s.moves_ok]).toEqual([3, 1, 2, 1, 1, 2]);
    expect(spot.xp(conn)).toBe(1 * spot.CALL_XP + 2 * spot.MOVE_XP);
    expect(progression.totalXp(conn)).toBe(spot.xp(conn));
  });
});
