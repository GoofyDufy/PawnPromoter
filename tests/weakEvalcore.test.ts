// SPEC §8 golden vectors, plus the v1.2 F1 checkmate cases — port of
// ~/WeaknessStats/tests/test_evalcore.py and test_see.py.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as ec from '../src/core/weak/evalcore';
import { material, see } from '../src/core/weak/see';

const near = (a: number, b: number, tol = 0.1) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('§8.1 win% and accuracy', () => {
  it.each([[0, 50.0], [100, 59.1], [300, 75.11], [377, 80.03], [1000, 97.54], [-300, 24.89]])('win%% of %s cp', (cp, expected) => {
    near(ec.winPct(cp), expected);
  });

  it('puts 80% at +376.5 cp', () => near(ec.winPct(376.5), 80, 0.01));

  it.each([[0, 100.0, 'Excellent'], [2, 91.4, 'Good'], [5, 79.8, 'Inaccuracy'], [10, 63.6, 'Mistake'], [20, 40.0, 'Blunder'], [40, 14.9, 'Blunder']] as const)(
    'accuracy and class at WPL %s', (w, expected, cls) => {
      near(ec.moveAccuracy(w), expected);
      expect(ec.classify(w)).toBe(cls);
    });

  it('grades the worked move', () => {
    expect(ec.cpl(30, -180, true, false)).toBe(210);
    const w = ec.wpl(30, -180, true);
    near(w, 18.75);
    near(ec.moveAccuracy(w), 42.4);
    expect(ec.classify(w)).toBe('Mistake');
  });
});

describe('§8.2 perspective and mate (exact)', () => {
  it('turns side-to-move cp into White POV', () => {
    expect(ec.derive('cp', 120, true)).toEqual([120, 120, null]);
    expect(ec.derive('cp', 120, false)).toEqual([-120, -120, null]);
  });

  it('turns mates into White POV and caps them', () => {
    expect(ec.derive('mate', 3, true)).toEqual([10000, 1000, 3]);
    expect(ec.derive('mate', 3, false)).toEqual([-10000, -1000, -3]);
    expect(ec.derive('mate', -2, false)[2]).toBe(2);
  });

  it('reads a Black mover POV', () => expect(ec.moverPov(-250, false)).toBe(250));

  it('gives a mate move no CPL but a WPL', () => {
    expect(ec.cpl(300, 1000, true, true)).toBeNull();
    expect(ec.wpl(1000, 300, true)).toBeGreaterThan(0);
  });

  it('scores Black checkmated as a White win (F1)', () => {
    const [raw, cap, mw] = ec.derive('mate', 0, false, true);
    expect([raw, cap, mw]).toEqual([10000, 1000, 0]);
    expect(ec.wpl(1000, cap, true)).toBe(0);
  });

  it('scores White checkmated as a Black win (F1)', () => expect(ec.derive('mate', 0, true, true).slice(0, 2)).toEqual([-10000, -1000]));

  it('refuses a bare mate 0', () => expect(() => ec.derive('mate', 0, true)).toThrow());
});

describe('§3.6, §5', () => {
  it('aggregates game accuracy as hm_am_v1', () => {
    expect(ec.gameAccuracy([100, 100])).toBe(100);
    near(ec.gameAccuracy([100, 50])!, 70.83, 0.01);
    expect(ec.gameAccuracy([])).toBeNull();
  });

  it('finds the dead zone', () => {
    expect(ec.inDeadZone(1000, 960, true)).toBe(true);
    expect(ec.inDeadZone(1000, 960, false)).toBe(true);
    expect(ec.inDeadZone(1000, 500, true)).toBe(false);
  });

  it('tags phases', () => {
    expect(ec.phaseWeight('NBRQnbrqNBRnbr')).toBe(24);
    expect(ec.phase(5, 24, true, false)).toBe('opening');
    expect(ec.phase(14, 18, true, true)).toBe('opening');
    expect(ec.phase(16, 18, true, true)).toBe('middlegame');
    expect(ec.phase(30, 6, true, false)).toBe('endgame');
    expect(ec.phase(30, 10, false, false)).toBe('endgame');
    expect(ec.phase(30, 10, true, false)).toBe('middlegame');
  });
});

describe('SEE', () => {
  it('wins a hanging rook', () => expect(see(Board.fromFen('4k3/8/8/3r4/8/8/3Q4/4K3 w - - 0 1'), 'd2d5')).toBe(500));
  it('loses the queen for a defended rook', () => expect(see(Board.fromFen('4k3/8/4p3/3r4/8/8/3Q4/4K3 w - - 0 1'), 'd2d5')).toBe(500 - 900));
  it('ignores a pinned defender', () => expect(see(Board.fromFen('4k3/8/4p3/3r4/8/2N5/8/4R1K1 w - - 0 1'), 'c3d5')).toBe(500));
  it('counts the whole exchange', () => expect(see(Board.fromFen('6k1/8/4p3/3n4/8/8/B2Q4/6K1 w - - 0 1'), 'd2d5')).toBe(300 - 900 + 100));
  it('measures material', () => {
    expect(material(Board.fromFen(), 'white')).toBe(0);
    expect(material(Board.fromFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1'), 'black')).toBe(-500);
  });
});
