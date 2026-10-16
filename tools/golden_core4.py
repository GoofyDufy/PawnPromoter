"""Golden fixtures, part 4: the opening tree (build + layout in normal, focused
and zoomed views, Lichess deviations, opening start points) for each of your
repertoires, on the snapshot from tools/snapshot.py. Writes tests/golden/core4.json.

Run:  ~/Chess/.venv/bin/python tools/golden_core4.py
"""
import json, os, pathlib, sqlite3, sys
from golden_common import CHESS, COMMIT, PROTOTYPE, SNAPSHOT  # noqa: E402  (prototype at its last commit)

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "core4.json"
import db, explorer, opening_tree  # noqa: E402
from models import PlayerColor  # noqa: E402

conn = sqlite3.connect(f"file:{SNAPSHOT}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
bands = explorer.rating_bands(conn)
stats_for = lambda fen: explorer.cached(conn, fen, bands)


def ucis(node):
    return " ".join(m.move_uci for m in node.path)


def dump(tree):
    nodes = []
    stack = [tree.root]
    while stack:
        n = stack.pop()
        stack.extend(n.children)
        nodes.append([ucis(n), round(n.x, 9), round(n.y, 9)])
    return {"width": tree.width, "height": tree.height,
            "board": None if tree.board is None else [tree.board.x0, tree.board.bottom, tree.board.square,
                                                       tree.board.ranks, tree.board.flipped],
            "focus": None if tree.focus is None else ucis(tree.focus),
            "hidden": sorted(ucis(b.end) for b in tree.branches if not tree.visible(b)),
            "branches": [[ucis(b.end), len(b.nodes), b.depth, b.color_index, b.lines] for b in tree.branches],
            "nodes": sorted(nodes)}


cases = []
reps = sorted({(r[0], r[1]) for r in conn.execute("SELECT DISTINCT repertoire_name, my_color FROM opening_lines")})
for name, color in [(n, c) for n, c in reps] + [(None, "white"), (None, "black")]:
    pc = PlayerColor(color)
    tree = opening_tree.build(conn, name, pc)
    if not tree.branches:
        continue
    case = {"name": name, "color": color,
            "leaves": [[n, [m.move_uci for m in p], ucis(end)] for n, p, end in tree.leaves],
            "views": {}}
    case["views"]["normal"] = dump(opening_tree.layout(tree, 400, 420))
    case["views"]["wide"] = dump(opening_tree.layout(tree, 900, 600))
    first = [b for b in tree.branches if b.parent is None]
    case["views"]["focus"] = dump(opening_tree.layout(tree, 400, 420, focus=first[-1].nodes[0]))
    deep = max(tree.branches, key=lambda b: (b.depth, len(b.nodes)))
    case["zoom_on"] = ucis(deep.end)
    case["views"]["zoom"] = dump(opening_tree.layout(tree, 400, 420, zoom=deep))
    devs = opening_tree.deviations(tree, stats_for, pc)
    case["deviations"] = sorted([ucis(d.node), d.uci, d.san, d.share, d.games, d.score]
                                for lst in devs.values() for d in lst)
    if name is not None:
        case["start_path"] = opening_tree.start_path(conn, name, pc)
    case["thickness"] = [opening_tree.thickness(b.lines) for b in tree.branches]
    cases.append(case)
OUT.write_text(json.dumps(cases))
print(f"{len(cases)} trees, {sum(len(c['leaves']) for c in cases)} leaves, "
      f"{sum(len(c['deviations']) for c in cases)} deviations -> {OUT}")
