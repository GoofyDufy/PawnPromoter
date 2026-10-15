"""Static server for the Phase 0 browser spikes.

Sends the COOP/COEP headers multithreaded Stockfish needs (pass --no-isolation
to test without them) and appends whatever pages POST to /report into
results/results.jsonl.
"""
import argparse, http.server, json, os, pathlib

ROOT = pathlib.Path(__file__).parent
RESULTS = ROOT / "results" / "results.jsonl"


class Handler(http.server.SimpleHTTPRequestHandler):
    isolate = True

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        if self.isolate:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith((".js", ".mjs")):
            return "text/javascript"
        if str(path).endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        RESULTS.parent.mkdir(exist_ok=True)
        with RESULTS.open("a") as f:
            f.write(json.dumps(json.loads(body)) + "\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-isolation", action="store_true")
    args = ap.parse_args()
    Handler.isolate = not args.no_isolation
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
