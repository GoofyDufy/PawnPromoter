/**
 * The small database interface the core modules use — the parts of Python's
 * sqlite3 the prototype relies on. Backed by the official SQLite WASM build:
 * in the browser an OPFS-stored file inside a worker, in tests an in-memory
 * database in Node. Same SQL, same engine, synchronous like Python's sqlite3.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

export type SqlValue = string | number | null | bigint | Uint8Array;
export type Params = SqlValue[] | Record<string, SqlValue>;
export type Row = Record<string, any>;

export interface Db {
  /** Run several statements (no parameters, no results) — executescript(). */
  exec(sql: string): void;
  /** One statement; returns rows changed and the new rowid (cursor.rowcount / lastrowid). */
  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number };
  all<T = Row>(sql: string, params?: Params): T[];
  get<T = Row>(sql: string, params?: Params): T | undefined;
  /** `with conn:` — all or nothing. Nests safely (savepoints). */
  transaction<T>(fn: () => T): T;
  close(): void;
  /** The whole database file, e.g. for "back up my database". */
  exportBytes(): Uint8Array;
}

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type OoDb = InstanceType<Sqlite3['oo1']['DB']>;

let modulePromise: Promise<Sqlite3> | null = null;
export function sqliteModule(): Promise<Sqlite3> {
  return (modulePromise ??= sqlite3InitModule());
}

/** Wraps an opened sqlite-wasm oo1 database in the Db interface. */
export function wrap(sqlite3: Sqlite3, db: OoDb): Db {
  const plain = (row: Row) => ({ ...row });   // sqlite-wasm rows have a null prototype
  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params) {
      db.exec({ sql, bind: params as any });
      return {
        changes: Number(db.changes()),
        lastInsertRowid: Number(db.selectValue('SELECT last_insert_rowid()')),
      };
    },
    all(sql, params) {
      return db.selectObjects(sql, params as any).map(plain) as any[];
    },
    get(sql, params) {
      const row = db.selectObject(sql, params as any);
      return row ? (plain(row) as any) : undefined;
    },
    transaction(fn) {
      return db.savepoint(() => fn());
    },
    close() {
      db.close();
    },
    exportBytes() {
      return sqlite3.capi.sqlite3_js_db_export(db);
    },
  };
}

/** An in-memory database (tests), optionally loaded from a database file's bytes. */
export async function openMemoryDb(bytes?: Uint8Array): Promise<Db> {
  const sqlite3 = await sqliteModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  if (bytes) {
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const rc = sqlite3.capi.sqlite3_deserialize(
      db.pointer!, 'main', p, bytes.byteLength, bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    db.checkRc(rc);
  }
  return wrap(sqlite3, db);
}
