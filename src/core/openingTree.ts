/**
 * Your repertoire as one tree, for the Tree view in Opening Drill — port of
 * opening_tree.py. Drawn as a "living tree": the starting position is the
 * root, every point where your lines part is a knot, and each line ends in a leaf.
 *
 * Lines that share their first moves are merged (separately imported PGN games
 * included), so 1.d4 Nf6 2.c4 ... is one branch until the lines differ. A line
 * that stops where others carry on gets its own leaf at that knot.
 *
 * Pure data + layout, no drawing: build() makes the tree, layout() places it in
 * a width x height box (growing wider than the box when there are many lines).
 * Python's id(...) lookups are object identity here (Map / Set keyed by node).
 */
import { BLACK, Board, WHITE, squareFile, squareRank } from './chess';
import * as db from './db';
import type { OpeningLine, PlayerColor } from './models';
import type { StatsFor } from './repertoireGaps';
import type { Db } from './sqlite';

export const LEAF_SPACING = 26;     // minimum px between neighbouring leaves
export const MARGIN_X = 28;
export const MARGIN_RIGHT = 96;     // leaf names slant up to the right: room for the last one
export const TOP = 112;             // leaves' row (their names go above, slanted)
export const BOTTOM_PAD = 34;       // the root sits this far above the bottom edge

/** Destination square of a UCI move. */
const toSquare = (uci: string) => uci.charCodeAt(2) - 97 + 8 * (uci.charCodeAt(3) - 49);

export type LineEnd = [string, OpeningLine[]];   // [line name, path]

/** One position: reached by `move` (null at the start). */
export class Node {
  children: Node[] = [];
  line_ends: LineEnd[] = [];
  x = 0.0;
  y = 0.0;

  constructor(readonly move: OpeningLine | null, readonly parent: Node | null = null) {}

  get path(): OpeningLine[] {
    const out: OpeningLine[] = [];
    let node: Node | null = this;
    while (node !== null && node.move !== null) {
      out.push(node.move);
      node = node.parent;
    }
    return out.reverse();
  }

  get ply(): number {
    return this.path.length;
  }

  /** Every line ending at or under this position. */
  lines(): LineEnd[] {
    const out = [...this.line_ends];
    for (const child of this.children) out.push(...child.lines());
    return out;
  }

  board(): Board {
    const board = Board.fromFen();
    for (const node of this.path) board.push(node.move_uci);
    return board;
  }
}

/** A run of moves with no choice in it: from a knot (or the start) to the next
 *  knot or a leaf. `nodes` are its positions, the last one is the knot. */
export class Branch {
  children: Branch[] = [];
  leaf_index: number | null = null;
  color_index = 0;

  constructor(readonly nodes: Node[], readonly parent: Branch | null = null, readonly depth = 0) {}

  get end(): Node {
    return this.nodes[this.nodes.length - 1];
  }

  get lines(): number {
    return this.end.lines().length;
  }

  /** Starts with the game's first move: grows out of its square on the mini board. */
  get is_first_move(): boolean {
    return this.parent === null;
  }

  get start_xy(): [number, number] {
    const first = this.nodes[0];
    if (this.is_first_move) return [first.x, first.y];
    return [first.parent!.x, first.parent!.y];
  }

  /** Where its i-th position sits along its curve (0 = start, 1 = end). */
  t_at(i: number): number {
    if (this.is_first_move) return this.nodes.length > 1 ? i / (this.nodes.length - 1) : 1.0;
    return (i + 1) / this.nodes.length;
  }
}

/** The near half of a chess set under the tree: your pieces, with each first
 *  move's piece on its square and a tree growing out of it. */
export class MiniBoard {
  constructor(
    readonly x0: number,
    readonly bottom: number,
    readonly square: number,
    readonly ranks: number[],          // displayed ranks (0-7), from the bottom row up
    readonly flipped: boolean,         // Black at the bottom
  ) {}

  center(sq: number): [number, number] {
    const file = squareFile(sq);
    const rank = squareRank(sq);
    const col = this.flipped ? 7 - file : file;
    const row = this.ranks.indexOf(rank);
    return [this.x0 + (col + 0.5) * this.square, this.bottom - (row + 0.5) * this.square];
  }

  get top(): number {
    return this.bottom - this.ranks.length * this.square;
  }
}

export class Tree {
  width = 0.0;
  height = 0.0;
  board: MiniBoard | null = null;
  focus: Node | null = null;          // a first move: only its tree is laid out (the rest hidden)
  zoom: Branch | null = null;         // zoomed in: only this branch and what grows from it
  hidden = new Set<Branch>();         // branches not shown

  constructor(
    readonly root: Node,
    readonly branches: Branch[],
    readonly leaves: [string, OpeningLine[], Node][],   // every line: [name, path, end position]
    readonly my_color: PlayerColor = 'white',
  ) {}

  visible(branch: Branch): boolean {
    return !this.hidden.has(branch);
  }

  firstMoveOf(node: Node | null): Node | null {
    while (node !== null && node.parent !== null && node.parent.move !== null) node = node.parent;
    return node !== null && node.move !== null ? node : null;
  }

  nodeForPath(ucis: string[]): Node | null {
    let node: Node | undefined = this.root;
    for (const uci of ucis) {
      node = node.children.find((c) => c.move!.move_uci === uci);
      if (!node) return null;
    }
    return node;
  }
}

/** One repertoire's tree, or (repertoireName null) every repertoire of that
 *  colour merged into one forest — a tree per first move. */
export function build(conn: Db, repertoireName: string | null, myColor: PlayerColor): Tree {
  const rows = repertoireName === null
    ? conn.all('SELECT * FROM opening_lines WHERE my_color = ? AND is_enabled = 1', [myColor])
    : conn.all('SELECT * FROM opening_lines WHERE repertoire_name = ? AND my_color = ? AND is_enabled = 1', [repertoireName, myColor]);
  const nodes = rows.map(db.rowToOpeningLine);
  const children = new Map<string | null, OpeningLine[]>();
  for (const n of nodes) {
    if (!children.has(n.parent_id)) children.set(n.parent_id, []);
    children.get(n.parent_id)!.push(n);
  }

  const root = new Node(null);
  const leaves: [string, OpeningLine[], Node][] = [];

  const walk = (lineRoot: OpeningLine, node: OpeningLine, prefix: OpeningLine[]): void => {
    const path = [...prefix, node];
    const kids = children.get(node.id) ?? [];
    if (!kids.length) {
      let pos = root;
      for (const step of path) {     // merge with lines sharing the same moves
        let next = pos.children.find((c) => c.move!.move_uci === step.move_uci);
        if (!next) {
          next = new Node(step, pos);
          pos.children.push(next);
        }
        pos = next;
      }
      const name = lineRoot.line_name || lineRoot.repertoire_name;
      pos.line_ends.push([name, path]);
      leaves.push([name, path, pos]);
    }
    for (const kid of kids) walk(lineRoot, kid, path);
  };

  for (const lineRoot of children.get(null) ?? []) walk(lineRoot, lineRoot, []);

  const branches: Branch[] = [];
  const makeBranch = (first: Node, parent: Branch | null, depth: number): Branch => {
    const run = [first];
    while (run[run.length - 1].children.length === 1 && !run[run.length - 1].line_ends.length) {
      run.push(run[run.length - 1].children[0]);
    }
    const branch = new Branch(run, parent, depth);
    branches.push(branch);
    for (const child of run[run.length - 1].children) branch.children.push(makeBranch(child, branch, depth + 1));
    return branch;
  };

  for (const child of root.children) makeBranch(child, null, 1);
  return new Tree(root, branches, leaves, myColor);
}

export const MINI_SQUARE = 26;      // px per square of the mini board (smaller if the view is narrow)
export const KNOT_GAP = 22;         // first knots sit this far above the board
export const ZOOM_BASE = 30;        // zoomed in: the branch starts this far above the bottom

/** The mini board along the bottom; each first move's tree grows from its
 *  piece, its strip of width in proportion to its lines. focus (a first move):
 *  only that tree, across the whole width. zoom (a branch further in): only it
 *  and what grows from it, starting at the bottom, no board. Leaves spread
 *  along the top row, each knot centred over the leaves it leads to, knots
 *  stepping up by depth. */
export function layout(tree: Tree, width: number, height: number, focus: Node | null = null,
  zoom: Branch | null = null): Tree {
  let tops = tree.branches.filter((b) => b.parent === null);
  tree.zoom = zoom !== null && zoom.parent !== null ? zoom : null;
  if (tree.zoom !== null) {
    tops = [tree.zoom];
    let node = tree.zoom.nodes[0];
    while (node.parent !== null && node.parent.move !== null) node = node.parent;
    tree.focus = node;
  } else if (focus !== null && tops.some((b) => b.nodes[0] === focus)) {
    tops = tops.filter((b) => b.nodes[0] === focus);
    tree.focus = focus;
  } else {
    tree.focus = null;
  }
  const shown = new Set<Branch>();
  const mark = (branch: Branch): void => {
    shown.add(branch);
    for (const child of branch.children) mark(child);
  };
  for (const b of tops) mark(b);
  tree.hidden = new Set(tree.branches.filter((b) => !shown.has(b)));

  const groups: Branch[][] = [];      // leaf slots per first-move tree, left to right
  tops.sort((a, b) => squareOrder(tree, a) - squareOrder(tree, b));
  for (const top of tops) {
    const slots: Branch[] = [];
    const order = (branch: Branch): void => {
      if (branch.end.line_ends.length) slots.push(branch);   // a line ends here (maybe others carry on)
      for (const child of branch.children) order(child);
    };
    order(top);
    groups.push(slots);
  }
  const n = Math.max(1, groups.reduce((s, g) => s + g.length, 0));
  tree.width = Math.max(width, MARGIN_X + MARGIN_RIGHT + (n - 1) * LEAF_SPACING);
  tree.height = height;
  const span = tree.width - MARGIN_X - MARGIN_RIGHT;

  // leaves evenly spaced overall, so each tree's strip is in proportion to its lines
  const xs = new Map<Branch, number>();
  let i = 0;
  for (const slots of groups) {
    for (const b of slots) {
      xs.set(b, MARGIN_X + (n > 1 ? (span * i) / (n - 1) : span / 2));
      b.color_index = i;
      i += 1;
    }
  }

  // the mini board: your back ranks up to the furthest first move
  const flipped = tree.my_color === 'black';
  let destRanks = tree.branches.filter((b) => b.parent === null).map((b) => squareRank(toSquare(b.nodes[0].move!.move_uci)));
  if (!destRanks.length) destRanks = [3];
  const ranks: number[] = [];
  if (flipped) for (let r = 7; r >= Math.min(...destRanks); r--) ranks.push(r);
  else for (let r = 0; r <= Math.max(...destRanks); r++) ranks.push(r);
  const sq = Math.min(MINI_SQUARE, (width - 2 * MARGIN_X) / 8);
  tree.board = new MiniBoard((tree.width - 8 * sq) / 2, height - 6, sq, ranks, flipped);
  let baseY = tree.board.top - KNOT_GAP;
  let depth0 = 0;                     // depth counted from here
  if (tree.zoom !== null) {
    tree.board = null;                // zoomed in: the branch itself is the base
    baseY = height - ZOOM_BASE - KNOT_GAP;
    depth0 = tree.zoom.depth - 1;
  }

  const visible = tree.branches.filter((b) => shown.has(b));
  const maxDepth = visible.length ? Math.max(...visible.map((b) => b.depth - depth0)) : 1;
  const step = ((baseY - TOP) * 0.82) / Math.max(1, maxDepth);

  const place = (branch: Branch): number => {
    const childX = branch.children.map(place);
    const own = xs.has(branch) ? [xs.get(branch)!] : [];
    const all = [...childX, ...own];
    const x = all.reduce((s, v) => s + v, 0) / all.length;
    if (tree.board !== null && branch.is_first_move && branch.nodes.length === 1 && branch.children.length) {
      // lines part right after the first move: the knot IS the piece on the board
      [branch.end.x, branch.end.y] = firstXy(tree, branch);
    } else {
      branch.end.x = x;
      branch.end.y = !branch.children.length ? TOP : baseY - (branch.depth - depth0 - 1) * step - step * 0.5;
    }
    return x;
  };

  for (const b of tops) {
    place(b);
    if (tree.board !== null) [b.nodes[0].x, b.nodes[0].y] = firstXy(tree, b);
  }
  if (tree.zoom !== null) {
    // the zoomed branch grows from the bottom centre (from its knot below, hidden)
    const start = tree.zoom.nodes[0].parent!;
    start.x = tree.width / 2;
    start.y = height - ZOOM_BASE;
    tree.root.x = start.x;
    tree.root.y = start.y;
  } else {
    tree.root.x = tree.width / 2;
    tree.root.y = (tree.board!.top + tree.board!.bottom) / 2;
  }

  // positions along each branch, on its curve (the knot is the last one)
  for (const b of visible) {
    const [x0, y0] = b.start_xy;
    const [x1, y1] = [b.end.x, b.end.y];
    for (const [j, node] of b.nodes.slice(0, -1).entries()) {
      if (b.is_first_move && j === 0) continue;     // on its square
      [node.x, node.y] = bezier(x0, y0, x1, y1, b.t_at(j));
    }
  }
  return tree;
}

function firstXy(tree: Tree, top: Branch): [number, number] {
  return tree.board!.center(toSquare(top.nodes[0].move!.move_uci));
}

/** Trees left to right in the order their squares sit on the board. */
function squareOrder(tree: Tree, top: Branch): number {
  const file = squareFile(toSquare(top.nodes[0].move!.move_uci));
  return tree.my_color === 'black' ? 7 - file : file;
}

/** Control points of a branch: leaves the knot straight up, arrives straight up. */
export function curve(x0: number, y0: number, x1: number, y1: number): number[] {
  const rise = y0 - y1;
  return [x0, y0, x0, y0 - rise * 0.5, x1, y1 + rise * 0.5, x1, y1];
}

export function bezier(x0: number, y0: number, x1: number, y1: number, t: number): [number, number] {
  const p = curve(x0, y0, x1, y1);
  const u = 1 - t;
  const x = u ** 3 * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t ** 3 * p[6];
  const y = u ** 3 * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t ** 3 * p[7];
  return [x, y];
}

/** Branch width grows with the lines running through it. */
export function thickness(lines: number): number {
  return 3 + 2.6 * Math.sqrt(Math.max(1, lines));
}

// ---------- where Lichess players leave your lines ----------

export const MIN_DEVIATION_SHARE = 0.08;   // a reply played in at least 8% of games there...
export const MIN_DEVIATION_GAMES = 30;     // ...with enough games to mean something
export const DEVIATIONS_PER_POSITION = 3;

export interface Deviation {
  node: Node;              // the position (opponent to move, your prep continues)
  uci: string;
  san: string;             // e.g. "7...c5"
  share: number;           // of games at that position
  games: number;
  score: number;           // how the players choosing it score
}

/** node -> popular opponent replies your lines don't cover, most played first.
 *  statsFor(fen) -> explorer PositionStats or null (cache only). Only where
 *  your prep goes on with an opponent move. */
export function deviations(tree: Tree, statsFor: StatsFor, myColor: PlayerColor): Map<Node, Deviation[]> {
  const mine = myColor === 'white' ? WHITE : BLACK;
  const out = new Map<Node, Deviation[]>();
  const stack = [tree.root];
  while (stack.length) {
    const node = stack.pop()!;
    stack.push(...node.children);
    if (!node.children.length) continue;
    const board = node.board();
    if (board.turn === mine) continue;
    const stats = statsFor(board.fen());
    if (!stats || !stats.games) continue;
    const covered = new Set(node.children.map((c) => c.move!.move_uci));
    const found: Deviation[] = [];
    for (const m of stats.moves) {
      const share = m.games / stats.games;
      if (covered.has(m.uci) || share < MIN_DEVIATION_SHARE || m.games < MIN_DEVIATION_GAMES) continue;
      if (!board.isLegal(m.uci)) continue;
      const san = board.san(m.uci);
      const number = board.fullmoveNumber;
      const prefix = board.turn === WHITE ? `${number}.` : `${number}...`;
      found.push({ node, uci: m.uci, san: prefix + san, share, games: m.games, score: m.scoreFor(board.turn) });
    }
    if (found.length) {
      found.sort((a, b) => b.share - a.share);
      out.set(node, found.slice(0, DEVIATIONS_PER_POSITION));
    }
  }
  return out;
}

// ---------- where an opening starts ----------
// Before that, the opponent's moves are OTHER openings (1...d5 against your
// Catalan isn't a Catalan deviation); from there on, they're deviations from
// your lines. Default: where all the repertoire's lines still agree (its trunk);
// a player can move it (saved per repertoire in settings).

function startKey(repertoireName: string, myColor: PlayerColor): string {
  return `opening_start|${repertoireName}|${myColor}`;
}

export function defaultStart(tree: Tree): Node {
  const tops = tree.branches.filter((b) => b.parent === null);
  return tops.length === 1 ? tops[0].end : tree.root;
}

export function startNode(conn: Db, tree: Tree, repertoireName: string, myColor: PlayerColor): Node {
  const saved = db.getSetting(conn, startKey(repertoireName, myColor));
  if (saved !== null) {
    const node = saved ? tree.nodeForPath(saved.split(/\s+/)) : tree.root;
    if (node !== null) return node;
  }
  return defaultStart(tree);
}

/** node null: back to the default. */
export function setStart(conn: Db, repertoireName: string, myColor: PlayerColor, node: Node | null): void {
  const key = startKey(repertoireName, myColor);
  if (node === null) conn.run('DELETE FROM settings WHERE key = ?', [key]);
  else db.setSetting(conn, key, node.path.map((m) => m.move_uci).join(' '));
}

/** The start position as moves (for code that has no tree at hand). */
export function startPath(conn: Db, repertoireName: string, myColor: PlayerColor): string[] {
  const tree = build(conn, repertoireName, myColor);
  return startNode(conn, tree, repertoireName, myColor).path.map((m) => m.move_uci);
}

/** At or after the opening's start. */
export function isInside(node: Node | null, start: Node): boolean {
  while (node !== null) {
    if (node === start) return true;
    node = node.parent;
  }
  return false;
}
