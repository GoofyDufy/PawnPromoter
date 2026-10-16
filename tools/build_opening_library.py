"""Builds the opening library the web app ships (public/openings/library.json):
every named line from Lichess's chess-openings dataset (CC0), each already
described Sharp / Balanced / Quiet by the prototype's own library_character
(board facts + Stockfish).

Why pre-built: the descriptions depend only on the line, never on the player,
and take ~7 minutes of native Stockfish — ~35 in a browser, for every user.
Computing them once here gives everyone the same result instantly. (The
download itself works from a browser; this just saves the engine time.)

Uses the prototype at its last commit (tools/prototype.py) and your native
Stockfish (found the way the desktop app finds it). Re-run when Lichess's
dataset or the prototype's description rules change:

    ~/Chess/.venv/bin/python tools/build_opening_library.py
"""
import datetime as dt, json, pathlib, sys, time

from prototype import COMMIT  # noqa: E402  (prototype at its last commit)
import chess.engine  # noqa: E402
import engine_locator, library_character, opening_library  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "openings" / "library.json"

started = time.time()
rows = opening_library.download()
print(f"{len(rows)} lines from {opening_library.SOURCE}", flush=True)
path = engine_locator.find_stockfish()
assert path, "Stockfish not found (see the desktop app's README)"
with chess.engine.SimpleEngine.popen_uci(path) as engine:
    for i, row in enumerate(rows):
        opening = opening_library.Opening(i + 1, row["eco"], row["name"], row["family"], row["pgn"],
                                          row["sans"].split(), row["ucis"].split())
        c = library_character.describe(engine, opening)
        row.update(character=c.label, sharpness=c.score, description=c.text, eval_cp=c.eval_cp,
                   char_version=library_character.VERSION)
        if (i + 1) % 500 == 0:
            print(f"  {i + 1}/{len(rows)} described ({time.time() - started:.0f}s)", flush=True)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({
    "source": opening_library.SOURCE, "built": dt.date.today().isoformat(), "prototype_commit": COMMIT,
    "char_version": library_character.VERSION, "engine": path.rsplit("/", 1)[-1],
    "columns": ["eco", "name", "family", "pgn", "sans", "ucis", "plies", "character", "sharpness",
                "description", "eval_cp", "char_version"],
    "rows": [[r[k] for k in ("eco", "name", "family", "pgn", "sans", "ucis", "plies", "character", "sharpness",
                             "description", "eval_cp", "char_version")] for r in rows],
}, ensure_ascii=False, separators=(",", ":")))
print(f"{len(rows)} lines described in {time.time() - started:.0f}s -> {OUT} ({OUT.stat().st_size // 1024} KB)")
