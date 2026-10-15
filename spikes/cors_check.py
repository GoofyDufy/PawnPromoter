"""Spike 0.1: simulate the browser's CORS checks against every API King Coach uses."""
import urllib.request, urllib.error

ORIGIN = "https://pawnpromoter.com"

def req(method, url, headers):
    r = urllib.request.Request(url, method=method, headers={"Origin": ORIGIN, "User-Agent": "Mozilla/5.0", **headers})
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers

checks = [
    ("chess.com archives", "GET", "https://api.chess.com/pub/player/hikaru/games/archives", {}),
    ("chess.com month",    "GET", "https://api.chess.com/pub/player/hikaru/games/2026/09", {}),
    ("lichess explorer (no token)", "GET", "https://explorer.lichess.ovh/lichess?fen=rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR%20b%20KQkq%20-%200%201", {}),
    ("lichess explorer preflight (token)", "OPTIONS", "https://explorer.lichess.ovh/lichess",
        {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}),
    ("lichess account preflight (token)", "OPTIONS", "https://lichess.org/api/account",
        {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}),
]
for name, m, url, h in checks:
    status, hd = req(m, url, h)
    acao = hd.get("Access-Control-Allow-Origin")
    extra = ""
    if m == "OPTIONS":
        extra = f"  allow-headers={hd.get('Access-Control-Allow-Headers')}"
    print(f"{name:38} HTTP {status}  allow-origin={acao}{extra}")
