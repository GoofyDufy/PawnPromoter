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

## Weakness stats (from ~/WeaknessStats, 2026-10-21)

A second reference: the weakness-stats prototype in `~/WeaknessStats` (Python,
not a git repo yet), built to its spec pack (SPEC.md v1.1 + FIXES-v1.2.md).

| Python | TypeScript | Checked by |
|---|---|---|
| `weakstats/evalcore.py`, `see.py` | `core/weak/evalcore.ts`, `see.ts` | prototype tests ported (SPEC §8 vectors, mate signs, SEE) |
| `weakstats/eco.py`, `tools/build_eco.py` | `core/weak/book.ts` (built from the `opening_library` table) | `tests/weakAnalysis.test.ts` |
| `weakstats/stats.py` | `core/weak/stats.ts` | prototype tests ported; golden (`tools/golden_weak.py`): the whole report, both windows, on the prototype's 188 analysed games |
| `weakstats/pipeline.py`, `engine.py`, `store.py` | `core/weak/analysis.ts`, `store.ts`, `data/weakServices.ts`, `jobs.analyzeWeak` | `tests/weakAnalysis.test.ts`; e2e `tests/e2e/weak.sh` |
| — (web only) | `core/weak/training.ts` — training plans (PHASE2.md P2.1, first version) | — |

Differences from the prototype: the engine setting (Stockfish 19 lite WASM,
depth 14, hash kept within a game, `sf19lite-d14-g1`; the prototype used
Stockfish 16 native at depth 18), positions deep in the opening book are not
searched (every stat treats them as having no evaluation), and the screen is
Stats → Weaknesses instead of a separate page (examples open Game Review).
Openings are grouped by family × colour in both.

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
- **Tactic? additions** (web only): a Hint button (what to look for → the
  piece → the move; a hinted move isn't scored); the board stays where you
  finished instead of jumping back to the start; arrows on the start position
  for the best move (green), your move (blue) and your game's move (yellow);
  Stockfish's top 3 lines after each round, each opening the analysis board.
  The evaluation bar is plain grey until the answer in all three drills.
- **Threat? additions** (web only): after naming the threat the board waits
  for "Now answer it →"; after your answer it stays on your move, a "Why"
  (explain.ts, worded for a drill move) says what's wrong with a weak answer
  and ▶ steps through the punishing line; Stockfish's lines and the analysis
  board as in Tactic? (shared in trainer/base.ts).
- **Sacrifice!! additions** (web only): the line ends when the sacrifice has
  paid off — mate, a forced draw (the same position 3 times), the material
  back (and better), or crushing while still down; a calm position no longer
  ends it while you're down material; MAX_MOVES 15 (desktop 10). Results say
  how it ended (Forced mate / Forced draw / Wins material …); mate scores show
  as M2 (also on every evaluation bar, instead of #2). Attack / Defend (the
  computer sacrifices, you defend; sacrifices that force mate are left out; recorded with key "…|defend"), a source
  filter (All / My games / Lichess), your game's moves as you go, Play it out
  from the end, and Try other defences (replay against Stockfish's other
  reasonable defences, unscored).
- **Game Review layout** (web only): the games list folds into a rail once a
  game is open (☰ Games opens it); a search box (opponent, or words in your
  notes) and a "📝 with notes" filter; the notes box sits under the board.
- **Opening Drill** (web only): after a wrong move you can play again at once
  (Show correct move stays offered — no Try again click); variations are
  grouped under their opening's name in the list and the title; Show full
  line draws colour-coded move pairs you can click.
- **Stats → Results by opening → Practice** (web only): the opening as you
  play it (the moves at least half your games in it share) goes into a
  "From your games" repertoire and the drill opens on it.
- **The Coach** (web only, `core/coach.ts`): Game Review's "Why" box, rewritten
  as a human coach would say it — rules only, no AI. It reads the position
  (named pawn structures and their plans, pawn breaks, walled-in bishops,
  stuck knights, outposts, development, the king's shelter, material vs
  evaluation), takes the engine's facts from `explain.solutionFacts` (shared
  with `explainSolution`, whose wording is unchanged), and says: what went
  wrong, what was better and why, "one move too early", whether the engine's
  move is a human one, the practical view, and the game's turning point.
  Material is only claimed when the evaluation backs it.
  Structures (2026-10-21, from PAWN-STRUCTURES-EXPLAINER.md): IQP, hanging pawns,
  Carlsbad, Maroczy bind, Boleslavsky hole (Sicilian …e5 + …d6), French chain,
  locked and open centres — each also recognised with colours reversed; healthy
  pawn majorities (a–c / e–h, doubled pawns don't count) are an Ideas point once
  the queens are off.
  Endgames (2026-10-21, from ENDGAME-EXPLAINER.md, `core/endgame.ts`): the ending's
  family, opposite-coloured bishops, the rule of the square (exact, pawn endings),
  rook-pawn and wrong-bishop corner draws, stalemate traps, Lucena / Philidor on exact
  matches only (silent when the engine's score disagrees), and captures that trade into
  a pawn ending — CoachIdeas has the engine score them; the Coach warns when the trade
  throws the advantage away (≥ 0.2 winning chances) and says so when the pawn ending wins.
  **💡 Ideas** (Game Review, remembered as `review_ideas`): the Coach on the
  position itself — who's better in human terms, structure and plans for both
  sides, pawn breaks, space, passed pawns, bad bishops / stuck knights /
  outposts / open files, kings and weaknesses, and Stockfish's plan in words.
  Deepened from our GothamChess notes: **📋 Game summary** ("What went well" — the hard moves found, a mistake punished, a defence, a clean conversion, keeping it open for the bishops or closed for the knights, an outpost, a model start, a long accurate stretch;
  phase by phase with the mistakes to jump to, one line on why you won or
  lost — one oversight, a slow slide, or the opening — and 1–2 takeaways);
  **What your opponent wants** (their last move and what it threatens, from a
  "pass" search); **Who has what** (material, king safety, activity, space);
  move habits (a check for its own sake, a one-move attack, trading when down,
  trading queens in your own attack, grabbing a pawn before developing); and
  position rules (opposite-side castling race, bishop pair, Rule of +2 vs a
  merely loose king, rooks facing on a file, weak colour complexes, backward
  pawns).
  Deepened again from our Naroditsky notes: what a pawn move leaves behind
  (squares no pawn can guard again), a move on the wing met by a strike in the
  centre, the base of the pawn chain in a locked centre and the push that hits
  it, hooks in an opposite-castling race, loose pieces (undefended, or guarded
  only by the queen — counted when attacked or advanced), king and queen on
  one open line, fianchetto holes, a sealed back rank (and the luft move), a
  "bad" bishop that guards a pawn, an **Endgame** section (the active king, an
  outside passer, rooks behind passed pawns, counting tempi in pawn endings),
  luft and fianchettos no longer called "loosening", the habit of pushing
  pawns in front of your own king in a race, and two summary lessons (giving
  a slip straight back; one mistake straight after another).
  **The Coach on the other tabs** (`ui/coachIdeas.ts` + `IdeasPanel`, shared
  with Game Review): 💡 Ideas, on / off remembered per tab, in Puzzle Review
  (once solved or revealed — it follows the board through the line; a wrong
  try also gets the habit behind it, "Coach: Bb5+ is a check for its own
  sake…"), Tactics & Threats (once the answer is shown), the Analysis board
  ("you" = the side at the bottom; it uses the lines Stockfish already shows)
  and Opening Drill (once a line is finished). Never before the answer, so it
  can't give a puzzle away.
  **Tuned on real games:** every Ideas point has a rule and a weight (0–100);
  the top three show first as **Key ideas**, the rest fold under "More".
  `tests/ideasAudit.test.ts` (skipped unless `IDEAS_SAMPLE` points at a JSON
  export of positions from your database) counts how often each rule fires,
  by phase, and how often it makes the key list, and dumps sample text to
  `IDEAS_OUT`. The first audit (600 of your positions) led to: a locked centre
  needs pawns pushed past the middle, no structure names in endgames, loose
  pieces in endgames only when attacked, isolated pawns only on half-open
  files, edge holes only next to the king, no central-king warning with the
  queens off, castling named as castling, and "no direct threat" only when
  Stockfish actually looked.
  **Why, not just what:** `coach.moveReasons` says what a move does (takes,
  forks, pins, attacks, defends a hanging piece, develops, centralises, takes
  an outpost, strikes at a pawn, frees a bishop, puts a rook on an open file or
  the 7th, pushes a passer). Stockfish's top three moves (MultiPV) each get
  their reason — "Just as good: Bc4 (develops the bishop)" — or "the only move
  that keeps things together" when the next best is a pawn worse; pawn breaks
  say what they'd do. **What's new:** points the last move made true are
  marked "New:" and move up. **By stage:** the opening stresses development
  and the king, the endgame passed pawns and the king, structure talk less.
  **Why the best move works** (`coach.lineOutcome` / `planOf`): Stockfish's
  line is played to a quiet moment (6 plies, on through captures and checks)
  and the end is compared with the start — material (only when the evaluation
  backs it), a king coming under fire or castling, passed pawns made or lost,
  reachable pawn weaknesses left behind, a knight on an outpost, rooks on open
  files or the 7th, development, trading down when ahead, activity. The
  biggest changes become the first key idea: "Your plan: win material. After
  32...Bd4 33.Kh1 Qxf2 34.Bd3, your opponent wins a pawn." A quiet best move
  that stops the other side's threat (a short null-move search, then a check
  that the threat no longer works) says so — "h3 is mainly a defensive move:
  it stops Bg4" — and an only move says what goes wrong after the next best.
  With `IDEAS_ENGINE=/usr/games/stockfish` the audit runs this whole pipeline
  on every 5th position.
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
