# Porting log

The Python prototype in `~/Chess` is the reference. Each TypeScript module
records the prototype commit it was translated from, so later changes can be
carried over with:

    git -C ~/Chess diff <base commit> -- <module>.py

Only **committed** prototype changes are ported; work in progress waits.

## Core modules (Phase 1)

| Python | TypeScript | Base commit | Checked by |
|---|---|---|---|
| python-chess (Board, PGN) | `src/core/chess.ts`, `src/core/pgn.ts` | — | golden: 12,935 positions from 200 real games (FEN, SAN, legal moves, attack maps, checks); Chess960 too |
| `models.py` | `src/core/models.ts` | `2a37292` | unit tests (SM-2, time classes) |
| `db.py` | `src/core/db.ts` | `2a37292` | golden on the real DB: queues, counts, weak spots, records, weeks, repertoires |
| `analyzer.py` | `src/core/analyzer.ts` | `2a37292` | golden: identical puzzles from all 88,464 cached evaluations at 150 and 300 cp; unit tests with FakeEngine |
| `progression.py` | `src/core/progression.ts` | `2a37292` | unit tests + golden total XP / level |
| `spot.py` | `src/core/spot.ts` | `2a37292` | all prototype tests ported + golden forcing-move test on 7,265 positions |
| `explain.py` | `src/core/explain.ts` | `2a37292` | golden: every puzzle's explanation word for word (board facts, no engine) |
| `stats.py` | `src/core/stats.ts` | `2a37292` | golden, every time filter |
| `style.py` | `src/core/style.ts` | `2a37292` | golden, every time filter (verdict text included) |
| `progress_data.py` | `src/core/progressData.ts` | `2a37292` | golden, every time class |

New support code with no Python counterpart: `sqlite.ts` (database interface:
OPFS in the browser, memory in tests), `engine.ts` (async `analyse()` +
python-chess-style scores), `time.ts` (Python-style local ISO dates — never
`toISOString()`), `format.ts` (Python f-string rounding).

## Still to port

| Python | Notes |
|---|---|
| `chess_com_client.py`, `explorer.py` | network: `fetch()` (CORS verified in Phase 0) |
| `opening_importer.py`, `openings_catalog.py`, `opening_notes.py` | repertoire import (PGN variations + comments via chessops) |
| `repertoire_gaps.py`, `scouting.py` | |
| `profiles.py` | one OPFS database per player |
| `engine_ideas.py` | Stockfish ideas on the tree |
| `drill.py`, `opening_tree.py` | **actively changing in the prototype — port last** |
| `puzzle_kind.py` (+ 3 new `puzzles` columns in `db.py`/`models.py`) | **uncommitted in the prototype as of 2026-10-14 — port after it's committed** |
| `paths.py`, `engine_locator.py` | desktop-only; not needed in the browser |

## Deliberate differences

- Engine calls are `async` (`evaluateGame`, `spot.classify/judgeMove/…`,
  `explainAttempt/explainSolution`); everything else stays synchronous like
  the Python, because SQLite WASM is synchronous inside a worker.
- `explainAttempt` always returns `{ text, pv, cp }` (Python's `with_line=True` shape).
- Running several engines side by side (`evaluate_games_parallel`) moves to
  the app's Stockfish worker pool.
- Uses chessops instead of chess.js: it matches python-chess's model
  (attack maps, attackers, pseudo-legal moves, PGN variations).

## Golden tests

`tools/golden_*.py` record the prototype's answers on your real
`~/Chess/chessprep.db` (opened read-only) into `tests/golden/`, which is
gitignored because it's built from your games. The matching tests skip
themselves when those files aren't there. Regenerate after porting a change:

    ~/Chess/.venv/bin/python tools/golden_chess.py
    ~/Chess/.venv/bin/python tools/golden_core.py
    ~/Chess/.venv/bin/python tools/golden_core2.py
    npm test
