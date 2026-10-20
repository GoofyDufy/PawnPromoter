/**
 * "Play it out" (play_window.py): play a position against Stockfish at an
 * adjustable strength — or analyze it yourself, moving both sides, with an
 * optional engine evaluation. Used from puzzles (for endgames it's the
 * endgame trainer: can you actually convert it?).
 *
 * It has an engine of its own: limiting the strength changes the engine's
 * options, which must never leak into the shared engine's analysis.
 */
import { useEffect, useRef, useState } from 'react';
import { Board as ChessBoard, type Color, WHITE } from '../core/chess';
import { pySigned } from '../core/format';
import { startChosenStockfish } from '../engine/stockfish';
import type { UciEngine } from '../engine/uci';
import { type Arrow, Board } from './Board';

/** label -> UCI_Elo (null = full strength). Stockfish's minimum Elo is ~1320. */
export const STRENGTHS: [string, number | null][] = [
  ['Club (1400)', 1400],
  ['Intermediate (1700)', 1700],
  ['Strong (2000)', 2000],
  ['Expert (2300)', 2300],
  ['Full strength', null],
];
const THINK_SECONDS = 0.6;
const EVAL_SECONDS = 0.5;          // per position while "Show engine evaluation" is on
const PLAY_MODE = 'Play Stockfish';
const ANALYZE_MODE = 'Analyze myself';

type Tone = 'normal' | 'success' | 'error' | 'muted';

/** Your moves from the start position, numbered: '41. Kf2 Kd5 42. Ke3'. */
function movesText(startFen: string, moves: string[]): string {
  const replay = ChessBoard.fromFen(startFen);
  const sans: string[] = [];
  for (const m of moves) {
    const prefix = replay.turn === WHITE ? `${replay.fullmoveNumber}. ` : !sans.length ? `${replay.fullmoveNumber}... ` : '';
    sans.push(prefix + replay.san(m));
    replay.push(m);
  }
  return sans.join(' ');
}

function drawReason(b: ChessBoard): string {
  if (b.isStalemate()) return 'stalemate';
  if (b.isInsufficientMaterial()) return 'insufficient material';
  return 'seventyfive moves';
}

/** myColor: your side (default: the side to move — a puzzle; a drilled line passes yours). */
/** analyze: open straight into Analyze myself, with the engine evaluation on. */
export function PlayDialog({ fen, title, onClose, myColor: mine, analyze = false }: { fen: string; title: string; onClose: () => void; myColor?: Color; analyze?: boolean }) {
  const myColor: Color = mine ?? ChessBoard.fromFen(fen).turn;
  const [moves, setMoves] = useState<string[]>([]);
  const [mode, setMode] = useState(analyze ? ANALYZE_MODE : PLAY_MODE);
  const [strength, setStrength] = useState('Intermediate (1700)');
  const [showEval, setShowEval] = useState(analyze);
  const [orientation, setOrientation] = useState<Color>(myColor);
  const [thinking, setThinking] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [evalText, setEvalText] = useState<{ text: string; muted: boolean } | null>(null);
  const [bestArrow, setBestArrow] = useState<Arrow | null>(null);
  const engine = useRef<Promise<UciEngine> | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);              // bumped on undo / restart: a stale reply is dropped

  // a new starting position (shouldn't happen while open): start over rather than replay moves onto it
  const [startFen, setStartFen] = useState(fen);
  if (startFen !== fen) {
    setStartFen(fen);
    setMoves([]);
  }
  const board = ChessBoard.fromFen(fen);
  for (const m of startFen === fen ? moves : []) if (board.isLegal(m)) board.push(m);
  const analyzing = mode === ANALYZE_MODE;
  const over = board.isGameOver();

  useEffect(() => {
    dialog.current?.showModal();
    engine.current = startChosenStockfish();
    engine.current.catch((e) => setEngineError(`Engine error: ${e instanceof Error ? e.message : e}`));
    return () => { void engine.current?.then((e) => e.quit()).catch(() => {}); };
  }, []);

  // Stockfish's turn while playing: it moves
  const position = moves.join(' ');
  useEffect(() => {
    if (analyzing || over || board.turn === myColor || engineError) return;
    const gen = ++generation.current;
    setThinking(true);
    void (async () => {
      try {
        const e = await engine.current!;
        const elo = STRENGTHS.find(([label]) => label === strength)![1];
        await e.setOption('UCI_LimitStrength', elo !== null);
        if (elo !== null) await e.setOption('UCI_Elo', elo);
        const move = await e.play(board, { time: THINK_SECONDS });
        // ignore a stale reply (undo / restart meanwhile, or you switched to analyzing)
        if (gen === generation.current && move && board.isLegal(move)) setMoves((ms) => (ms.join(' ') === position ? [...ms, move] : ms));
      } catch (e) {
        setEngineError(`Engine error: ${e instanceof Error ? e.message : e}`);
      } finally {
        if (gen === generation.current) setThinking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, analyzing, engineError]);

  // the engine evaluation in Analyze myself
  useEffect(() => {
    setEvalText(null);
    setBestArrow(null);
    if (!analyzing || !showEval || over || engineError) return;
    const gen = ++generation.current;
    setEvalText({ text: 'Evaluating…', muted: true });
    void (async () => {
      try {
        const e = await engine.current!;
        await e.setOption('UCI_LimitStrength', false);
        const [info] = await e.analyse(board, { time: EVAL_SECONDS });
        if (gen !== generation.current || !info) return;
        const white = info.score.pov(WHITE);
        const mate = white.mate();
        let text = white.isMate()
          ? (mate ? `Mate in ${Math.abs(mate)} for ${mate > 0 ? 'White' : 'Black'}` : 'Checkmate')
          : pySigned(white.score()! / 100, 1);
        const best = info.pv[0];
        if (best && board.isLegal(best)) {
          text += ` · best: ${board.san(best)}`;
          setBestArrow({ from: best.slice(0, 2), to: best.slice(2, 4), brush: 'green' });
        }
        setEvalText({ text: `Evaluation ${text}`, muted: false });
      } catch (e) {
        if (gen === generation.current) setEngineError(`Engine error: ${e instanceof Error ? e.message : e}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, analyzing, showEval, engineError]);

  const onMove = (uci: string) => {
    if (thinking || over) return;
    if (!analyzing && board.turn !== myColor) return;
    setMoves([...moves, uci]);
  };

  const undo = () => {
    if (thinking) return;
    if (analyzing) { setMoves(moves.slice(0, -1)); return; }
    // take back to the last position where it's your move
    const youFirst = ChessBoard.fromFen(fen).turn === myColor;
    let keep = Math.max(0, moves.length - 1);
    if ((keep % 2 === 0) !== youFirst) keep = Math.max(0, keep - 1);
    setMoves(moves.slice(0, keep));
  };

  const restart = () => {
    generation.current += 1;
    setThinking(false);
    setMoves([]);
  };

  const close = () => {
    dialog.current?.close();
    onClose();
  };

  let status: { text: string; tone: Tone };
  if (engineError) status = { text: engineError, tone: 'error' };
  else if (over) {
    const winner = board.isCheckmate() ? (board.turn === WHITE ? 'black' : 'white') : null;
    if (winner === null) status = { text: `Draw (${drawReason(board)}).`, tone: 'normal' };
    else if (analyzing) status = { text: `Checkmate — ${winner === 'white' ? 'White' : 'Black'} wins.`, tone: 'normal' };
    else if (winner === myColor) status = { text: 'You won! Position converted.', tone: 'success' };
    else status = { text: 'Stockfish won. Try again with Restart.', tone: 'error' };
  } else if (analyzing) status = { text: `${board.turn === WHITE ? 'White' : 'Black'} to move.`, tone: 'normal' };
  else if (thinking) status = { text: 'Stockfish is thinking...', tone: 'muted' };
  else status = { text: board.turn === myColor ? 'Your move.' : '', tone: 'normal' };

  const you = myColor === WHITE ? 'White' : 'Black';
  return (
    <dialog ref={dialog} className="play-dialog" aria-label={title} onCancel={(e) => { e.preventDefault(); close(); }}>
      <div className="play">
        <Board fen={board.fen()} orientation={orientation} movable={over || thinking ? null : analyzing ? 'both' : myColor}
          onMove={onMove} lastMove={moves.at(-1) ?? null} arrows={analyzing && bestArrow ? [bestArrow] : []} />
        <div className="play-side">
          <h2>{title}</h2>
          <div className="segmented" role="radiogroup" aria-label="Mode">
            {[PLAY_MODE, ANALYZE_MODE].map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
          <p className="note">{analyzing ? 'Move both sides yourself and try ideas out. Undo takes back one move.'
            : `You play ${you}. Can you convert (or hold) this position?`}</p>
          {analyzing ? (
            <label className="check"><input type="checkbox" checked={showEval} onChange={(e) => setShowEval(e.target.checked)} /> Show engine evaluation</label>
          ) : (
            <label className="field"><span className="section">Engine strength</span>
              <select value={strength} onChange={(e) => setStrength(e.target.value)}>
                {STRENGTHS.map(([label]) => <option key={label}>{label}</option>)}
              </select>
            </label>
          )}
          <p className={`status ${status.tone}`} role="status">{status.text}</p>
          {evalText && <p className={evalText.muted ? 'note' : ''}>{evalText.text}</p>}
          <p className="note moves">{movesText(fen, moves)}</p>
          <div className="play-buttons">
            <button type="button" className="btn secondary" onClick={undo}>Undo move</button>
            <button type="button" className="btn secondary" onClick={restart}>Restart position</button>
            <button type="button" className="btn secondary" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')}>Flip board</button>
            <button type="button" className="btn ghost" onClick={close}>Close</button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
