"""Golden fixtures for the core modules: the Python prototype's answers on
your real chessprep.db (opened read-only). Writes tests/golden/core.json
(gitignored — built from your data).

Run:  ~/Chess/.venv/bin/python tools/golden_core.py
"""
import json, os, pathlib, sqlite3, sys

CHESS = pathlib.Path(os.environ.get("CHESS_DIR", pathlib.Path.home() / "Chess"))
OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "core.json"
sys.path.insert(0, str(CHESS))
import analyzer, db, models  # noqa: E402

conn = sqlite3.connect(f"file:{CHESS / 'chessprep.db'}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
commit = os.popen(f"git -C {CHESS} rev-parse --short HEAD").read().strip()

evals = db.all_evaluations_by_game(conn)
puzzles = {}
for threshold in (150, 300):
    out = []
    for game_id in sorted(evals):
        for p in analyzer.puzzles_from_evaluations(evals[game_id], threshold):
            out.append([p.source_game_id, p.fen, p.correct_move_san, p.played_move_san,
                        p.eval_swing_cp, p.puzzle_type])
    puzzles[threshold] = out

filters = {name: sorted(tc) if tc else None for name, tc in models.TIME_FILTERS.items()}
golden = {
    "commit": commit,
    "puzzles": puzzles,
    "game_stats": {name: db.game_stats(conn, tc) for name, tc in models.TIME_FILTERS.items()},
    "needing_eval": {name: [g.id for g in db.games_needing_evaluation(conn, 50, tc)]
                     for name, tc in models.TIME_FILTERS.items()},
    "filters": filters,
    "weak": {t: db.weak_item_ids(conn, t) for t in ("puzzle", "line")},
    "records": db.puzzle_records(conn),
    "by_week": {t: db.attempts_by_week(conn, t) for t in ("puzzle", "line")},
    "repertoires": sorted(db.list_repertoires(conn)),
    "first_moves": {c: db.first_moves(conn, c) for c in ("white", "black")},
    "types": db.distinct_puzzle_types(conn),
    "time_classes": {tc: models.time_class(tc) for tc in
                     {r[0] for r in conn.execute("SELECT DISTINCT time_control FROM games")} | {"", "abc", "60+x", "1/86400", None}
                     if tc is not None},
}
OUT.write_text(json.dumps(golden))
print(f"commit {commit}: {sum(len(v) for v in evals.values())} evaluations -> "
      f"{len(puzzles[150])} / {len(puzzles[300])} puzzles; {OUT}")
