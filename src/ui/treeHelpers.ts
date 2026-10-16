/** Small helpers shared by the tree's drawing and its controller (tree_view.py). */
import { Board, WHITE } from '../core/chess';
import type { Node, Tree } from '../core/openingTree';

// how often Lichess players at your level choose a sideline: grey / amber / red
export const LIKELY: [number, string, string][] = [[0.30, '#E8735E', '#F2A493'], [0.15, '#E6A94A', '#F0C27A'], [0.0, '#8A8F98', '#B4B9C2']];
export const LIKELY_TEXT = 'grey under 15% · amber 15–30% · red 30%+';

/** [line / ring colour, label colour] for a sideline played this often. */
export function likelyColors(share: number): [string, string] {
  const [, line, label] = LIKELY.find(([floor]) => share >= floor)!;
  return [line, label];
}

/** Names compared without case or punctuation ("Queens Gambit" = "Queen's Gambit"). */
const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

/** 'Catalan - Closed' -> 'Catalan' (null: no opening part). */
export function headOf(name: string): string | null {
  for (const sep of [' - ', ' — ', ': ']) {
    const i = name.indexOf(sep);
    if (i > 0 && name.slice(i + sep.length).trim()) return name.slice(0, i).trim();
  }
  return null;
}

/** 'Catalan - Open, Classical 7.Qc2' -> 'Open, Classical 7.Qc2' (a name without an opening part stays whole). */
export function variationName(name: string): string {
  const head = headOf(name);
  return head ? name.slice(head.length).replace(/^\s*(-|—|:)\s*/, '') : name;
}

/** 'Catalan - Closed' -> 'Closed' inside the Catalan repertoire; with every
 *  repertoire on show (repertoire ''), 'Catalan · Closed'. */
export function shortName(name: string, repertoire: string): string {
  for (const sep of [' - ', ' — ', ': ']) {
    const i = name.indexOf(sep);
    if (i < 0) continue;
    const head = name.slice(0, i);
    const tail = name.slice(i + sep.length);
    if (tail && same(head.trim(), repertoire.trim())) return tail.trim();
    if (tail && !repertoire) return `${head.trim()} · ${tail.trim()}`;
  }
  return name;
}

/** A leaf's name inside its own opening: 'Catalan - Closed' -> 'Closed' (the opening's
 *  name stands at its base — see familyRoots). */
export function leafName(lineName: string, path: { repertoire_name: string }[]): string {
  return shortName(lineName, path[0]?.repertoire_name ?? '');
}

export interface Family {
  label: string;           // shown at the opening's base: its lines' shared name ("Scandinavian Defense"), else the repertoire's
  repertoire: string;
}

/** Where each opening's name goes: the first position whose lines all belong to one
 *  repertoire (its own branch, after the moves it shares with your other openings).
 *  With one repertoire on show, that's the start. */
export function familyRoots(tree: Tree): Map<Node, Family> {
  const out = new Map<Node, Family>();
  const reps = (n: Node) => new Set(n.lines().map(([, path]) => path[0].repertoire_name));
  const family = (n: Node, repertoire: string): Family => {
    const heads = new Set(n.lines().map(([name]) => headOf(name)));
    const [head] = heads;
    return { label: heads.size === 1 && head ? head : repertoire, repertoire };
  };
  const rootReps = reps(tree.root);
  if (rootReps.size === 1) {
    out.set(tree.root, family(tree.root, [...rootReps][0]));
    return out;
  }
  const walk = (n: Node) => {
    for (const child of n.children) {
      const r = reps(child);
      if (r.size === 1) out.set(child, family(child, [...r][0]));
      else walk(child);
    }
  };
  walk(tree.root);
  return out;
}

/** A line's name where it ends: just the variation when its opening's name stands
 *  above it (a family root of the same repertoire on the way up) — 'Catalan - Closed'
 *  and 'Catalan Opening: Closed' both read 'Closed' — else in full ('Catalan · Closed'). */
export function endName(node: Node, lineName: string, path: { repertoire_name: string }[], families: Map<Node, Family>): string {
  const rep = path[0]?.repertoire_name ?? '';
  for (let n: Node | null = node; n; n = n.parent) {
    const f = families.get(n);
    if (f && f.repertoire === rep) return variationName(lineName);   // whatever its opening part is called ('Catalan', 'Catalan Opening')
  }
  return shortName(lineName, '');
}

/** '4...Be7' for the move that reached this position. */
export function moveLabel(node: Node): string {
  const board = node.parent ? node.parent.board() : Board.fromFen();
  const prefix = board.turn === WHITE ? `${board.fullmoveNumber}.` : `${board.fullmoveNumber}...`;
  return prefix + board.san(node.move!.move_uci);
}

/** Position key: placement, side to move, castling, en passant. */
export const posKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
