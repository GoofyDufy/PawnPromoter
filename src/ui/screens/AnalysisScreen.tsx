/**
 * A free analysis board: move either side, step back and forth, and see
 * Stockfish's top lines (green / blue / grey arrows, as on desktop) with the
 * evaluation bar — the app's shared engine, through the core's IdeasEngine.
 * The screens share analysis.ts (analysis_board.py) for their own analysis boards.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Board as ChessBoard, type Color, STARTING_FEN } from '../../core/chess';
import { type Idea, IdeasEngine, lineText } from '../../core/engineIdeas';
import { sharedEngine } from '../../engine/stockfish';
import type { DbClient } from '../../data/client';
import { type Arrow, Board } from '../Board';
import { beforeLast, CoachIdeas } from '../coachIdeas';
import { EvalBar } from '../EvalBar';
import { IdeasPanel } from '../SquareText';

const COLORS: Arrow['brush'][] = ['green', 'blue', 'grey'];
const DOT = { green: '#15781b', blue: '#003088', grey: '#8d8d8d' } as Record<string, string>;
const NO_SQUARES: string[] = [];
const PLAN_READY = 12;                                   // the Coach uses Stockfish's line from this depth

export function AnalysisScreen({ client }: { client: DbClient }) {
  const [start, setStart] = useState(STARTING_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [at, setAt] = useState(0);                       // moves played on the board (≤ moves.length)
  const [orientation, setOrientation] = useState<Color>('white');
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [depth, setDepth] = useState(0);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [fenInput, setFenInput] = useState('');
  const ideasEngine = useRef<IdeasEngine | null>(null);
  // the Coach's ideas for the position ("you" = the side at the bottom), from the lines Stockfish shows
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const coachIdeas = useMemo(() => new CoachIdeas(client, 'analysis_ideas', null, redraw), [client]);
  const [lit, setLit] = useState<string[] | null>(null);
  useEffect(() => { void coachIdeas.load(); }, [coachIdeas]);

  const board = useMemo(() => {
    const b = ChessBoard.fromFen(start);
    for (const m of moves.slice(0, at)) b.push(m);
    return b;
  }, [start, moves, at]);
  const fen = board.fen();

  useEffect(() => {
    ideasEngine.current = new IdeasEngine(sharedEngine(), (forFen, d, list) => {
      if (forFen !== currentFen.current) return;
      setIdeas(list);
      setDepth(d);
    }, setEngineError);
    return () => ideasEngine.current?.stop();
  }, []);

  const currentFen = useRef(fen);
  useEffect(() => {
    currentFen.current = fen;
    setIdeas([]);
    setDepth(0);
    ideasEngine.current?.analyse(fen);
  }, [fen]);

  const play = (uci: string) => {
    setMoves([...moves.slice(0, at), uci]);           // a new move cuts off any moves ahead
    setAt(at + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') setAt((n) => Math.max(0, n - 1));
      if (e.key === 'ArrowRight') setAt((n) => Math.min(moves.length, n + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moves.length]);

  const loadFen = () => {
    try {
      ChessBoard.fromFen(fenInput.trim());
      setStart(fenInput.trim());
      setMoves([]);
      setAt(0);
      setFenInput('');
    } catch {
      setEngineError("That isn't a valid FEN.");
    }
  };

  const best = ideas[0];
  const planReady = depth >= PLAN_READY && best ? best.move : '';
  useEffect(() => {
    setLit(null);
    const me = orientation;
    const cpWhite = planReady && best ? best.cp_white : null;
    void coachIdeas.explain({ fen, me, cp: cpWhite === null ? null : me === 'white' ? cpWhite : -cpWhite,
      theirMove: board.turn === me && at ? moves[at - 1] : undefined, bestLine: planReady && best ? best.pv : undefined,
      before: beforeLast(board), alternatives: planReady ? ideas.map((k) => ({ move: k.move, cp: me === 'white' ? k.cp_white : -k.cp_white, line: k.pv })) : undefined });
    // once per position and side, and again when Stockfish's line is deep enough (not on every new depth)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coachIdeas, fen, orientation, planReady]);
  const arrows: Arrow[] = ideas.map((i, k) => ({ from: i.move.slice(0, 2), to: i.move.slice(2, 4), brush: COLORS[k] }));
  const history = ChessBoard.fromFen(start);
  const sans = moves.map((m) => { const san = history.san(m); history.push(m); return san; });

  return (
    <section>
      <h1>Analysis board</h1>
      <p className="lede">Move either side. Stockfish shows its top lines as arrows; ← and → step through the moves.</p>
      <div className="analysis">
        <div className="board-row">
          <EvalBar cpWhite={best ? best.cp_white : null} mate={best?.mate} orientation={orientation} />
          <Board fen={fen} orientation={orientation} movable="both" onMove={play}
            lastMove={at ? moves[at - 1] : null} arrows={arrows} highlights={lit ?? NO_SQUARES} />
        </div>
        <div className="card">
          <h2>Stockfish {depth ? <span className="note">· depth {depth}</span> : <span className="note">· thinking…</span>}</h2>
          {engineError && <p className="error">{engineError}</p>}
          {board.isGameOver() ? <p className="note">{board.isCheckmate() ? 'Checkmate.' : 'The game is over.'}</p> : (
            <div className="lines">
              {ideas.map((idea, k) => (
                <button type="button" key={idea.move} className="line" style={{ border: 0, textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => play(idea.move)} title="Play this move">
                  <span className="dot" style={{ background: DOT[COLORS[k]!] }} />
                  <span className="ev">{idea.evalText()}</span>
                  <span className="pv">{lineText(board, idea.pv)}</span>
                </button>
              ))}
            </div>
          )}
          <IdeasPanel ideas={coachIdeas} onToggle={(on) => void coachIdeas.set(on)} onSquares={setLit} />
          <div className="row" style={{ marginTop: 14 }}>
            <button type="button" className="btn secondary" onClick={() => setAt(0)} disabled={!at} aria-label="Start">⏮</button>
            <button type="button" className="btn secondary" onClick={() => setAt(at - 1)} disabled={!at} aria-label="Back">◀</button>
            <button type="button" className="btn secondary" onClick={() => setAt(at + 1)} disabled={at >= moves.length} aria-label="Forward">▶</button>
            <button type="button" className="btn secondary" onClick={() => setAt(moves.length)} disabled={at >= moves.length} aria-label="End">⏭</button>
            <button type="button" className="btn secondary" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')}>Flip</button>
            <button type="button" className="btn secondary" onClick={() => { setStart(STARTING_FEN); setMoves([]); setAt(0); }}>New</button>
          </div>
          {sans.length > 0 && (
            <p className="moves" style={{ marginTop: 12 }}>
              {sans.map((san, i) => (
                <span key={i} style={{ fontWeight: i === at - 1 ? 700 : 400, cursor: 'pointer' }} onClick={() => setAt(i + 1)}>
                  {i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ''}{san}{' '}
                </span>
              ))}
            </p>
          )}
          <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); loadFen(); }}>
            <input aria-label="Position (FEN)" placeholder="Paste a position (FEN)" value={fenInput}
              onChange={(e) => setFenInput(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
            <button type="submit" className="btn secondary" disabled={!fenInput.trim()}>Set up</button>
          </form>
        </div>
      </div>
    </section>
  );
}
