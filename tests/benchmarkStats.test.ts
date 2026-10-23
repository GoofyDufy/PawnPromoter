// Benchmarks from Lichess, step 2 (not part of the normal run): BENCH_DIR = ~/LichessBench (the sampled PGNs and the
// analysed_*.jsonl from benchmarkBuild), BENCH_JSON = where to write the app's benchmarks. Each game counts for both
// players: rated 1500–2200, sorted into bands by their own rating. Per time control and band, the same report as
// your own stats (computeAll), on all the band's games; and, from random 50-game samples, how much a 50-game report
// varies by chance (so the app only calls a difference real when it's bigger than that).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeGame } from '../src/core/models';
import { fillEvaluations, parseGame } from '../src/core/weak/analysis';
import { Book } from '../src/core/weak/book';
import * as st from '../src/core/weak/stats';

const dir = process.env.BENCH_DIR;
const out = process.env.BENCH_JSON;
export const BANDS = [[1500, 1699], [1700, 1899], [1900, 2200]] as const;
const SAMPLES = 120;                        // random 50-game reports per band, for the chance variation
const WINDOW = 50;

/** The report's headline numbers the app compares (path in the report, and whether lower is better). */
export const METRICS: [string, string, boolean][] = [
  ['accuracy', 'accuracy.value.mean_game_accuracy', false],
  ['blunders', 'blunder_mistake_rate.value.blunder_per100', true],
  ['mistakes', 'blunder_mistake_rate.value.mistake_per100', true],
  ['acpl', 'acpl.value.acpl_capped', true],
  ['worst_move', 'worst_move.value.pct_games_max_ge_20', true],
  ['conversion', 'conversion.value.rate_pct', false],
  ['rescue', 'rescue.value.rate_pct', false],
  ['punished', 'opportunism.value.punished_pct', false],
  ['hanging', 'material.value.per100', true],
];
const at = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | null)?.[k], o) as number | null | undefined;

/** Seeded random numbers, so the benchmarks come out the same each time they're built. */
function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

describe.skipIf(!dir || !out)('Lichess benchmarks: the numbers', () => {
  it('builds the benchmarks by time control and rating band', () => {
    const lib = JSON.parse(readFileSync(new URL('../public/openings/library.json', import.meta.url), 'utf8'));
    const ucisAt = lib.columns.indexOf('ucis');
    const book = new Book(lib.rows.map((r: unknown[]) => ({ eco: r[0] as string, name: r[1] as string, ucis: r[ucisAt] as string })));
    const result: Record<string, unknown> = { source: 'Lichess rated games, September 2026 (sampled), both players 1500–2200',
      engine: 'Stockfish 19 (native), depth 14 — the app uses Stockfish 19 lite at the same depth', built: new Date().toISOString().slice(0, 10), time_controls: {} };
    for (const tc of ['180+2', '600+0']) {
      const file = `${dir}/analysed_${tc.replace('+', '_')}.jsonl`;
      const pgnFile = `${dir}/lichess_${tc.replace('+', '_')}.pgn`;
      if (!existsSync(file)) continue;
      const pgns = new Map(readFileSync(pgnFile, 'utf8').split(/\n\n(?=\[Event )/).map((p) => [/\[Site "([^"]+)"\]/.exec(p)?.[1] ?? '', p.trim()]));
      const byBand: st.Game[][] = BANDS.map(() => []);
      const openings = BANDS.map(() => new Map<string, { n: number; white: number; draws: number }>());
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        const rec = JSON.parse(line);
        const pgn = pgns.get(rec.id);
        if (!pgn) continue;
        const evals = new Map(Object.entries(rec.evals)) as Map<string, never>;
        for (const colour of ['white', 'black'] as const) {
          const rating = colour === 'white' ? rec.white_elo : rec.black_elo;
          const b = BANDS.findIndex(([lo, hi]) => rating >= lo && rating <= hi);
          if (b < 0) continue;
          const won = rec.result === (colour === 'white' ? '1-0' : '0-1');
          const game = makeGame({ id: `${rec.id}#${colour}`, chess_com_url: rec.id, pgn, played_at: rec.date, time_control: rec.tc, my_color: colour,
            opponent_username: '', result: rec.result === '1/2-1/2' ? 'draw' : won ? 'win' : 'loss' });
          const parsed = parseGame(game, book);
          if (!parsed) continue;
          let positions;
          try { positions = fillEvaluations(parsed[1], evals); } catch { continue; }
          const g = new st.Game(parsed[0] as unknown as st.GameRow, positions as unknown as st.PositionRow[]);
          st.buildMoves(g);
          byBand[b].push(g);
          // openings by level: each game once, in the band of White's rating
          if (colour === 'white') {
            const fam = (parsed[0].opening_name || rec.opening || '?').split(':')[0].trim();
            const o = openings[b].get(fam) ?? { n: 0, white: 0, draws: 0 };
            o.n += 1;
            o.white += rec.result === '1-0' ? 1 : rec.result === '1/2-1/2' ? 0.5 : 0;
            o.draws += rec.result === '1/2-1/2' ? 1 : 0;
            openings[b].set(fam, o);
          }
        }
      }
      const bands: Record<string, unknown> = {};
      for (const [b, [lo, hi]] of BANDS.entries()) {
        const games = byBand[b];
        if (games.length < WINDOW) continue;
        const ctx: st.Ctx = { time_control: tc, config_id: 'lichess-bench', spec_version: '1.2-draft', window_games: games.length };
        const all = st.computeAll(ctx, games);
        // how much a 50-game report varies by chance: the spread of random 50-game samples
        const rand = rng(lo * 7 + tc.length);
        const samples: Record<string, number[]> = Object.fromEntries(METRICS.map(([k]) => [k, []]));
        for (let s = 0; s < SAMPLES; s++) {
          const pick = Array.from({ length: WINDOW }, () => games[Math.floor(rand() * games.length)]);
          const r = st.computeAll({ ...ctx, window_games: WINDOW }, pick);
          for (const [k, path] of METRICS) { const v = at(r, path); if (typeof v === 'number') samples[k].push(v); }
        }
        const sd = (xs: number[]) => { const m = xs.reduce((a, x) => a + x, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
        const mat = all.material as unknown as { breakdown?: unknown };
        bands[`${lo}-${hi}`] = {
          players_games: games.length,
          metrics: Object.fromEntries(METRICS.map(([k, path, lower]) => [k, { value: at(all, path) ?? null, sd50: samples[k].length > 10 ? Number(sd(samples[k]).toFixed(2)) : null, lower_is_better: lower }])),
          hanging: mat.breakdown ?? null,
          openings: [...openings[b].entries()].filter(([, o]) => o.n >= 25).sort((x, y) => y[1].n - x[1].n).slice(0, 25)
            .map(([family, o]) => ({ family, games: o.n, white_score_pct: Number(((100 * o.white) / o.n).toFixed(1)), draw_pct: Number(((100 * o.draws) / o.n).toFixed(1)) })),
        };
        console.log(`${tc} ${lo}-${hi}: ${games.length} player-games · accuracy ${at(all, METRICS[0][1])} · blunders ${at(all, METRICS[1][1])}/100 · hanging ${at(all, 'material.value.per100')}/100`);
      }
      (result.time_controls as Record<string, unknown>)[tc] = bands;
    }
    writeFileSync(out!, JSON.stringify(result));
    expect(Object.keys(result.time_controls as object).length).toBeGreaterThan(0);
  }, 7_200_000);
});
