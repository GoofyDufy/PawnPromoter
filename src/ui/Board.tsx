/**
 * The chess board: chessground (the board Lichess uses) driven by the core's
 * Board — only legal moves can be played, by click or drag; promotion asks
 * which piece; arrows for engine lines and hints (the desktop's
 * board_widget.py role).
 */
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import { useEffect, useRef, useState } from 'react';

declare module 'react' {
  // chessground draws pieces as <piece class="queen white">
  namespace JSX {
    interface IntrinsicElements {
      piece: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
import { Board as ChessBoard, type Color, squareRank } from '../core/chess';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';

export interface Arrow {
  from: string;          // square name, e.g. "e2"
  to: string;            // the same square as from: a circle on it
  brush?: 'green' | 'blue' | 'grey' | 'red' | 'yellow';
}

export interface BoardProps {
  fen: string;
  orientation?: Color;
  /** Which side you can move: one colour, 'both' (analysis), or none. */
  movable?: Color | 'both' | null;
  onMove?: (uci: string) => void;
  lastMove?: string | null;          // UCI, highlighted
  /** Bump it to put the pieces back on `fen` (a wrong move the position didn't take). */
  snapBack?: number;
  /** Squares lit up (e.g. the ones the Coach's text you're pointing at mentions). */
  highlights?: string[];
  arrows?: Arrow[];
  /** A move badge in a square's corner (Game Review's !!, !, ✓, ?!, ?, ??, ≡, ⚑). */
  badges?: { square: string; text: string; color: string }[];
}

/** The badge's SVG, in chessground's 100-unit square with its origin at the centre. */
function badgeSvg(text: string, color: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const size = text.length > 1 ? 17 : 21;
  return `<g transform="translate(36 -36)"><circle r="17" fill="${color}" stroke="#fff" stroke-width="3"/>`
    + `<text text-anchor="middle" dominant-baseline="central" font-size="${size}" font-weight="700" fill="#fff" `
    + `font-family="system-ui, sans-serif">${esc}</text></g>`;
}

const BRUSHES: Record<NonNullable<Arrow['brush']>, string> = {
  green: 'green', blue: 'blue', grey: 'paleGrey', red: 'red', yellow: 'yellow',
};

const PROMOTIONS = [['q', 'queen'], ['r', 'rook'], ['b', 'bishop'], ['n', 'knight']] as const;

/** Legal destinations per square for chessground; castling also by moving the king onto the rook. */
function destsOf(board: ChessBoard): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  const add = (from: string, to: string) => {
    const list = dests.get(from as Key) ?? [];
    if (!list.includes(to as Key)) list.push(to as Key);
    dests.set(from as Key, list);
  };
  for (const uci of board.legalMoves()) {
    add(uci.slice(0, 2), uci.slice(2, 4));
    if (board.isCastling(uci)) add(uci.slice(0, 2), `${uci[2] === 'g' ? 'h' : 'a'}${uci[3]}`);
  }
  return dests;
}

const NO_SQUARES: string[] = [];

export function Board({ fen, orientation = 'white', movable = null, onMove, lastMove, arrows = [], badges = [], snapBack = 0, highlights = NO_SQUARES }: BoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    api.current = Chessground(el.current!, {
      coordinates: true, animation: { duration: 150 },
      trustAllEvents: import.meta.env.MODE === 'e2e',      // tests/e2e clicks the board with scripted events
    });
    if (import.meta.env.MODE === 'e2e') {                  // tests/e2e looks inside (window.cg, or this board's element)
      (window as unknown as { cg: Api }).cg = api.current;
      (el.current as unknown as { cg: Api }).cg = api.current;
    }
    // chessground remembers where the board is on the page and re-measures only on
    // resize / scroll; when something above it changes height the board moves and
    // clicks land on the wrong square. Re-measure as each click or touch starts.
    const wrap = el.current!;
    const remeasure = () => api.current?.state.dom.bounds.clear();
    wrap.addEventListener('mousedown', remeasure, { capture: true });
    wrap.addEventListener('touchstart', remeasure, { capture: true, passive: true });
    return () => {
      wrap.removeEventListener('mousedown', remeasure, { capture: true });
      wrap.removeEventListener('touchstart', remeasure, { capture: true });
      api.current?.destroy();
    };
  }, []);

  useEffect(() => {
    if (!ChessBoard.isValidFen(fen)) {   // e.g. an empty board (no puzzle yet): pieces only, nothing to move
      api.current?.set({ fen, lastMove: undefined, check: false, movable: { color: undefined, dests: new Map() }, drawable: { autoShapes: [] } });
      return;
    }
    if (import.meta.env.MODE === 'e2e' && api.current) (window as unknown as { cg: Api }).cg = api.current;   // the board updated last
    const board = ChessBoard.fromFen(fen);
    const turn = board.turn;
    const canMove = movable === 'both' || movable === turn;
    api.current?.set({
      fen,
      orientation,
      turnColor: turn,
      check: board.isCheck() ? turn : false,
      lastMove: lastMove ? [lastMove.slice(0, 2) as Key, lastMove.slice(2, 4) as Key] : undefined,
      highlight: { custom: new Map(highlights.map((sq) => [sq as Key, 'coach-hl'])) },
      movable: {
        free: false,
        color: canMove ? turn : undefined,
        dests: canMove ? destsOf(board) : new Map(),
        showDests: true,
        events: {
          after: (orig, dest) => {
            const piece = board.pieceAt(parseSquareName(orig));
            const lastRank = turn === 'white' ? 7 : 0;
            if (piece?.role === 'pawn' && squareRank(parseSquareName(dest)) === lastRank) {
              setPromotion({ from: orig, to: dest });
              return;
            }
            onMoveRef.current?.(board.normalizeUci(orig + dest) ?? orig + dest);
          },
        },
      },
      drawable: { autoShapes: [
        ...arrows.map((a): DrawShape => ({ orig: a.from as Key, dest: a.to === a.from ? undefined : a.to as Key, brush: BRUSHES[a.brush ?? 'green'] })),
        ...badges.map((b): DrawShape => ({ orig: b.square as Key, customSvg: { html: badgeSvg(b.text, b.color) } })),
      ] },
    });
  }, [fen, orientation, movable, lastMove, arrows, badges, snapBack, highlights]);

  const choose = (letter: string | null) => {
    const p = promotion;
    setPromotion(null);
    if (p && letter) onMoveRef.current?.(p.from + p.to + letter);
    else api.current?.set({ fen });              // cancelled: put the pawn back
  };

  const turn = fen.split(' ')[1] === 'b' ? 'black' : 'white';
  return (
    <div className="board-wrap">
      <div ref={el} className="board cg-wrap" />
      {promotion && (
        <div className="promotion cg-wrap" role="dialog" aria-label="Promote to">
          {PROMOTIONS.map(([letter, role]) => (
            <button key={letter} type="button" className="promo-piece" title={`Promote to a ${role}`}
              onClick={() => choose(letter)}>
              {/* chessground's own piece element, so its piece set draws it */}
              <piece className={`${role} ${turn}`} />
              <span className="visually-hidden">{role}</span>
            </button>
          ))}
          <button type="button" className="btn secondary promo-cancel" onClick={() => choose(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function parseSquareName(name: string): number {
  return name.charCodeAt(0) - 97 + 8 * (name.charCodeAt(1) - 49);
}

