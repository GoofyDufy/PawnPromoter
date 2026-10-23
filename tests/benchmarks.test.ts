// "How do I compare?": your stats next to Lichess players at your level — the band, the time control, and when a
// difference is real (more than chance in a 50-game report).
import { describe, expect, it } from 'vitest';
import { type Benchmarks, bandFor, benchTimeControl, lichessRating, verdict } from '../src/core/benchmarks';

const bench = { source: '', engine: '', built: '', time_controls: { '180+2': {}, '600+0': {} } } as unknown as Benchmarks;
const BANDS = ['1500-1699', '1700-1899', '1900-2200'];

describe('the Lichess comparison', () => {
  it('maps your time control to the benchmark\'s (Chess.com writes 10 minutes as "600")', () => {
    expect(benchTimeControl('180+2', bench)).toBe('180+2');
    expect(benchTimeControl('600', bench)).toBe('600+0');
    expect(benchTimeControl('60+1', bench)).toBeNull();
    expect(benchTimeControl(null, bench)).toBeNull();
  });

  it('your level: Chess.com ratings run lower than Lichess\'s', () => {
    expect(lichessRating(1514, '180+2')).toBe(1764);
    expect(lichessRating(1514, '600+0')).toBe(1714);
    expect(bandFor(1764, BANDS)).toBe('1700-1899');
    expect(bandFor(1300, BANDS)).toBe('1500-1699');                    // below the range: the nearest band
    expect(bandFor(2400, BANDS)).toBe('1900-2200');
    expect(bandFor(null, BANDS)).toBe('1700-1899');                    // no rating: the middle
  });

  it('a difference counts only when it beats chance (1.5× the 50-game spread)', () => {
    const blunders = { value: 4.0, sd50: 0.6, lower_is_better: true };
    expect(verdict(4.5, blunders)).toBe('same');
    expect(verdict(5.5, blunders)).toBe('worse');
    expect(verdict(2.9, blunders)).toBe('better');
    const accuracy = { value: 80, sd50: 1, lower_is_better: false };
    expect(verdict(83, accuracy)).toBe('better');
    expect(verdict(null, accuracy)).toBeNull();
  });
});
