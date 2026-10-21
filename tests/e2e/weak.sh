#!/usr/bin/env bash
# Stats → Weaknesses end to end: builds the e2e page, imports your snapshot
# into a kept profile (tests/e2e/results/ff-profile-weak), analyses 25 games
# for real in headless Firefox, prints the results; then screenshots.py can
# open the same profile. Usage: tests/e2e/weak.sh [--keep-server]
set -eu
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/node/bin:$PATH"
[ -f tests/golden/chessprep.snapshot.db ] || { echo "run tools/snapshot.py first"; exit 1; }
node tools/copy-engine.mjs >/dev/null && npx vite build --mode e2e --logLevel warn
mkdir -p tests/e2e/results && : > tests/e2e/results/results.jsonl
python3 -I tests/e2e/server.py & SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
export SPIKE_PROFILE="$PWD/tests/e2e/results/ff-profile-weak"; rm -rf "$SPIKE_PROFILE"; mkdir -p "$SPIKE_PROFILE"
tests/e2e/run_page.sh "e2e.html?phase=weak" 1800
grep -v '"done": true' tests/e2e/results/results.jsonl | python3 -m json.tool --json-lines
