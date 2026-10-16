# Lichess puzzle packs

Puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles)
(CC0 1.0 — public domain), pre-filtered by `tools/build_lichess_packs.py` with
the desktop app's quality rules (popularity ≥ 80, ≥ 300 plays, rating
deviation ≤ 100) into one gzip CSV per 100-point rating band, in the file's
order. `manifest.json` lists the packs and when they were built.

They exist because browsers can't download the full database file from
database.lichess.org (no CORS headers), so the web app loads these instead.
Re-run the script for fresh puzzles.
