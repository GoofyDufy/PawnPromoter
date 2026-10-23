// Puzzle difficulty from rated Lichess puzzles (not part of the normal run): PD_OUT = where to write the table.
// Reads the app's Lichess puzzle packs (public/lichess, ~75,000 puzzles across ratings), describes each puzzle
// (puzzleDifficulty.features), and keeps the median rating per kind of puzzle — learnt on 80% of them and tested on
// the other 20%, against simply guessing the overall median.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import { type DifficultyTable, features, keysFor } from '../src/core/puzzleDifficulty';

const out = process.env.PD_OUT;
const MIN = 30;                       // puzzles a kind needs before it gets its own rating
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

describe.skipIf(!out)('puzzle difficulty from Lichess puzzles', () => {
  it('learns a rating per kind of puzzle, and checks it on puzzles it has not seen', () => {
    const dir = new URL('../public/lichess/', import.meta.url);
    const rows = new Map<string, string[]>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.csv.gz'))) {
      const text = gunzipSync(readFileSync(new URL(f, dir))).toString('utf8');
      for (const line of text.split('\n').slice(1)) { const r = line.split(','); if (r.length > 7) rows.set(r[0], r); }
    }
    const items: { keys: string[]; first: string[]; rating: number; id: string }[] = [];
    for (const [id, r] of rows) {
      const moves = r[2].split(' ');
      const b = Board.fromFen(r[1]);
      if (!b.isLegal(moves[0])) continue;
      b.push(moves[0]);                          // Lichess: the first move is the opponent's, then it's your puzzle
      const f = features(b.fen(), moves.slice(1));
      const g = features(b.fen(), moves.slice(1, 2), false);         // only the first move known: no length
      if (f && g) items.push({ keys: keysFor(f), first: keysFor(g), rating: Number(r[3]), id });
    }
    // 80% to learn from, 20% to test on (by id, so it's the same split each time)
    const test = items.filter((x) => x.id.charCodeAt(x.id.length - 1) % 5 === 0);
    const train = items.filter((x) => x.id.charCodeAt(x.id.length - 1) % 5 !== 0);
    const groups = new Map<string, number[]>();
    for (const x of train) for (const k of [...x.keys, ...x.first]) (groups.get(k) ?? groups.set(k, []).get(k)!).push(x.rating);
    const table: DifficultyTable['table'] = {};
    for (const [k, rs] of groups) if (rs.length >= MIN) table[k] = [median(rs), rs.length];
    const overall = median(train.map((x) => x.rating));
    const guess = (keys: string[]) => { for (const k of keys) if (table[k]) return table[k][0]; return overall; };
    const mae = test.reduce((a, x) => a + Math.abs(guess(x.keys) - x.rating), 0) / test.length;
    const baseline = test.reduce((a, x) => a + Math.abs(overall - x.rating), 0) / test.length;
    const maeFirst = test.reduce((a, x) => a + Math.abs(guess(x.first) - x.rating), 0) / test.length;
    console.log(`${items.length} puzzles · ${Object.keys(table).length} kinds · error on unseen puzzles ${mae.toFixed(0)} (first move only: ${maeFirst.toFixed(0)}) vs ${baseline.toFixed(0)} guessing the median`);
    const t: DifficultyTable = { table, overall, mae: Math.round(mae), baseline_mae: Math.round(baseline), mae_first_move: Math.round(maeFirst) };
    writeFileSync(out!, JSON.stringify(t));
    expect(items.length).toBeGreaterThan(1000);
  }, 3_600_000);
});
