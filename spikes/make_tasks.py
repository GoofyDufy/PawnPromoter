"""Spike 0.2 baseline: turn one real game into the exact engine searches the
desktop analyzer would run, and time native Stockfish on them."""
import io, json, os, pathlib, sys, time, sqlite3

# the Python prototype this benchmarks against (run with its .venv python)
CHESS = pathlib.Path(os.environ.get("CHESS_DIR", pathlib.Path.home() / "Chess"))
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(CHESS))
import chess, chess.pgn, chess.engine
import analyzer, engine_locator

conn = sqlite3.connect(f"file:{CHESS / 'chessprep.db'}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
row = conn.execute("""SELECT * FROM games WHERE length(pgn) > 1500
                      ORDER BY played_at DESC LIMIT 1""").fetchone()
print("game", row["chess_com_url"], row["played_at"])

my_color = chess.WHITE if row["my_color"] == "white" else chess.BLACK
parsed = chess.pgn.read_game(io.StringIO(row["pgn"]))
board = parsed.board()

path = engine_locator.find_stockfish()
print("native engine:", path)
limit = chess.engine.Limit(depth=analyzer.ANALYSIS_DEPTH)
tasks, t0 = [], time.perf_counter()
with chess.engine.SimpleEngine.popen_uci(path) as eng:
    for move in parsed.mainline_moves():
        if board.turn == my_color:
            lines = eng.analyse(board, limit, multipv=analyzer.MULTI_PV)
            cp = analyzer._score_to_cp(lines[0]["score"], my_color)
            tasks.append({"fen": board.fen(), "multipv": 3, "best": lines[0]["pv"][0].uci(), "cp": cp})
            if abs(cp) < analyzer.DECISIVE_EVAL_CP:
                board.push(move)
                info = eng.analyse(board, limit)
                tasks.append({"fen": board.fen(), "multipv": 1, "best": info["pv"][0].uci(),
                              "cp": analyzer._score_to_cp(info["score"], my_color)})
                board.pop()
        board.push(move)
native = time.perf_counter() - t0
json.dump({"depth": analyzer.ANALYSIS_DEPTH, "my_color": "white" if my_color else "black", "native_seconds": native, "tasks": tasks},
          open(HERE / "public" / "tasks.json", "w"), indent=1)
print(f"{len(tasks)} searches, native single-thread: {native:.2f}s")
