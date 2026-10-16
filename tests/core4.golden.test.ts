// Part 4 of the golden checks (tools/golden_core4.py): the opening tree for
// each of your repertoires — structure, every node's position in normal, wide,
// focused and zoomed layouts, Lichess deviations and opening start points.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import * as db from '../src/core/db';
import * as explorer from '../src/core/explorer';
import * as tree from '../src/core/openingTree';
import { type Db, openMemoryDb } from '../src/core/sqlite';

const FIXTURE = new URL('./golden/core4.json', import.meta.url);
const DB_FILE = fileURLToPath(new URL('./golden/chessprep.snapshot.db', import.meta.url));   // tools/snapshot.py
const ready = existsSync(FIXTURE) && existsSync(DB_FILE);
const golden = ready ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;

const ucis = (n: tree.Node) => n.path.map((m) => m.move_uci).join(' ');

function dump(t: tree.Tree) {
  const nodes: [string, number, number][] = [];
  const stack = [t.root];
  while (stack.length) {
    const n = stack.pop()!;
    stack.push(...n.children);
    nodes.push([ucis(n), n.x, n.y]);
  }
  nodes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    width: t.width, height: t.height,
    board: t.board === null ? null : [t.board.x0, t.board.bottom, t.board.square, t.board.ranks, t.board.flipped],
    focus: t.focus === null ? null : ucis(t.focus),
    hidden: t.branches.filter((b) => !t.visible(b)).map((b) => ucis(b.end)).sort(),
    branches: t.branches.map((b) => [ucis(b.end), b.nodes.length, b.depth, b.color_index, b.lines]),
    nodes,
  };
}

function expectSameView(got: ReturnType<typeof dump>, want: any, label: string) {
  expect({ ...got, nodes: undefined, board: undefined, width: undefined }, label)
    .toEqual({ ...want, nodes: undefined, board: undefined, width: undefined });
  expect(got.width).toBeCloseTo(want.width, 9);
  if (want.board === null) expect(got.board).toBeNull();
  else {
    got.board!.slice(0, 3).forEach((v, i) => expect(v as number).toBeCloseTo(want.board[i], 9));
    expect(got.board!.slice(3)).toEqual(want.board.slice(3));
  }
  expect(got.nodes.map((n) => n[0]), label).toEqual(want.nodes.map((n: any) => n[0]));
  got.nodes.forEach(([path, x, y], i) => {
    expect(x, `${label} ${path} x`).toBeCloseTo(want.nodes[i][1], 6);
    expect(y, `${label} ${path} y`).toBeCloseTo(want.nodes[i][2], 6);
  });
}

describe.skipIf(!ready)('the opening tree matches the Python prototype on your repertoires', () => {
  let conn: Db;
  beforeAll(async () => {
    conn = db.initDb(await openMemoryDb(new Uint8Array(readFileSync(DB_FILE))));
  });

  it('builds and lays out every tree the same way, in every view', () => {
    expect(golden.length).toBeGreaterThan(0);
    for (const c of golden) {
      const label = `${c.name ?? 'all'} (${c.color})`;
      const t = tree.build(conn, c.name, c.color);
      expect(t.leaves.map(([n, p, end]) => [n, p.map((m) => m.move_uci), ucis(end)]), label).toEqual(c.leaves);
      expectSameView(dump(tree.layout(t, 400, 420)), c.views.normal, `${label} normal`);
      expectSameView(dump(tree.layout(t, 900, 600)), c.views.wide, `${label} wide`);
      const first = t.branches.filter((b) => b.parent === null);
      expectSameView(dump(tree.layout(t, 400, 420, first[first.length - 1].nodes[0])), c.views.focus, `${label} focus`);
      // max(branches, key=(depth, len(nodes))): the first of equal maxima
      let deep = t.branches[0];
      for (const b of t.branches) {
        if (b.depth > deep.depth || (b.depth === deep.depth && b.nodes.length > deep.nodes.length)) deep = b;
      }
      expect(ucis(deep.end)).toBe(c.zoom_on);
      expectSameView(dump(tree.layout(t, 400, 420, null, deep)), c.views.zoom, `${label} zoom`);
      expect(t.branches.map((b) => tree.thickness(b.lines))).toEqual(c.thickness);
    }
  });

  it('finds the same Lichess deviations and opening starts', () => {
    const bands = explorer.ratingBands(conn);
    for (const c of golden) {
      const t = tree.build(conn, c.name, c.color);
      const devs = tree.deviations(t, (fen) => explorer.cached(conn, fen, bands), c.color);
      const got = [...devs.values()].flat().map((d) => [ucis(d.node), d.uci, d.san, d.share, d.games, d.score])
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      const want = [...c.deviations].sort((a: unknown, b: unknown) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      expect(got.length, c.name).toBe(want.length);
      got.forEach((d, i) => {
        expect(d.slice(0, 3).concat([d[4]]), c.name).toEqual(want[i].slice(0, 3).concat([want[i][4]]));
        expect(d[3] as number).toBeCloseTo(want[i][3], 12);
        expect(d[5] as number).toBeCloseTo(want[i][5], 12);
      });
      if (c.name !== null) expect(tree.startPath(conn, c.name, c.color), c.name).toEqual(c.start_path);
    }
  });
});
