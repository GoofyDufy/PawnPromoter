// What players who went on to gain rating did differently (not part of the normal run): BENCH_DIR = ~/LichessBench
// (analysed_*.jsonl, the PGNs, history.jsonl: each sampled player's rating in the sampled game and now), RISERS_JSON =
// where to write the result. Players are grouped by their change since: up 50+, about the same, down 50+. Each
// group's games are pooled into one report (computeAll, as for your own stats), and a difference counts only when
// it's more than twice what resampling the groups gives by chance.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeGame } from '../src/core/models';
import { fillEvaluations, parseGame } from '../src/core/weak/analysis';
import { Book } from '../src/core/weak/book';
import * as st from '../src/core/weak/stats';
import { METRICS } from './benchmarkStats.test';

const dir = process.env.BENCH_DIR;
const out = process.env.RISERS_JSON;
const at = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | null)?.[k], o) as number | null | undefined;
function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

describe.skipIf(!dir || !out)('Lichess benchmarks: what risers did differently', () => {
  it('compares players who gained 50+ with those who lost 50+', () => {
    const lib = JSON.parse(readFileSync(new URL('../public/openings/library.json', import.meta.url), 'utf8'));
    const ucisAt = lib.columns.indexOf('ucis');
    const book = new Book(lib.rows.map((r: unknown[]) => ({ eco: r[0] as string, name: r[1] as string, ucis: r[ucisAt] as string })));
    const hist = new Map<string, { change: number }>();
    for (const line of readFileSync(`${dir}/history.jsonl`, 'utf8').split('\n').filter(Boolean)) {
      const h = JSON.parse(line);
      if (h.latest && !h.latest.prov) hist.set(`${h.game}#${h.colour}`, { change: h.latest.rating - h.elo_at_game });
    }
    const groups: Record<'up' | 'same' | 'down', st.Game[]> = { up: [], same: [], down: [] };
    for (const tc of ['180_2', '600_0']) {
      const file = `${dir}/analysed_${tc}.jsonl`;
      if (!existsSync(file)) continue;
      const pgns = new Map(readFileSync(`${dir}/lichess_${tc}.pgn`, 'utf8').split(/\n\n(?=\[Event )/).map((p) => [/\[Site "([^"]+)"\]/.exec(p)?.[1] ?? '', p.trim()]));
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        const rec = JSON.parse(line);
        for (const colour of ['white', 'black'] as const) {
          const h = hist.get(`${rec.id}#${colour}`);
          if (!h) continue;
          const won = rec.result === (colour === 'white' ? '1-0' : '0-1');
          const game = makeGame({ id: `${rec.id}#${colour}`, chess_com_url: rec.id, pgn: pgns.get(rec.id)!, played_at: rec.date, time_control: rec.tc, my_color: colour,
            opponent_username: '', result: rec.result === '1/2-1/2' ? 'draw' : won ? 'win' : 'loss' });
          const parsed = parseGame(game, book);
          if (!parsed) continue;
          let positions;
          try { positions = fillEvaluations(parsed[1], new Map(Object.entries(rec.evals)) as never); } catch { continue; }
          const g = new st.Game(parsed[0] as unknown as st.GameRow, positions as unknown as st.PositionRow[]);
          st.buildMoves(g);
          groups[h.change >= 50 ? 'up' : h.change <= -50 ? 'down' : 'same'].push(g);
        }
      }
    }
    const report = (gs: st.Game[]) => st.computeAll({ time_control: 'mixed', config_id: 'lichess-bench', spec_version: '1.2-draft', window_games: gs.length }, gs);
    const value = (gs: st.Game[]) => { const r = report(gs); return Object.fromEntries(METRICS.map(([k, path]) => [k, at(r, path) ?? null])); };
    const result: Record<string, unknown> = { players: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), metrics: {} };
    const up = value(groups.up);
    const down = value(groups.down);
    const same = value(groups.same);
    // chance: the spread of the up−down difference when the groups are resampled
    const rand = rng(99);
    const pick = (gs: st.Game[]) => Array.from({ length: gs.length }, () => gs[Math.floor(rand() * gs.length)]);
    const diffs: Record<string, number[]> = Object.fromEntries(METRICS.map(([k]) => [k, []]));
    for (let s = 0; s < 60; s++) {
      const u = value(pick(groups.up));
      const d = value(pick(groups.down));
      for (const [k] of METRICS) if (u[k] != null && d[k] != null) diffs[k].push(u[k]! - d[k]!);
    }
    for (const [k, , lower] of METRICS) {
      const ds = diffs[k];
      const m = ds.reduce((a, x) => a + x, 0) / Math.max(1, ds.length);
      const sd = Math.sqrt(ds.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, ds.length - 1));
      const diff = up[k] != null && down[k] != null ? up[k]! - down[k]! : null;
      const real = diff !== null && Math.abs(diff) > 2 * sd;
      (result.metrics as Record<string, unknown>)[k] = { up: up[k], same: same[k], down: down[k], diff, sd: Number(sd.toFixed(2)), real,
        risers_better: diff === null ? null : (diff < 0) === lower };
      console.log(`${k.padEnd(12)} up ${up[k]} · same ${same[k]} · down ${down[k]} · diff ${diff?.toFixed(2)} ± ${(2 * sd).toFixed(2)}${real ? '  ← real' : ''}`);
    }
    writeFileSync(out!, JSON.stringify(result, null, 1));
    expect(groups.up.length + groups.down.length).toBeGreaterThan(0);
  }, 7_200_000);
});
