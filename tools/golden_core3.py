"""Golden fixtures, part 3: repertoire import, gaps (from your games and from
the cached Lichess explorer data), scouting, opening notes, the catalog and
rating bands — on the snapshot of your data (tools/snapshot.py). Writes tests/golden/core3.json.

Run:  ~/Chess/.venv/bin/python tools/golden_core3.py
"""
import glob, json, os, pathlib, sqlite3, sys, tempfile
from golden_common import CHESS, COMMIT, PROTOTYPE, SNAPSHOT  # noqa: E402  (prototype at its last commit)

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "core3.json"
import db, explorer, models, opening_importer, opening_notes, openings_catalog  # noqa: E402
import repertoire_gaps, scouting, stats  # noqa: E402

conn = sqlite3.connect(f"file:{SNAPSHOT}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
rec = lambda r: [r.wins, r.draws, r.losses]


def tree_rows(c):
    """Opening lines as (path of UCIs from the root, fields) — ids differ between runs."""
    rows = {r["id"]: dict(r) for r in c.execute("SELECT * FROM opening_lines")}
    def path(r):
        out = []
        while r is not None:
            out.append(r["move_uci"])
            r = rows.get(r["parent_id"])
        return list(reversed(out))
    return sorted([[r["repertoire_name"], r["my_color"], r["line_name"], " ".join(path(r)), r["move_san"],
                    r["fen_before_move"], r["fen_after_move"], r["move_number"], r["is_line_end"], r["notes"]]
                   for r in rows.values()])


imports = {}
for path in sorted(glob.glob(str(PROTOTYPE / "*.pgn"))):
    name = pathlib.Path(path).stem
    color = models.PlayerColor.BLACK if "black" in name.lower() or name in ("Scandinavian",) else models.PlayerColor.WHITE
    db.DB_PATH = pathlib.Path(tempfile.mkdtemp()) / "t.db"
    c = db.get_connection()
    text = pathlib.Path(path).read_text(encoding="utf-8")
    added = opening_importer.import_pgn_text(text, name, color, c)
    again = opening_importer.import_pgn_text(text, name, color, c)      # re-import adds nothing
    imports[pathlib.Path(path).name] = {"color": color.value, "added": added, "again": again, "rows": tree_rows(c)}


def gap_json(g):
    return [g.color, g.prefix, g.move, g.by_opponent, g.covered, rec(g.record), g.opening,
            g.suggestion, g.suggestion_source, g.game_ids, g.line, g.who]


reports = {}
for fname, tc in models.TIME_FILTERS.items():
    r = repertoire_gaps.compute(conn, tc)
    reports[fname] = {"games": r.games, "gaps": [gap_json(g) for g in r.gaps],
                      "common": [[c.color, c.sans, rec(c.record), c.opening, c.in_repertoire, c.game_ids] for c in r.common],
                      "has_repertoire": r.has_repertoire, "first_moves": list(r.first_moves.items())}

bands = explorer.rating_bands(conn)
stats_for = lambda fen: explorer.cached(conn, fen, bands)
popular = repertoire_gaps.popular_gaps(conn, stats_for)
cache_rows = conn.execute("SELECT COUNT(*) FROM explorer_cache").fetchone()[0]

games = [db._row_to_game(r) for r in conn.execute("SELECT * FROM games ORDER BY played_at")]
scout = {name: scouting.scout_lines(conn, games, tc) for name, tc in models.TIME_FILTERS.items()}

names = sorted({r[0] for r in conn.execute("SELECT DISTINCT line_name FROM opening_lines WHERE line_name IS NOT NULL")}
               | {r[0] for r in conn.execute("SELECT DISTINCT repertoire_name FROM opening_lines")}
               | {o.name for o in openings_catalog.CATALOG} | {"Queens Gambit - Semi-Slav Defense", "Grünfeld", "nothing here"})
notes = [[n, (opening_notes.notes_for(n) or None) and opening_notes.notes_for(n).title] for n in names]

records = stats.compute(conn).openings
catalog = [[o.name, (lambda r: rec(r) if r else None)(openings_catalog.your_record(o, records)),
            [openings_catalog.fit(s, o) for s in ("sharp", "quiet", "balanced", None)]] for o in openings_catalog.CATALOG]

golden = {
    "imports": imports, "gaps": reports, "bands": bands, "rating": explorer.my_recent_rating(conn),
    "describe": explorer.describe_bands(bands), "cache_rows": cache_rows,
    "popular": [[g.color, g.prefix, g.move, g.share, g.reach, g.games, g.opponent_score, g.suggestion,
                 g.suggestion_source, g.line] for g in popular],
    "opponent_positions": explorer.opponent_positions(conn),
    "scout": scout, "notes": notes, "catalog": catalog,
}
OUT.write_text(json.dumps(golden))
print(f"{len(imports)} PGN files, {sum(len(v['rows']) for v in imports.values())} imported moves; "
      f"{len(reports['All games']['gaps'])} gaps, {len(popular)} popular gaps from {cache_rows} cached positions "
      f"(bands {bands}); {len(notes)} names for notes -> {OUT}")
