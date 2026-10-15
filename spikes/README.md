# Phase 0 spikes (throwaway)

Proof-of-concept checks before the web port. Not part of the app.

    npm install                                   # stockfish, sqlite-wasm, chess.js (pinned)
    ~/Chess/.venv/bin/python make_tasks.py        # reads ~/Chess (read-only): builds public/tasks.json + native baseline
    cp ~/Chess/chessprep.db public/               # only while testing; contains your Lichess token — delete after (gitignored)
    python3 server.py [--no-isolation]            # serves on :8765, collects results/results.jsonl
    ./run_page.sh "bench.html?flavor=stockfish-19-lite-single&workers=2"
    SPIKE_PROFILE=$PWD/results/p ./run_page.sh "sqlite.html?phase=import"   # then phase=reload

- cors_check.py  — 0.1 chess.com / Lichess APIs callable from a browser
- bench.html     — 0.2 Stockfish WASM speed and accuracy vs native
- sqlite.html    — 0.3 real chessprep.db in OPFS: import, persist, query, export
