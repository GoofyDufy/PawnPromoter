#!/usr/bin/env bash
# Opens KingSide Coach in your browser (the desktop launcher runs this): starts
# the dev server on http://127.0.0.1:5173 if it isn't already running — the dev
# server is what lets Your data → "Load from King Coach" read ~/Chess — then
# opens the page. The server keeps running in the background; its log is in
# ~/.cache/pawnpromoter/dev.log.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
URL="http://127.0.0.1:5173/"
up() { (exec 3<>/dev/tcp/127.0.0.1/5173) 2>/dev/null; }
if ! up; then
  mkdir -p "$HOME/.cache/pawnpromoter"
  nohup npm run dev -- --host 127.0.0.1 --port 5173 --strictPort > "$HOME/.cache/pawnpromoter/dev.log" 2>&1 &
  for _ in $(seq 60); do up && break; sleep 0.5; done
fi
xdg-open "$URL" >/dev/null 2>&1 &
