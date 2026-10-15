# Pawn Promoter

Web version of King Coach, the chess trainer that turns your own games into
puzzles and drills your opening repertoire. Runs entirely in the browser:
Stockfish (WASM), SQLite (OPFS) and all the training logic, with no server.

The Python desktop prototype it's ported from lives separately in `~/Chess`
(github.com/GoofyDufy/Chess) and is only ever read from, never modified.

- `src/core/` — the training logic, ported module by module from the prototype (see PORTING.md)
- `tests/` — unit tests (run anywhere) and golden tests against the prototype (your data only)
- `tools/` — scripts that record the prototype's answers for the golden tests
- `spikes/` — Phase 0 feasibility checks (APIs, Stockfish speed, SQLite storage); throwaway

    npm install
    npm test          # vitest
    npm run typecheck
