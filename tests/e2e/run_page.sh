#!/usr/bin/env bash
# Usage: run_page.sh "<path?query>" [timeout_seconds]
# Opens the page in headless Firefox (throwaway profile) and waits until it
# POSTs {"done": true} to the spike server, or the timeout passes.
set -u
URL="http://127.0.0.1:8766/$1"
TIMEOUT="${2:-300}"
DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS="$DIR/results/results.jsonl"
mkdir -p "$DIR/results"; touch "$RESULTS"
# snap Firefox has a private /tmp, so the throwaway profile lives under results/
PROFILE="${SPIKE_PROFILE:-$(mktemp -d "$DIR/results/ff-profile.XXXX")}"
before=$(grep -c '"done": true' "$RESULTS")

firefox --headless --no-remote --profile "$PROFILE" "$URL" >/dev/null 2>&1 &
FF=$!
for ((i = 0; i < TIMEOUT; i++)); do
  sleep 1
  [ "$(grep -c '"done": true' "$RESULTS")" -gt "$before" ] && break
done
kill "$FF" 2>/dev/null; wait "$FF" 2>/dev/null
[ -z "${SPIKE_PROFILE:-}" ] && rm -rf "$PROFILE"
[ "$i" -ge "$TIMEOUT" ] && echo "TIMEOUT after ${TIMEOUT}s: $1"
exit 0
