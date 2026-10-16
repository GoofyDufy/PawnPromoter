# Pawn Promoter

A chess trainer that turns your own games into puzzles and drills your
opening repertoire, built as a web app: Stockfish (WASM), SQLite (OPFS) and
all the training logic run in your browser, with no server and nothing
uploaded.

It's the web version of King Coach, a Python desktop app
([GoofyDufy/Chess](https://github.com/GoofyDufy/Chess)). That app stays the
reference: this project only ever reads from it, never changes it.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Feasibility: chess.com / Lichess APIs from the browser, Stockfish WASM speed, SQLite in browser storage; Lichess puzzles as pre-built packs with theme top-ups (the Lichess file can't be downloaded by a browser); the opening library pre-described | done (`spikes/`, `public/`) |
| 1 | All the training logic ported to TypeScript and checked against the desktop app | done (`src/core/`, see [PORTING.md](PORTING.md)) |
| 2 | App shell, board, Stockfish in the browser (pool + shared engine), database in a worker, desktop import, backup, players | done (`src/ui/`, `src/engine/`, `src/data/`) |
| 3 | Puzzles: import from chess.com, analyze, solve (multi-move lines, near-best tries, explanations), the shared analysis board, Play it out, tags, Lichess puzzles, missed sacrifices — first public version | done (`src/ui/puzzleController.ts`, `src/ui/jobs.ts`, `src/ui/screens/`) |
| 4 | Opening drill, repertoire import, tree, opening library, My games (where you leave your prep, why, what works at your level) | done (`src/ui/drillController.ts`, `treeController.ts`, `TreeView.tsx`, `myGamesController.ts`, `LibraryDialog.tsx`) |
| 5 | **next** — Stats, Progress (overview, themes, this week), Game Review (badges, accuracy, prep), Tactics & Threats (tactic? / threat? / sacrifice!!), scouting | |
| 6 | Phone layout, installable app | |

The app opens (`npm run dev`) on Puzzle Review; Import & Analyze brings in your chess.com games and Lichess puzzles; Opening Drill drills your repertoire, with its tree, the opening library and My games; and "Your data" imports your desktop `chessprep.db`, backs up and adds players. The other screens come with their phases.

## Layout

- `src/ui/` — the React app: shell, board (chessground), evaluation bar, screens.
- `src/engine/` — Stockfish in the browser: UCI over a Web Worker, the pool, the shared engine.
- `src/data/` — the database worker (SQLite on OPFS, one file per player) and the page's client.
- `src/core/` — the training logic (puzzles, analysis, drills, stats, …), one
  module per desktop module. `src/core/data/` is generated from the desktop
  app's text by `tools/gen_data.py` — don't edit it by hand.
- `tests/` — unit tests, which run anywhere, and golden tests, which compare
  the results with the desktop app on your own data.
- `public/lichess/` — Lichess puzzle packs (CC0) with per-theme top-ups, built
  by `tools/build_lichess_packs.py`.
- `public/openings/` — the opening library (Lichess's named lines, CC0), each
  described Sharp / Balanced / Quiet, built by `tools/build_opening_library.py`.
- `tools/` — `snapshot.py` freezes a copy of your desktop database for the
  golden tests, `golden_*.py` record the desktop app's answers (using its
  last commit, never uncommitted edits), `gen_data.py` regenerates
  `src/core/data/`, `build_lichess_packs.py` rebuilds the puzzle packs and
  `build_opening_library.py` the opening library.
- `spikes/` — the Phase 0 experiments; throwaway.
- [PORTING.md](PORTING.md) — which desktop commit each module was ported
  from, how it was checked, and the deliberate differences.

## Development

Needs Node.js 24.

    npm install
    npm run dev         # the app at http://localhost:5173
    npm run build       # into dist/ — static files, any host
    npm test            # unit tests; golden tests skip unless set up (below)
    npm run typecheck
    tests/e2e/run.sh    # the app in headless Firefox: storage, import, Stockfish, solving a puzzle, rebuild, Lichess, drilling a line, reload

The golden tests need the desktop app in `~/Chess` with its database. They
read a snapshot (your personal data, gitignored) and skip themselves without
it:

    ~/Chess/.venv/bin/python tools/snapshot.py
    for t in chess core core2 core3 core4 core5 core6; do ~/Chess/.venv/bin/python tools/golden_$t.py; done
    npm test

Your games, analysis, database copies and Lichess token are never committed:
see `.gitignore`.

## Licence

GPL-3.0-or-later. Stockfish and chessops are GPL, so the source of the
published app stays open.
