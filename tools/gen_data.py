"""Generates the static data modules from the Python prototype, so the
hand-written opening explainers and the openings catalog are never retyped:

    src/core/data/openingNotes.ts   <- opening_notes.NOTES, MATCHERS
    src/core/data/catalog.ts        <- openings_catalog.CATALOG

Run after the prototype's text changes:  ~/Chess/.venv/bin/python tools/gen_data.py
"""
import dataclasses, json, os, pathlib, subprocess, sys

DATA = pathlib.Path(__file__).resolve().parent.parent / "src" / "core" / "data"
from prototype import CHESS, COMMIT  # noqa: E402  (prototype at its last commit)
import opening_notes, openings_catalog  # noqa: E402

commit = subprocess.run(["git", "-C", str(CHESS), "log", "-1", "--format=%h", COMMIT, "--",
                         "opening_notes.py", "openings_catalog.py"], capture_output=True, text=True).stdout.strip()


def header(source):
    return (f"// GENERATED from ~/Chess/{source} (prototype commit {commit}) by tools/gen_data.py.\n"
            "// Don't edit by hand — change the prototype and re-run the generator.\n")


notes = {k: dataclasses.asdict(v) for k, v in opening_notes.NOTES.items()}
matchers = [[list(keywords), key] for keywords, key in opening_notes.MATCHERS]
(DATA / "openingNotes.ts").write_text(
    header("opening_notes.py")
    + "import type { OpeningNotes } from '../openingNotes';\n\n"
    + f"export const NOTES: Record<string, OpeningNotes> = {json.dumps(notes, indent=2, ensure_ascii=False)};\n\n"
    + "/** [keywords that must ALL appear, notes key] — most specific first */\n"
    + f"export const MATCHERS: [string[], string][] = {json.dumps(matchers, ensure_ascii=False)};\n")

catalog = [{**dataclasses.asdict(o), "color": o.color.value} for o in openings_catalog.CATALOG]
(DATA / "catalog.ts").write_text(
    header("openings_catalog.py")
    + "import type { CatalogOpening } from '../openingsCatalog';\n\n"
    + f"export const CATALOG: CatalogOpening[] = {json.dumps(catalog, indent=2, ensure_ascii=False)};\n")
print(f"commit {commit}: {len(notes)} opening notes, {len(matchers)} matchers, {len(catalog)} catalog openings")
