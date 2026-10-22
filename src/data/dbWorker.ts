/**
 * The database worker: SQLite (the official WASM build) stored in the
 * browser's origin-private file system, with the core modules running next to
 * it — synchronous, like the Python prototype's sqlite3 — so the page stays
 * smooth while they work. The page talks to it through client.ts.
 *
 * One database file per player (profiles.ts); the registry of players is a
 * small JSON file next to them. A desktop chessprep.db can be imported as-is.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { initDb } from '../core/db';
import { type ProfileStorage, Profiles, type Registry } from '../core/profiles';
import { type Db, wrap } from '../core/sqlite';
import { type Services, services, upgradePuzzles } from './services';

export type Request =
  | { id: number; op: 'init' }
  | { id: number; op: 'profiles' }
  | { id: number; op: 'timings' }
  | { id: number; op: 'addProfile'; name: string }
  | { id: number; op: 'switchProfile'; name: string }
  | { id: number; op: 'importDb'; bytes: Uint8Array; asNewPlayer: boolean }
  | { id: number; op: 'exportDb' }
  | { id: number; op: 'service'; name: keyof Services; args: unknown[] }
  | { id: number; op: 'query'; sql: string; params: unknown[] };

export interface ProfilesView {
  current: string;
  players: string[];
}

const REGISTRY_FILE = 'profiles.json';
const POOL_NAME = 'pawn-promoter';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Pool = Awaited<ReturnType<Sqlite3['installOpfsSAHPoolVfs']>>;

let sqlite3: Sqlite3;
let pool: Pool;
let profiles: Profiles;
let registry: Registry | null = null;
let conn: Db | null = null;
let currentFile = '';

// ---------- the registry (a JSON file in OPFS, kept in memory) ----------

async function registryFile(): Promise<FileSystemFileHandle> {
  const dir = await navigator.storage.getDirectory();
  return dir.getFileHandle(REGISTRY_FILE, { create: true });
}

let saving: Promise<void> = Promise.resolve();
function saveRegistry(data: Registry): void {
  registry = structuredClone(data);
  const text = JSON.stringify(data, null, 2);
  saving = saving.then(async () => {
    const writable = await (await registryFile()).createWritable();
    await writable.write(text);
    await writable.close();
  });
}

const storage: ProfileStorage = {
  load: () => (registry ? structuredClone(registry) : null),
  save: saveRegistry,
  dbExists: (filename) => pool.getFileNames().includes(`/${filename}`),
  legacyUsername: () => '',
};

// ---------- opening databases ----------

/** Room in the storage pool for every player's database and its journal
 *  (plus one spare). Kept small: on reload the pool opens every slot, and on a
 *  slow disk each one takes a while (3 slots: ~1.2 s on a 5,400 rpm drive, 8: ~4.4 s). */
async function ensureCapacity(): Promise<void> {
  await pool.reserveMinimumCapacity(2 * profiles.list().length + 1);
}

/** Fewer disk flushes per commit, still crash-safe (a journal on disk). On a
 *  laptop hard drive: 154 ms per commit instead of 543 ms with SQLite's
 *  defaults. Temporary files stay in memory, so they need no pool slots. */
const PRAGMAS = ['PRAGMA journal_mode=TRUNCATE', 'PRAGMA synchronous=NORMAL', 'PRAGMA temp_store=MEMORY'];

function open(filename: string): Db {
  conn?.close();
  const raw = wrap(sqlite3, new pool.OpfsSAHPoolDb(`/${filename}`));
  for (const pragma of PRAGMAS) raw.exec(pragma);
  const t = performance.now();
  conn = initDb(raw);
  upgradePuzzles(conn);                 // the desktop's one-off puzzle rule updates (puzzle_tab.py)
  timings.migrate = Math.round(performance.now() - t);
  currentFile = filename;
  return conn;
}

function profilesView(): ProfilesView {
  return { current: profiles.current(), players: profiles.list() };
}

/** The database's files on this device. A page that is closing (a reload, or the browser still shutting
 *  down when it's started again) can hold them for a moment, so this waits and tries again before giving up. */
async function openPool(): Promise<Pool> {
  // (forceReinitIfPreviouslyFailed: sqlite-wasm otherwise hands back the first failure; its types omit it)
  const options = { name: POOL_NAME, initialCapacity: 3, forceReinitIfPreviouslyFailed: true };
  for (let attempt = 1; ; attempt++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs(options);
    } catch (err) {
      report(err, `open the storage (attempt ${attempt})`);
      if (attempt >= 8) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`${why}. KingSide Coach may still be open in another tab or window — close it, then reload this page.`);
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/** Which step of opening is running, for the error report. */
let step = 'start';

/** Dev server only: a database error, with its step and stack, to ~/.cache/pawnpromoter/client-errors.log. */
function report(err: unknown, op: string): void {
  if (!import.meta.env.DEV) return;
  const e = err instanceof Error ? err : null;
  const body = JSON.stringify({ at: new Date().toISOString(), op, step, name: e?.name ?? typeof err, message: e?.message ?? String(err),
    stack: e?.stack ?? null, agent: navigator.userAgent });
  void fetch('/__client-log', { method: 'POST', body }).catch(() => {});
}

async function init(): Promise<ProfilesView> {
  if (conn) return profilesView();           // already open (the page called init again)
  let t = performance.now();
  const lap = (name: string) => { timings[name] = Math.round(performance.now() - t); t = performance.now(); step = `after ${name}`; };
  sqlite3 = await sqlite3InitModule();
  lap('sqlite');
  pool = await openPool();
  lap('pool');
  try {
    const text = await (await (await registryFile()).getFile()).text();
    registry = text ? JSON.parse(text) : null;
  } catch {
    registry = null;
  }
  lap('registry');
  profiles = new Profiles(storage);
  await ensureCapacity();
  lap('capacity');
  open(profiles.dbFile(profiles.current()));
  lap('open');
  return profilesView();
}

/** Where opening time goes (the e2e test reports it). */
export const timings: Record<string, number> = {};

/** A desktop chessprep.db: into the current player's file, or as a new player
 *  named after its chess.com username. Migrations run on open, as on desktop. */
async function importDb(bytes: Uint8Array, asNewPlayer: boolean): Promise<ProfilesView> {
  const header = new TextDecoder().decode(bytes.slice(0, 15));
  if (header !== 'SQLite format 3') throw new Error("That isn't a SQLite database file (chessprep.db).");
  let target = currentFile;
  if (asNewPlayer) {
    // read its username from a throwaway in-memory copy, to name the player
    const probe = new sqlite3.oo1.DB(':memory:');
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    probe.checkRc(sqlite3.capi.sqlite3_deserialize(probe.pointer!, 'main', p, bytes.byteLength, bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE));
    let name = '';
    try {
      name = String(probe.selectValue("SELECT value FROM settings WHERE key = 'chess_com_username'") ?? '');
    } catch {
      name = '';
    }
    probe.close();
    let candidate = name || 'Imported player';
    for (let n = 2; profiles.list().some((x) => x.toLowerCase() === candidate.toLowerCase()); n++) candidate = `${name || 'Imported player'} ${n}`;
    profiles.add(candidate);
    profiles.setCurrent(candidate);
    await ensureCapacity();
    target = profiles.dbFile(candidate);
  }
  conn?.close();
  conn = null;
  await pool.importDb(`/${target}`, bytes);
  open(target);
  return profilesView();
}

// ---------- requests ----------

async function handle(req: Request): Promise<unknown> {
  if (req.op === 'init') return init();
  if (!conn) throw new Error('The database is not open yet.');
  switch (req.op) {
    case 'profiles':
      return profilesView();
    case 'timings':
      return timings;
    case 'addProfile': {
      const name = profiles.add(req.name);
      await ensureCapacity();
      profiles.setCurrent(name);
      open(profiles.dbFile(name));
      return profilesView();
    }
    case 'switchProfile':
      profiles.setCurrent(req.name);
      open(profiles.dbFile(profiles.current()));
      return profilesView();
    case 'importDb':
      return importDb(req.bytes, req.asNewPlayer);
    case 'exportDb':
      return pool.exportFile(`/${currentFile}`);
    case 'service':
      return (services[req.name] as (c: Db, ...a: unknown[]) => unknown)(conn, ...req.args);
    case 'query':
      return conn.all(req.sql, req.params as never);
    default:
      throw new Error('unknown request');
  }
}

let chain: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data;
  // one request at a time: the database and the profile switch never interleave
  chain = chain.then(async () => {
    try {
      const result = await handle(req);
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, result });
    } catch (err) {
      report(err, req.op === 'service' ? `service ${req.name}` : req.op);
      (self as unknown as Worker).postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};

