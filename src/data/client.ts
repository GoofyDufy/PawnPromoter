/**
 * The page's side of the database worker (dbWorker.ts): each call is a
 * message with an id, answered by a promise.
 */
import type { ProfilesView, Request } from './dbWorker';
import type { Services } from './services';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Op = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export class DbClient {
  private worker: Worker;
  private next = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./dbWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }

  private request<T>(op: Op, transfer: Transferable[] = []): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...op, id }, transfer);
    });
  }

  init(): Promise<ProfilesView> {
    return this.request({ op: 'init' });
  }

  profiles(): Promise<ProfilesView> {
    return this.request({ op: 'profiles' });
  }

  /** Where opening the database spent its time (ms per step). */
  timings(): Promise<Record<string, number>> {
    return this.request({ op: 'timings' });
  }

  addProfile(name: string): Promise<ProfilesView> {
    return this.request({ op: 'addProfile', name });
  }

  switchProfile(name: string): Promise<ProfilesView> {
    return this.request({ op: 'switchProfile', name });
  }

  /** A desktop chessprep.db (its bytes): into the current player, or as a new player. */
  importDb(bytes: Uint8Array, asNewPlayer: boolean): Promise<ProfilesView> {
    return this.request({ op: 'importDb', bytes, asNewPlayer }, [bytes.buffer]);
  }

  /** The current player's whole database file, for "Back up my database". */
  exportDb(): Promise<Uint8Array> {
    return this.request({ op: 'exportDb' });
  }

  service<K extends keyof Services>(name: K, ...args: Parameters<Services[K]> extends [unknown, ...infer A] ? A : never)
    : Promise<ReturnType<Services[K]>> {
    return this.request({ op: 'service', name, args });
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.request({ op: 'query', sql, params });
  }
}
