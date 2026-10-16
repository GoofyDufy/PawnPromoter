# Porting log

The Python prototype in `~/Chess` is the reference. Each TypeScript module
records the prototype commit it was translated from, so later changes can be
carried over with:

    git -C ~/Chess diff <base commit> -- <module>.py

Only **committed** prototype changes are ported; work in progress waits.

## Core modules (Phase 1) — complete

| Python | TypeScript | Base commit | Checked by |
|---|---|---|---|
| python-chess (Board, PGN) | `chess.ts`, `pgn.ts` | — | golden: 12,935 positions from 200 real games (FEN, SAN, legal moves, attack maps, checks); Chess960 too |
| `models.py` | `models.ts` | `67e3b53` | unit tests (SM-2, time classes) |
| `db.py` | `db.ts` | `67e3b53` | golden on the real DB: queues, counts, weak spots, records, weeks, repertoires |
| `analyzer.py` | `analyzer.ts` | `67e3b53` | golden: identical puzzles from all 88,464 cached evaluations at 150 and 300 cp; unit tests with FakeEngine |
| `puzzle_kind.py` | `puzzleKind.ts` | `67e3b53` | prototype tests ported (+ invalid-pass case); golden: answer kind for every puzzle |
| `progression.py` | `progression.ts` | `67e3b53` | unit tests + golden total XP / level |
| `spot.py` | `spot.ts` | `67e3b53` | all prototype tests ported + golden forcing-move test on 7,265 positions |
| `explain.py` | `explain.ts` | `2a37292` | golden: every puzzle's explanation word for word (board facts, no engine) |
| `stats.py` | `stats.ts` | `67e3b53` | golden, every time filter |
| `style.py` | `style.ts` | `67e3b53` | golden, every time filter (verdict text included) |
| `progress_data.py` | `progressData.ts` | `2a37292` | golden, every time class |
| `chess_com_client.py` | `chessCom.ts` | `67e3b53` | unit tests with a fake API |
| `explorer.py` | `explorer.ts` | `4c104cc` | prototype tests ported; download loop (rate limit, bad token) with a fake API; golden: rating bands, cache reads |
| `opening_importer.py` | `openingImporter.ts` | `4c104cc` | golden: all 10 `.pgn` files in ~/Chess imported row for row (1,049 moves, comments, line ends) |
| `repertoire_gaps.py` | `repertoireGaps.ts` | `67e3b53` | golden: gaps and common lines on 3,000 games, every filter; 250 popular gaps from the cached Lichess data |
| `scouting.py` | `scouting.ts` | `4c104cc` | golden on your games, every filter; unit test |
| `openings_catalog.py` | `openingsCatalog.ts` + generated `data/catalog.ts` | `1b1cba1` | golden: your records and fit labels for every entry |
| `opening_notes.py` | `openingNotes.ts` + generated `data/openingNotes.ts` | `1b1cba1` | golden: notes picked for 55 names |
| `profiles.py` | `profiles.ts` | `4c104cc` | unit tests (storage injected: browser storage in the app) |
| `engine_ideas.py` | `engineIdeas.ts` | `67e3b53` | unit tests (newest-position-only loop, eval text) |
| `drill.py` | `drill.ts` | `4c104cc` | all prototype tests ported (seeded random) |
| `opening_tree.py` | `openingTree.ts` | `4c104cc` | golden: 6 trees, every node's position in 4 layouts, 468 Lichess deviations, start points; prototype tests ported |
| `lichess_puzzles.py` | `lichessPuzzles.ts` | `67e3b53` | prototype tests ported; golden: 8,900 puzzles imported from the real packs by the prototype's own `download()` — 3 rating ranges and 3 themes |
| `puzzle_tags.py` | `puzzleTags.ts` | `67e3b53` | prototype tests ported; golden: automatic tags for every puzzle, your saved tags |
| `amazing.py` | `amazing.ts` | `67e3b53` | prototype tests ported; golden: every amazing move and missed sacrifice in your games, accuracy of 2,500 games, the saved scan |
| `engine_service.py` | `engineService.ts` | `67e3b53` | unit test: one start, one search at a time, restart after a crash |
| `threat.py` | `threat.ts` | `67e3b53` | prototype tests ported (TurnEngine); golden: threat-drill skills |
| `sac.py` | `sac.ts` | `67e3b53` | prototype tests ported |
| `opening_library.py` | `openingLibrary.ts` | `67e3b53` | prototype tests ported; golden: Lichess's real TSVs parsed to the same 3,865 lines |
| `library_character.py` | `libraryCharacter.ts` | `67e3b53` | prototype tests ported; golden: board-fact descriptions of all 3,865 lines; engine part pre-built (`public/openings/`) |
| `my_lines.py` | `myLines.ts` | `67e3b53` | prototype tests ported; golden: 3,007 games matched to library lines, per-line records and text |
| `my_openings.py` | `myOpenings.ts` | `67e3b53` | prototype tests ported; golden: openings, your deviations and your opponents', every filter |
| `opening_commentary.py` | `openingCommentary.ts` | `67e3b53` | prototype tests ported; golden: opening principles for every move of your 46 deviations |
| `practical.py` | `practical.ts` | `67e3b53` | prototype tests ported (ranking, text, cache) |
| `theme_stats.py` | `themeStats.ts` | `67e3b53` | prototype tests ported; golden: theme rows and skills |
| `weekly.py` | `weekly.ts` | `67e3b53` | prototype tests ported; golden: a full week of your data |

All files are in `src/core/`. New support code with no Python counterpart:
`sqlite.ts` (database interface: OPFS in the browser, memory in tests),
`engine.ts` (async `analyse()` + python-chess-style scores), `time.ts`
(Python-style local ISO dates — never `toISOString()`), `format.ts` (Python
f-string rounding). `data/*.ts` are generated by `tools/gen_data.py` — re-run
it when the prototype's notes or catalog text change.

Not ported (desktop-only): `paths.py`, `engine_locator.py`. The `*_tab.py`,
`gui.py`, `board_widget.py`, `tree_view.py`, `charts.py`, `analysis_board.py`,
`library_window.py`, `my_games_view.py`, `progress_views.py`, `trainer_page.py`
etc. are UI — Phases 2-5.

## Screens (Phase 3)

| Web | Desktop (commit) | Checked by |
|---|---|---|
| `src/ui/analysis.ts` | `analysis_board.py` (67e3b53) | `tests/analysis.test.ts` (incl. the prototype's AnalysisBoardTests) |
| `src/ui/puzzleController.ts`, `screens/PuzzleScreen.tsx` | `puzzle_tab.py` (5a380ca), Puzzle Review | `tests/puzzles.test.ts`, e2e (solves one of your puzzles by clicking) |
| `src/ui/jobs.ts`, `screens/ImportScreen.tsx` | `puzzle_tab.py` (5a380ca), Import & Analyze | e2e (rebuild, Lichess packs); analysis is `evaluateGame` (golden) |
| `src/ui/PlayDialog.tsx` | `play_window.py` (59a84d6) | by hand |
| `src/ui/drillController.ts`, `screens/DrillScreen.tsx`, `src/data/drillServices.ts` | `drill_tab.py` (5a380ca): Setup, Plans, Add lines, the drill flow | `tests/drillScreen.test.ts`, e2e (drills one of your lines by clicking) |
| `src/ui/treeController.ts`, `TreeView.tsx` (SVG), `treeHelpers.ts` | `drill_tab.py` tree methods (5a380ca), `tree_view.py` (59a84d6) | `tests/treeLibrary.test.ts`, e2e (draws your tree, a click, a new branch) |
| `src/ui/myGamesController.ts`, `src/data/myGamesServices.ts` | `my_games_view.py` (5a380ca) | e2e (your deviations, commentary, works best at your level) |
| `src/ui/LibraryDialog.tsx`, `src/data/libraryServices.ts` | `library_window.py` (5a380ca) | `tests/treeLibrary.test.ts`, e2e (load, search, preview) |
| `src/ui/openingData.ts`, the Connect Lichess dialog | `lichess_ui.py` (5a380ca) | by hand (needs your token) |
| `src/ui/trainer/*`, `screens/TrainerScreen.tsx`, `src/data/trainerServices.ts` | `trainer_page.py`, `spot_tab.py`, `threat_tab.py`, `sac_tab.py` (5a380ca) | e2e (a round of each drill on your games) |
| `src/ui/reviewController.ts`, `screens/ReviewScreen.tsx`, `src/data/reviewServices.ts` | `game_review_tab.py` (67e3b53) | e2e (a game, next mistake, badges, Analyze, Review game from a drill) |
| `screens/StatsScreen.tsx`, `DataTable.tsx`, `src/data/statsServices.ts` | `stats_tab.py` (a4339b3) | e2e (all three pages, the games behind a gap) |
| `screens/ProgressScreen.tsx`, `Charts.tsx`, `src/data/progressServices.ts` | `progress_tab.py` (a4339b3), `progress_views.py` (2f4401d), `charts.py` (79cb567) | e2e (Overview, Themes, This week) |
| `screens/ScoutScreen.tsx` | `scout_tab.py` (b7738c2) | e2e (scouts a real account) |
| `src/data/services.ts` | the database calls the tabs make (`upgradePuzzles` = puzzle_tab's start-up rule upgrades) | golden core modules + the above |

## Deliberate differences

- **Lichess puzzles come from pre-built packs**, not by streaming
  database.lichess.org: browsers can't download that file (no CORS headers —
  checked 2026-10-15). `tools/build_lichess_packs.py` filters it with the
  prototype's own `parse`/`good` into `public/lichess/` (28 packs, 75,685
  puzzles, 5 MB); `packRows()` merges a range's packs by id so `download()`
  picks the same puzzles the desktop import would. Theme requests ("+100 of
  this theme") add per-theme top-ups (`themes/<theme>/`): for each of the 39
  themes the app offers, the first 300 good puzzles per rating band beyond the
  base pack — so rare themes don't run out (15 MB in all; a request downloads
  only its own few files).
- **The opening library is pre-built** (`public/openings/library.json`,
  `tools/build_opening_library.py`): Lichess's 3,865 named lines already
  described Sharp / Balanced / Quiet by the prototype's own code and native
  Stockfish. The descriptions depend only on the line, so this saves every
  user ~35 minutes of browser Stockfish; the download itself would work.
- **Database settings in the browser:** `journal_mode=TRUNCATE`,
  `synchronous=NORMAL`, `temp_store=MEMORY` (dbWorker.ts), and schema setup in
  one transaction (`initDb`). Browser storage flushes to disk on every commit;
  on a laptop hard drive that cut a commit from ~0.5 s to ~0.15 s and a new
  database's setup from ~18 s to ~0.4 s. The desktop keeps SQLite's defaults;
  a database file moves between the two either way.
- Engine calls are `async` (`evaluateGame`, `spot.classify/judgeMove/…`,
  `explainAttempt/explainSolution`); everything else stays synchronous like
  the Python, because SQLite WASM is synchronous inside a worker.
- `explainAttempt` always returns `{ text, pv, cp }` (Python's `with_line=True` shape).
- The engine interface takes `rootMoves` (python-chess `root_moves`, UCI `searchmoves`),
  used by the opening commentary and practical moves.
- `engineService.SharedEngine` queues searches with promises instead of a lock;
  give it a factory for the real (Web Worker) engine.
- Running several engines side by side (`evaluate_games_parallel`,
  `puzzle_kind.classify_all`) moves to the app's Stockfish worker pool.
- No `User-Agent` header on chess.com / Lichess requests: browsers don't
  allow setting it (neither API needs it).
- `explorer.warm` is an async loop (no thread); `engineIdeas.IdeasEngine` is an
  async newest-position-only loop instead of a thread + UI poller.
- `profiles.ts` takes its storage as a parameter (profiles.json on desktop,
  browser storage in the app); `drill.ts` takes its random source (seeded in tests).
- **Games are analyzed with the lite single-threaded Stockfish** (WASM, ~0.5 s
  a move, 2 engines side by side). It picks the desktop's best move about 70%
  of the time, so puzzles made in the browser differ a little from desktop
  ones; a desktop database imported into the app keeps its own.
- **Engine strength** (Your data → Engine, a web-app addition): "Strong" uses
  the full-network single-threaded build (95 MB, downloaded once and cached)
  for the interactive engine and Play it out; analyzing games stays on the
  lite build. The choice is per browser (localStorage), not per player.
- "Review game" opens the game on chess.com until Game Review arrives
  (Phase 5). Import asks for the username on the page instead of a dialog;
  results show as a notice on the page instead of message boxes.
- The tag picker is a pop-over and shows every tag (no "+N" overflow chip):
  chips wrap instead.
- **Opening Drill:** after the computer's reply, the drill waits for your move.
  Desktop checked again 0.3 s later regardless, and a quick move made that
  check play the next reply at once, over your "Correct". The drill session
  runs in the database worker (it reads your lines and the Lichess cache).
  Message boxes are notices in the commentary panel; dialogs are pop-overs.
- **The tree is drawn in SVG**, not on a canvas: the same layout (openingTree.ts),
  hovering, clicking, zoom and drag. Where the selected position's Lichess
  sidelines go is decided against the drawing's own shapes instead of
  Tk's find_overlapping.
- **The opening library ships described** (no background describer in the
  browser); your games are matched to its lines in the database worker the
  first time it opens.
- **"Review game(s)"** in My games and the library open the games on
  chess.com until Game Review (Phase 5).
- **Not synced yet:** the prototype has uncommitted edits to `game_review_tab.py`,
  `stats.py`, `progress_*.py`, `scout_tab.py`, `explorer.py`, `db.py` and
  `puzzle_tab.py` (2026-10-16). Phase 5 ports their last commits; diff once committed.
- **Stats tables** sort by clicking a heading like the desktop's; the bars are the
  same ▰▱ text. Charts are SVG. Game Review's move badges are chessground custom
  shapes in the square's corner.
- "Play it out" runs its own engine, so limiting its strength never touches
  the shared engine's analysis.
- Uses chessops instead of chess.js: it matches python-chess's model
  (attack maps, attackers, pseudo-legal moves, PGN variations).

## Golden tests

`tools/snapshot.py` freezes a copy of your `~/Chess/chessprep.db` (SQLite
backup API, safe while the desktop app is open; Lichess token removed), then
`tools/golden_*.py` record the prototype's answers on that snapshot into
`tests/golden/`. They run the prototype **as of its last commit**
(`tools/prototype.py` extracts it with `git archive` — your uncommitted edits
never leak into the checks, and nothing is written to ~/Chess). Everything there is gitignored because it's built from your
games. The matching tests read the same snapshot and skip themselves when
it isn't there. Regenerate after porting a change:

    ~/Chess/.venv/bin/python tools/snapshot.py
    for t in chess core core2 core3 core4 core5 core6; do ~/Chess/.venv/bin/python tools/golden_$t.py; done
    npm test
