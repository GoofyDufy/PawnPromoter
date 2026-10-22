/**
 * One Stockfish for the whole app's interactive work — port of
 * engine_service.py: the analysis boards, Tactics & Threats, puzzle
 * explanations, the opening commentary. Started the first time it's needed
 * and kept running, so an analysis board doesn't wait for Stockfish to start
 * and the screens don't run several copies at once.
 *
 * Stockfish works on one search at a time, so each analyse() waits its turn
 * (a queue), but only for that one search: a long job on one screen (many
 * searches) lets another screen's searches in between.
 *
 * Bulk work keeps its own engines, as on desktop: game analysis (several in
 * parallel), puzzle sorting and Play.
 */
import type { Board } from './chess';
import type { Engine, InfoLine, Limit } from './engine';

export class NoStockfish extends Error {}

export class SharedEngine implements Engine {
  private engine: Promise<Engine> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  /** start(): makes the real engine (a Stockfish Web Worker in the app). */
  constructor(private readonly start: () => Promise<Engine>) {}

  analyse(board: Board, limit: Limit, multipv?: number, rootMoves?: string[]): Promise<InfoLine[]> {
    const run = this.queue.then(async () => {
      if (this.closed) throw new NoStockfish('The app is closing.');
      this.engine ??= this.start();
      try {
        return await (await this.engine).analyse(board, limit, multipv, rootMoves);
      } catch (e) {
        this.engine = null;                 // restarted on the next search
        throw e;
      }
    });
    this.queue = run.catch(() => undefined);   // one failed search doesn't block the next
    return run;
  }

  /** A long search that can be called off: stop() ends it early (it still resolves, with what it found so far)
   *  if it's the search running, and drops it if it's still waiting its turn — never anyone else's search. */
  stoppable(board: Board, limit: Limit, multipv?: number): { result: Promise<InfoLine[]>; stop: () => void } {
    let state: 'waiting' | 'running' | 'done' | 'stopped' = 'waiting';
    const result = this.queue.then(async () => {
      if (state === 'stopped') return [];
      if (this.closed) throw new NoStockfish('The app is closing.');
      this.engine ??= this.start();
      state = 'running';
      try {
        return await (await this.engine).analyse(board, limit, multipv);
      } catch (e) {
        this.engine = null;
        throw e;
      } finally {
        state = 'done';
      }
    });
    this.queue = result.catch(() => undefined);
    const stop = () => {
      if (state === 'running') void this.engine?.then((e) => (e as { stop?: () => void }).stop?.()).catch(() => undefined);
      if (state === 'waiting' || state === 'running') state = 'stopped';
    };
    return { result, stop };
  }

  /** A different engine from now on (e.g. a new strength): after the searches
   *  already queued, the running one is closed and the next search starts a new one. */
  restart(): void {
    this.queue = this.queue.then(async () => {
      const old = this.engine;
      this.engine = null;
      const engine = await old?.catch(() => null);
      (engine as { quit?: () => void } | null | undefined)?.quit?.();
    }).catch(() => undefined);
  }

  /** At exit: no more searches (a late one gets NoStockfish). */
  shutdown(): void {
    this.closed = true;
  }

  /** A new app session after shutdown() (e.g. in tests): Stockfish may start again. */
  reopen(): void {
    this.closed = false;
  }
}
