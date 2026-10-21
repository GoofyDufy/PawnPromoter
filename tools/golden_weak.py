"""Golden fixture for src/core/weak/stats.ts: the weakness-stats prototype's stored rows and its report.

Run with the prototype's venv:  ~/WeaknessStats/.venv/bin/python tools/golden_weak.py
Reads ~/WeaknessStats/out/weakstats.db (read-only) and recomputes the report there, at the prototype's
current code; writes tests/golden/weak.json (gitignored — it's built from your games).
"""
import json, pathlib, sqlite3, sys

PROTO = pathlib.Path.home() / "WeaknessStats"
sys.path.insert(0, str(PROTO))
from weakstats.engine import EngineConfig  # noqa: E402
from weakstats.stats import compute_all  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "weak.json"
GAME_COLS = ("game_id player_colour result eco_code opening_name eco_source time_control base_s increment_s "
             "date clock_coverage clock_valid").split()
POS_COLS = ("game_id ply fen side_to_move move_number move_uci move_san mover score_type score_value best_move_uci "
            "pv_uci phase clock_after_s emt_s cp_raw_white cp_cap_white mate_white n_legal is_book terminal").split()


def main():
    cfg = EngineConfig()
    conn = sqlite3.connect(f"file:{PROTO / 'out' / 'weakstats.db'}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    games = conn.execute("SELECT * FROM games WHERE time_control = '180+2' ORDER BY date DESC").fetchall()
    rows = {"games": [{c: g[c] for c in GAME_COLS} for g in games], "positions": {}}
    for g in games:
        rows["positions"][g["game_id"]] = [{c: p[c] for c in POS_COLS} for p in conn.execute(
            "SELECT * FROM positions WHERE game_id = ? ORDER BY ply", (g["game_id"],))]
    reports = {str(w): compute_all(conn, "180+2", cfg.config_id, cfg.spec_version, w) for w in (50, 10_000)}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"config_id": cfg.config_id, "spec_version": cfg.spec_version, "rows": rows, "reports": reports}))
    print(f"wrote {OUT} ({len(games)} games)")


if __name__ == "__main__":
    main()
