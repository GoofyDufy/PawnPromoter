// The TS weakness stats against the Python prototype, on the same stored rows
// (tests/golden/weak.json from tools/golden_weak.py; skipped when it's absent).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as st from '../src/core/weak/stats';

const FILE = new URL('./golden/weak.json', import.meta.url);
const golden = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;

/** Every key and value equal; numbers within 0.051 (rounding at the last digit). */
function diff(a: unknown, b: unknown, path = ''): string[] {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.051 ? [] : [`${path}: ${a} ≠ ${b}`];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? [] : [`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array vs object`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
}

describe.skipIf(!golden)('weakness stats vs the prototype', () => {
  for (const window of ['50', '10000']) {
    it(`matches the report for window ${window}`, () => {
      const games = golden.rows.games.slice(0, Number(window)).map((r: st.GameRow) => {
        const g = new st.Game(r, golden.rows.positions[r.game_id]);
        st.buildMoves(g);
        return g;
      });
      const ctx: st.Ctx = { time_control: '180+2', config_id: golden.config_id, spec_version: golden.spec_version, window_games: Number(window) };
      const ours = JSON.parse(JSON.stringify(st.computeAll(ctx, games)));
      const problems = diff(ours, golden.reports[window]);
      expect(problems.slice(0, 20)).toEqual([]);
    });
  }
});
