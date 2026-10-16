// End-to-end check in a real browser (headless Firefox, tests/e2e/run.sh):
// the database worker on OPFS, importing your real database, backup, players,
// real Stockfish (one engine and the 2-engine pool on one of your games), the
// app shell and the board — then, after a reload (?phase=2), that it all stayed;
// and (?phase=ui, a fresh browser) the app opened first on an empty database.
// Results go to the test server's /report.
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { evaluateGame } from '../../src/core/analyzer';
import { Board } from '../../src/core/chess';
const ChessBoardFen = (fen: string) => Board.fromFen(fen);
import { rowToGame } from '../../src/core/db';
import { DbClient } from '../../src/data/client';
import { runPool } from '../../src/engine/pool';
import { startStockfish } from '../../src/engine/stockfish';
import { App } from '../../src/ui/App';
import type { DrillController } from '../../src/ui/drillController';
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
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })))   // as main.tsx;
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

/** A fresh browser: the app opens first (empty), then your database comes in through Your data. */
async function phaseUi(client: DbClient) {
  const errors: string[] = [];
  results.pageErrors = errors;
  addEventListener('error', (e) => errors.push(`${e.message} ${e.error?.stack}`));
  addEventListener('unhandledrejection', (e) => errors.push(e.reason instanceof Error ? `${e.reason.message} ${e.reason.stack}` : String(e.reason)));
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })));
  // an empty database: the empty board and "No puzzles yet" (not "Loading puzzles…" for ever)
  await waitFor('the empty queue', () => document.querySelector('.queue-card > p.note')?.textContent?.startsWith('No puzzles'), 120_000);
  results.before = document.querySelector('.queue-card > p.note')!.textContent;
  nav('Your data');
  const input = await waitFor('the file input', () => document.querySelector('input[type=file]') as HTMLInputElement | null);
  const bytes = await (await fetch('/fixture/snapshot.db')).arrayBuffer();
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'chessprep.db'));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor('the import', () => [...document.querySelectorAll('.ok, .error')].find((n) => n.textContent), 120_000);
  results.importMessage = [...document.querySelectorAll('.ok, .error')].map((n) => n.textContent);
  nav('Puzzle Review');
  await new Promise((r) => setTimeout(r, 3000));
  results.after = { rows: document.querySelectorAll('.queue li').length, note: document.querySelector('.queue-card > p.note')?.textContent,
    status: statusText() };

  // one new game analyzed and saved through Import & Analyze
  nav('Import & Analyze');
  const perRun = await waitFor('games per run', () => document.querySelector('input[aria-label="Games per run"]') as HTMLInputElement | null);
  await new Promise((r) => setTimeout(r, 1000));          // the saved settings filled in
  setInput(perRun, '1');
  // your saved focus is "All except Bullet" and every such game is analyzed: the waiting ones are bullet
  const focus = document.querySelector('.import-cards select') as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(focus, 'All games');
  focus.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const t = performance.now();
  button('Analyze new games').click();
  const snap = () => ({ job: document.querySelector('.job')?.textContent, notice: document.querySelector('.notice')?.textContent,
    error: document.querySelector('.main > section > .error')?.textContent });
  await new Promise((r) => setTimeout(r, 5000));
  results.analyze5s = snap();
  await waitFor('the analysis', () => document.querySelector('.notice > span')?.textContent?.startsWith('Analyzed'), 240_000);
  const notice = document.querySelector('.notice > span')!.textContent;
  await waitFor('the games line', () => document.querySelector('.import-cards .pre')?.textContent?.includes('2501 analyzed'), 10_000);
  results.analyzeOne = { ms: ms(t), notice, games: document.querySelector('.import-cards .pre')!.textContent };
}

/** Where things land on Puzzle Review at this window size (run after phase=ui, same profile). */
async function phaseLayout(client: DbClient) {
  createRoot(document.getElementById('root')!).render(createElement(App, { client }));
  await waitFor('a puzzle', () => document.querySelectorAll('.queue li').length > 0 && document.querySelectorAll('cg-board piece').length > 0, 120_000);
  const box = (sel: string) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  results.layout = { window: [innerWidth, innerHeight], board: box('.board-wrap'), card: box('.board-card'), buttons: box('.puzzle-buttons'),
    status: box('.status'), queue: box('.queue-card'), commentary: box('.commentary-card'), scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    mainScroll: [document.querySelector('.main')!.scrollHeight, document.querySelector('.main')!.clientHeight] };
}

/** Changing your mind: pick one piece, then another, and move the second (run after phase=ui). */
async function phaseSelect(client: DbClient) {
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })));
  await waitFor('a puzzle', () => document.querySelectorAll('.queue li').length > 0 && document.querySelectorAll('cg-board piece').length > 0, 120_000);
  const c = (window as unknown as { puzzles: PuzzleController }).puzzles;
  await waitFor('details', () => c.details, 30_000);
  await new Promise((r) => setTimeout(r, 1000));
  const move = c.puzzle!.correct_move_uci;
  const other = c.board.legalMoves().find((m) => m.slice(0, 2) !== move.slice(0, 2))!;
  const selected = () => document.querySelector('cg-board square.selected') ? 'yes' : 'no';
  const cgState = () => { const st = (window as unknown as { cg: { state: any } }).cg.state;
    return { color: st.movable.color, turn: st.turnColor, dests: st.movable.dests ? st.movable.dests.size : null, selected: st.selected,
      viewOnly: st.viewOnly, orientation: st.orientation }; };
  results.cgBefore = cgState();
  await clickSquare(other.slice(0, 2));
  results.cgAfterFirst = cgState();
  const first = { square: other.slice(0, 2), selected: selected(), dests: document.querySelectorAll('cg-board square.move-dest').length };
  await clickSquare(move.slice(0, 2));
  const second = { square: move.slice(0, 2), selected: selected(), dests: document.querySelectorAll('cg-board square.move-dest').length };
  await clickSquare(move.slice(2, 4));
  await waitFor('the answer', () => c.state !== 'solving', 10_000);      // saving your first try comes first
  const rect = (sel: string) => { const r = document.querySelector(sel)!.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
  results.select = { first, second, move, status: statusText(), state: c.state, turn: c.board.turn,
    wrapClass: document.querySelector('.board.cg-wrap')?.className, boardRect: rect('cg-board'), wrapRect: rect('.board-wrap'),
    containerRect: rect('cg-container'), pieces: document.querySelectorAll('cg-board piece').length };
}

/** Opening Drill on your repertoire: start a line and play it to the end by clicking (run after phase=ui). */
async function phaseDrill(client: DbClient) {
  const errors: string[] = [];
  results.pageErrors = errors;
  addEventListener('error', (e) => errors.push(`${e.message} ${e.error?.stack}`));
  addEventListener('unhandledrejection', (e) => errors.push(e.reason instanceof Error ? `${e.reason.message} ${e.reason.stack}` : String(e.reason)));
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })));
  await waitFor('the app', () => document.querySelector('.level-card'), 120_000);
  nav('Opening Drill');
  const c = (window as unknown as { drill: DrillController }).drill;
  await waitFor('the repertoires', () => c.repertoires.length > 0 && c.variations.length > 0 && c.status.text, 30_000);
  results.drillSetup = { repertoires: c.repertoires.length, first: c.repertoire, variations: c.variations.length,
    view: c.view, status: statusText() };
  // the screen redraws a moment after the data arrives: wait for the button to be live
  await waitFor('Start drill enabled', () => { const b = button(c.startLabel); return b && !b.disabled; }, 10_000);
  button(c.startLabel).click();
  await waitFor('a line', () => c.drill && c.status.text.endsWith('Your move.'), 10_000);
  const statuses: string[] = [statusText()];
  let moves = 0;
  while (c.drill && !c.drill.finished && moves < 30) {
    await waitFor('your turn', () => c.drill!.finished || (c.drill!.myTurn && c.board().movable), 10_000);
    if (c.drill.finished) break;
    const uci = c.drill.path[c.drill.index].uci;
    const cgs = () => { const st = (window as unknown as { cg: { state: any } }).cg.state;
      return { color: st.movable.color, turn: st.turnColor, dests: st.movable.dests?.size ?? null, selected: st.selected ?? null,
        orientation: st.orientation, fen: st.pieces.size }; };
    results.drillDebug = { uci, before: cgs(), status: c.status.text, dom: statusText(), myTurn: c.drill.myTurn, movable: c.board().movable };
    await clickSquare(uci.slice(0, 2));
    (results.drillDebug as Record<string, unknown>).afterFirst = cgs();
    await clickSquare(uci.slice(2, 4));
    (results.drillDebug as Record<string, unknown>).afterSecond = { ...cgs(), status: c.status.text, index: c.drill.index };
    moves += 1;
    await waitFor('the answer', () => statusText().startsWith('Correct') || statusText().startsWith('Not'), 10_000);
    statuses.push(statusText());
    await waitFor('the reply', () => c.drill!.finished || !statusText().startsWith('Correct'), 10_000);
    statuses.push(statusText());
  }
  await waitFor('the end of the line', () => statusText().startsWith('End of line'), 10_000);
  results.drill = { line: c.drill!.lineName, myMoves: moves, statuses: statuses.slice(0, 6), end: statusText(),
    recap: document.querySelector('.commentary-card .explanation')?.textContent, plans: c.plans?.title ?? null };

  // the Tree: drawn, a click on a move shows it, a new branch, Discard
  button('Tree').click();
  const t = c.tree;
  await waitFor('the tree', () => t.tree && document.querySelectorAll('.tree-view svg path').length > 3, 30_000);
  const box = (sel: string) => { const r = document.querySelector(sel)!.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
  results.tree = { scope: t.scope, leaves: t.tree!.leaves.length, paths: document.querySelectorAll('.tree-view svg path').length,
    svg: box('.tree-view svg'), view: box('.tree-view'), board: box('.board-wrap'), lineLabel: t.lineLabel, moves: t.movesLabel,
    title: document.querySelector('.board-card .game-label')?.textContent };
  // click (mouse down + up) on the first leaf's position in the drawing
  const leaf = t.tree!.leaves[0][2];
  const svg = document.querySelector('.tree-view svg') as SVGSVGElement;
  const sr = svg.getBoundingClientRect();
  const at = { bubbles: true, clientX: sr.left + leaf.x, clientY: sr.top + leaf.y, button: 0 };
  svg.dispatchEvent(new MouseEvent('mousedown', at));
  svg.dispatchEvent(new MouseEvent('mouseup', at));
  await waitFor('the leaf on the board', () => t.node === leaf, 5000);
  results.treeClick = { moves: t.movesLabel, status: statusText(), title: document.querySelector('.board-card .game-label')?.textContent,
    fen: c.board().fen, line: t.lineLabel };
  await t.step(-1);
  const back = t.node!;
  // the board redraws a moment later: wait until it takes moves for both sides at this position
  const ready = () => { const st = (window as unknown as { cg: { state: any } }).cg.state;
    return { color: st.movable.color, dests: st.movable.dests?.size ?? null, last: st.lastMove ?? null, want: back.move?.move_uci,
      exploring: t.exploring(), boardMovable: c.board().movable, view: c.view, drill: !!c.drill }; };
  setTimeout(() => { if (!t.draft.length) results.readyState = ready(); }, 4900);
  await waitFor('the board ready', () => {
    const st = (window as unknown as { cg: { state: any } }).cg.state;
    return st.movable.color === st.turnColor && st.movable.dests?.size > 0 && st.lastMove?.join('') === back.move?.move_uci.slice(0, 4);
  }, 5000);
  const legal = ChessBoardFen(c.board().fen).legalMoves().find((m) => !back.children.some((ch) => ch.move!.move_uci === m))!;
  const snap = () => { const st = (window as unknown as { cg: { state: any } }).cg.state;
    return { node: t.node?.path.map((m) => m.move_uci).join(' ').slice(-24), draft: [...t.draft], selected: st.selected ?? null,
      last: st.lastMove ?? null, status: c.status.text.slice(0, 60) }; };
  results.draftTrace = [{ legal, ...snap() }];
  await clickSquare(legal.slice(0, 2));
  (results.draftTrace as unknown[]).push(snap());
  await clickSquare(legal.slice(2, 4));
  (results.draftTrace as unknown[]).push(snap());
  await new Promise((r) => setTimeout(r, 800));
  (results.draftTrace as unknown[]).push(snap());
  await waitFor('a new branch', () => t.draft.length === 1, 5000);
  results.treeDraft = { draft: t.draft, label: t.lineLabel, status: statusText(), saveButton: !!button('Save branch') };
  button('Discard').click();
  await waitFor('discarded', () => t.draft.length === 0, 5000);

  // My games: the report, a deviation on the board with Stockfish's commentary
  button('My games').click();
  await waitFor('the report', () => c.myGames.report && !c.myGames.loading, 60_000);
  const g = c.myGames;
  results.myGames = { summary: g.summary(), openings: g.openings.length, deviations: g.shown.length };
  if (g.shown.length) {
    const t0 = performance.now();
    await c.openMyDeviation(g.shown[0]);
    await waitFor('the commentary', () => g.text && !g.text.includes('Stockfish is looking'), 60_000);
    results.myGamesPick = { ms: ms(t0), title: document.querySelector('.board-card .game-label')?.textContent, status: statusText(),
      arrows: c.board().arrows.length, text: g.text.slice(0, 400) };
  }

  // the opening library: loads the pre-built lines, searches, previews
  button('Add lines').click();
  await waitFor('the library button', () => button('Opening library — all named openings…'), 5000);
  let t1 = performance.now();
  button('Opening library — all named openings…').click();
  await waitFor('the library', () => document.querySelectorAll('.library-lines .queue li button').length > 100, 60_000);
  results.library = { loadMs: ms(t1), count: document.querySelector('.library > p.note')?.textContent,
    rows: document.querySelectorAll('.library-lines .queue li button').length };
  const search = document.querySelector('.library input[aria-label="Search"]') as HTMLInputElement;
  setInput(search, 'Najdorf');
  await waitFor('the search', () => (document.querySelector('.library-lines .queue li button')?.textContent ?? '').includes('Najdorf'), 10_000);
  (document.querySelector('.library-lines .queue li button') as HTMLButtonElement).click();
  t1 = performance.now();
  await waitFor('the preview', () => document.querySelector('.library-preview h3'), 10_000);
  results.libraryPick = { ms: ms(t1), title: document.querySelector('.library-preview h3')!.textContent,
    flag: document.querySelector('.library-preview .flag')?.textContent, pieces: document.querySelectorAll('.library-preview cg-board piece').length,
    games: document.querySelector('.library-preview .pre')?.textContent?.slice(0, 200) };
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
    else if (phase === 'ui') await phaseUi(client);
    else if (phase === 'layout') await phaseLayout(client);
    else if (phase === 'select') await phaseSelect(client);
    else if (phase === 'drill') await phaseDrill(client);
    else await phase2(client);
    results.ok = true;
  } catch (e) {
    results.ok = false;
    results.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
  }
  await report(results);
  await report({ done: true });
})();
