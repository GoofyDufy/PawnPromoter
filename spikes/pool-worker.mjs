// Times the OPFS "SAH pool" setup, and raw sync-access-handle opening, in this browser.
import sqlite3InitModule from "./node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs";
const out = { spike: "pool", phase: new URL(self.location).searchParams.get("phase") };
const lap = (() => { let t = performance.now(); return (k) => { out[k] = Math.round(performance.now() - t); t = performance.now(); }; })();
try {
  const sqlite3 = await sqlite3InitModule(); lap("sqliteInit");
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "bench" }); lap("installPool");
  out.capacity = pool.getCapacity(); out.files = pool.getFileNames().length;
  const db = new pool.OpfsSAHPoolDb("/bench.db"); lap("openDb");
  db.exec("CREATE TABLE IF NOT EXISTS t(a)"); lap("ddl1");
  db.exec("BEGIN; CREATE TABLE IF NOT EXISTS t2(a); CREATE TABLE IF NOT EXISTS t3(a); INSERT INTO t VALUES (1); COMMIT;"); lap("txn");
  for (let i = 0; i < 10; i++) db.exec("INSERT INTO t VALUES (1)"); lap("tenCommits");
  db.close();
  // raw OPFS: how long does one createSyncAccessHandle take here?
  const dir = await navigator.storage.getDirectory();
  const fh = await dir.getFileHandle("raw-bench.bin", { create: true }); lap("getFileHandle");
  const h = await fh.createSyncAccessHandle(); lap("createSyncAccessHandle");
  h.write(new Uint8Array(4096), { at: 0 }); h.flush(); lap("writeFlush4k");
  h.close();
} catch (e) { out.error = String(e && e.stack || e); }
postMessage(out);
