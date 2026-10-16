/**
 * Stockfish in the browser: talks UCI to a Stockfish Web Worker (stockfish.js
 * by Nathan Rugg / Chess.com, the 1.8 MB "lite single-threaded" build — Phase 0
 * showed it's as accurate as the 95 MB one at our depths and needs no special
 * server headers) and implements the core's Engine interface, so everything in
 * src/core runs against it exactly as the tests run against FakeEngine.
 *
 * One search at a time per engine (UCI has no concurrency): analyse() calls
 * queue up. For several searches side by side use an EnginePool (pool.ts);
 * for the app's interactive screens, one SharedEngine (core/engineService.ts).
 */
import type { Board } from '../core/chess';
import { type Engine, type InfoLine, type Limit, parseInfo } from '../core/engine';

/** The part of a Worker this needs (a fake one in tests). */
export interface WorkerLike {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  terminate?(): void;
}

export class EngineError extends Error {}

type Waiter = { prefix: string; resolve: (line: string) => void };

export class UciEngine implements Engine {
  private waiters: Waiter[] = [];
  private listener: ((line: string) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  private dead: Error | null = null;
  /** The engine's name from "id name ..." (e.g. "Stockfish 19 Lite"). */
  name = '';

  constructor(private readonly worker: WorkerLike, options: Record<string, string | number> = {}) {
    worker.onmessage = (e) => this.receive(String(e.data));
    worker.onerror = (e) => this.fail(new EngineError(`Stockfish stopped: ${(e as { message?: string })?.message ?? e}`));
    this.ready = (async () => {
      this.send('uci');
      await this.until('uciok');
      for (const [name, value] of Object.entries(options)) this.send(`setoption name ${name} value ${value}`);
      this.send('isready');
      await this.until('readyok');
    })();
  }

  private send(cmd: string): void {
    if (this.dead) throw this.dead;
    this.worker.postMessage(cmd);
  }

  private receive(line: string): void {
    if (line.startsWith('id name ')) this.name = line.slice(8).trim();
    this.listener?.(line);
    const i = this.waiters.findIndex((w) => line.startsWith(w.prefix));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(line);
  }

  private until(prefix: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.dead);
      this.waiters.push({ prefix, resolve });
    });
  }

  private fail(error: Error): void {
    this.dead = error;
    this.waiters = [];
    this.listener = null;
  }

  /** Resolves once the engine has answered "readyok". */
  whenReady(): Promise<void> {
    return this.ready;
  }

  analyse(board: Board, limit: Limit, multipv = 1, rootMoves?: string[]): Promise<InfoLine[]> {
    const run = this.queue.then(async () => {
      await this.ready;
      if (this.dead) throw this.dead;
      const turn = board.turn;
      const lines = new Map<number, InfoLine>();
      this.listener = (line) => {
        if (!line.startsWith('info ') || !line.includes(' pv ')) return;
        if (line.includes(' lowerbound') || line.includes(' upperbound')) return;   // not a final score
        const info = parseInfo(line, turn);
        if (info) lines.set(info.multipv, { pv: info.pv, score: info.score, depth: info.depth });
      };
      this.send(`setoption name MultiPV value ${Math.max(1, multipv)}`);
      this.send(`position fen ${board.fen()}`);
      let go = 'go';
      if (limit.depth !== undefined) go += ` depth ${limit.depth}`;
      if (limit.time !== undefined) go += ` movetime ${Math.round(limit.time * 1000)}`;
      if (limit.depth === undefined && limit.time === undefined) go += ' depth 12';
      if (rootMoves?.length) go += ` searchmoves ${rootMoves.join(' ')}`;
      const done = this.until('bestmove');
      this.send(go);
      const best = await done;
      this.listener = null;
      const out = [...lines.entries()].sort(([a], [b]) => a - b).map(([, l]) => l);
      if (!out.length) {
        // no info line with a pv (e.g. a mate or stalemate on the board): only the bestmove
        const move = best.split(/\s+/)[1];
        if (move && move !== '(none)') throw new EngineError(`no analysis for ${board.fen()}`);
      }
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** setoption, in turn with the searches (e.g. UCI_LimitStrength / UCI_Elo for Play it out). */
  setOption(name: string, value: string | number | boolean): Promise<void> {
    const run = this.queue.then(async () => {
      await this.ready;
      this.send(`setoption name ${name} value ${value}`);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** engine.play(): the move Stockfish chooses (its "bestmove" — with a limited
   *  strength that's the weakened choice, not the best line's first move). */
  play(board: Board, limit: Limit): Promise<string | null> {
    const run = this.queue.then(async () => {
      await this.ready;
      if (this.dead) throw this.dead;
      this.send('setoption name MultiPV value 1');
      this.send(`position fen ${board.fen()}`);
      const done = this.until('bestmove');
      this.send(limit.time !== undefined ? `go movetime ${Math.round(limit.time * 1000)}` : `go depth ${limit.depth ?? 12}`);
      const move = (await done).split(/\s+/)[1];
      return move && move !== '(none)' ? board.normalizeUci(move) ?? move : null;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stops the search running (its analyse() still resolves with what it found). */
  stop(): void {
    if (!this.dead) this.worker.postMessage('stop');
  }

  quit(): void {
    if (this.dead) return;
    this.worker.postMessage('quit');
    this.worker.terminate?.();
    this.fail(new EngineError('Stockfish was closed'));
  }
}
