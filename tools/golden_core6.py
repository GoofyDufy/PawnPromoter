"""Golden fixtures, part 6 (prototype 67e3b53+): amazing moves / missed
sacrifices / accuracy, My games, the opening library (Lichess's real TSVs),
line descriptions (board facts), your games per library line, opening
principles for your deviations, theme stats, skills, the week, and the
one-off puzzle fixes — on the snapshot. Writes tests/golden/core6.json.

Run:  ~/Chess/.venv/bin/python tools/golden_core6.py   (after tools/snapshot.py)
"""
import json, pathlib, shutil, sqlite3, tempfile

from golden_common import COMMIT, SNAPSHOT  # noqa: E402  (prototype at its last commit)
import datetime as dt  # noqa: E402
import chess  # noqa: E402
import amazing, analyzer, db, library_character, models, my_lines, my_openings  # noqa: E402
import opening_commentary, opening_library, theme_stats, weekly  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "core6.json"
conn = sqlite3.connect(f"file:{SNAPSHOT}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
rec = lambda r: [r.wins, r.draws, r.losses]

# amazing moves / missed sacrifices / accuracy
found = [list(vars(a).values()) for a in amazing._find_all_direct(conn)]
missed = [list(vars(m).values()) for m in amazing._find_missed_direct(conn)]
evals = {}
for r in conn.execute("SELECT game_id, ply, cp_before, cp_after FROM move_evaluations"):
    evals.setdefault(r["game_id"], {})[r["ply"]] = {"cp_before": r["cp_before"], "cp_after": r["cp_after"]}
accuracy = sorted([gid, amazing.game_accuracy(e)] for gid, e in evals.items())

# My games
def dev_json(d):
    return [d.color, d.prefix, d.fen, d.played_uci, d.played_san, d.prep_ucis, d.prep_sans, rec(d.record),
            rec(d.prep_record), d.opening, d.repertoires, d.game_ids, d.line, d.move_number]
mine = {}
for name, tc in models.TIME_FILTERS.items():
    r = my_openings.compute(conn, tc)
    mine[name] = {"games": r.games,
                  "openings": [[o.name, o.color, rec(o.record), o.followed, o.left, o.no_prep,
                                list(o.deviation_keys.items())] for o in r.openings],
                  "deviations": [dev_json(d) for d in r.deviations],
                  "opponent": [[o.color, o.prefix, o.fen, o.played_uci, o.played_san, o.prep_ucis, o.prep_sans,
                                rec(o.record), list(o.replies.items()), o.opening, o.game_ids, o.usual_reply]
                               for o in r.opponent_deviations]}

# opening principles for each of your deviations (board with the game's moves)
principles = []
for d in my_openings.compute(conn).deviations:
    board = chess.Board()
    for san in d.prefix:
        board.push_san(san)
    for uci in [d.played_uci] + d.prep_ucis:
        principles.append([d.key, uci, [[f.good, f.text] for f in opening_commentary.principles(board, chess.Move.from_uci(uci))]])

# the opening library from Lichess's real TSVs, and the board-fact descriptions
tsvs = {}
import requests  # noqa: E402
for part in opening_library.PARTS:
    tsvs[part] = requests.get(opening_library.URL.format(part=part), timeout=30).text
rows = []
for part in opening_library.PARTS:
    rows += opening_library.parse(tsvs[part])
described = []
for i, row in enumerate(rows):
    o = opening_library.Opening(i + 1, row["eco"], row["name"], row["family"], row["pgn"], row["sans"].split(), row["ucis"].split())
    c = library_character.describe(None, o)
    described.append([c.label, c.score, c.text])

# your games per library line, on a copy with the library loaded
tmp = pathlib.Path(tempfile.mkdtemp()) / "t.db"
shutil.copy(SNAPSHOT, tmp)
db.DB_PATH = tmp
c2 = db.get_connection()
opening_library.save(c2, rows)
positions = my_lines.library_positions(c2)
matches = sorted([g, *my_lines.match_game(p, positions)] for g, p in c2.execute("SELECT id, pgn FROM games"))
my_lines.save(c2, matches)
names = {o.id: o.name for o in opening_library.search(c2, limit=100000)}
line_recs = sorted([names[lid], color, rec(r.record), r.loss_sum, r.loss_moves, r.blunders, r.eval_sum, r.eval_games,
                    sorted(r.game_ids), my_lines.describe(r)] for (lid, color), r in my_lines.records(c2).items())

# the one-off puzzle fixes, on a fresh copy each
def fixed(fn):
    t = pathlib.Path(tempfile.mkdtemp()) / "t.db"
    shutil.copy(SNAPSHOT, t)
    c = sqlite3.connect(t)
    c.row_factory = sqlite3.Row
    out = list(fn(c))
    after = sorted([r[0], r[1], r[2], r[3]] for r in c.execute(
        "SELECT source_game_id, fen, correct_move_uci, puzzle_type FROM puzzles"))
    return out, after

today = max(dt.datetime.fromisoformat(r[0]).date() for r in conn.execute("SELECT played_at FROM games"))
w = weekly.review(conn, today)
golden = {
    "commit": COMMIT, "amazing": found, "missed": missed, "accuracy": accuracy, "my_openings": mine,
    "principles": principles, "tsvs": tsvs, "library_rows": rows, "described": described,
    "matches": matches, "line_records": line_recs,
    "themes": [[t.tag, t.tries, t.solved, t.near, t.recent_tries, t.recent_solved, t.yours]
               for t in theme_stats.theme_rows(conn, "2026-09-15")],
    "skills": [[s.name, s.hits, s.total] for s in theme_stats.skills(conn)],
    "week_today": today.isoformat(),
    "week": {"start": w.start.isoformat(), "games": w.games, "wins": w.wins, "losses": w.losses, "draws": w.draws,
             "analyzed": w.analyzed, "rating": [w.rating_class, w.rating_from, w.rating_to],
             "mistakes": [[m.puzzle_id, m.game_id, m.move_number, m.played_san, m.best_san, m.before_cp, m.after_cp,
                           m.kind, m.puzzle_type, round(m.cost, 12), m.swing_text()] for m in w.mistakes],
             "counts": [w.mistake_count, w.facing_threat, w.endgame, w.common_type, w.common_type_count,
                        w.puzzles_tried, w.puzzles_solved, w.spot_rounds, w.threat_rounds, w.lines_drilled],
             "suggestions": [[s.text, s.action, s.arg] for s in w.suggestions]},
    "chances_rule": fixed(analyzer.apply_chances_rule),
    "missed_sacrifices": fixed(analyzer.add_missed_sacrifices),
}
OUT.write_text(json.dumps(golden))
print(f"commit {COMMIT}: {len(found)} amazing, {len(missed)} missed sacrifices, {len(accuracy)} game accuracies; "
      f"{len(mine['All games']['deviations'])} deviations; {len(rows)} library lines; "
      f"{sum(1 for m in matches if m[1])} games matched to lines; week of {today} -> {OUT}")
