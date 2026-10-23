/**
 * "How do I compare?" — your weakness stats next to Lichess players at your level (public/benchmarks/lichess.json,
 * built by tests/benchmarkStats.test.ts from sampled Lichess games, both players rated 1500–2200, 3+2 and 10+0).
 *
 * The sample has about one game per player, so it shows the average player at each level well but not how players
 * differ from each other: no percentiles. A difference is called real only when it's bigger than the chance
 * variation of a 50-game report (sd50, from random 50-game samples of the band).
 */
export interface BenchMetric { value: number | null; sd50: number | null; lower_is_better: boolean }
export interface BenchShare { label: string; n: number; pct: number | null }
export interface BenchRate { label: string; n: number; moves: number; n_games: number; per100: number }
export interface BenchBand {
  players_games: number;
  metrics: Record<string, BenchMetric>;
  hanging: { by_piece: BenchShare[]; by_tactic: BenchShare[]; by_phase: BenchRate[]; by_time: BenchRate[] } | null;
  openings: { family: string; games: number; white_score_pct: number; draw_pct: number }[];
}
export interface Benchmarks {
  source: string;
  engine: string;
  built: string;
  time_controls: Record<string, Record<string, BenchBand>>;
}

/** Your time control → the benchmark's (Chess.com writes 10 minutes as "600", Lichess as "600+0"). null: none. */
export function benchTimeControl(tc: string | null, bench: Benchmarks): string | null {
  if (!tc) return null;
  const key = /^\d+$/.test(tc) ? `${tc}+0` : tc;
  return bench.time_controls[key] ? key : null;
}

/** Lichess ratings run higher than Chess.com's: roughly +250 in blitz, +200 in rapid (a rule of thumb). */
export function lichessRating(chessComRating: number, tc: string): number {
  const base = Number(tc.split('+')[0]);
  return chessComRating + (base >= 600 ? 200 : 250);
}

/** The band for a (Lichess) rating: the nearest one when it's outside 1500–2200. */
export function bandFor(rating: number | null, bands: string[]): string | null {
  if (!bands.length) return null;
  if (rating === null) return bands[Math.floor(bands.length / 2)];
  const range = (b: string) => b.split('-').map(Number);
  return bands.find((b) => rating >= range(b)[0] && rating <= range(b)[1])
    ?? (rating < range(bands[0])[0] ? bands[0] : bands[bands.length - 1]);
}

export type Verdict = 'better' | 'same' | 'worse';

/** Better, the same or worse than the band's average: "the same" unless the gap is more than 1.5× the chance
 *  variation of a 50-game report. */
export function verdict(you: number | null, m: BenchMetric | undefined): Verdict | null {
  if (you === null || !m || m.value === null) return null;
  const tol = 1.5 * (m.sd50 ?? 0);
  const diff = you - m.value;
  if (Math.abs(diff) <= tol) return 'same';
  return (diff < 0) === m.lower_is_better ? 'better' : 'worse';
}

export const VERDICT_WORDS: Record<Verdict, string> = { better: 'better than average', same: 'about average', worse: 'worse than average' };
