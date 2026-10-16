/**
 * Downloading Lichess opening data for your repertoire (lichess_ui.py's
 * downloader): one shared queue so Lichess never gets more than one request
 * at a time. The positions come from the database worker; each answer is saved
 * there as it arrives. Screens subscribe to its progress line.
 */
import * as explorer from '../core/explorer';
import type { DbClient } from '../data/client';

export interface OpeningDataState {
  /** "Downloading opening data: 12 / 80 positions…", an error, or null. */
  progress: string | null;
  /** Bumped when new data arrived (the tree's deviations, reply shares). */
  version: number;
}

type Job = { name: string | null };

export class OpeningData {
  state: OpeningDataState = { progress: null, version: 0 };
  private listeners = new Set<() => void>();
  private queue: Job[] = [];
  private running = false;
  private stopped = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly client: DbClient) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<OpeningDataState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Queues the opponent positions of this repertoire (null: all) not cached yet. */
  start(name: string | null): void {
    this.queue.push({ name });
    if (!this.running) void this.next();
  }

  /** Downloads these positions (those not cached yet), after anything already queued —
   *  never two requests at once. Resolves to [fetched, error or null]. */
  fetchFens(fens: string[], onProgress?: (done: number, total: number) => void): Promise<[number, string | null]> {
    const run = this.chain.then(async (): Promise<[number, string | null]> => {
      while (this.running) await new Promise((r) => setTimeout(r, 200));     // the repertoire downloads first
      const todo = await this.client.service('explorerMissing', fens);
      if (!todo.token) return [0, 'Not connected to Lichess.'];
      if (!todo.fens.length) return [0, null];
      let done = 0;
      const saves: Promise<void>[] = [];
      this.stopped = false;
      const result = await explorer.warm(todo.token, todo.fens, todo.bands, (fen, data) => {
        saves.push(this.client.service('explorerSave', fen, todo.bands, data));
        done += 1;
        onProgress?.(done, todo.fens.length);
      }, () => this.stopped);
      await Promise.all(saves);
      if (result[0]) this.set({ version: this.state.version + 1 });
      return result;
    });
    this.chain = run.catch((): [number, string | null] => [0, null]);
    return run;
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  private async next(): Promise<void> {
    const job = this.queue.shift();
    if (!job) {
      this.running = false;
      return;
    }
    this.running = true;
    this.stopped = false;
    try {
      const todo = await this.client.service('explorerTodo', job.name);
      if (todo.token && todo.fens.length) {
        let done = 0;
        const saves: Promise<void>[] = [];
        const [fetched, error] = await explorer.warm(todo.token, todo.fens, todo.bands, (fen, data) => {
          saves.push(this.client.service('explorerSave', fen, todo.bands, data));
          done += 1;
          this.set({ progress: `Downloading opening data: ${done} / ${todo.fens.length} positions…` });
        }, () => this.stopped);
        await Promise.all(saves);
        this.set({ progress: error ? `Couldn't download opening data: ${error}` : null,
          version: fetched ? this.state.version + 1 : this.state.version });
      }
    } catch (e) {
      this.set({ progress: `Couldn't download opening data: ${e instanceof Error ? e.message : e}` });
    }
    await this.next();
  }
}
