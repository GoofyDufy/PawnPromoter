"""Builds the Lichess puzzle packs the web app loads (public/lichess/).

Why: browsers can't download database.lichess.org/lichess_db_puzzle.csv.zst
(the server sends no CORS headers — checked 2026-10-15), so the desktop app's
"stream the big file" import can't run in a web page. Instead this script
streams the file once, keeps the puzzles the desktop app would accept (its own
lichess_puzzles.parse / good, imported from ~/Chess — the rules never drift),
and writes them as small gzip packs per 100-point rating band, in the file's
order (sorted by puzzle id), at most PER_BAND each. The app merges the packs of
a rating range by id, which picks the same puzzles as streaming the file.

Theme top-ups (themes/<theme>/puzzles-<band>.csv.gz): the desktop can ask for
"100 puzzles of this theme", which a sample can't answer for rare themes. For
each Lichess theme the app offers (puzzle_tags.LICHESS_THEMES), the first
--per-theme good puzzles with it per band, minus those already in the base
pack — together with the base pack, the complete start of that theme's list,
so theme requests pick what the desktop would too.

The puzzle database is CC0 (public domain), so the packs can be hosted with
the app. Re-run now and then for fresh puzzles:

    ~/Chess/.venv/bin/python tools/build_lichess_packs.py [--per-band 3000] [--per-theme 300]
"""
import argparse, csv, datetime as dt, gzip, io, json, os, pathlib, sys, time

OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "lichess"
from prototype import CHESS, COMMIT  # noqa: E402  (prototype at its last commit)
import lichess_puzzles, puzzle_tags  # noqa: E402

BAND = 100
LOW, HIGH = 400, 3400                      # bands 400-499 ... 3300-3399

ap = argparse.ArgumentParser()
ap.add_argument("--per-band", type=int, default=3000)
ap.add_argument("--per-theme", type=int, default=300)
args = ap.parse_args()

bands = {b: [] for b in range(LOW, HIGH, BAND)}
full = set()
THEMES = set(puzzle_tags.LICHESS_THEMES)
theme_rows = {(t, b): [] for t in THEMES for b in bands}     # beyond the base pack
theme_seen = {(t, b): 0 for t in THEMES for b in bands}      # good puzzles with the theme so far
header = None
scanned = 0
started = time.time()
stream, close = lichess_puzzles._open_remote()
try:
    reader = csv.reader(stream)
    header = next(reader)
    for row in reader:
        scanned += 1
        if scanned % 500_000 == 0:
            print(f"  {scanned:,} rows, {sum(map(len, bands.values())):,} kept, {len(full)}/{len(bands)} bands full",
                  flush=True)
        try:                               # cheap checks before the full parse (which builds a board)
            rating, deviation, popularity, plays = int(row[3]), int(row[4]), int(row[5]), int(row[6])
        except (ValueError, IndexError):
            continue
        band = rating // BAND * BAND
        if band not in bands:
            continue
        wanted = [t for t in row[7].split() if t in THEMES and theme_seen[(t, band)] < args.per_theme]
        if band in full and not wanted:
            continue
        if (popularity < lichess_puzzles.MIN_POPULARITY or plays < lichess_puzzles.MIN_PLAYS
                or deviation > lichess_puzzles.MAX_RATING_DEVIATION):
            continue
        p = lichess_puzzles.parse(row)
        if p is None or not lichess_puzzles.good(p, band, band + BAND - 1):
            continue
        in_base = band not in full
        if in_base:
            bands[band].append(row)
            if len(bands[band]) >= args.per_band:
                full.add(band)
        for t in wanted:
            theme_seen[(t, band)] += 1
            if not in_base:
                theme_rows[(t, band)].append(row)
        if len(full) == len(bands) and all(n >= args.per_theme for n in theme_seen.values()):
            break
finally:
    close()

OUT.mkdir(parents=True, exist_ok=True)
for old in list(OUT.glob("puzzles-*.csv.gz")) + list(OUT.glob("themes/*/puzzles-*.csv.gz")):
    old.unlink()
manifest = {"source": lichess_puzzles.URL, "prototype_commit": COMMIT, "license": "CC0 1.0 (Lichess puzzle database)",
            "built": dt.date.today().isoformat(), "rows_scanned": scanned, "per_band": args.per_band,
            "band": BAND, "per_theme": args.per_theme, "filters": {"min_popularity": lichess_puzzles.MIN_POPULARITY,
                                      "min_plays": lichess_puzzles.MIN_PLAYS,
                                      "max_rating_deviation": lichess_puzzles.MAX_RATING_DEVIATION},
            "packs": [], "themes": {}}
total_bytes = 0


def write_pack(name, rows):
    global total_bytes
    text = io.StringIO()
    w = csv.writer(text, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    data = gzip.compress(text.getvalue().encode("utf-8"), compresslevel=9, mtime=0)
    (OUT / name).parent.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_bytes(data)
    total_bytes += len(data)
    return len(data)


for band, rows in bands.items():
    if not rows:
        continue
    name = f"puzzles-{band}.csv.gz"
    size = write_pack(name, rows)
    manifest["packs"].append({"band": band, "file": name, "count": len(rows), "bytes": size,
                              "first_id": rows[0][0], "last_id": rows[-1][0]})
theme_bytes = total_bytes
for theme in sorted(THEMES):
    packs = []
    for band in bands:
        rows = theme_rows[(theme, band)]
        if rows:
            name = f"themes/{theme}/puzzles-{band}.csv.gz"
            packs.append({"band": band, "file": name, "count": len(rows), "bytes": write_pack(name, rows)})
    manifest["themes"][theme] = {"packs": packs,
                                 "available": {str(b): theme_seen[(theme, b)] for b in bands if theme_seen[(theme, b)]}}
theme_bytes = total_bytes - theme_bytes
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
print(f"{scanned:,} rows scanned in {time.time() - started:.0f}s; "
      f"{sum(p['count'] for p in manifest['packs']):,} puzzles in {len(manifest['packs'])} packs + "
      f"{sum(p['count'] for t in manifest['themes'].values() for p in t['packs']):,} theme top-ups "
      f"({theme_bytes / 1e6:.1f} MB), {total_bytes / 1e6:.1f} MB in all -> {OUT}")
