/**
 * Coach text with its squares live: point at a sentence and every square it
 * mentions lights up on the board; point at one square name (or a move — its
 * destination: "Nxd4" lights d4) and just that one does. A tap does the same
 * on a touch screen.
 */
import type { ReactNode } from 'react';

// a square, or a move ending on one ("d4", "Nxd4", "exd5", "Qh5+", "e8=Q"), not inside a word or a number
const SQUARE = /(?<![A-Za-z0-9])(?:[KQRBN]?[a-h]?[1-8]?x?)([a-h][1-8])(?:=[QRBN])?[+#]?(?![A-Za-z0-9])/g;

/** The squares a text mentions, in order, each once. */
export function squaresIn(text: string): string[] {
  return [...new Set([...text.matchAll(SQUARE)].map((m) => m[1]))];
}

export function SquareText({ text, onSquares }: { text: string; onSquares: (squares: string[] | null) => void }) {
  const all = squaresIn(text);
  if (!all.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(SQUARE)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    const sq = m[1];
    parts.push(
      <span key={m.index} className="sq-ref" onMouseEnter={() => onSquares([sq])} onMouseLeave={() => onSquares(all)}
        onClick={(e) => { e.stopPropagation(); onSquares([sq]); }}>{m[0]}</span>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className="sq-text" onMouseEnter={() => onSquares(all)} onMouseLeave={() => onSquares(null)} onClick={() => onSquares(all)}>
      {parts}
    </span>
  );
}

/** The 💡 Ideas toggle and, when on, the Coach's ideas for the position: the key few first, the
 *  rest folded under "More" (shared by the screens). */
export function IdeasPanel({ ideas, onToggle, onSquares, extra, children }: {
  ideas: { on: boolean; ideas: { summary: string; key: string[]; sections: { title: string; points: string[] }[] } | null };
  onToggle: (on: boolean) => void;
  onSquares: (squares: string[] | null) => void;
  extra?: ReactNode;                               // more toggles beside it (Game Review's summary)
  children?: ReactNode;                            // shown between the toggles and the ideas
}) {
  const shown = ideas.on ? ideas.ideas : null;
  const more = shown ? shown.sections.reduce((n, s) => n + s.points.length, 0) : 0;
  return (
    <div className="coach-ideas">
      <div className="row coach-toggles">
        <button type="button" className={`chip ideas-toggle${ideas.on ? ' on' : ''}`} aria-pressed={ideas.on}
          onClick={() => onToggle(!ideas.on)}>💡 {ideas.on ? 'Hide the ideas' : 'Ideas in this position'}</button>
        {extra}
      </div>
      {children}
      {shown && (<>
        <p className="ideas-summary"><SquareText text={shown.summary} onSquares={onSquares} /></p>
        {shown.key.length > 0 && (
          <div className="ideas-section ideas-key">
            <div className="section">Key ideas</div>
            <ul>{shown.key.map((p) => <li key={p}><SquareText text={p} onSquares={onSquares} /></li>)}</ul>
          </div>
        )}
        {more > 0 && (
          <details className="ideas-more">
            <summary>More ({more})</summary>
            {shown.sections.map((s) => (
              <div key={s.title} className="ideas-section">
                <div className="section">{s.title}</div>
                <ul>{s.points.map((p) => <li key={p}><SquareText text={p} onSquares={onSquares} /></li>)}</ul>
              </div>
            ))}
          </details>
        )}
      </>)}
    </div>
  );
}
