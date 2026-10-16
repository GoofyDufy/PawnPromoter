"""Golden fixtures, part 5 (prototype b483c26): Lichess puzzles imported from
the packs in public/lichess/ by the prototype's own download(), answer kinds
(Counterattack / Defensive) for every puzzle, automatic tags, and whatever
Lichess puzzles / tags your snapshot already has. Writes tests/golden/core5.json.

Run:  ~/Chess/.venv/bin/python tools/golden_core5.py   (after tools/snapshot.py)
"""
import csv, gzip, io, json, os, pathlib, sqlite3, sys, tempfile, threading
from golden_common import CHESS, COMMIT, PROTOTYPE, SNAPSHOT  # noqa: E402  (prototype at its last commit)

ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKS = ROOT / "public" / "lichess"
OUT = ROOT / "tests" / "golden" / "core5.json"
import chess  # noqa: E402
import db, lichess_puzzles, progression, puzzle_kind, puzzle_tags, stats, style  # noqa: E402

manifest = json.loads((PACKS / "manifest.json").read_text())


def merged_csv(low, high, theme=""):
    """The packs overlapping low..high (plus a theme's top-ups) as one CSV, rows in puzzle-id order."""
    header, by_id = None, {}
    files = list(manifest["packs"]) + (manifest["themes"][theme]["packs"] if theme else [])
    for p in files:
        if p["band"] <= high and p["band"] + manifest["band"] - 1 >= low:
            r = list(csv.reader(io.StringIO(gzip.decompress((PACKS / p["file"]).read_bytes()).decode())))
            header = r[0]
            for row in r[1:]:
                by_id[row[0]] = row
    rows = sorted(by_id.values(), key=lambda r: r[0])
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows([header] + rows)
    return out.getvalue()


def puzzle_json(p):
    return [p.id, p.fen, p.correct_move_san, p.correct_move_uci, p.puzzle_type, p.kind, p.solution_ucis,
            p.solution_moves, p.rating, p.themes, p.game_url, p.opening, p.setup_fen, p.setup_uci,
            puzzle_tags.auto_tags(p, False, False), lichess_puzzles.nice_themes(p.themes)]


imports = []
for low, high, count, theme in ((1100, 1700, 5000, ""), (2500, 3200, 2000, ""), (400, 800, 1000, ""),
                                (1300, 1900, 500, "smotheredMate"), (1300, 1900, 300, "xRayAttack"),
                                (1600, 2200, 100, "sacrifice")):
    db.DB_PATH = pathlib.Path(tempfile.mkdtemp()) / "t.db"
    c = db.get_connection()
    text = merged_csv(low, high, theme)
    found = lichess_puzzles.download(low, high, count, set(), lambda b: lichess_puzzles.save(c, b),
                                     threading.Event(), open_stream=lambda: io.StringIO(text), theme=theme)
    rows = [dict(r) for r in c.execute("SELECT * FROM lichess_puzzles ORDER BY id")]
    puzzles = [puzzle_json(lichess_puzzles.to_puzzle(r)) for r in
               (c.execute("SELECT * FROM lichess_puzzles WHERE id = ?", (row["id"],)).fetchone() for row in rows)]
    imports.append({"range": [low, high, count], "theme": theme, "found": found, "span": list(lichess_puzzles.rating_span(c)),
                    "rows": [[r[k] for k in ("id", "setup_fen", "setup_uci", "fen", "solution_ucis", "rating",
                                              "popularity", "plays", "themes", "game_url", "opening")] for r in rows],
                    "puzzles": puzzles})

conn = sqlite3.connect(f"file:{SNAPSHOT}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
own = [db._row_to_puzzle(r) for r in conn.execute("SELECT * FROM puzzles ORDER BY id")]
answer = [[p.id, puzzle_kind.answer_kind(chess.Board(p.fen), chess.Move.from_uci(p.correct_move_uci))] for p in own]
sharp = style.puzzle_sharpness(conn, own)
own_tags = [[p.id, puzzle_tags.auto_tags(p, sharp[p.id], stats.is_endgame(p.fen))] for p in own]
lichess_have = [puzzle_json(lichess_puzzles.to_puzzle(r)) for r in conn.execute("SELECT * FROM lichess_puzzles ORDER BY id")]
user_tags = sorted([k, sorted(v)] for k, v in puzzle_tags.all_user_tags(conn).items())
golden = {
    "packs_built": manifest["built"], "imports": imports, "answer_kinds": answer, "own_tags": own_tags,
    "kinds_in_db": dict(conn.execute("SELECT COALESCE(kind, '-'), COUNT(*) FROM puzzles GROUP BY 1").fetchall()),
    "lichess_have": lichess_have, "user_tags": user_tags,
    "lichess_records": db.puzzle_records(conn, lichess_puzzles.ITEM_TYPE), "xp": progression.total_xp(conn),
}
OUT.write_text(json.dumps(golden))
print(f"imports {[i['found'] for i in imports]}; {len(answer)} answer kinds; {len(lichess_have)} Lichess puzzles "
      f"and {len(user_tags)} tags in your DB; kinds {golden['kinds_in_db']} -> {OUT}")
