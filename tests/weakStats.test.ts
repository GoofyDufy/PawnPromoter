// Reference fixtures for SPEC §6 / §7, hand-computed — port of
// ~/WeaknessStats/tests/test_stats.py, plus the skipped-book-position case.
import { describe, expect, it } from 'vitest';
import { STARTING_FEN } from '../src/core/chess';
import * as ec from '../src/core/weak/evalcore';
import * as st from '../src/core/weak/stats';

const CTX: st.Ctx = { time_control: '180+2', config_id: 'test-cfg', spec_version: '1.2-draft', window_games: 50 };

interface Opts {
  colour?: 'white' | 'black'; result?: number; gid?: string; phases?: Record<number, ec.Phase>; bookPlies?: number;
  clocks?: number[]; clockValid?: number; coverage?: number; nLegal?: Record<number, number>; mates?: Record<number, number>;
}

/** Synthetic game: evals[p] is cp_cap_white of ply p (null: not searched). */
function makeGame(evals: (number | null)[], o: Opts = {}): st.Game {
  const colour = o.colour ?? 'white';
  const gid = o.gid ?? 'g1';
  const positions: st.PositionRow[] = evals.map((cp, p) => {
    const last = p === evals.length - 1;
    const stm = p % 2 === 0 ? 'white' : 'black';
    const mate = o.mates?.[p];
    return {
      game_id: gid, ply: p, fen: STARTING_FEN, side_to_move: stm, move_number: Math.floor(p / 2) + 1,
      move_uci: last ? null : 'e2e4', move_san: last ? null : 'e4', mover: last ? null : stm === colour ? 'player' : 'opponent',
      score_type: cp == null ? null : mate !== undefined ? 'mate' : 'cp', score_value: 0, best_move_uci: null, pv_uci: '',
      phase: o.phases?.[p] ?? 'middlegame', clock_after_s: last || !o.clocks ? null : o.clocks[p], emt_s: null,
      cp_raw_white: cp, cp_cap_white: cp, mate_white: mate ?? null, n_legal: o.nLegal?.[p] ?? 20,
      is_book: p < (o.bookPlies ?? 0) ? 1 : 0, terminal: null,
    };
  });
  const row: st.GameRow = { game_id: gid, player_colour: colour, result: o.result ?? 1, base_s: 180, increment_s: 2,
    clock_valid: o.clockValid ?? 1, clock_coverage: o.coverage ?? 1, eco_code: 'B20', opening_name: 'Sicilian Defense',
    eco_source: 'eco_table', date: '2026-10-01', time_control: '180+2' };
  const g = new st.Game(row, positions);
  st.buildMoves(g);
  return g;
}

/** Ten copies, so the <10-game suppression gate doesn't hide the value. */
const ten = (evals: number[], o: Opts = {}) => Array.from({ length: 10 }, (_, i) => makeGame(evals, { ...o, gid: `t${i}` }));
const val = (p: st.Payload) => p.value as Record<string, number | null>;

describe('§5 exclusions', () => {
  it('excludes a book move but keeps its phase', () => {
    const m0 = makeGame([0, 0, 0, -300, -300], { bookPlies: 1 }).moves[0];
    expect(m0.book && !st.included(m0) && m0.phase === 'middlegame').toBe(true);
  });

  it('excludes a forced move', () => {
    const m = makeGame([0, 0, -400, -400], { nLegal: { 2: 1 } }).moves[2];
    expect(m.forced && !st.included(m)).toBe(true);
  });

  it('includes a move that exits the dead zone', () => {
    const g = makeGame([1000, 1000, 400, 400]);
    expect(g.moves[0].dead).toBe(true);
    expect(g.moves[2].dead).toBe(false);
    expect(st.included(g.moves[2])).toBe(true);
  });

  it('grades a mate move by WPL, not ACPL', () => {
    const g = makeGame([300, 1000, 1000], { mates: { 1: 4 } });
    const m = g.moves[0];
    expect(st.included(m) && m.cpl === null && m.wpl === 0).toBe(true);
    expect(st.quality(g.own(), 1).n_mate).toBe(1);
    const g2 = makeGame([1000, 300, 300], { mates: { 0: 4 } });
    expect(g2.moves[0].cpl).toBeNull();
    expect(g2.moves[0].wpl).toBeGreaterThan(10);
    expect(st.quality(g2.own(), 1).acpl).toBeNull();
  });

  it('leaves unsearched book positions out of everything', () => {
    const g = makeGame([null, null, 0, -500, -500], { bookPlies: 2 });
    expect(g.moves[0].no_eval && !st.included(g.moves[0])).toBe(true);
    expect(st.quality(g.own(), 1).n_moves).toBe(1);
    expect(val(st.statRescue(CTX, [g])).opportunities).toBe(1);   // the unsearched plies are skipped, the game still counts
  });
});

describe('stats 1–4', () => {
  it('matches the hand calculation for a game as Black', () => {
    const g = makeGame([-50, -50, 250, 250, 250], { colour: 'black', result: 0 });
    const own = g.own();
    expect(own.map((m) => m.ply)).toEqual([1, 3]);
    expect(own[0].cpl).toBe(300);
    expect(own[0].wpl).toBeCloseTo(ec.winPct(50) - ec.winPct(-250), 9);
    expect(ec.classify(own[0].wpl)).toBe('Blunder');
    const q = st.quality(own, 1);
    expect([q.blunders, q.blunder_per100, q.acpl]).toEqual([1, 50, 150]);
  });
});

describe('stats 8–10', () => {
  it('(a) reaches 85% once and wins: converted', () => {
    const v = val(st.statConversion(CTX, ten([0, 0, 500, 500, 600], { result: 1 })));
    expect([v.opportunities, v.converted, v.rate_pct]).toEqual([10, 10, 100]);
  });

  it('(b) crosses 80% three times and draws: one opportunity, not converted', () => {
    const v = val(st.statConversion(CTX, ten([0, 400, 100, 400, 100, 400, 0], { result: 0.5 })));
    expect([v.opportunities, v.converted, v.win_to_draw, v.thrown_points]).toEqual([10, 0, 10, 5]);
  });

  it('ignores crossings in the opening', () => {
    const g = makeGame([0, 500, 0, 0], { result: 0, phases: { 0: 'opening', 1: 'opening' } });
    expect(st.statConversion(CTX, [g]).state).toBe('insufficient_data');
  });

  it('(c) reaches 15% and draws: rescued', () => {
    const v = val(st.statRescue(CTX, ten([0, -500, -500, 0], { result: 0.5 })));
    expect([v.opportunities, v.rescued, v.points_saved]).toEqual([10, 10, 5]);
  });

  it('keeps counts and hides rates when suppressed', () => {
    const p = st.statConversion(CTX, [makeGame([0, 0, 500, 500], { result: 1 })]);
    expect(p.state).toBe('suppressed');
    expect([val(p).opportunities, val(p).rate_pct]).toEqual([1, null]);
  });

  it('(d) sorts replies into punished / partial / missed', () => {
    const games = [540, 380, 230, 540, 380, 230, 540, 380, 230, 540, 380, 230].map((after, i) => makeGame([0, 0, 600, after, after], { gid: `d${i}` }));
    const w = games.slice(0, 3).map((g) => g.moves[2].wpl);
    expect(w[0] < 5 && w[1] >= 5 && w[1] < 10 && w[2] >= 10).toBe(true);
    const v = val(st.statOpportunism(CTX, games));
    expect(v.opportunities).toBe(12);
    expect([v.punished_pct, v.partial_pct, v.missed_pct]).toEqual([33.3, 33.3, 33.3]);
  });
});

describe('stats 11–12', () => {
  it('flags a hanging rook', () => {
    expect(st.materialFlag('4k3/8/4p3/8/8/8/8/3RK3 w - - 0 1', 'd1d2 e8e7', '4k3/8/4p3/3R4/8/8/8/4K3 b - - 1 1', 'e6d5 e1e2', true)).toBe(true);
  });

  it('does not flag a line with no capture', () => {
    expect(st.materialFlag('6k1/8/4p3/3n4/8/8/B2Q4/6K1 w - - 0 1', '', '6k1/8/4p3/3n4/8/8/B2Q2P1/6K1 b - - 0 1', 'g8f7 g1f1', true)).toBe(false);
  });

  it('never sends a sound sacrifice to the detector', () => {
    expect(makeGame([100, 100, 150, 150]).own().filter((m) => m.wpl >= st.BIG)).toEqual([]);
  });

  it('returns insufficient_data when the >60s blunder rate is 0', () => {
    const evals = [0, 0, 0, 0, 0, 0, 0, -600, -600, -600, -600, -600, -600];
    const clocks = [170, 170, 165, 165, 160, 160, 25, 25, 20, 20, 15, 15];
    const p = st.statClock(CTX, Array.from({ length: 12 }, (_, i) => makeGame(evals, { gid: `c${i}`, clocks })));
    expect([p.state, p.value]).toEqual(['insufficient_data', null]);
  });

  it('takes no clock stats from a 50%-coverage game', () => {
    const p = st.statClock(CTX, [makeGame([0, 0, 0], { clocks: [170, 170], coverage: 0.5 })]);
    expect([p.state, p.has_clock]).toEqual(['insufficient_data', false]);
  });

  it('reads [%clk] with the increment included (F3)', () => {
    const m = makeGame([0, 0, 0], { clocks: [181.5, 180] }).moves[0];
    expect(m.elapsed).toBeCloseTo(0.5, 9);
    expect(m.remaining_before).toBe(180);
  });
});

describe('§7 gates and ranking', () => {
  it.each([[9, 'suppressed'], [10, 'provisional'], [29, 'provisional'], [30, 'ok']])('%s games → %s', (n, state) => {
    expect(st.stateFor(n)).toBe(state);
  });

  it('hides a suppressed value', () => expect(st.payload(CTX, 42, 9).value).toBeNull());

  it('ranks a rare-but-bad segment below a frequent one', () => {
    const games = Array.from({ length: 12 }, (_, i) => {
      const phases: Record<number, ec.Phase> = {};
      for (let p = 0; p < 13; p++) phases[p] = p < 8 ? 'middlegame' : 'endgame';
      const late = i === 0 ? -1000 : -400;
      return makeGame([0, 0, 0, -400, -400, -400, -400, -400, -400, -400, -400, late, late], { gid: `r${i}`, phases });
    });
    const names = st.weaknessRanking(games).map((r) => r.segment);
    expect(names.indexOf('Middlegame')).toBeLessThan(names.indexOf('Endgame'));
  });
});

describe('pieces left hanging: what was lost, and the tactic that won it', () => {
  // each: the position after your move (the opponent to move), and Stockfish's punishing line
  it('a fork', () => {
    expect(st.hangingDetail('4k3/8/8/8/3n4/8/8/R3K3 b - - 0 1', 'a2a1', 'd4c2 e1d1 c2a1', false)).toEqual({ piece: 'rook', tactic: 'Fork', by: 'knight' });
  });
  it('a piece left undefended', () => {
    expect(st.hangingDetail('4k3/8/8/8/2B1r3/8/8/7K b - - 0 1', 'g1h1', 'e4c4', false)).toEqual({ piece: 'bishop', tactic: 'Left a piece undefended', by: 'rook' });
  });
  it('a piece moved into an attack', () => {
    expect(st.hangingDetail('4k3/8/8/1p6/2B5/8/8/4K3 b - - 0 1', 'f1c4', 'b5c4', false)).toEqual({ piece: 'bishop', tactic: 'Moved into an attack', by: 'pawn' });
  });
  it('a mate threat, with nothing big taken', () => {
    expect(st.hangingDetail('4k3/8/8/q7/8/8/3R4/4K3 b - - 0 1', 'd1d2', 'a5a1', true).tactic).toBe('Mate threat');
  });
});
