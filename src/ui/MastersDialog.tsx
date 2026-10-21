/**
 * Stats → Lines you face most → "Show lines in master database": a line in the Lichess masters database
 * (over-the-board games between strong players) — what masters play next, how often and how it scores,
 * and a few of their games. Click a move to go further down the line; Back steps out again.
 */
import { useEffect, useState } from 'react';
import { Board as ChessBoard, type Color, STARTING_FEN, WHITE } from '../core/chess';
import * as explorer from '../core/explorer';
import { Board } from './Board';
import { Modal } from './Modal';

const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const cache = new Map<string, explorer.MastersPosition>();     // positions already looked up (this visit)

/** '1. e4 c5 2. Nf3' for moves from the start position. */
function numbered(moves: string[]): string {
  const b = ChessBoard.fromFen(STARTING_FEN);
  return moves.map((m) => {
    const text = b.turn === WHITE ? `${b.fullmoveNumber}. ${b.san(m)}` : b.san(m);
    b.push(m);
    return text;
  }).join(' ');
}

export function MastersDialog({ title, moves, color, token, onClose }: {
  title: string; moves: string[]; color: Color; token: string | null; onClose: () => void;
}) {
  const [path, setPath] = useState<string[]>(moves);
  const [data, setData] = useState<explorer.MastersPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const board = ChessBoard.fromFen(STARTING_FEN);
  for (const m of path) board.push(m);
  const fen = board.fen();

  useEffect(() => {
    let alive = true;
    setError(null);
    const known = cache.get(fen);
    if (known) {
      setData(known);
      return;
    }
    setData(null);
    explorer.fetchMasters(token, fen)
      .then((d) => { cache.set(fen, d); if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [fen, token]);

  const extra = path.length - moves.length;
  return (
    <Modal title="Master database" onClose={onClose} wide>
      <div className="masters">
        <div className="masters-board">
          <Board fen={fen} orientation={color} lastMove={path.at(-1) ?? null} />
        </div>
        <div className="masters-side">
          <p className="note">{title}</p>
          <p className="masters-line"><strong>{numbered(path) || 'Start position'}</strong>
            {data?.opening ? <span className="note">  ·  {data.opening}</span> : null}</p>
          <div className="row">
            <button type="button" className="btn secondary small" disabled={!path.length} onClick={() => setPath(path.slice(0, -1))}>◀ Back</button>
            {extra !== 0 && <button type="button" className="btn secondary small" onClick={() => setPath(moves)}>Back to your line</button>}
          </div>
          {error ? <p className="error">{error}</p> : !data ? <p className="note">Looking it up in the master database…</p> : (<>
            <p className="note">{data.games ? `${data.games.toLocaleString()} master games reached this position · White wins ${pct(data.white, data.games)}, draws ${pct(data.draws, data.games)}, Black wins ${pct(data.black, data.games)}.`
              : 'No master games reached this position — it\'s off the beaten track at that level.'}</p>
            {data.moves.length > 0 && (
              <table className="data-table masters-moves">
                <thead><tr><th>Move</th><th>Games</th><th>Played</th><th>White / Draw / Black</th><th>Avg rating</th></tr></thead>
                <tbody>
                  {data.moves.map((m) => (
                    <tr key={m.uci} className="clickable" title="Go further down this line" onClick={() => setPath([...path, m.uci])}>
                      <td><strong>{m.san}</strong></td>
                      <td>{m.games.toLocaleString()}</td>
                      <td>{pct(m.games, data.games)}</td>
                      <td>
                        <span className="wdl" aria-label={`White ${pct(m.white, m.games)}, draws ${pct(m.draws, m.games)}, Black ${pct(m.black, m.games)}`}>
                          <span className="w" style={{ flexGrow: m.white }} /><span className="d" style={{ flexGrow: m.draws }} /><span className="b" style={{ flexGrow: m.black }} />
                        </span>
                        <span className="note"> {pct(m.white, m.games)} / {pct(m.draws, m.games)} / {pct(m.black, m.games)}</span>
                      </td>
                      <td>{m.rating || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data.topGames.length > 0 && (<>
              <div className="section">Master games</div>
              <ol className="queue masters-games">
                {data.topGames.map((g) => (
                  <li key={g.id}><a href={`https://lichess.org/${g.id}`} target="_blank" rel="noopener noreferrer">
                    {`${g.white} (${g.whiteRating}) – ${g.black} (${g.blackRating})  ${g.result}  · ${g.year}`}</a></li>
                ))}
              </ol>
            </>)}
            <p className="note">Source: Lichess masters database (over-the-board games, 2200+). Click a move to see what masters play after it.</p>
          </>)}
          <div className="row modal-buttons"><button type="button" className="btn" onClick={onClose}>Close</button></div>
        </div>
      </div>
    </Modal>
  );
}
