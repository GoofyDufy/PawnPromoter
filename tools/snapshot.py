"""Freezes a copy of your ~/Chess/chessprep.db for the golden tests, so the
Python recording and the TypeScript tests compare the same data even while
you keep practising in the desktop app.

Uses SQLite's backup API (safe while the app is writing), then removes the
Lichess token from the copy — the tests don't need it. The snapshot lives in
tests/golden/ (gitignored: it's your personal data).

Run first:  ~/Chess/.venv/bin/python tools/snapshot.py
"""
import os, pathlib, sqlite3

CHESS = pathlib.Path(os.environ.get("CHESS_DIR", pathlib.Path.home() / "Chess"))
SNAPSHOT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "chessprep.snapshot.db"

SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
SNAPSHOT.unlink(missing_ok=True)
src = sqlite3.connect(f"file:{CHESS / 'chessprep.db'}?mode=ro", uri=True)
dst = sqlite3.connect(SNAPSHOT)
src.backup(dst)
src.close()
dst.execute("DELETE FROM settings WHERE key = 'lichess_token'")
dst.commit()
dst.execute("VACUUM")
dst.close()
print(f"snapshot -> {SNAPSHOT} ({SNAPSHOT.stat().st_size // 1024} KB, Lichess token removed)")
