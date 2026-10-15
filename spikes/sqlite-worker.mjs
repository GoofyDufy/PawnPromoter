// Spike 0.3: SQLite in the browser, stored in OPFS (origin-private file system).
// Imports public/chessprep.db on first run, then times queries copied from db.py.
// Run with ?phase=import first, then ?phase=reload to prove the data persisted.
import sqlite3InitModule from "./node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs";

const phase = new URL(self.location).searchParams.get("phase");
const out = { spike: "sqlite", phase };
const timed = (label, fn) => {
  const t = performance.now();
  const r = fn();
  out[label + "Ms"] = Math.round(performance.now() - t);
  return r;
};

try {
  const t0 = performance.now();
  const sqlite3 = await sqlite3InitModule();
  out.initMs = Math.round(performance.now() - t0);
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "spike-pool" });
  out.filesBefore = pool.getFileNames();

  if (phase === "import") {
    await pool.wipeFiles();
    const t = performance.now();
    const bytes = new Uint8Array(await (await fetch("public/chessprep.db")).arrayBuffer());
    out.dbBytes = bytes.byteLength;
    await pool.importDb("/chessprep.db", bytes);
    out.importMs = Math.round(performance.now() - t);
  }

  const db = new pool.OpfsSAHPoolDb("/chessprep.db");
  const all = (sql, bind) => db.selectObjects(sql, bind);

  out.counts = timed("counts", () => Object.fromEntries(
    ["games", "move_evaluations", "puzzles", "attempts", "opening_lines"].map(
      (t) => [t, db.selectValue(`SELECT count(*) FROM ${t}`)])));

  // db.games_needing_evaluation
  out.needingEval = timed("gamesNeedingEval", () => all(
    `SELECT * FROM games WHERE evaluated_at IS NULL OR COALESCE(eval_version, 1) < 2
     ORDER BY is_analyzed ASC, played_at DESC`).length);

  // db.all_evaluations_by_game — the big one: every saved engine result
  out.evalRows = timed("allEvaluations", () => all(
    "SELECT * FROM move_evaluations ORDER BY game_id, ply").length);

  // db.due_puzzles
  out.duePuzzles = timed("duePuzzles", () => all(
    `SELECT p.* FROM puzzles p JOIN review_state rs ON rs.puzzle_id = p.id
     WHERE rs.due_date <= ? ORDER BY RANDOM() LIMIT 20`, [new Date().toISOString()]).length);

  // db.weak_item_ids
  out.attemptRows = timed("weakItems", () => all(
    "SELECT item_id, correct FROM attempts WHERE item_type = ? ORDER BY attempted_at", ["puzzle"]).length);

  // a write: record 200 attempts in one transaction, then undo them
  timed("write200", () => {
    db.transaction(() => {
      for (let i = 0; i < 200; i++)
        db.exec({ sql: "INSERT INTO attempts (item_type, item_id, correct, attempted_at) VALUES ('spike', ?, 1, ?)",
                  bind: ["spike-" + i, new Date().toISOString()] });
    });
  });
  db.exec("DELETE FROM attempts WHERE item_type = 'spike'");

  if (phase === "reload") {
    // export round-trip: the "back up my database" button
    const t = performance.now();
    out.exportBytes = (await pool.exportFile("/chessprep.db")).byteLength;
    out.exportMs = Math.round(performance.now() - t);
  }
  db.close();
  out.filesAfter = pool.getFileNames();
} catch (e) {
  out.error = String((e && e.stack) || e);
}
postMessage(out);
