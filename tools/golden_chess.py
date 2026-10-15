"""Golden fixtures for src/core/chess.ts: python-chess's answers on real games.

Run with the prototype's venv:  ~/Chess/.venv/bin/python tools/golden_chess.py [n_games]
Reads ~/Chess/chessprep.db read-only; writes tests/golden/chess.json (gitignored —
it's built from your games).
"""
import hashlib, io, json, os, pathlib, sqlite3, sys
import chess, chess.pgn

CHESS = pathlib.Path(os.environ.get("CHESS_DIR", pathlib.Path.home() / "Chess"))
OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "chess.json"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 200


def digest(parts):
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def position_facts(board):
    attackers = [",".join(str(s) for s in sorted(board.attackers(c, sq)))
                 for sq in chess.SQUARES for c in (chess.WHITE, chess.BLACK)]
    attacks = [",".join(str(s) for s in sorted(board.attacks(sq))) for sq in chess.SQUARES]
    mobility = []
    for sq, piece in sorted(board.piece_map().items()):
        if piece.piece_type in (chess.BISHOP, chess.ROOK, chess.QUEEN):
            b = board.copy(stack=False); b.turn = piece.color
            mobility.append(f"{sq}:{sum(1 for m in b.pseudo_legal_moves if m.from_square == sq)}")
    return {"attackers": digest(attackers), "attacks": digest(attacks), "mobility": ";".join(mobility),
            "legal": sorted(m.uci() for m in board.legal_moves),
            "check": board.is_check(), "mate": board.is_checkmate(), "over": board.is_game_over()}


conn = sqlite3.connect(f"file:{CHESS / 'chessprep.db'}?mode=ro", uri=True)
rows = conn.execute("SELECT id, pgn FROM games ORDER BY played_at DESC LIMIT ?", (N,)).fetchall()
games = []
for gid, pgn in rows:
    game = chess.pgn.read_game(io.StringIO(pgn))
    board = game.board()
    plies = []
    for move in game.mainline_moves():
        uci = move.uci()
        plies.append({"fen": board.fen(), "uci": uci, "san": board.san(move),
                      "capture": board.is_capture(move), "ep": board.is_en_passant(move),
                      "castling": board.is_castling(move), "gives_check": board.gives_check(move),
                      **position_facts(board)})
        board.push(move)
    games.append({"id": gid, "pgn": pgn, "start": game.board().fen(), "plies": plies,
                  "final_fen": board.fen(), "final": position_facts(board)})
OUT.write_text(json.dumps(games))
print(f"{len(games)} games, {sum(len(g['plies']) for g in games)} positions -> {OUT}")
