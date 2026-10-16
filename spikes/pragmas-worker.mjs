// Commit cost under different SQLite settings, and pool size vs startup, on this disk.
import sqlite3InitModule from "./node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs";
const params = new URL(self.location).searchParams;
const out = { spike: "pragmas", phase: params.get("phase") };
try {
  const sqlite3 = await sqlite3InitModule();
  let t = performance.now();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "bench2", initialCapacity: 3 });
  out.installPool = Math.round(performance.now() - t);
  out.capacity = pool.getCapacity();
  const settings = {
    default: [],
    normal: ["PRAGMA synchronous=NORMAL"],
    truncateNormal: ["PRAGMA journal_mode=TRUNCATE", "PRAGMA synchronous=NORMAL"],
    persistNormal: ["PRAGMA journal_mode=PERSIST", "PRAGMA synchronous=NORMAL"],
    memoryJournal: ["PRAGMA journal_mode=MEMORY", "PRAGMA synchronous=NORMAL"],
  };
  for (const [name, pragmas] of Object.entries(settings)) {
    const db = new pool.OpfsSAHPoolDb(`/b-${name}.db`);
    db.exec("PRAGMA temp_store=MEMORY");
    for (const p of pragmas) db.exec(p);
    db.exec("CREATE TABLE IF NOT EXISTS t(a)");
    t = performance.now();
    for (let i = 0; i < 5; i++) db.exec("INSERT INTO t VALUES (1)");
    out[name] = Math.round((performance.now() - t) / 5);
    db.close();
    pool.unlink(`/b-${name}.db`);
  }
  out.filesAfter = pool.getFileNames();
} catch (e) { out.error = String(e && e.stack || e); }
postMessage(out);
