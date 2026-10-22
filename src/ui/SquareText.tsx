/**
 * Coach text with its squares live: point at a sentence and every square it
 * mentions lights up on the board, and every move it names gets an arrow
 * ("Nxd4" from the knight's square to d4); point at one square or move and
 * just that one does. A tap does the same on a touch screen.
 *
 * Moves are read against the position on the board: a move gets its arrow only
 * when it's legal there (for either side), or continues a line just named
 * ("13.Nf3 Bd7"). A bare square after "on", "hits", "to"… is a place, not a
 * move ("a knight on d5"), and stays a highlight.
 */
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Board } from '../core/chess';
import type { Arrow } from './Board';

// a square, or a move ending on one ("d4", "Nxd4", "exd5", "Qh5+", "e8=Q"), not inside a word or a number
const SQUARE = /(?<![A-Za-z0-9])(?:[KQRBN]?[a-h]?[1-8]?x?)([a-h][1-8])(?:=[QRBN])?[+#]?(?![A-Za-z0-9])/g;

/** The squares a text mentions, in order, each once. */
export function squaresIn(text: string): string[] {
  return [...new Set([...text.matchAll(SQUARE)].map((m) => m[1]))];
}

/** What the board shows for some Coach text: squares lit, and arrows for the moves. */
export type OnFocus = (squares: string[] | null, arrows?: Arrow[]) => void;

export interface Ref { index: number; text: string; square: string; arrow: Arrow | null }

// a bare square right after one of these words is a place, not a move ("a knight on d5", "hits d4")
const PLACE = /\b(?:on|at|of|to|from|onto|into|hits|hit|attacks|attack|guards|guard|covers|cover|toward|towards|behind|via|over|around|near|square|squares|in front of|is|are)\s*$/i;

/** A board with the other side to move (null if that position can't exist, e.g. a king left in check). */
function flipped(fen: string): Board | null {
  const f = fen.split(' ');
  f[1] = f[1] === 'w' ? 'b' : 'w';
  f[3] = '-';
  try {
    const b = Board.fromFen(f.join(' '));
    return b;
  } catch {
    return null;
  }
}

function tryMove(board: Board | null, san: string): string | null {
  if (!board) return null;
  try {
    return board.parseSan(san) ?? null;
  } catch {
    return null;
  }
}

/** The squares and moves a text mentions, in order; moves resolved against `fen` (no fen: no arrows). */
export function refsIn(text: string, fen?: string | null): Ref[] {
  let base: Board | null = null;
  try {
    base = fen ? Board.fromFen(fen) : null;
  } catch {
    base = null;
  }
  const other = base && fen ? flipped(fen) : null;
  let line: Board | null = null;            // the line being read, after its last move
  let lineEnd = -1;
  const out: Ref[] = [];
  for (const m of text.matchAll(SQUARE)) {
    const tok = m[0];
    const at = m.index!;
    const before = text.slice(0, at);
    let uci: string | null = null;
    if (base) {
      const blackMarked = /(?:…|\.\.\.)$/.test(before);
      const numbered = /\d+\.(?:\.\.)?\s*$/.test(before) || blackMarked;
      const moveLike = /[KQRBNx=+#]/.test(tok) || numbered;
      const continues = line !== null && /^[\s\d.…]*$/.test(text.slice(lineEnd, at));
      if (moveLike || !PLACE.test(before)) {
        // the line being read, first: right after its last move, or any move of it named later on
        if (continues || (line !== null && moveLike)) uci = tryMove(line, tok);
        if (!uci) {
          // from the position on the board: the side to move first, unless it's marked as Black's move
          const order = blackMarked ? [base, other].filter((b) => b?.turn === 'black') : [base, other];
          for (const b of order) {
            uci = tryMove(b, tok);
            if (uci) {
              line = b!.copy();
              break;
            }
          }
        }
        if (uci && line) {
          try {
            line.push(uci);
          } catch {
            line = null;
          }
          lineEnd = at + tok.length;
        }
      }
    }
    out.push({ index: at, text: tok, square: m[1], arrow: uci ? { from: uci.slice(0, 2), to: uci.slice(2, 4), brush: 'yellow' } : null });
  }
  return out;
}

/** A screen's own arrows plus the coach's (the same array when there are none, so the board doesn't redraw). */
export const plusCoach = (arrows: Arrow[], coach: Arrow[]): Arrow[] => (coach.length ? [...arrows, ...coach] : arrows);

/** The board's side of SquareText: lit squares and coach arrows, for a screen's Board. */
export function useCoachFocus() {
  const [lit, setLitSquares] = useState<string[] | null>(null);
  const [litArrows, setLitArrows] = useState<Arrow[]>([]);
  const setLit = useCallback<OnFocus>((squares, arrows = []) => {
    setLitSquares(squares);
    setLitArrows(squares === null ? [] : arrows);
  }, []);
  return { lit, litArrows, setLit };
}

export function SquareText({ text, onSquares, fen }: { text: string; onSquares: OnFocus; fen?: string | null }) {
  const refs = refsIn(text, fen);
  if (!refs.length) return <>{text}</>;
  // a move shows as its arrow; a square as a highlight
  const show = (rs: Ref[]) => onSquares([...new Set(rs.filter((r) => !r.arrow).map((r) => r.square))], rs.flatMap((r) => (r.arrow ? [r.arrow] : [])));
  const parts: ReactNode[] = [];
  let last = 0;
  for (const r of refs) {
    if (r.index > last) parts.push(text.slice(last, r.index));
    parts.push(
      <span key={r.index} className={`sq-ref${r.arrow ? ' move-ref' : ''}`} onMouseEnter={() => show([r])} onMouseLeave={() => show(refs)}
        onClick={(e) => { e.stopPropagation(); show([r]); }}>{r.text}</span>,
    );
    last = r.index + r.text.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className="sq-text" onMouseEnter={() => show(refs)} onMouseLeave={() => onSquares(null)} onClick={() => show(refs)}>
      {parts}
    </span>
  );
}

const THINK_FIRST = 'pawnpromoter.ideasThinkFirst';
/** A remembered on/off in this browser (a convenience: blocked storage just means off). */
function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* this session only */ }
}

/** The 💡 Ideas toggle and, when on, the Coach's ideas for the position: the key few first, the
 *  rest folded under "More" (shared by the screens). */
export function IdeasPanel({ ideas, onToggle, onSquares, fen, extra, children }: {
  ideas: { on: boolean; ideas: { summary: string; key: string[]; sections: { title: string; points: string[] }[] } | null };
  onToggle: (on: boolean) => void;
  onSquares: OnFocus;
  /** The position the ideas are about: moves in them get arrows. */
  fen?: string | null;
  extra?: ReactNode;                               // more toggles beside it (Game Review's summary)
  children?: ReactNode;                            // shown between the toggles and the ideas
}) {
  const shown = ideas.on ? ideas.ideas : null;
  const more = shown ? shown.sections.reduce((n, s) => n + s.points.length, 0) : 0;
  // Think first (Gotham's "pause the video"): the key ideas wait behind his two questions until you ask
  const [thinkFirst, setThinkFirst] = useState(() => readFlag(THINK_FIRST));
  const [revealed, setRevealed] = useState(false);
  const keyText = shown?.key.join('\n') ?? '';
  useEffect(() => { setRevealed(false); }, [keyText]);
  const hideKey = thinkFirst && !revealed && (shown?.key.length ?? 0) > 0;
  return (
    <div className="coach-ideas">
      <div className="row coach-toggles">
        <button type="button" className={`chip ideas-toggle${ideas.on ? ' on' : ''}`} aria-pressed={ideas.on}
          onClick={() => onToggle(!ideas.on)}>💡 {ideas.on ? 'Hide the ideas' : 'Ideas in this position'}</button>
        {ideas.on && (
          <button type="button" className={`chip ideas-toggle${thinkFirst ? ' on' : ''}`} aria-pressed={thinkFirst}
            title="Hide the key ideas until you've thought about the position yourself"
            onClick={() => { const v = !thinkFirst; setThinkFirst(v); writeFlag(THINK_FIRST, v); }}>🤔 Think first</button>
        )}
        {extra}
      </div>
      {children}
      {shown && (<>
        <p className="ideas-summary"><SquareText text={shown.summary} onSquares={onSquares} fen={fen} /></p>
        {hideKey ? (
          <div className="ideas-section ideas-key think-first">
            <div className="section">Before you look</div>
            <p>What does your opponent want? Is there one move here — or is it about a plan?</p>
            <button type="button" className="btn small" onClick={() => setRevealed(true)}>Show the key ideas</button>
          </div>
        ) : shown.key.length > 0 && (
          <div className="ideas-section ideas-key">
            <div className="section">Key ideas</div>
            <ul>{shown.key.map((p) => <li key={p}><SquareText text={p} onSquares={onSquares} fen={fen} /></li>)}</ul>
          </div>
        )}
        {more > 0 && (
          <details className="ideas-more">
            <summary>More ({more})</summary>
            {shown.sections.map((s) => (
              <div key={s.title} className="ideas-section">
                <div className="section">{s.title}</div>
                <ul>{s.points.map((p) => <li key={p}><SquareText text={p} onSquares={onSquares} fen={fen} /></li>)}</ul>
              </div>
            ))}
          </details>
        )}
      </>)}
    </div>
  );
}
