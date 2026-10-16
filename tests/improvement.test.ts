// Stats → Improvement: the commentary on your strengths, weaknesses and trends.
import { describe, expect, it } from 'vitest';
import { type AreaTrend, commentary } from '../src/core/improvement';

const area = (name: AreaTrend['area'], overall: number, before: number | null, recent: number | null): AreaTrend =>
  ({ area: name, series: [], overall, before, recent, change: before !== null && recent !== null ? recent - before : null, moves: 500 });

describe('improvement commentary', () => {
  it('names the strongest and weakest phase, a weak tactics score, and what changed', () => {
    const c = commentary([
      area('Openings', 90, 89, 89.5), area('Middlegame', 82, 84, 81), area('Endgame', 86, 83, 87), area('Tactics', 70, 70, 70),
    ], 1.4, 1.8);
    expect(c.strengths[0]).toBe('You play the opening best: 90.0% accuracy, against 82.0% in the middlegame.');
    expect(c.weaknesses).toContain('The middlegame is where you lose the most: 82.0% accuracy.');
    expect(c.weaknesses.some((w) => w.startsWith('Sharp positions'))).toBe(true);
    expect(c.trends).toContain('📉 Middlegame: slipping — 84.0% → 81.0% over the last 3 months.');
    expect(c.trends).toContain('📈 Endgame: improving — 83.0% → 87.0% over the last 3 months.');
    expect(c.trends).toContain('📈 Blunders: down from 1.80 to 1.40 per game.');
    expect(c.practice.map((p) => p.action)).toEqual(['threats', 'tactics']);
  });

  it('even phases and steady play', () => {
    const c = commentary([area('Openings', 85, 85, 85.2), area('Middlegame', 84.5, 84, 84.4), area('Endgame', 85.2, null, null), area('Tactics', 80, 80, 80)], null, null);
    expect(c.strengths[0]).toMatch(/^You're about equally strong in every phase/);
    expect(c.trends).toEqual(['➡️ Openings: steady at about 85.2%.', '➡️ Middlegame: steady at about 84.4%.', '➡️ Tactics: steady at about 80.0%.']);
  });
});
