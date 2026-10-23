// Benchmarks from Lichess (not part of the normal run): BENCH_PGN = a PGN of sampled Lichess games, BENCH_OUT = where
// the results go (JSON lines, one game each: its Stockfish evaluations, so the stats can be rebuilt for either side),
// BENCH_ENGINE = a Stockfish on this computer. The same pipeline as your own games (parseGame → searchGame, depth 14,
// the hash cleared per game), with native Stockfish on every core. Resumes: games already in BENCH_OUT are skipped.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import { type Engine, type InfoLine, parseInfo } from '../src/core/engine';
import { makeGame } from '../src/core/models';
import { CONFIG, type Eval, parseGame, searchGame, toSearch } from '../src/core/weak/analysis';
import { Book } from '../src/core/weak/book';

const pgnPath = process.env.BENCH_PGN;
const outPath = process.env.BENCH_OUT;
const enginePath = process.env.BENCH_ENGINE ?? '/usr/games/stockfish';
const LIMIT = Number(process.env.BENCH_LIMIT ?? 0);          // (a smaller run, for timing)

/** A native Stockfish over UCI with the app's settings (one thread, 16 MB hash), one search at a time. */
function uciEngine(path: string): Engine & { newGame(): Promise<void>; quit(): void } {
  const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let onLine: ((l: string) => void) | null = null;
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); onLine?.(l); }
  });
  let queue: Promise<unknown> = Promise.resolve();
  const send = (c: string) => proc.stdin.write(`${c}\n`);
  send('uci');
  send(`setoption name Threads value ${CONFIG.threads}`);
  send(`setoption name Hash value ${CONFIG.hash_mb}`);
  const until = (word: string) => new Promise<void>((resolve) => { onLine = (l) => { if (l.startsWith(word)) { onLine = null; resolve(); } }; });
  return {
    analyse(board, limit) {
      const run = queue.then(() => new Promise<InfoLine[]>((resolve) => {
        let last: InfoLine | null = null;
        onLine = (l) => {
          if (l.startsWith('info') && l.includes(' pv ') && !l.includes('bound')) { const x = parseInfo(l, board.turn); if (x) last = x; }
          if (l.startsWith('bestmove')) { onLine = null; resolve(last ? [last] : []); }
        };
        send('setoption name MultiPV value 1');
        send(`position fen ${board.fen()}`);
        send(`go depth ${limit.depth ?? CONFIG.depth}`);
      }));
      queue = run.catch(() => undefined);
      return run;
    },
    newGame() {
      const run = queue.then(async () => { const ok = until('readyok'); send('ucinewgame'); send('isready'); await ok; });
      queue = run.catch(() => undefined);
      return run;
    },
    quit() { send('quit'); },
  };
}

/** The games in a PGN file, as (headers, text) pairs. */
function games(path: string): { headers: Map<string, string>; pgn: string }[] {
  return readFileSync(path, 'utf8').split(/\n\n(?=\[Event )/).filter((g) => g.trim()).map((pgn) => {
    const headers = new Map<string, string>();
    for (const m of pgn.matchAll(/^\[(\w+) "([^"]*)"\]$/gm)) headers.set(m[1], m[2]);
    return { headers, pgn: pgn.trim() };
  });
}

describe.skipIf(!pgnPath || !outPath)('Lichess benchmarks: analysing the games', () => {
  it('searches every position the stats read, both players\' moves', async () => {
    const lib = JSON.parse(readFileSync(new URL('../public/openings/library.json', import.meta.url), 'utf8'));
    const ucisAt = lib.columns.indexOf('ucis');
    const book = new Book(lib.rows.map((r: unknown[]) => ({ eco: r[0] as string, name: r[1] as string, ucis: r[ucisAt] as string })));
    const done = new Set(existsSync(outPath!) ? readFileSync(outPath!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
    let todo = games(pgnPath!).filter((g) => !done.has(g.headers.get('Site')));
    if (LIMIT) todo = todo.slice(0, LIMIT);
    const n = Math.max(1, cpus().length);
    const engines = Array.from({ length: n }, () => uciEngine(enginePath));
    const t0 = Date.now();
    let finished = 0;
    let positions = 0;
    let next = 0;
    await Promise.all(engines.map(async (engine) => {
      while (next < todo.length) {
        const g = todo[next++];
        const h = g.headers;
        const date = `${(h.get('UTCDate') ?? '').replaceAll('.', '-')}T${h.get('UTCTime') ?? '00:00:00'}Z`;
        // White's side drives the search: the positions (and so the evaluations) are the same for both
        const game = makeGame({ id: h.get('Site')!, chess_com_url: h.get('Site')!, pgn: g.pgn, played_at: date, time_control: h.get('TimeControl')!,
          my_color: 'white', opponent_username: h.get('Black') ?? '', result: h.get('Result') === '1-0' ? 'win' : h.get('Result') === '0-1' ? 'loss' : 'draw' });
        const parsed = parseGame(game, book);
        if (!parsed) continue;
        const keys = toSearch(parsed[1], new Set());
        const evals: Map<string, Eval> = await searchGame(engine, keys);
        positions += keys.length;
        appendFileSync(outPath!, `${JSON.stringify({ id: game.id, tc: game.time_control, white_elo: Number(h.get('WhiteElo')), black_elo: Number(h.get('BlackElo')),
          result: h.get('Result'), date, eco: h.get('ECO'), opening: h.get('Opening'), evals: Object.fromEntries(evals) })}\n`);
        finished += 1;
        if (finished % 25 === 0) {
          const s = (Date.now() - t0) / 1000;
          console.log(`${finished}/${todo.length} games · ${positions} positions · ${(s / finished).toFixed(2)} s/game · ~${Math.round(((todo.length - finished) * s) / finished / 60)} min left`);
        }
      }
      engine.quit();
    }));
    console.log(`done: ${finished} games, ${positions} positions in ${Math.round((Date.now() - t0) / 1000)} s`);
    expect(finished).toBeGreaterThanOrEqual(0);
  }, 86_400_000);
});
