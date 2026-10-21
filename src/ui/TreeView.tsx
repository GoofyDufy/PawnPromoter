/**
 * The "living tree" drawing of a repertoire (tree_view.py; layout in
 * openingTree.ts), as SVG: bark-coloured branches growing up from your pieces
 * on a mini board, thicker where more lines run, a bead for every move, a knot
 * where lines part and a coloured leaf, with its name, where each line ends.
 * The selected position glows back to the root; the line ahead is dashed.
 * Hovering snaps to the nearest move; a click picks it; the wheel steps along
 * the line (Ctrl + wheel or + − zoom in, drag to move). Lichess players'
 * popular replies: rings, and for the selected position clickable sidelines;
 * your games: red (you) and blue (your opponents) stars. A new branch being
 * played sprouts as a dashed twig. Wider than the view: it scrolls sideways.
 */
import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Board as ChessBoard } from '../core/chess';
import * as openingTree from '../core/openingTree';
import type { Branch, Node, Tree } from '../core/openingTree';
import type { MyDeviationView, OpponentDeviationView } from '../data/myGamesServices';
import type { TreeController } from './treeController';
import { endName, familyRoots, likelyColors, moveLabel } from './treeHelpers';

const BARK = '#4E4434';
const BEAD = '#8A7E68';
const GLOW = 'var(--gold)';
const NAME_CHARS = 20;          // leaf names longer than this are shortened (the full name shows below the tree)
const SNAP_PX = 24;             // the pointer picks the nearest move within this distance
const DRAFT_STEP: [number, number] = [15, -17];
const MY_DEVIATION = '#D9534F';
const OPP_DEVIATION = '#3B82F6';
const WILD = '#6B7280';
const WILD_BEFORE = '#3F4450';
const WILD_BEFORE_TEXT = '#6B7280';
const LABEL_AT = 0.78;
const LEAF_COLORS = ['#E6A94A', '#E8735E', '#D6789E', '#CBB26A', '#4FB3A5', '#5B8DEF', '#8FC7F0', '#7DCB98', '#9C8BE0'];
const MAX_VIEW_ZOOM = 6.0;
const GLYPHS: Record<string, string> = { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' };
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

type Rect = [number, number, number, number];
type Hit = { kind: 'node'; node: Node } | { kind: 'dev'; node: Node; uci: string } | { kind: 'star'; dev: MyDeviationView | OpponentDeviationView } | { kind: 'board'; node: Node };

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, px: number, bold = false): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * px * 0.6;
  measureCtx.font = `${bold ? 'bold ' : ''}${px}px ${FONT}`;
  return measureCtx.measureText(text).width;
}

const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function leafShape(x: number, y: number, tiltDeg: number): string {
  const a = ((tiltDeg - 90) * Math.PI) / 180;
  const [ux, uy] = [Math.cos(a), Math.sin(a)];
  const [px, py] = [-uy, ux];
  const [length, half] = [18, 6];
  const tip = [x + ux * length, y + uy * length];
  const mid = [x + (ux * length) / 2, y + (uy * length) / 2];
  // a smooth leaf: two quadratic curves through the side points
  return `M${x},${y} Q${mid[0] + px * half * 2},${mid[1] + py * half * 2} ${tip[0]},${tip[1]} Q${mid[0] - px * half * 2},${mid[1] - py * half * 2} ${x},${y} Z`;
}

function starPoints(x: number, y: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((-90 + 36 * i) * Math.PI) / 180;
    pts.push(`${x + r * Math.cos(a)},${y + r * Math.sin(a)}`);
  }
  return pts.join(' ');
}

const curvePath = (x0: number, y0: number, x1: number, y1: number) => {
  const p = openingTree.curve(x0, y0, x1, y1);
  return `M${p[0]},${p[1]} C${p[2]},${p[3]} ${p[4]},${p[5]} ${p[6]},${p[7]}`;
};

interface Props {
  t: TreeController;
  version: number;
  onSelect: (node: Node) => void;
  onDeviation: (node: Node, uci: string) => void;
  onStar: (dev: MyDeviationView | OpponentDeviationView) => void;
  onContext: (node: Node, x: number, y: number) => void;
  onWheel: (delta: number) => void;
}

export function TreeView({ t, onSelect, onDeviation, onStar, onContext, onWheel }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([400, 300]);
  const [hover, setHover] = useState<Node | null>(null);
  const [view, setView] = useState<{ zoom: number; center: [number, number] | null }>({ zoom: 1, center: null });
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const hits = useRef(new Map<string, Hit>());
  const onWheelRef = useRef(onWheel);
  onWheelRef.current = onWheel;

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize([Math.max(el.clientWidth, 200), Math.max(el.clientHeight - 4, 200)]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tree = t.tree;
  useEffect(() => setView({ zoom: 1, center: null }), [tree]);

  // the wheel steps along the line; Ctrl + wheel zooms (a non-passive listener, to keep the page still)
  const zoomAtRef = useRef<(sx: number | null, sy: number | null, f: number) => void>(() => {});
  useEffect(() => {
    const el = box.current!;
    const wheel = (e: WheelEvent) => {
      if (e.shiftKey) return;                                  // sideways scrolling
      e.preventDefault();
      if (e.ctrlKey) {
        const r = el.getBoundingClientRect();
        zoomAtRef.current(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.25 : 0.8);
      } else onWheelRef.current(e.deltaY < 0 ? -1 : 1);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const [w, h] = size;
  const selected = t.node;

  /** Zoomed in: the branch you're on — or, on a line's last branch, the one before it. */
  const zoomBranch = (): Branch | null => {
    if (!t.zoom || !tree || !selected || selected.move === null) return null;
    let branch = tree.branches.find((b) => b.nodes.includes(selected)) ?? null;
    if (branch && !branch.children.length && branch.parent) branch = branch.parent;
    return branch && branch.parent ? branch : null;
  };

  // ---------- layout (mutates the nodes' x, y) ----------
  let width = w;
  const zoomed = view.zoom > 1.0;
  if (tree) {
    const focus = selected ? tree.firstMoveOf(selected) : null;
    openingTree.layout(tree, w, h, focus, zoomBranch());
    width = zoomed ? w : tree.width;
    if (zoomed) {
      // layout coordinates -> the zoomed view, in place (so clicks and hovering just work)
      const z = view.zoom;
      const [cx, cy] = view.center ?? [w / 2, h / 2];
      const stack = [tree.root];
      while (stack.length) {
        const n = stack.pop()!;
        n.x = (n.x - cx) * z + w / 2;
        n.y = (n.y - cy) * z + h / 2;
        stack.push(...n.children);
      }
      tree.board = null;                   // zoomed in, the mini board would fill the view
    }
  }

  const layoutPoint = (sx: number, sy: number): [number, number] => {
    if (view.zoom <= 1.0) return [sx, sy];
    const [cx, cy] = view.center ?? [w / 2, h / 2];
    return [(sx - w / 2) / view.zoom + cx, (sy - h / 2) / view.zoom + cy];
  };

  const zoomAt = (sx: number | null, sy: number | null, factor: number) => {
    if (!tree) return;
    const [px, py] = sx === null ? [w / 2, h / 2] : [sx, sy!];
    const [lx, ly] = layoutPoint(px, py);
    const z = Math.max(1.0, Math.min(MAX_VIEW_ZOOM, view.zoom * factor));
    if (z <= 1.0001) setView({ zoom: 1, center: null });
    else setView({ zoom: z, center: [lx - (px - w / 2) / z, ly - (py - h / 2) / z] });
  };
  zoomAtRef.current = zoomAt;

  // keep the selection in view when the tree is wider than the box
  useEffect(() => {
    const el = box.current;
    if (!el || !selected || zoomed || !tree || tree.width <= el.clientWidth + 1) return;
    const left = el.scrollLeft;
    const right = left + el.clientWidth;
    if (!(left + 30 <= selected.x && selected.x <= right - 30)) el.scrollLeft = Math.max(0, selected.x - el.clientWidth / 2);
  });

  if (!tree) return <div ref={box} className="tree-view" />;

  // ---------- drawing ----------
  hits.current = new Map();
  let hitId = 0;
  const hit = (target: Hit) => {
    const id = String(hitId++);
    hits.current.set(id, target);
    return id;
  };
  const obstacles: Rect[] = [];
  const els: ReactNode[] = [];
  let key = 0;
  const add = (el: ReactNode) => els.push(<g key={key++}>{el}</g>);

  const shown = tree.branches.filter((b) => tree.visible(b));
  const families = familyRoots(tree);
  const nodes = shown.flatMap((b) => b.nodes);
  const overview = tree.focus === null && tree.branches.filter((b) => b.parent === null).length > 1;
  const onPath = new Set<Node>();
  for (let n: Node | null = selected; n; n = n.parent) onPath.add(n);
  const focusSet = new Set<Node>();
  if (t.focus.length && selected && selected.move !== null) {
    for (let n = tree.nodeForPath(t.focus.map((m) => m.move_uci)); n; n = n.parent) focusSet.add(n);
  }

  // the mini board along the bottom: your pieces; each first move's piece on its square
  const board = tree.board;
  if (board) {
    const firsts = new Map<number, Node>();
    const movedFrom = new Set<number>();
    for (const top of tree.root.children) {
      const u = top.move!.move_uci;
      firsts.set(sqOf(u.slice(2, 4)), top);
      movedFrom.add(sqOf(u.slice(0, 2)));
    }
    const start = ChessBoard.fromFen();
    const s = board.square;
    for (const rank of board.ranks) {
      for (let file = 0; file < 8; file++) {
        const sq = file + 8 * rank;
        const [x, y] = board.center(sq);
        const target = firsts.get(sq) ?? tree.root;
        const id = hit({ kind: 'board', node: target });
        let piece = movedFrom.has(sq) ? null : start.pieceAt(sq);
        if (firsts.has(sq)) piece = start.pieceAt(sqOf(firsts.get(sq)!.move!.move_uci.slice(0, 2)));
        add(<>
          <rect data-hit={id} x={x - s / 2} y={y - s / 2} width={s} height={s} fill={(file + rank) % 2 === 1 ? 'var(--sq-light)' : 'var(--sq-dark)'} />
          {piece && <text data-hit={id} x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={Math.max(10, s * 0.72)}
            className={`glyph ${piece.color}`}>{GLYPHS[piece.role]}</text>}
        </>);
      }
    }
    for (const [sq, node] of firsts) {
      const [x, y] = board.center(sq);
      const active = tree.focus === null || tree.focus === node;
      const id = hit({ kind: 'board', node });
      add(<>
        <rect data-hit={id} x={x - s / 2 + 1} y={y - s / 2 + 1} width={s - 2} height={s - 2} fill="none" strokeWidth={2}
          style={{ stroke: active ? GLOW : 'var(--line)' }} />
        {!active && <rect data-hit={id} x={x - s / 2} y={y - s / 2} width={s} height={s} style={{ fill: 'var(--panel)' }} opacity={0.55} />}
      </>);
    }
    obstacles.push([board.x0, board.top, board.x0 + 8 * s, board.bottom]);
  }

  // zoomed in: the branch grows from a knot at the bottom
  if (tree.zoom) {
    const start = tree.zoom.nodes[0].parent!;
    const id = hit({ kind: 'node', node: start });
    const where = start.move === null ? 'the start' : moveLabel(start);
    add(<>
      <line x1={start.x} y1={start.y} x2={start.x} y2={tree.height} stroke={BARK} strokeWidth={openingTree.thickness(tree.zoom.lines)} />
      <circle data-hit={id} cx={start.x} cy={start.y} r={7} strokeWidth={2.5} style={{ fill: 'var(--panel)', stroke: 'var(--ink)' }} />
      <text x={start.x + 12} y={tree.height - 8} fontSize={12} style={{ fill: 'var(--ink-2)' }}>
        {`zoomed in · after ${where} · ${moveLabel(tree.zoom.nodes[0])}`}</text>
    </>);
  }

  // bark: thick trunks first, so thinner twigs lie on top
  for (const b of [...shown].sort((a, c) => c.lines - a.lines)) {
    const [x0, y0] = b.start_xy;
    const th = openingTree.thickness(b.lines);
    add(<path d={curvePath(x0, y0, b.end.x, b.end.y)} fill="none" stroke={BARK} strokeWidth={th} strokeLinecap="round" />);
    for (let k = 0; k <= 24; k++) {
      const [x, y] = openingTree.bezier(x0, y0, b.end.x, b.end.y, k / 24);
      obstacles.push([x - th / 2, y - th / 2, x + th / 2, y + th / 2]);
    }
  }

  // glow: the selected path solid, the rest of the focus line dashed
  const glow = (b: Branch, t0: number, t1: number, dashed: boolean) => {
    if (t1 <= t0) return;
    const [x0, y0] = b.start_xy;
    const steps = Math.max(2, Math.floor(24 * (t1 - t0)));
    const pts: string[] = [];
    for (let k = 0; k <= steps; k++) {
      const [x, y] = openingTree.bezier(x0, y0, b.end.x, b.end.y, t0 + ((t1 - t0) * k) / steps);
      pts.push(`${x},${y}`);
    }
    add(<polyline points={pts.join(' ')} fill="none" strokeWidth={4} strokeLinecap="round" strokeDasharray={dashed ? '3 6' : undefined}
      style={{ stroke: GLOW }} />);
  };
  for (const b of shown) {
    const solid = b.nodes.flatMap((n, i) => (onPath.has(n) ? [i] : []));
    const ahead = b.nodes.flatMap((n, i) => (focusSet.has(n) && !onPath.has(n) ? [i] : []));
    if (solid.length) glow(b, 0, b.t_at(Math.max(...solid)), false);
    if (ahead.length) glow(b, solid.length ? b.t_at(Math.max(...solid)) : 0, 1, true);
  }

  // beads (every move), knots, leaves
  for (const b of shown) {
    b.nodes.slice(0, -1).forEach((node, i) => {
      if (b.is_first_move && i === 0) return;              // the piece on the mini board is this move
      add(<circle data-hit={hit({ kind: 'node', node })} cx={node.x} cy={node.y} r={2.6} fill={BEAD} />);
      obstacles.push([node.x - 3, node.y - 3, node.x + 3, node.y + 3]);
    });
    if (!(b.is_first_move && b.nodes.length === 1) || b.end.line_ends.length) {
      const end = b.end;
      if (b.children.length) {
        add(<circle data-hit={hit({ kind: 'node', node: end })} cx={end.x} cy={end.y} r={7} strokeWidth={2.5}
          style={{ fill: 'var(--panel)', stroke: 'var(--ink)' }} />);
        obstacles.push([end.x - 8, end.y - 8, end.x + 8, end.y + 8]);
      }
      if (end.line_ends.length) {
        const color = LEAF_COLORS[b.color_index % LEAF_COLORS.length];
        let [lx, ly, tilt] = [end.x, end.y, b.color_index % 2 === 0 ? -25 : 25];
        if (b.children.length) [lx, ly, tilt] = [end.x - 12, end.y - 6, -60];   // a line that stops at a knot: a leaf beside it
        const id = hit({ kind: 'node', node: end });
        add(<path data-hit={id} d={leafShape(lx, ly, tilt)} fill={color} stroke="#111317" strokeWidth={1} />);
        obstacles.push([lx - 12, ly - 20, lx + 12, ly + 4]);
        if (!overview) {
          let name = endName(end, end.line_ends[0][0], end.line_ends[0][1], families);
          if (name.length > NAME_CHARS) name = `${name.slice(0, NAME_CHARS - 1).replace(/[ ,(]+$/, '')}…`;
          if (end.line_ends.length > 1) name += ` +${end.line_ends.length - 1}`;
          const tw = textWidth(name, 13, true);
          add(<text data-hit={id} x={lx + 4} y={ly - 18} fontSize={13} fontWeight="bold" transform={`rotate(-40 ${lx + 4} ${ly - 18})`}
            style={{ fill: 'var(--ink)' }}>{name}</text>);
          const cos = Math.cos((40 * Math.PI) / 180);
          const sin = Math.sin((40 * Math.PI) / 180);
          obstacles.push([lx, ly - 18 - tw * sin - 10, lx + 6 + tw * cos, ly - 12]);
        }
      }
    }
  }

  // each branch's first move, a little way along it (along your path and the choices leaving it)
  if (!overview) {
    for (const b of shown) {
      if (b.is_first_move || b === tree.zoom) continue;
      const on = b.nodes.some((n) => onPath.has(n));
      const choice = b.parent !== null && b.parent.nodes.some((n) => onPath.has(n));
      if (!(on || choice)) continue;
      const [x0, y0] = b.start_xy;
      const [x, y] = openingTree.bezier(x0, y0, b.end.x, b.end.y, b.nodes.length > 1 ? LABEL_AT : 0.5);
      const label = moveLabel(b.nodes[0]);
      add(<text x={x + 8} y={y} dominantBaseline="central" fontSize={12} style={{ fill: 'var(--ink-2)' }}>{label}</text>);
      obstacles.push([x + 8, y - 7, x + 8 + textWidth(label, 12), y + 7]);
    }
  }

  // each opening's name, once, where its lines branch off on their own (the leaves show just the variation)
  {
    const visibleSet = new Set(nodes);
    for (const [node, { label: name }] of families) {
      if (node === tree.root || !visibleSet.has(node)) continue;
      const tw = textWidth(name, 12, true);
      const [x, y] = [node.x - tw / 2, node.y + 12];
      add(<g pointerEvents="none">
        <rect x={x - 5} y={y - 1} width={tw + 10} height={17} rx={8} className="family-pill" />
        <text x={node.x} y={y + 8} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight="bold" className="family-text">{name}</text>
      </g>);
      obstacles.push([x - 5, y - 1, x + tw + 5, y + 16]);
    }
  }

  // a flag where each opening starts (not at the very start)
  if (!overview) {
    const visibleSet = new Set(nodes);
    const at = new Map<Node, string[]>();
    for (const [name, node] of t.starts) {
      if (node.move !== null && node.parent!.move !== null && visibleSet.has(node)) at.set(node, [...(at.get(node) ?? []), name]);
    }
    for (const [node, names] of at) {
      const right = node.x < tree.width - 120;
      const fx = node.x + (right ? 10 : -10);
      const label = `${names.join(' / ')} starts`;
      add(<>
        <line x1={fx} y1={node.y - 2} x2={fx} y2={node.y - 22} strokeWidth={2} style={{ stroke: GLOW }} />
        <polygon points={`${fx},${node.y - 22} ${fx + (right ? 12 : -12)},${node.y - 18} ${fx},${node.y - 14}`} style={{ fill: GLOW }} />
        <text x={fx + (right ? 16 : -16)} y={node.y - 18} dominantBaseline="central" textAnchor={right ? 'start' : 'end'} fontSize={12}
          fontWeight="bold" style={{ fill: GLOW }}>{label}</text>
      </>);
      const tw = textWidth(label, 12, true);
      obstacles.push(right ? [fx, node.y - 26, fx + 16 + tw, node.y - 10] : [fx - 16 - tw, node.y - 26, fx, node.y - 10]);
    }
  }

  // Lichess deviations: a ring where players leave your lines; the selected position's sidelines as a list
  let sidelinesHidden = false;
  if (!overview) {
    const visibleSet = new Set(nodes);
    const rings: [Node, openingTree.Deviation[], boolean, string, string][] = [];
    for (const [node, devs] of t.deviations) {
      if (!visibleSet.has(node) || node.move === null) continue;
      const inside = t.inside(node);
      if (!inside && !t.showBefore) continue;
      const [lineColor, textColor] = inside ? [WILD, '#9AA1AD'] : [WILD_BEFORE, WILD_BEFORE_TEXT];
      if (node !== selected) {
        const ring = inside ? likelyColors(Math.max(...devs.map((d) => d.share)))[0] : lineColor;
        add(<circle cx={node.x} cy={node.y} r={6} fill="none" stroke={ring} strokeWidth={1.5} />);
        obstacles.push([node.x - 7, node.y - 7, node.x + 7, node.y + 7]);
      } else rings.push([node, devs, inside, lineColor, textColor]);
    }
    for (const [node, devs, inside, lineColor, textColor] of rings) {
      // the first clear spot: left / right, below / above / level, nearer / further out
      const big = tree.zoom !== null;
      const [px, bold, rowH, r] = big ? [13, true, 22, 5] : [12, false, 17, 4];
      const texts = devs.map((d) => `${d.san.split('.').at(-1)} ${Math.round(d.share * 100)}%`);
      const listW = r + 6 + Math.max(...texts.map((tx) => textWidth(tx, px, bold)));
      const listH = rowH * devs.length;
      const rows = (side: number, dx: number, top: number) => devs.map((_, i) => [node.x + side * dx, top + rowH * i + rowH / 2] as [number, number]);
      const crowded = (side: number, dx: number, top: number) => {
        const xr = node.x + side * dx;
        const x0 = Math.min(xr - r - 2, xr + side * listW);
        const x1 = Math.max(xr + r + 2, xr + side * listW);
        if (x0 < 2 || x1 > tree.width - 2 || top < 2 || top + listH > tree.height - 2) return true;
        const area: Rect = [x0, top, x1, top + listH];
        if (obstacles.some((o) => overlaps(o, area))) return true;
        for (const [rx, ry] of rows(side, dx, top)) {
          for (const f of [0.35, 0.6, 0.85]) {
            const [qx, qy] = [node.x + (rx - node.x) * f, node.y + (ry - node.y) * f];
            if (obstacles.some((o) => overlaps(o, [qx - 2, qy - 2, qx + 2, qy + 2]))) return true;
          }
        }
        return false;
      };
      let best: [number, number, number] | null = null;
      for (const dx of [36, 52, 72, 96]) {
        for (const side of [-1, 1]) {
          for (const top of [node.y + 8, node.y - 8 - listH, node.y - listH / 2]) {
            if (!best && !crowded(side, dx, top)) best = [side, dx, top];
          }
        }
      }
      if (!best) {
        sidelinesHidden = true;            // never on top of a branch
        continue;
      }
      const [side, dx, top] = best;
      rows(side, dx, top).forEach(([rx, ry], i) => {
        const dev = devs[i];
        const [stroke, ink] = inside ? likelyColors(dev.share) : [lineColor, textColor];
        const id = hit({ kind: 'dev', node, uci: dev.uci });
        const tw = textWidth(texts[i], px, bold);
        const barW = Math.max(4, tw * Math.min(1, dev.share / 0.5));
        const tx = rx + side * (r + 4);
        add(<g data-hit={id} className="clickable">
          <line x1={node.x} y1={node.y} x2={rx} y2={ry} stroke={stroke} strokeWidth={2} strokeDasharray="2 3" />
          <circle data-hit={id} cx={rx} cy={ry} r={r} stroke={stroke} strokeWidth={2} style={{ fill: 'var(--panel)' }} />
          <text data-hit={id} x={tx} y={ry} dominantBaseline="central" textAnchor={side > 0 ? 'start' : 'end'} fontSize={px}
            fontWeight={bold ? 'bold' : 'normal'} fill={ink}>{texts[i]}</text>
          {big && <rect data-hit={id} x={side > 0 ? tx : tx - barW} y={ry + px / 2 + 1} width={barW} height={2} fill={stroke} />}
        </g>);
      });
    }
  }

  // stars from your games: red = you left your prep, blue = your opponent did
  if (!overview) {
    for (const node of nodes) {
      for (const [devs, color, dx] of [[t.myDevs.get(node), MY_DEVIATION, 10], [t.oppDevs.get(node), OPP_DEVIATION, -10]] as const) {
        if (!devs?.length) continue;
        const games = (devs as { games: number }[]).reduce((s, d) => s + d.games, 0);
        const [x, y] = [node.x + dx, node.y - 10];
        const outer = games < 100 ? 10 : 12;
        const top = [...(devs as (MyDeviationView | OpponentDeviationView)[])].sort((a, b) => b.games - a.games)[0];
        const id = hit({ kind: 'star', dev: top });
        add(<g data-hit={id} className="clickable">
          <polygon data-hit={id} points={starPoints(x, y, outer, outer * 0.5)} fill={color} strokeWidth={1.2} style={{ stroke: 'var(--panel)' }} />
          <text data-hit={id} x={x} y={y + 1} textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight="bold" fill="#fff">
            {games < 1000 ? games : '1k'}</text>
        </g>);
      }
    }
  }

  // a new branch being played: a dashed twig; else the marker on the selected move
  if (t.draft.length && selected) {
    const sans = t.draftSans();
    let [dx, dy] = DRAFT_STEP;
    if (selected.x > tree.width - 160) dx = -dx;
    const pts = [[selected.x, selected.y], ...sans.map((_, k) => [selected.x + dx * (k + 1), selected.y + dy * (k + 1)])];
    const [tipX, tipY] = pts[pts.length - 1];
    const label = `New branch${sans.length ? `: ${sans.slice(-3).join(' ')}` : ''}`;
    add(<>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" strokeWidth={4} strokeDasharray="4 4" strokeLinecap="round" style={{ stroke: GLOW }} />
      {pts.slice(1).map(([x, y], k) => <circle key={k} cx={x} cy={y} r={3.5} style={{ fill: GLOW }} />)}
      <circle cx={tipX} cy={tipY} r={10} strokeWidth={3.5} style={{ stroke: GLOW, fill: 'var(--bg)' }} />
      <circle cx={tipX} cy={tipY} r={3.5} style={{ fill: GLOW }} />
      <text x={tipX + (dx > 0 ? 14 : -14)} y={tipY} dominantBaseline="central" textAnchor={dx > 0 ? 'start' : 'end'} fontSize={13}
        fontWeight="bold" style={{ fill: GLOW }}>{label}</text>
    </>);
  } else if (selected && selected.move !== null) {
    add(<>
      <circle cx={selected.x} cy={selected.y} r={10} strokeWidth={3.5} style={{ stroke: GLOW, fill: 'var(--bg)' }} />
      <circle cx={selected.x} cy={selected.y} r={3.5} style={{ fill: GLOW }} />
    </>);
  }

  // the snapping hover: a ring on the nearest move and its name
  let hoverEl: ReactNode = null;
  if (hover && nodes.includes(hover)) {
    let text = hover.move === null ? 'Start' : moveLabel(hover);
    if (hover.line_ends.length) {
      text = endName(hover, hover.line_ends[0][0], hover.line_ends[0][1], families) + (hover.line_ends.length > 1 ? ` (+${hover.line_ends.length - 1})` : '');
    }
    const right = hover.x < tree.width - 80;
    const tw = textWidth(text, 13, true);
    const tx = right ? hover.x + 13 : hover.x - 13;
    hoverEl = <g pointerEvents="none">
      <circle cx={hover.x} cy={hover.y} r={7} fill="none" strokeWidth={2} style={{ stroke: 'var(--ink)' }} />
      <rect x={(right ? tx : tx - tw) - 5} y={hover.y - 10} width={tw + 10} height={20} rx={4} style={{ fill: 'var(--panel-2)' }} />
      <text x={tx} y={hover.y} dominantBaseline="central" textAnchor={right ? 'start' : 'end'} fontSize={13} fontWeight="bold"
        style={{ fill: 'var(--ink)' }}>{text}</text>
    </g>;
  }

  queueMicrotask(() => t.setSidelinesHidden(sidelinesHidden));

  // ---------- pointing ----------
  const point = (e: MouseEvent): [number, number] => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const nearest = (x: number, y: number): Node | null => {
    let best: Node | null = null;
    let bestD = SNAP_PX ** 2;
    for (const n of nodes) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d <= bestD) [best, bestD] = [n, d];
    }
    return best;
  };
  const hitOf = (e: MouseEvent): Hit | null => {
    const id = (e.target as Element).closest('[data-hit]')?.getAttribute('data-hit');
    return id ? hits.current.get(id) ?? null : null;
  };
  const nodeAt = (e: MouseEvent): Node | null => {
    const hh = hitOf(e);
    if (hh?.kind === 'node') return hh.node;
    const [x, y] = point(e);
    return nearest(x, y);
  };

  const onMove = (e: MouseEvent) => {
    if (press.current && zoomed) {
      const dx = e.clientX - press.current.x;
      const dy = e.clientY - press.current.y;
      if (press.current.dragged || dx * dx + dy * dy >= 16) {
        press.current = { x: e.clientX, y: e.clientY, dragged: true };
        const [cx, cy] = view.center ?? [w / 2, h / 2];
        setView({ zoom: view.zoom, center: [cx - dx / view.zoom, cy - dy / view.zoom] });
        return;
      }
    }
    const hh = hitOf(e);
    if (hh?.kind === 'dev' || hh?.kind === 'star') { if (hover) setHover(null); return; }
    const n = hh?.kind === 'board' ? (hh.node.move !== null ? hh.node : null) : nodeAt(e);
    if (n !== hover) setHover(n);
  };

  const onUp = (e: MouseEvent) => {
    const dragged = press.current?.dragged;
    press.current = null;
    if (dragged || e.button !== 0) return;
    const hh = hitOf(e);
    if (hh?.kind === 'star') return onStar(hh.dev);
    if (hh?.kind === 'dev') return onDeviation(hh.node, hh.uci);
    if (hh?.kind === 'board') return onSelect(hh.node);
    const n = nodeAt(e);
    if (n) onSelect(n);
  };

  return (
    <div ref={box} className="tree-view" style={{ overflowX: zoomed ? 'hidden' : 'auto' }}>
      <svg width={width} height={h} role="img" aria-label="Repertoire tree" className={hover ? 'pointing' : ''}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        onMouseDown={(e) => { if (e.button === 0) press.current = { x: e.clientX, y: e.clientY, dragged: false }; }}
        onMouseUp={onUp}
        onContextMenu={(e) => { e.preventDefault(); const n = nodeAt(e); if (n) onContext(n, e.clientX, e.clientY); }}>
        {els}
        {hoverEl}
      </svg>
      <div className="tree-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(null, null, 1.4)}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(null, null, 1 / 1.4)}>−</button>
        <button type="button" aria-label="Reset zoom" onClick={() => setView({ zoom: 1, center: null })}>⟲</button>
        {zoomed && <span>{view.zoom.toFixed(1)}×</span>}
      </div>
    </div>
  );
}

function sqOf(name: string): number {
  return name.charCodeAt(0) - 97 + 8 * (name.charCodeAt(1) - 49);
}

