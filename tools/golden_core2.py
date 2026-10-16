"""Golden fixtures, part 2: stats, style, progress, XP, sharpness, explanations
and Spot the Tactic's forcing-move test — on the snapshot of your chessprep.db (tools/snapshot.py).
Writes tests/golden/core2.json (gitignored).

Run:  ~/Chess/.venv/bin/python tools/golden_core2.py
"""
import json, os, pathlib, sqlite3, sys
from golden_common import CHESS, COMMIT, PROTOTYPE, SNAPSHOT  # noqa: E402  (prototype at its last commit)

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "core2.json"
import chess  # noqa: E402
import db, explain, models, progress_data, progression, spot, stats, style  # noqa: E402

conn = sqlite3.connect(f"file:{SNAPSHOT}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

rec = lambda r: [r.wins, r.draws, r.losses]
phase = lambda p: [p.moves, p.total_loss, p.blunders]
key = lambda k: f"{k[0]}\t{k[1]}"

def stats_json(s):
    return {"total_games": s.total_games, "engine_games": s.engine_games,
            "openings": [[key(k), rec(r)] for k, r in s.openings.items()],
            "loss_reasons": [[tc, list(v.items())] for tc, v in s.loss_reasons.items()],
            "phases": [[k, phase(v)] for k, v in s.phases.items()],
            "clock": [[k, phase(v)] for k, v in s.clock.items()]}

def style_json(r):
    return {"games": r.games, "multipv_games": r.multipv_games,
            "accuracy": [[k, phase(v)] for k, v in r.accuracy.items()],
            "only_moves": [r.only_moves, r.only_moves_found], "punish": [r.punish_chances, r.punished],
            "game_types": [[k, rec(v)] for k, v in r.game_types.items()],
            "openings": [[key(k), rec(v[0]), v[1]] for k, v in r.openings.items()],
            "cutoffs": list(r.sharp_cutoffs), "style": r.style, "verdict": r.verdict}

puzzles = [db._row_to_puzzle(r) for r in conn.execute("SELECT * FROM puzzles ORDER BY id")]
explanations, forcing = [], []
for p in puzzles:
    best = chess.Move.from_uci(p.correct_move_uci)
    board = chess.Board(p.fen)
    played = board.parse_san(p.played_move_san) if p.played_move_san else None
    explanations.append([p.id, explain.explain_solution(p.fen, best, played, None),
                         explain.explain_attempt(p.fen, played, None) if played else None])
    forcing.append([p.id, spot.is_forcing(board, best), spot.is_forcing(board, played) if played else None,
                    style.pawn_structure(p.fen), stats.is_endgame(p.fen)])

xp = progression.total_xp(conn)
level = progression.level_for(xp)
golden = {
    "stats": {name: stats_json(stats.compute(conn, tc)) for name, tc in models.TIME_FILTERS.items()},
    "style": {name: style_json(style.compute_style(conn, tc)) for name, tc in models.TIME_FILTERS.items()},
    "progress": {tc: progress_data.compute(conn, tc, 1800) for tc in ("Rapid", "Blitz", "Bullet", "Daily")},
    "xp": xp, "level": [level.number, level.name, level.xp_into_level, level.xp_for_level],
    "level_costs": progression.LEVEL_COSTS,
    "sharpness": sorted([k, v] for k, v in style.puzzle_sharpness(conn, puzzles).items()),
    "explanations": explanations, "forcing": forcing,
    "spot_summary": vars(spot.summary(conn)), "spot_xp": spot.xp(conn),
}
OUT.write_text(json.dumps(golden))
print(f"{len(puzzles)} puzzles explained; XP {xp} ({level.name}) -> {OUT}")
