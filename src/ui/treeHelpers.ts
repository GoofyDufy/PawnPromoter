/** Small helpers shared by the tree's drawing and its controller (tree_view.py). */
import { Board, WHITE } from '../core/chess';
import type { Node } from '../core/openingTree';

// how often Lichess players at your level choose a sideline: grey / amber / red
export const LIKELY: [number, string, string][] = [[0.30, '#E8735E', '#F2A493'], [0.15, '#E6A94A', '#F0C27A'], [0.0, '#8A8F98', '#B4B9C2']];
export const LIKELY_TEXT = 'grey under 15% · amber 15–30% · red 30%+';

/** [line / ring colour, label colour] for a sideline played this often. */
export function likelyColors(share: number): [string, string] {
  const [, line, label] = LIKELY.find(([floor]) => share >= floor)!;
  return [line, label];
}

/** 'Catalan - Closed' -> 'Closed' inside the Catalan repertoire; with every
 *  repertoire on show (repertoire ''), 'Catalan · Closed'. */
export function shortName(name: string, repertoire: string): string {
  for (const sep of [' - ', ' — ', ': ']) {
    const i = name.indexOf(sep);
    if (i < 0) continue;
    const head = name.slice(0, i);
    const tail = name.slice(i + sep.length);
    if (tail && head.trim().toLowerCase() === repertoire.trim().toLowerCase()) return tail.trim();
    if (tail && !repertoire) return `${head.trim()} · ${tail.trim()}`;
  }
  return name;
}

/** '4...Be7' for the move that reached this position. */
export function moveLabel(node: Node): string {
  const board = node.parent ? node.parent.board() : Board.fromFen();
  const prefix = board.turn === WHITE ? `${board.fullmoveNumber}.` : `${board.fullmoveNumber}...`;
  return prefix + board.san(node.move!.move_uci);
}

/** Position key: placement, side to move, castling, en passant. */
export const posKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
