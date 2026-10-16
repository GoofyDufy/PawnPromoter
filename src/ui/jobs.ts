/**
 * The long-running work behind Import & Analyze (puzzle_tab.py's background
 * threads): importing from chess.com, analyzing games with a pool of Stockfish
 * engines, rebuilding puzzles at a new blunder size, sorting new puzzles into
 * kinds, and adding Lichess puzzles. It lives outside the screens, so it keeps
 * going when you switch screens; screens subscribe to its state.
 *
 * Database work goes to the worker (services.ts); engine work runs here on
 * engines of its own (the interactive screens keep the shared one).
 */
import { AnalysisStopped, countMyMoves, evaluateGame } from '../core/analyzer';
import { fetchAllGames } from '../core/chessCom';
import * as lichessPuzzles from '../core/lichessPuzzles';
import * as puzzleKind from '../core/puzzleKind';
import { pyFixed } from '../core/format';
import type { DbClient } from '../data/client';
import { parallelEngines, runPool } from '../engine/pool';
import { startStockfish } from '../engine/stockfish';
import type { UciEngine } from '../engine/uci';

export interface Progress {
  text: string;
  value: number;
  max: number | null;            // null: no known end (a spinner)
  stoppable: boolean;
}

export interface Notice {
  ok: boolean;
  text: string;
  /** Offer to analyze right away (after an import). */
  offerAnalyze?: boolean;
}

export interface JobsState {
  busy: null | 'import' | 'analyze' | 'regenerate';
  progress: Progress | null;
  notice: Notice | null;
  classify: string;              // "Sorting new puzzles into kinds: 12 / 40…"
  lichess: { busy: boolean; text: string };
  /** Bumped whenever puzzles were added or changed (screens reload their queue). */
  puzzlesVersion: number;
  /** Bumped each time an analyzed game adds puzzles, while the run goes on. */
  puzzlesFound: number;
}

type Listener = (s: JobsState) => void;

export class Jobs {
  state: JobsState = { busy: null, progress: null, notice: null, classify: '', lichess: { busy: false, text: '' }, puzzlesVersion: 0, puzzlesFound: 0 };
  private listeners = new Set<Listener>();
  private stopRequested = false;
  private classifyStop: { stopped: boolean } | null = null;
  private lichessStop: { stopped: boolean } | null = null;

  constructor(private readonly client: DbClient) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<JobsState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private puzzlesChanged(): void {
    this.set({ puzzlesVersion: this.state.puzzlesVersion + 1 });
  }

  clearNotice(): void {
    this.set({ notice: null });
  }

  // ---------- import from chess.com ----------

  async importGames(username: string, months: number): Promise<void> {
    if (this.state.busy) return;
    await this.client.service('setSettings', { chess_com_username: username, import_months: String(months) });
    this.set({ busy: 'import', notice: null, progress: { text: `Downloading games for ${username}…`, value: 0, max: null, stoppable: false } });
    try {
      const games = await fetchAllGames(username, months, (done, total) =>
        this.set({ progress: { text: `Downloading month ${done} of ${total}…`, value: done, max: total, stoppable: false } }));
      const added = await this.client.service('importGames', games);
      this.set({ busy: null, progress: null, notice: added === 0
        ? { ok: true, text: "No new games found. You're up to date." }
        : { ok: true, text: `Imported ${added} new games.`, offerAnalyze: true } });
    } catch (e) {
      this.set({ busy: null, progress: null, notice: { ok: false,
        text: `Couldn't download games from chess.com: ${e instanceof Error ? e.message : e}. Check the username and your internet connection.` } });
    }
  }

  // ---------- analyze ----------

  async analyze(thresholdCp: number, limit: number, focus: string, parallel: boolean): Promise<void> {
    if (this.state.busy) return;
    const games = await this.client.service('gamesToAnalyze', limit, focus);
    if (!games.length) {
      this.set({ notice: { ok: true, text: `Every imported game${focus === 'All games' ? '' : ` (${focus})`} has already been analyzed.` } });
      return;
    }
    this.pauseClassifying();                      // the analysis gets the processor
    this.stopRequested = false;
    const totalMoves = games.reduce((n, g) => n + countMyMoves(g), 0);
    const p = { moves: 0, games: 0, puzzles: 0 };
    const text = () => `${p.games} of ${games.length} games done · ${p.moves} / ${totalMoves} moves`;
    this.set({ busy: 'analyze', notice: null, progress: { text: 'Starting Stockfish…', value: 0, max: totalMoves, stoppable: true } });
    let engines: UciEngine[] = [];
    let stopped = false;
    try {
      engines = await Promise.all(Array.from({ length: parallel ? parallelEngines() : 1 }, () => startStockfish()));
      this.set({ progress: { text: text(), value: 0, max: totalMoves, stoppable: true } });
      await runPool(engines, games,
        (engine, game) => evaluateGame(game, engine, () => {
          p.moves += 1;
          this.set({ progress: { text: text(), value: p.moves, max: totalMoves, stoppable: !this.stopRequested } });
        }, () => this.stopRequested),
        async (game, evaluations) => {
          // saved the moment it finishes: stopping loses at most the game in progress
          const found = await this.client.service('saveGameAnalysis', game.id, evaluations, thresholdCp);
          p.puzzles += found;
          p.games += 1;
          this.set({ progress: { text: text(), value: p.moves, max: totalMoves, stoppable: !this.stopRequested },
            puzzlesFound: this.state.puzzlesFound + (found ? 1 : 0) });
        });
    } catch (e) {
      if (e instanceof AnalysisStopped) stopped = true;
      else {
        for (const engine of engines) engine.quit();
        this.set({ busy: null, progress: null, notice: { ok: false,
          text: `Something went wrong while analyzing: ${e instanceof Error ? e.message : e}. Games finished before the error are saved.` } });
        this.puzzlesChanged();
        return;
      }
    }
    for (const engine of engines) engine.quit();
    this.set({ busy: null, progress: null, notice: { ok: true, text: `${stopped ? 'Stopped. ' : ''}Analyzed and saved ${p.games} of ${games.length} games, `
      + `found ${p.puzzles} puzzles (blunder size ${pyFixed(thresholdCp / 100, 1)} pawns).` } });
    this.puzzlesChanged();
    setTimeout(() => void this.classify(parallel), 500);     // the new puzzles' kinds
  }

  /** Stop (keeps finished games). */
  stop(): void {
    this.stopRequested = true;
    if (this.state.progress) this.set({ progress: { ...this.state.progress, text: 'Stopping after the current move…', stoppable: false } });
  }

  // ---------- rebuild at a new blunder size ----------

  async regenerate(thresholdCp: number, parallel: boolean): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: 'regenerate', notice: null, progress: { text: 'Rebuilding puzzles from saved analysis…', value: 0, max: null, stoppable: false } });
    try {
      const r = await this.client.service('regeneratePuzzles', thresholdCp);
      let text = `Rebuilt ${r.puzzles} puzzles from ${r.games} analyzed games (blunder size ${pyFixed(thresholdCp / 100, 1)} pawns).`;
      if (r.legacy) {
        text += ` ${r.legacy} older games were analyzed before results were saved, so they kept their existing puzzles. `
          + 'Analyze new games will save them one run at a time.';
      }
      this.set({ busy: null, progress: null, notice: { ok: true, text } });
      this.puzzlesChanged();
      setTimeout(() => void this.classify(parallel), 500);   // rebuilt puzzles: their kinds again
    } catch (e) {
      this.set({ busy: null, progress: null, notice: { ok: false, text: `Couldn't rebuild the puzzles: ${e instanceof Error ? e.message : e}` } });
    }
  }

  // ---------- sorting new puzzles into kinds (puzzle_kind.py) ----------

  /** Works out kind + solution for puzzles that don't have them yet. Never while
   *  an import / analysis runs (that pauses it). */
  async classify(parallel = true): Promise<void> {
    if (this.state.busy || this.classifyStop) return;
    const todo = await this.client.service('unclassified');
    if (!todo.length) return;
    const stop = { stopped: false };
    this.classifyStop = stop;
    this.set({ classify: `Sorting ${todo.length} new puzzles into kinds…` });
    let engines: UciEngine[] = [];
    let done = 0;
    let pending: [string, string[], string][] = [];
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      await this.client.service('saveKinds', batch);
    };
    try {
      engines = await Promise.all(Array.from({ length: parallel ? parallelEngines() : 1 }, () => startStockfish()));
      await runPool(engines, todo, (engine, [, fen, best]) => puzzleKind.classify(engine, fen, best), async ([id], result) => {
        pending.push([id, result.solution, result.kind]);
        done += 1;
        if (done % 10 === 0 || done === todo.length) {
          await flush();
          this.set({ classify: `Sorting new puzzles into kinds: ${done} / ${todo.length}…` });
        }
      }, () => stop.stopped);
    } catch {
      /* an engine error: whatever's left is tried again next time */
    }
    await flush();
    for (const engine of engines) engine.quit();
    if (this.classifyStop === stop) this.classifyStop = null;
    const left = (await this.client.service('unclassified')).length;
    this.set({ classify: left ? `${left} puzzles still to sort into kinds (continues after the analysis).` : '' });
    if (done) this.puzzlesChanged();
    if (left && !stop.stopped) setTimeout(() => void this.classify(parallel), 500);
  }

  pauseClassifying(): void {
    if (this.classifyStop) {
      this.classifyStop.stopped = true;
      this.classifyStop = null;
    }
  }

  // ---------- Lichess puzzles (from the packs in public/lichess/) ----------

  async addLichess(low: number, high: number, count: number, theme = ''): Promise<number> {
    if (this.lichessStop) return 0;
    const stop = { stopped: false };
    this.lichessStop = stop;
    this.set({ lichess: { busy: true, text: 'Loading the Lichess puzzle packs…' } });
    let found = 0;
    try {
      const skip = new Set(await this.client.service('lichessIds'));
      const rows = await lichessPuzzles.packRows(low, high, `${import.meta.env.BASE_URL}lichess/`, fetch, theme);
      const saves: Promise<void>[] = [];
      found = await lichessPuzzles.download(low, high, count, skip, (batch) => { saves.push(this.client.service('lichessSave', batch)); },
        () => stop.stopped, rows, (f, scanned) => this.set({ lichess: { busy: true, text: `${f.toLocaleString()} of ${count.toLocaleString()} found · ${scanned.toLocaleString()} Lichess puzzles checked` } }),
        500, theme);
      await Promise.all(saves);
      this.set({ lichess: { busy: false, text: `Added ${found.toLocaleString()} puzzles${stop.stopped ? ' (stopped).' : '.'}`
        + (found < count && !stop.stopped ? ' That is every puzzle in this range not added yet.' : '') } });
    } catch (e) {
      this.set({ lichess: { busy: false, text: `Couldn't load the Lichess puzzles (${e instanceof Error ? e.message : e}). Reload the page and try again.` } });
    }
    this.lichessStop = null;
    if (found) this.puzzlesChanged();
    return found;
  }

  stopLichess(): void {
    if (this.lichessStop) {
      this.lichessStop.stopped = true;
      this.set({ lichess: { busy: true, text: 'Stopping…' } });
    }
  }

  async removeLichess(): Promise<void> {
    await this.client.service('lichessRemoveAll');
    this.set({ lichess: { busy: false, text: 'Removed.' } });
    this.puzzlesChanged();
  }
}
