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
import { setEngineStrength, sharedEngine, startStockfish } from '../../src/engine/stockfish';
import { App } from '../../src/ui/App';
import type { DrillController } from '../../src/ui/drillController';
import type { Jobs } from '../../src/ui/jobs';
import type { ReviewController } from '../../src/ui/reviewController';
import type { Trainers } from '../../src/ui/screens/TrainerScreen';
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

const pawnsText = (cp: number | null) => (cp === null ? '?' : (cp / 100).toFixed(1));
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
async function clickSquare(square: string, root: ParentNode = document) {
  const board = root.querySelector('cg-board') as HTMLElement;
  const r = board.getBoundingClientRect();
  const white = !root.querySelector('.cg-wrap.orientation-black');
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
    if (moves === 0) {
      // a wrong move first: it says so, and you can play again straight away (Show correct move offered)
      const wrong = Board.fromFen(c.drill.fen).legalMoves().find((m) => m !== uci)!;
      await clickSquare(wrong.slice(0, 2));
      await clickSquare(wrong.slice(2, 4));
      await waitFor('the miss', () => statusText().startsWith('Not'), 10_000);
      results.drillMiss = { status: statusText(), movable: c.board().movable, reveal: !!button('Show correct move'), tryAgain: !!button('Try again'),
        piecesBack: (window as unknown as { cg: { getFen(): string } }).cg.getFen() === c.drill.fen.split(' ')[0] };
      button('Show full line').click();
      await waitFor('the full line', () => document.querySelectorAll('.full-line .move-pair').length > 0, 5000);
      results.drillFullLine = { pairs: document.querySelectorAll('.full-line .move-pair').length,
        colours: [...new Set([...document.querySelectorAll('.full-line .move-pair')].slice(0, 3).map((p) => getComputedStyle(p).backgroundColor))].length };
      button('Hide full line').click();
      await waitFor('your turn again', () => c.board().movable, 5000);
    }
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

  // Play it out from the end of the line: the board is there, a move works, Stockfish answers
  button('Play it out').click();
  await waitFor('the game window', () => document.querySelector('dialog.play-dialog[open] cg-board piece'), 10_000);
  const dlg = document.querySelector('dialog.play-dialog[open]')!;
  const rect = dlg.querySelector('cg-board')!.getBoundingClientRect();
  const dlgStatus = () => dlg.querySelector('.status')?.textContent ?? '';
  results.drillPlay = { board: [Math.round(rect.width), Math.round(rect.height)], pieces: dlg.querySelectorAll('cg-board piece').length,
    status: dlgStatus(), fen: (window as unknown as { cg: { getFen(): string } }).cg.getFen() };
  await waitFor('your move in the game window', () => dlgStatus() === 'Your move.', 30_000);
  const st = (dlg.querySelector('.cg-wrap') as unknown as { cg: { state: any } }).cg.state;   // the window's board, not the drill's
  const [from, tos] = [...st.movable.dests.entries()][0] as [string, string[]];
  await clickSquare(from, dlg);
  await clickSquare(tos[0], dlg);
  await waitFor('Stockfish to answer', () => (dlg.querySelector('.moves')?.textContent ?? '').trim().split(/\s+/).filter((w) => !/^\d+\./.test(w)).length >= 2, 30_000);
  results.drillPlay = { ...(results.drillPlay as object), played: from + tos[0], moves: dlg.querySelector('.moves')?.textContent, after: dlgStatus() };
  dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
  await waitFor('the window closed', () => !document.querySelector('dialog.play-dialog'), 5000);

  // the Tree: drawn, a click on a move shows it, a new branch, Discard
  button('Tree').click();
  const t = c.tree;
  // the move list (the default view; this profile may remember the drawing): click a move in it
  await waitFor('the view switch', () => button('Moves'), 30_000);
  button('Moves').click();
  await waitFor('the move list', () => t.tree && document.querySelectorAll('.tree-moves .tm-move').length > 5, 30_000);
  button('Unfold all').click();
  await new Promise((r) => setTimeout(r, 300));
  const listMoves = [...document.querySelectorAll('.tree-moves .tm-branch .tm-move')] as HTMLButtonElement[];
  listMoves[2].click();
  await waitFor('the move selected', () => document.querySelector('.tree-moves .tm-move.selected')?.textContent === listMoves[2].textContent, 5000);
  results.treeList = { moves: listMoves.length, clicked: listMoves[2].textContent, shown: t.movesLabel,
    names: [...document.querySelectorAll('.tree-moves .tm-name')].map((n) => n.textContent),
    families: [...document.querySelectorAll('.tree-moves .tm-family')].map((n) => n.textContent) };
  // filter: by name, then only one opening, then clear
  setInput(document.querySelector('input[aria-label="Filter openings"]') as HTMLInputElement, 'slav');
  await waitFor('the filtered tree', () => t.filterText === 'slav' && t.lineCounts.shown < t.lineCounts.total, 10_000);
  results.treeFilter = { text: t.filterText, counts: { ...t.lineCounts }, names: [...document.querySelectorAll('.tree-moves .tm-name')].map((n) => n.textContent),
    chips: [...document.querySelectorAll('.opening-chips .chip')].map((b) => b.textContent) };
  button('Clear').click();
  await waitFor('cleared', () => !t.filtering(), 10_000);
  // then the drawing
  button('Drawing').click();
  await waitFor('the tree', () => t.tree && document.querySelectorAll('.tree-view svg path').length > 3, 30_000);
  await t.select(t.tree!.root);                       // the whole tree again (the list's click zoomed into one first move)
  await new Promise((r) => setTimeout(r, 500));
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

/** Tactics & Threats on your games: a round of each drill (run after phase=ui). */
async function phaseTrainer(client: DbClient) {
  const errors: string[] = [];
  results.pageErrors = errors;
  addEventListener('error', (e) => errors.push(`${e.message} ${e.error?.stack}`));
  addEventListener('unhandledrejection', (e) => errors.push(e.reason instanceof Error ? `${e.reason.message} ${e.reason.stack}` : String(e.reason)));
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })));
  await waitFor('the app', () => document.querySelector('.level-card'), 120_000);
  nav('Tactics & Threats');
  const tr = (window as unknown as { trainers: Trainers }).trainers;
  const playAnyMove = async (t: { fen: string | null; movable: string | null }) => {
    await waitFor('the board ready', () => { const st = (window as unknown as { cg: { state: any } }).cg.state;
      return t.movable && st.movable.color === st.turnColor && st.movable.dests?.size > 0 && st.pieces.size > 2; }, 10_000);
    const b = Board.fromFen(t.fen!);
    const m = b.legalMoves()[0];
    await clickSquare(m.slice(0, 2));
    await clickSquare(m.slice(2, 4));
    return m;
  };

  // Tactic?: a position, "No", a move, the verdict (your saved mode may be another drill)
  await waitFor('the drills', () => button('Tactic?'), 30_000);
  button('Tactic?').click();
  let t0 = performance.now();
  const samples: string[] = [];
  results.spotSamples = samples;
  const sampler = setInterval(() => samples.push(`${ms(t0)} ${statusText()} | ${JSON.stringify((tr.spot as unknown as { pools: unknown }).pools ? Object.fromEntries(Object.entries((tr.spot as unknown as { pools: Record<string, unknown[]> }).pools).map(([k, v]) => [k, v.length])) : null)}`), 15000);
  try {
    await waitFor('a tactic question', () => statusText().endsWith('Is there a tactic?'), 180_000);
  } finally {
    clearInterval(sampler);
  }
  results.spotFirst = { ms: ms(t0), source: tr.spot.source, status: statusText() };
  const startFen = tr.spot.fen;
  results.spotBarBlank = { question: !!document.querySelector('.eval-bar.blank') };
  button('No — nothing  (N)').click();
  await waitFor('your move', () => tr.spot.movable, 5000);
  (results.spotBarBlank as Record<string, boolean>).move = !!document.querySelector('.eval-bar.blank');
  // every move with all three hints, then the hinted move (a multi-move tactic: each of your moves)
  const hints: unknown[] = [];
  results.spotHints = hints;
  const startsWith = (text: string) => [...document.querySelectorAll('.board-card button')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement | undefined;
  for (let moves = 0; moves < 6; moves++) {
    await waitFor('your move or the verdict', () => (tr.spot.movable && startsWith('Hint')) || /Your call/.test(statusText()), 30_000);
    if (/Your call/.test(statusText())) break;
    for (const label of ['Hint', 'Another hint', 'Show the move']) {
      await waitFor(label, () => startsWith(label) && !startsWith(label)!.disabled, 5000);
      startsWith(label)!.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    const arrow = tr.spot.arrows[0];
    hints.push({ detail: document.querySelector('.commentary-card .explanation')?.textContent, arrow, blank: !!document.querySelector('.eval-bar.blank') });
    await waitFor('the board ready', () => { const st = (window as unknown as { cg: { state: any } }).cg.state; return st.movable.dests?.size > 0; }, 10_000);
    await clickSquare(arrow.from);
    await clickSquare(arrow.to);
    await waitFor('the move taken', () => !tr.spot.movable || !startsWith('Hint'), 30_000);
  }
  await waitFor('the verdict', () => /Your call/.test(statusText()), 30_000);
  results.spot = { status: statusText(), detail: document.querySelector('.commentary-card .explanation')?.textContent?.slice(0, 400),
    buttons: tr.spot.buttons.map((b) => b.label), allTime: tr.spot.allTime,
    stayed: tr.spot.fen !== startFen, arrows: tr.spot.arrows, barBlank: !!document.querySelector('.eval-bar.blank') };
  // ◀ to the start: the arrows there
  button('◀')?.click();
  await new Promise((r) => setTimeout(r, 300));
  results.spotBack = { status: statusText(), atStart: tr.spot.fen === startFen, arrows: tr.spot.arrows };
  // Stockfish's lines, and one opened on the analysis board
  t0 = performance.now();
  await waitFor('Stockfish lines', () => document.querySelectorAll('.stockfish-lines .line').length >= 2, 60_000);
  results.spotStockfish = { ms: ms(t0), rows: [...document.querySelectorAll('.stockfish-lines .line')].map((l) => l.textContent) };
  const resultStatus = statusText();
  (document.querySelector('.stockfish-lines .line') as HTMLButtonElement).click();
  await waitFor('the analysis board', () => document.querySelector('.commentary-card .ideas strong')?.textContent?.startsWith('Analysis'), 10_000);
  results.spotAnalysis = { title: document.querySelector('.commentary-card .ideas strong')?.textContent, buttons: tr.spot.buttons.map((b) => b.label),
    lineMovePlayed: tr.spot.fen !== (tr.spot as unknown as { shownBoard: { fen(): string } }).shownBoard.fen(), lastMove: tr.spot.lastMove };
  startsWith('Back')?.click();
  await waitFor('back to the result', () => statusText() === resultStatus && document.querySelector('.stockfish-lines'), 10_000);

  // Threat?: name "No threat", then an answer
  button('Threat?').click();
  t0 = performance.now();
  await waitFor('a threat question', () => statusText().endsWith('What does it threaten?'), 180_000);
  results.threatFirst = { ms: ms(t0), status: statusText() };
  button('No threat  (N)').click();
  await waitFor('the named verdict', () => button('Now answer it →  (Enter)'), 30_000);
  await new Promise((r) => setTimeout(r, 1500));
  results.threatNamed = { status: statusText(), stillWaiting: !!button('Now answer it →  (Enter)'), movable: tr.threat.movable, arrows: tr.threat.arrows };
  button('Now answer it →  (Enter)').click();
  await waitFor('answer it', () => tr.threat.movable, 5000);
  const answer = await playAnyMove(tr.threat);
  await waitFor('the verdict', () => statusText().includes('Threat ·'), 30_000);
  const explanation = () => document.querySelector('.commentary-card .explanation')?.textContent ?? '';
  results.threatStayed = { onAnswer: tr.threat.lastMove === answer, fen: tr.threat.fen };
  await waitFor('the explanation', () => !explanation().includes('working it out'), 60_000);
  results.threat = { status: statusText(), detail: explanation(), buttons: tr.threat.buttons.map((b) => `${b.label}${b.disabled ? ' (off)' : ''}`) };
  const fwd = button('▶');
  if (fwd && !fwd.disabled) {
    fwd.click();
    await new Promise((r) => setTimeout(r, 300));
    results.threatPunish = { lastMove: tr.threat.lastMove, arrows: tr.threat.arrows };
  }
  await waitFor('Stockfish lines (Threat?)', () => document.querySelectorAll('.stockfish-lines .line').length >= 1, 60_000);
  results.threatStockfish = [...document.querySelectorAll('.stockfish-lines .line')].map((l) => l.textContent);

  // Sacrifice!!: find the sacrifice (we know it), see their defence
  button('Sacrifice!!').click();
  t0 = performance.now();
  await waitFor('a sacrifice', () => statusText().includes('find the sacrifice!!'), 300_000);
  results.sacFirst = { ms: ms(t0), source: tr.sac.source, pool: tr.sac.poolText };
  const sacUci = (tr.sac as unknown as { cand: { sacUci: string } }).cand.sacUci;
  await waitFor('the board ready', () => { const st = (window as unknown as { cg: { state: any } }).cg.state; return st.movable.dests?.size > 0; }, 10_000);
  await clickSquare(sacUci.slice(0, 2));
  await clickSquare(sacUci.slice(2, 4));
  await waitFor('their defence', () => statusText().includes('Your move — keep it going') || statusText().startsWith('✓ You made it work'), 60_000);
  results.sac = { status: statusText(), detail: document.querySelector('.commentary-card .explanation')?.textContent?.slice(0, 200) };

  // play Stockfish's move each turn to the end of the round
  type SacInside = { stepInfo: { best: string | null } | null; state: string };
  const sacInside = tr.sac as unknown as SacInside;
  const playToEnd = async (what: string) => {
    for (let i = 0; i < 40; i++) {
      await waitFor(`${what}: your move or the end`, () => sacInside.state === 'move' || sacInside.state === 'result', 120_000);
      if (sacInside.state === 'result') break;
      const best = sacInside.stepInfo!.best!;
      await waitFor('the board ready', () => { const st = (window as unknown as { cg: { state: any } }).cg.state; return st.movable.dests?.size > 0; }, 10_000);
      await clickSquare(best.slice(0, 2));
      await clickSquare(best.slice(2, 4));
      await waitFor('the move taken', () => sacInside.state !== 'move', 30_000);
    }
    return { status: statusText(), detail: document.querySelector('.commentary-card .explanation')?.textContent?.slice(0, 500),
      bar: document.querySelector('.eval-bar')?.getAttribute('title') };
  };
  results.sacEnd = await playToEnd('attack');
  await waitFor('other defences', () => tr.sac.branchesNote && !tr.sac.branchesNote.startsWith('Looking'), 120_000);
  results.sacBranches = { note: tr.sac.branchesNote, branches: tr.sac.branches.map((b) => b.label) };
  if (tr.sac.branches.length) {
    (document.querySelector('.sac-branches .btn') as HTMLButtonElement).click();
    await waitFor('the other defence', () => sacInside.state !== 'result', 10_000);
    results.sacBranchPlayed = await playToEnd('branch');
    results.sacBranchMark = document.querySelector('.sac-branches .btn')?.textContent;
  }
  button('Play it out').click();
  await waitFor('the game window', () => document.querySelector('dialog.play-dialog[open] cg-board piece'), 10_000);
  results.sacPlay = document.querySelector('dialog.play-dialog[open]')?.getAttribute('aria-label');
  document.querySelector('dialog.play-dialog[open]')!.dispatchEvent(new Event('cancel', { cancelable: true }));
  await waitFor('the window closed', () => !document.querySelector('dialog.play-dialog'), 5000);
  // Defend: they sacrifice, you defend
  (document.querySelector('.sac-switches [aria-label="Side"] button:nth-child(2)') as HTMLButtonElement).click();
  t0 = performance.now();
  await waitFor('their sacrifice', () => tr.sac.source.endsWith('you defend') && (statusText().startsWith('They sacrificed') || sacInside.state === 'result'), 300_000);
  results.sacDefendStart = { ms: ms(t0), status: statusText(), detail: document.querySelector('.commentary-card .explanation')?.textContent, orientation: tr.sac.orientation };
  results.sacDefendEnd = await playToEnd('defend');
  // only Lichess sacrifices
  (document.querySelector('.sac-switches [aria-label="Side"] button:nth-child(1)') as HTMLButtonElement).click();
  (document.querySelector('.sac-switches [aria-label="Sacrifices from"] button:nth-child(3)') as HTMLButtonElement).click();
  await waitFor('a Lichess sacrifice (or none)', () => statusText().includes('find the sacrifice!!') || statusText().startsWith('No Lichess'), 300_000);
  results.sacLichess = { status: statusText(), source: tr.sac.source };
  (document.querySelector('.sac-switches [aria-label="Sacrifices from"] button:nth-child(1)') as HTMLButtonElement).click();
}

/** Game Review on your games (run after phase=ui). */
async function phaseReview(client: DbClient) {
  const errors: string[] = [];
  results.pageErrors = errors;
  addEventListener('error', (e) => errors.push(`${e.message} ${e.error?.stack}`));
  addEventListener('unhandledrejection', (e) => errors.push(e.reason instanceof Error ? `${e.reason.message} ${e.reason.stack}` : String(e.reason)));
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })));
  await waitFor('the app', () => document.querySelector('.level-card'), 120_000);
  nav('Game Review');
  const r = (window as unknown as { review: ReviewController }).review;
  let t0 = performance.now();
  await waitFor('the games', () => document.querySelectorAll('.review .queue-card .queue li button').length > 0, 60_000);
  results.reviewGames = { ms: ms(t0), count: r.games.length, first: r.games[0]?.label };
  t0 = performance.now();
  (document.querySelector('.review .queue-card .queue li button') as HTMLButtonElement).click();
  await waitFor('the game', () => r.game && document.querySelectorAll('.moves-list li').length > 10, 30_000);
  results.reviewGame = { ms: ms(t0), title: r.game!.title, opening: r.game!.opening, accuracy: r.game!.accuracy,
    moves: r.game!.ucis.length, evals: Object.keys(r.game!.evals).length, graphDots: document.querySelectorAll('.eval-graph circle').length };
  // the list folds away; the board grows
  await waitFor('the list folded', () => document.querySelector('.games-rail'), 5000);
  results.reviewFolded = { rail: !!document.querySelector('.games-rail'), board: Math.round(document.querySelector('.review cg-board')!.getBoundingClientRect().width),
    noteBox: !!document.querySelector('.review-side .note-box textarea') };
  button('Next mistake').click();
  await new Promise((res) => setTimeout(res, 300));
  results.reviewMistake = { ply: r.ply, status: statusText(), detail: document.querySelector('.review-side .explanation')?.textContent,
    arrows: r.view().arrows.length };
  r.step(1);
  await new Promise((res) => setTimeout(res, 500));
  t0 = performance.now();
  await waitFor('the why', () => r.why && !r.why.startsWith('Working'), 30_000);
  results.reviewWhy = { ms: ms(t0), text: r.why };
  // a good move of yours: its why, at once
  const goodPly = Object.keys(r.game!.evals).map(Number).find((p) => r.game!.evals[p].move_uci === r.game!.evals[p].best_move_uci && p > 6);
  if (goodPly !== undefined) {
    const keep = r.ply;
    r.go(goodPly + 1);
    await waitFor('the good why', () => r.why && !r.why.startsWith('Working'), 30_000);
    results.reviewWhyGood = r.why;
    // the Coach on every marked move of this game (and a few good ones)
    const coachTexts: string[] = [];
    results.coach = coachTexts;
    const plies = Object.keys(r.game!.evals).map(Number).sort((x, y) => x - y);
    const marked = plies.filter((p) => { const e = r.game!.evals[p]; return e.cp_after !== null && e.cp_before - e.cp_after >= 80; });
    const good = plies.filter((p) => r.game!.evals[p].move_uci === r.game!.evals[p].best_move_uci).slice(3, 6);
    for (const p of [...marked.slice(0, 8), ...good]) {
      r.go(p + 1);
      await waitFor('the coach', () => r.why && !r.why.startsWith('Working'), 30_000).catch(() => null);
      const e = r.game!.evals[p];
      coachTexts.push(`[ply ${p} ${pawnsText(e.cp_before)}→${pawnsText(e.cp_after)}] ${r.why}`);
    }
    r.go(keep);
  }
  results.reviewAfter = { status: statusText(), badge: r.view().badges[0] ?? null,
    badgeOnBoard: document.querySelectorAll('.cg-custom-svgs g').length };
  button('Analyze').click();
  t0 = performance.now();
  await waitFor('Stockfish lines', () => r.analysis.panel.rows.length > 0, 30_000);
  results.reviewAnalysis = { ms: ms(t0), title: r.analysis.panel.title, rows: r.analysis.panel.rows };
  button('Back to game').click();
  // only losses (the list is folded while a game is open: open it)
  (document.querySelector('.games-rail button') as HTMLButtonElement | null)?.click();
  await waitFor('the result filter', () => button('Losses'), 5000);
  button('Losses').click();
  await waitFor('losses only', () => r.result === 'Losses' && r.games.length > 0 && r.games.every((g) => g.label.includes('LOSS')), 30_000);
  results.reviewLosses = { count: r.games.length, first: r.games[0].label };
  // make a puzzle from a position of yours that isn't one, then try it in Puzzle Review
  const g0 = r.game!;
  const myPly = Object.keys(g0.evals).map(Number).find((p) => !g0.puzzles[p] && g0.evals[p].best_move_uci);
  if (myPly !== undefined) {
    r.go(myPly);
    await waitFor('the make button', () => button('🧩 Make this a puzzle'), 5000);
    button('🧩 Make this a puzzle').click();
    await waitFor('the tag window', () => button('Opening'), 10_000);
    button('Opening').click();
    button('Attacking').click();
    await waitFor('both tags ticked', () => document.querySelectorAll('.modal .tag-choice.on').length === 2, 5000);
    button('🧩 Make the puzzle').click();
    await waitFor('made', () => r.game!.puzzles[myPly]?.pick, 10_000);
    results.reviewMadeType = r.game!.puzzles[myPly].type;
    await waitFor('the header flag', () => document.querySelector('.puzzle-flag.is-puzzle'), 5000);
    results.reviewFlag = { here: document.querySelector('.review-head .puzzle-flag')?.textContent,
      graphMarks: document.querySelectorAll('.eval-graph .puzzle-mark').length };
    r.step(1);
    await new Promise((res) => setTimeout(res, 200));
    results.reviewFlagNext = document.querySelector('.review-head .puzzle-flag')?.textContent;
    r.step(-1);
    // a note on this position: saved as you type, listed under Your notes
    const box = await waitFor('the notes box', () => document.querySelector('textarea[aria-label="Your note on this position"]') as HTMLTextAreaElement | null, 5000);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Should have castled first.');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor('the Save button', () => { const b = button('Save'); return b && !b.disabled; }, 5000);
    button('Save').click();
    await waitFor('the note saved', () => r.game!.notes[myPly] === 'Should have castled first.', 10_000);
    await waitFor('Saved shown', () => document.querySelector('.note-box .ok')?.textContent === 'Saved ✓', 5000);
    ((document.querySelector('.games-rail button[title="Your notes"]') ?? button('📝 Your notes')) as HTMLButtonElement).click();
    await waitFor('the notes list', () => document.querySelector('.notes-list li button'), 10_000);
    results.reviewNotes = [...document.querySelectorAll('.notes-list li button')].map((b) => b.textContent).slice(0, 3);
    button('Close').click();
    results.reviewMade = { ply: myPly, notice: r.notice, flagRows: document.querySelectorAll('.moves-list li button').length };
    await waitFor('try it', () => button('Try it'), 5000);
    button('Try it').click();
    const pz = (window as unknown as { puzzles: PuzzleController }).puzzles;
    await waitFor('the puzzle in Puzzle Review', () => pz.puzzle?.id === r.game!.puzzles[myPly].id, 30_000);
    await waitFor('the details', () => pz.details, 10_000);
    results.reviewTryIt = { type: pz.puzzle!.puzzle_type, status: statusText(), note: pz.details!.note,
      tags: [...pz.details!.userTags, ...pz.details!.autoTags] };
    nav('Game Review');
    // the list again: search an opponent, then only games with notes
    (document.querySelector('.games-rail button') as HTMLButtonElement | null)?.click();   // folded or not
    const search = await waitFor('the search box', () => document.querySelector('input[aria-label="Search games"]') as HTMLInputElement | null, 5000);
    const opp = r.games.find((x) => x.id === r.game!.id)!.opponent;
    setInput(search, opp.slice(0, 5));
    await new Promise((res) => setTimeout(res, 200));
    const searched = document.querySelectorAll('.review .queue-card .queue li button').length;
    setInput(search, '');
    (document.querySelector('.games-search input[type="checkbox"]') as HTMLInputElement).click();
    await new Promise((res) => setTimeout(res, 200));
    results.reviewSearch = { opponent: opp, matching: searched, of: r.games.length,
      withNotes: [...document.querySelectorAll('.review .queue-card .queue li button')].map((b) => b.textContent) };
  }
  // from Tactics & Threats: Review game opens it here, at the position
  nav('Tactics & Threats');
  const tr = (window as unknown as { trainers: Trainers }).trainers;
  await waitFor('the drills', () => button('Threat?'), 30_000);
  button('Threat?').click();
  await waitFor('a threat question', () => statusText().endsWith('What does it threaten?'), 180_000);
  button('No threat  (N)').click();
  await waitFor('the named verdict', () => button('Now answer it →  (Enter)'), 30_000);
  button('Now answer it →  (Enter)').click();
  await waitFor('answer it', () => tr.threat.movable, 5000);
  const fenBefore = tr.threat.gameAt()!.fen;
  const b = Board.fromFen(tr.threat.fen!);
  const m = b.legalMoves()[0];
  await waitFor('the board ready', () => { const st = (window as unknown as { cg: { state: any } }).cg.state; return st.movable.dests?.size > 0; }, 10_000);
  await clickSquare(m.slice(0, 2));
  await clickSquare(m.slice(2, 4));
  await waitFor('the verdict', () => statusText().includes('Threat ·'), 30_000);
  button('Review game').click();
  await waitFor('Game Review at the position', () => document.querySelector('.review') && r.game && r.view().fen.split(' ')[0] === fenBefore.split(' ')[0], 30_000);
  results.reviewFromThreat = { game: r.game!.title, ply: r.ply };
}

/** Stats, Progress and Opponent Prep on your data (run after phase=ui). */
async function phaseStats(client: DbClient) {
  const errors: string[] = [];
  results.pageErrors = errors;
  addEventListener('error', (e) => errors.push(`${e.message} ${e.error?.stack}`));
  addEventListener('unhandledrejection', (e) => errors.push(e.reason instanceof Error ? `${e.reason.message} ${e.reason.stack}` : String(e.reason)));
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })));
  await waitFor('the app', () => document.querySelector('.level-card'), 120_000);
  const tables = () => [...document.querySelectorAll('.stats-card')].map((c) => `${c.querySelector('h2')?.textContent}: ${c.querySelectorAll('tbody tr').length}`);
  nav('Stats');
  let t0 = performance.now();
  await waitFor('the overview', () => document.querySelectorAll('.data-table tbody tr').length > 5, 120_000);
  results.statsOverview = { ms: ms(t0), summary: document.querySelector('.stats-screen > p.note')?.textContent, tables: tables(),
    firstOpening: document.querySelector('.data-table tbody tr')?.textContent,
    practiceButtons: document.querySelectorAll('.data-table td.row-action button').length };
  button('Playing style').click();
  await waitFor('the style', () => document.querySelector('.style-verdict h2')?.textContent, 60_000);
  results.statsStyle = { verdict: document.querySelector('.style-verdict h2')!.textContent, tables: tables() };
  button('Improvement').click();
  t0 = performance.now();
  await waitFor('the improvement', () => document.querySelector('.improve-strengths'), 60_000);
  results.statsImprovement = { ms: ms(t0), strengths: [...document.querySelectorAll('.improve-strengths li')].map((l) => l.textContent),
    weaknesses: [...document.querySelectorAll('.improve-weaknesses li')].map((l) => l.textContent),
    trends: [...document.querySelectorAll('.trend-list li')].map((l) => l.textContent), charts: document.querySelectorAll('svg.chart').length };
  button('Repertoire').click();
  t0 = performance.now();
  await waitFor('the gaps', () => [...document.querySelectorAll('.stats-card h2')].some((h) => h.textContent === 'Where your games leave your repertoire')
    && (document.querySelector('.stats-column > p.note')?.textContent ?? 'Working').indexOf('Working') !== 0
    && document.querySelectorAll('.data-table tbody tr.clickable').length > 0, 120_000);
  results.statsRepertoire = { ms: ms(t0), note: document.querySelector('.stats-column > p.note')?.textContent, tables: tables() };
  // show the games behind the first gap
  (document.querySelector('.data-table tbody tr.clickable') as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 200));
  button('Show games').click();
  await waitFor('the games', () => document.querySelector('.modal .games-list li'), 10_000);
  results.statsGames = { title: document.querySelector('.modal h2')?.textContent, games: document.querySelectorAll('.modal .games-list li').length };
  button('Close').click();

  nav('Progress');
  t0 = performance.now();
  await waitFor('the tiles', () => document.querySelectorAll('.tile').length === 5, 60_000);
  results.progress = { ms: ms(t0), tiles: [...document.querySelectorAll('.tile')].map((t) => t.textContent), charts: document.querySelectorAll('svg.chart').length };
  button('Themes').click();
  await waitFor('the themes', () => document.querySelectorAll('.theme-row').length > 2, 60_000);
  results.progressThemes = { rows: document.querySelectorAll('.theme-row').length, first: document.querySelectorAll('.theme-row')[2]?.textContent };
  button('This week').click();
  await waitFor('the week', () => [...document.querySelectorAll('.stats-card h2')].some((h) => h.textContent?.startsWith('Your week')), 60_000);
  results.progressWeek = [...document.querySelectorAll('.stats-card h2')].map((h) => h.textContent);

  nav('Opponent Prep');
  const user = await waitFor('the username box', () => document.querySelector('input[aria-label="Opponent\'s chess.com username"]') as HTMLInputElement | null, 10_000);
  setInput(user, 'GoofyDufy');
  setInput(document.querySelector('input[aria-label="Months"]') as HTMLInputElement, '1');
  await new Promise((r) => setTimeout(r, 200));
  t0 = performance.now();
  button('Scout player').click();
  await waitFor('their lines', () => document.querySelectorAll('.stats-card').length === 2 || document.querySelector('.stats-screen p.error'), 120_000);
  results.scout = { ms: ms(t0), status: document.querySelector('.stats-screen > p')?.textContent, tables: tables() };

  // Stats → Results by opening → Practice: the drill opens on that opening as you play it
  nav('Stats');
  await waitFor('the practice buttons', () => document.querySelector('.data-table td.row-action button'), 120_000);
  const opening = document.querySelector('.data-table tbody tr td')!.textContent;
  (document.querySelector('.data-table td.row-action button') as HTMLButtonElement).click();
  const dc = (window as unknown as { drill: DrillController }).drill;
  await waitFor('the drill on it', () => dc.drill && dc.lineTitle().includes('as you play it') && /Your move|Opponent played/.test(dc.status.text), 60_000);
  results.statsPractice = { opening, title: dc.lineTitle(), status: dc.status.text, moves: dc.drill!.path.map((n) => n.san).join(' ') };
}

async function phase2(client: DbClient) {
  const t = performance.now();
  results.profiles = await client.init();
  results.reopenMs = ms(t);
  results.reopenSteps = await client.timings();
  results.summary = await client.service('summary');
}

/** Stats → Weaknesses: your snapshot imported into a fresh browser, 25 of your
 *  games analysed for real at the weakness stats' engine setting, then the
 *  page's views read back. The profile is kept for screenshots (?phase=show). */
async function phaseWeak(client: DbClient) {
  const errors: string[] = [];
  results.pageErrors = errors;
  addEventListener('error', (e) => errors.push(`${e.message} ${e.error?.stack}`));
  addEventListener('unhandledrejection', (e) => errors.push(e.reason instanceof Error ? `${e.reason.message} ${e.reason.stack}` : String(e.reason)));
  await client.init();
  await client.importDb(new Uint8Array(await (await fetch('/fixture/snapshot.db')).arrayBuffer()), false);
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })));
  await waitFor('the app', () => document.querySelector('.level-card'), 120_000);
  nav('Stats');
  await waitFor('the weaknesses page', () => document.querySelector('.weak-empty, .weak-page'), 60_000);
  const jobs = (window as unknown as { jobs: Jobs }).jobs;
  const tc = (document.querySelector('#weak-tc') as HTMLSelectElement).value;
  let t0 = performance.now();
  let positions = 0;
  const off = jobs.subscribe((s) => { const m = /(\d+) positions searched/.exec(s.progress?.text ?? ''); if (m) positions = Number(m[1]); });
  await jobs.analyzeWeak(tc, 25);
  off();
  results.weakAnalysis = { timeControl: tc, ms: ms(t0), positions, perGameMs: Math.round(ms(t0) / 25), notice: jobs.state.notice };
  await waitFor('the report', () => document.querySelector('.weak-page .stat-card'), 60_000);
  await new Promise((r) => setTimeout(r, 500));
  const cards = () => [...document.querySelectorAll('.weak-page .stat-card')].map((c) => `${c.querySelector('.stat-title span')?.textContent}: ${c.querySelector('.stat-headline')?.textContent ?? c.querySelector('.stat-empty')?.textContent}`);
  results.weakOverview = { cards: cards(), weaknesses: [...document.querySelectorAll('.weak-row')].map((r) => r.textContent),
    examples: document.querySelectorAll('.weak-example').length, meta: document.querySelector('.weak-page > p.note')?.textContent };
  button('Training plan').click();
  await new Promise((r) => setTimeout(r, 300));
  results.weakPlan = { focuses: [...document.querySelectorAll('.weak-focus h3')].map((h) => h.textContent),
    note: document.querySelector('.weak-section .note:last-child')?.textContent };
  const track = button('Track my progress');
  if (track) {
    track.click();
    await waitFor('the tracked plan', () => document.querySelector('.weak-progress'), 20_000);
    results.weakTracked = document.querySelector('.weak-progress')?.textContent;
  }
  button('Splits').click();
  await new Promise((r) => setTimeout(r, 300));
  results.weakSplits = { cards: cards(), openings: document.querySelectorAll('.weak-openings tbody tr').length };
  t0 = performance.now();
  button('Last 50 games').click();
  button('All analysed').click();
  await new Promise((r) => setTimeout(r, 300));
  results.weakSwitchMs = ms(t0);
}

/** Opens the app on whatever this profile holds (for screenshots). */
async function phaseShow(client: DbClient) {
  await client.init();
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App, { client })));
  await new Promise(() => undefined);
}

/** The Strong engine (the 95 MB full network): loads, analyses, and switching back restarts the shared engine. */
async function phaseEngine() {
  const board = Board.fromFen('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3');
  const results_: Record<string, unknown> = {};
  for (const strength of ['standard', 'strong', 'standard'] as const) {
    setEngineStrength(strength);
    const t = performance.now();
    const lines = await sharedEngine().analyse(board, { depth: 18 });
    results_[`${strength}${results_[strength] ? 'Again' : ''}`] = { ms: ms(t), best: lines[0].pv[0], depth: 18 };
  }
  const strong = await startStockfish(16, 'strong');
  results_.strongName = strong.name;
  strong.quit();
  results.engineStrength = results_;
}

(async () => {
  const client = new DbClient();
  try {
    if (phase === '1') await phase1(client);
    else if (phase === 'ui') await phaseUi(client);
    else if (phase === 'layout') await phaseLayout(client);
    else if (phase === 'select') await phaseSelect(client);
    else if (phase === 'drill') await phaseDrill(client);
    else if (phase === 'trainer') await phaseTrainer(client);
    else if (phase === 'review') await phaseReview(client);
    else if (phase === 'stats') await phaseStats(client);
    else if (phase === 'engine') await phaseEngine();
    else if (phase === 'weak') await phaseWeak(client);
    else if (phase === 'show') await phaseShow(client);
    else await phase2(client);
    results.ok = true;
  } catch (e) {
    results.ok = false;
    results.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
  }
  await report(results);
  await report({ done: true });
})();
