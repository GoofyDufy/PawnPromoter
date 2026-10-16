// End-to-end check in a real browser (headless Firefox, tests/e2e/run.sh):
// the database worker on OPFS, importing your real database, backup, players,
// real Stockfish (one engine and the 2-engine pool on one of your games), the
// app shell and the board — then, after a reload (?phase=2), that it all stayed.
// Results go to the test server's /report.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { evaluateGame } from '../../src/core/analyzer';
import { Board } from '../../src/core/chess';
import { rowToGame } from '../../src/core/db';
import { DbClient } from '../../src/data/client';
import { runPool } from '../../src/engine/pool';
import { startStockfish } from '../../src/engine/stockfish';
import { App } from '../../src/ui/App';
import type { PuzzleController } from '../../src/ui/puzzleController';
import '../../src/ui/styles.css';

const phase = new URLSearchParams(location.search).get('phase') ?? '1';
const results: Record<string, unknown> = { phase };
const report = (data: object) => fetch('/report', { method: 'POST', body: JSON.stringify(data) });
const ms = (t: number) => Math.round(performance.now() - t);

function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (performance.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function phase1(client: DbClient) {
  let t = performance.now();
  results.profiles = await client.init();
  results.initMs = ms(t);
  results.initSteps = await client.timings();

  // import your real database (the snapshot) into the current player
  t = performance.now();
  const bytes = new Uint8Array(await (await fetch('/fixture/snapshot.db')).arrayBuffer());
  results.importBytes = bytes.byteLength;
  await client.importDb(bytes, false);
  results.importMs = ms(t);
  t = performance.now();
  results.summary = await client.service('summary');
  results.summaryMs = ms(t);

  t = performance.now();
  results.backupBytes = (await client.exportDb()).byteLength;
  results.backupMs = ms(t);

  const added = await client.addProfile('E2E Second');
  const back = await client.switchProfile((results.profiles as { current: string }).current);
  results.players = { afterAdd: added, afterSwitchBack: back.current };

  // real Stockfish: one search, then two of your games with the 2-engine pool
  t = performance.now();
  const engine = await startStockfish();
  results.engine = { name: engine.name, startMs: ms(t) };
  t = performance.now();
  const lines = await engine.analyse(Board.fromFen(), { depth: 12 }, 3);
  results.engine = { ...(results.engine as object), searchMs: ms(t), lines: lines.map((l) => l.pv[0]) };

  const rows = await client.query('SELECT * FROM games WHERE evaluated_at IS NOT NULL ORDER BY played_at DESC LIMIT 2');
  const games = rows.map((r) => rowToGame(r as Record<string, unknown>));
  const stored = await client.query<{ game_id: string; ply: number; best_move_uci: string }>(
    `SELECT game_id, ply, best_move_uci FROM move_evaluations WHERE game_id IN (?, ?)`, games.map((g) => g.id));
  const storedBest = new Map(stored.map((s) => [`${s.game_id}:${s.ply}`, s.best_move_uci]));
  const second = await startStockfish();
  t = performance.now();
  let evaluated = 0;
  let agree = 0;
  await runPool([engine, second], games, (e, g) => evaluateGame(g, e), (_g, evs) => {
    evaluated += evs.length;
    agree += evs.filter((ev) => storedBest.get(`${ev.game_id}:${ev.ply}`) === ev.best_move_uci).length;
  });
  results.analysis = { games: games.length, moves: evaluated, ms: ms(t), sameBestMoveAsDesktop: agree };
  engine.quit();
  second.quit();

  // the app itself: the shell renders, the analysis board shows a board and Stockfish's lines
  // the same client: browser storage lets one worker at a time open the databases, as in the app
  createRoot(document.getElementById('root')!).render(createElement(App, { client }));
  await waitFor('the level card', () => document.querySelector('.level-card'));
  results.levelCard = document.querySelector('.level-card')!.textContent;
  nav('Analysis board');
  await waitFor('the board', () => document.querySelectorAll('cg-board piece').length === 32);
  results.boardPieces = document.querySelectorAll('cg-board piece').length;
  t = performance.now();
  await waitFor('engine lines', () => document.querySelectorAll('.line').length >= 1, 60_000);
  results.uiEngine = { firstLinesMs: ms(t), lines: [...document.querySelectorAll('.line')].map((l) => l.textContent) };

  // Puzzle Review: the queue, then solving the puzzle by clicking the board as you would
  nav('Puzzle Review');
  await waitFor('the puzzle queue', () => document.querySelectorAll('.queue li').length > 0);
  const c = (window as unknown as { puzzles: PuzzleController }).puzzles;
  results.puzzles = { queue: document.querySelectorAll('.queue li').length, firstRow: document.querySelector('.queue li')?.textContent,
    prompt: statusText() };
  // a one-move puzzle (its line saved), so the answer is final at once
  const one = c.queue.findIndex((p) => p.solution_ucis && p.solution_ucis.split(' ').length === 1);
  if (one >= 0) {
    (document.querySelectorAll('.queue li button')[one] as HTMLButtonElement).click();
    await waitFor('the puzzle', () => c.puzzle === c.queue[one] && c.details);
    const move = c.puzzle!.correct_move_uci;
    await clickSquare(move.slice(0, 2));
    await clickSquare(move.slice(2, 4));
    await waitFor('solved', () => statusText().startsWith('Correct'), 10_000);
    t = performance.now();
    await waitFor('the explanation', () => !document.querySelector('.explanation')?.textContent?.startsWith('Working'), 30_000);
    results.solved = { move: c.puzzle!.correct_move_san, status: statusText(), explanationMs: ms(t),
      explanation: document.querySelector('.explanation')?.textContent, record: c.recordLabel() };
  }

  // Import & Analyze: rebuild at the same blunder size (instant), and Lichess puzzles from the packs
  nav('Import & Analyze');
  await waitFor('the games line', () => document.querySelector('.import-cards .pre')?.textContent);
  results.importScreen = document.querySelector('.import-cards .pre')!.textContent;
  t = performance.now();
  button('Apply blunder size (instant)').click();
  await waitFor('the rebuild', () => document.querySelector('.notice')?.textContent, 120_000);
  results.rebuild = { ms: ms(t), notice: document.querySelector('.notice > span')!.textContent };
  const count = document.querySelector('input[aria-label="How many puzzles"]') as HTMLInputElement;
  setInput(count, '25');
  t = performance.now();
  button('Add Lichess puzzles').click();
  await waitFor('the Lichess puzzles', () => [...document.querySelectorAll('.note')].find((n) => n.textContent?.startsWith('Added ')), 120_000);
  results.lichess = { ms: ms(t), text: [...document.querySelectorAll('.note')].find((n) => n.textContent?.startsWith('Added '))!.textContent };
}

const statusText = () => document.querySelector('.status')?.textContent ?? '';

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
}

function nav(label: string) {
  ([...document.querySelectorAll('.nav button')].find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement).click();
}

/** Types into a React-controlled input. */
function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A click on a square of the board, as chessground sees one (mouse down + up, no drag). */
async function clickSquare(square: string) {
  const board = document.querySelector('cg-board') as HTMLElement;
  const r = board.getBoundingClientRect();
  const white = !document.querySelector('.cg-wrap.orientation-black');
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const x = r.left + ((white ? file : 7 - file) + 0.5) * (r.width / 8);
  const y = r.top + ((white ? 7 - rank : rank) + 0.5) * (r.height / 8);
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  board.dispatchEvent(new MouseEvent('mousedown', opts));
  document.dispatchEvent(new MouseEvent('mouseup', opts));
  await new Promise((res) => setTimeout(res, 150));
}

async function phase2(client: DbClient) {
  const t = performance.now();
  results.profiles = await client.init();
  results.reopenMs = ms(t);
  results.reopenSteps = await client.timings();
  results.summary = await client.service('summary');
}

(async () => {
  const client = new DbClient();
  try {
    if (phase === '1') await phase1(client);
    else await phase2(client);
    results.ok = true;
  } catch (e) {
    results.ok = false;
    results.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
  }
  await report(results);
  await report({ done: true });
})();
