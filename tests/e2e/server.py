"""Serves dist-e2e/ for the end-to-end test, plus your database snapshot
(tests/golden, personal data — only on 127.0.0.1) at /fixture/snapshot.db, and
collects what the page POSTs to /report into tests/e2e/results/results.jsonl."""
import http.server, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
DIST = ROOT / "dist-e2e"
SNAPSHOT = ROOT / "tests" / "golden" / "chessprep.snapshot.db"
RESULTS = pathlib.Path(__file__).resolve().parent / "results" / "results.jsonl"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def translate_path(self, path):
        if path.split("?")[0] == "/fixture/snapshot.db":
            return str(SNAPSHOT)
        return super().translate_path(path)

    def guess_type(self, path):
        p = str(path)
        if p.endswith((".js", ".mjs")):
            return "text/javascript"
        if p.endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

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
    http.server.ThreadingHTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
