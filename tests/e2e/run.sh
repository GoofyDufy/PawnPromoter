#!/usr/bin/env bash
# End-to-end check of the app in headless Firefox: builds the e2e page, serves
# it (with your database snapshot from tools/snapshot.py), runs phase 1 and,
# with the same browser profile, phase 2 (after a reload); then, in a fresh
# profile, the app opened first on an empty database. Prints the results.
set -eu
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/node/bin:$PATH"
[ -f tests/golden/chessprep.snapshot.db ] || { echo "run tools/snapshot.py first"; exit 1; }
node tools/copy-engine.mjs >/dev/null && npx vite build --mode e2e --logLevel warn
mkdir -p tests/e2e/results && : > tests/e2e/results/results.jsonl
python3 -I tests/e2e/server.py & SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf tests/e2e/results/ff-profile*' EXIT
sleep 1
export SPIKE_PROFILE="$PWD/tests/e2e/results/ff-profile-e2e"; rm -rf "$SPIKE_PROFILE"; mkdir -p "$SPIKE_PROFILE"
tests/e2e/run_page.sh "e2e.html?phase=1" 300
tests/e2e/run_page.sh "e2e.html?phase=2" 120
export SPIKE_PROFILE="$PWD/tests/e2e/results/ff-profile-fresh"; rm -rf "$SPIKE_PROFILE"; mkdir -p "$SPIKE_PROFILE"
tests/e2e/run_page.sh "e2e.html?phase=ui" 500
grep -v '"done": true' tests/e2e/results/results.jsonl | python3 -m json.tool --json-lines
