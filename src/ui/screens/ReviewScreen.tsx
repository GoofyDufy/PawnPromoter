/**
 * Game Review (game_review_tab.py): your analyzed games on the left, the board
 * in the centre (the game's line and where it left your prep above it, the
 * controls below), and on the right what each move was, the evaluation graph
 * and the moves list with their badges. Logic: ReviewController.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DbClient } from '../../data/client';
import type { NoteView } from '../../data/reviewServices';
import { TIME_FILTERS } from '../../core/models';
import { IDEA_BRUSHES } from '../analysis';
import { Board } from '../Board';
import { EvalBar } from '../EvalBar';
import { Modal } from '../Modal';
import {
  AMAZING_COLOR, BEST_COLOR, BOOK_COLOR, ERROR, INFO, LEFT_PREP, ONLY_COLOR, type ReviewController, WARNING,
} from '../reviewController';

const DOT: Record<string, string> = { green: '#15781b', blue: '#003088', grey: '#8d8d8d' };
const LEGEND: [string, string][] = [['🧩 puzzle', 'var(--ink)'], ['📝 your note', 'var(--ink)'], ['≡ prep', BOOK_COLOR], ['⚑ left prep', LEFT_PREP], ['!! amazing', AMAZING_COLOR], ['! only move', ONLY_COLOR],
  ['✓ best', BEST_COLOR], ['?! inaccuracy', INFO], ['? mistake', WARNING], ['?? blunder', ERROR]];

/** The evaluation graph (your point of view, ±6 pawns): your moves, mistakes as dots, your prep shaded. */
function Graph({ r }: { r: ReviewController }) {
  const { points, at, prepTo, prepLine, puzzles } = r.graph();
  const [w, h] = [400, 110];
  const x = (f: number) => 4 + (w - 8) * f;
  const y = (v: number) => h / 2 - (h / 2 - 6) * v;
  const line = points.map(([f, v]) => `${x(f)},${y(v)}`).join(' ');
  return (
    <svg className="eval-graph" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Evaluation graph"
      onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); r.graphClick(((e.clientX - b.left) / b.width * w - 4) / (w - 8)); }}>
      {prepTo !== null && <rect x={0} y={0} width={x(prepTo)} height={h} className="prep-band" />}
      {prepTo !== null && prepLine && <line x1={x(prepTo)} y1={0} x2={x(prepTo)} y2={h} stroke={LEFT_PREP} strokeWidth={2} />}
      <line x1={0} y1={h / 2} x2={w} y2={h / 2} className="axis" />
      {points.length >= 2 && <>
        <polygon points={`${x(0)},${h / 2} ${line} ${x(points[points.length - 1][0])},${h / 2}`} className="area" />
        <polyline points={line} fill="none" className="curve" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </>}
      {points.filter(([, , c]) => c).map(([f, v, c], i) => <circle key={i} cx={x(f)} cy={y(v)} r={3.5} fill={c!} />)}
      {points.length > 0 && <line x1={x(at)} y1={0} x2={x(at)} y2={h} strokeDasharray="3 3" className="cursor" vectorEffect="non-scaling-stroke" />}
      {puzzles.map((f, i) => <text key={`p${i}`} x={x(f)} y={10} textAnchor="middle" fontSize={10} className="puzzle-mark">🧩</text>)}
      <text x={6} y={12} className="tick">+6</text>
      <text x={6} y={h - 4} className="tick">−6</text>
    </svg>
  );
}

/** "Make this a puzzle": pick its tags (the common ones, yours, or a new one). */
function MakePuzzleDialog({ client, onSave, onClose }: { client: DbClient; onSave: (tags: string[]) => Promise<void>; onClose: () => void }) {
  const [options, setOptions] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void client.service('pickTagOptions').then(setOptions); }, [client]);
  const toggle = (t: string) => setPicked((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const addTyped = () => {
    const t = typed.split(/\s+/).filter(Boolean).join(' ');
    if (t) setPicked((cur) => (cur.includes(t) ? cur : [...cur, t]));
    if (t) setOptions((cur) => (cur.includes(t) ? cur : [...cur, t]));
    setTyped('');
  };
  return (
    <Modal title="Make this a puzzle" onClose={onClose}>
      <p className="note">It goes to Puzzle Review as <strong>Self made</strong> (Type filter → Self made). Tags help you find it again (Type filter → Tag: …).</p>
      <div className="section">Tags</div>
      <div className="tag-grid">
        {options.map((t) => <button key={t} type="button" className={`tag-choice ${picked.includes(t) ? 'on' : ''}`} aria-pressed={picked.includes(t)} onClick={() => toggle(t)}>{t}</button>)}
      </div>
      <form className="row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); addTyped(); }}>
        <span className="note">Your own</span>
        <input aria-label="Your own tag" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: 180 }} />
        <button type="submit" className="btn secondary small" disabled={!typed.trim()}>Add</button>
      </form>
      <div className="row modal-buttons">
        <button type="button" className="btn" disabled={busy} onClick={async () => { setBusy(true); await onSave(picked); onClose(); }}>🧩 Make the puzzle</button>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** Your note on the position shown: Save note (or Ctrl+Enter) saves it; it's also saved a moment
 *  after you stop typing and when you move on, so nothing is lost. A failed save says why. */
function NoteBox({ r }: { r: ReviewController }) {
  const place = r.notePlace();
  const key = place ? `${place.gameId}|${place.ply}` : '';
  const saved = r.note();
  const [text, setText] = useState(saved);
  const [state, setState] = useState<{ kind: 'idle' | 'typing' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' });
  const current = useRef({ place, text, dirty: false });

  const save = async (at = current.current.place, t = current.current.text) => {
    if (!at) return;
    current.current.dirty = false;
    setState({ kind: 'saving' });
    try {
      await r.saveNote(at, t);
      setState({ kind: 'saved' });
    } catch (e) {
      current.current.dirty = true;
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  // a new position: save what was typed on the last one (there), then show this one's note
  useEffect(() => {
    const prev = current.current;
    if (prev.dirty && prev.place) void r.saveNote(prev.place, prev.text).catch(() => {});
    current.current = { place, text: saved, dirty: false };
    setText(saved);
    setState({ kind: 'idle' });
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  // leaving Game Review: save it too
  useEffect(() => () => {
    const prev = current.current;
    if (prev.dirty && prev.place) void r.saveNote(prev.place, prev.text).catch(() => {});
  }, [r]);
  // and a moment after you stop typing
  useEffect(() => {
    if (!current.current.dirty) return;
    const timer = setTimeout(() => void save(), 1500);
    return () => clearTimeout(timer);
  }, [text]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!r.game || r.analysis.active) return null;
  const status = state.kind === 'saving' ? 'Saving…' : state.kind === 'saved' ? (text.trim() ? 'Saved ✓' : 'Note removed')
    : state.kind === 'typing' ? 'Not saved yet' : saved ? 'Saved ✓' : '';
  return (
    <div className="note-box">
      <div className="row"><div className="section" style={{ flex: 1 }}>📝 Your notes on this position</div>
        <span className={`note ${state.kind === 'saved' ? 'ok' : ''}`}>{status}</span></div>
      <textarea aria-label="Your notes on this position" rows={3} placeholder="What were you thinking here? What should you remember?" value={text}
        onChange={(e) => { setText(e.target.value); current.current.text = e.target.value; current.current.dirty = true; setState({ kind: 'typing' }); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }} />
      <div className="row">
        <button type="button" className="btn small" disabled={state.kind === 'saving' || (text === saved && state.kind !== 'error')} onClick={() => void save()}>Save note</button>
        {saved && <button type="button" className="btn ghost small" onClick={() => { setText(''); current.current.text = ''; void save(current.current.place, ''); }}>Delete note</button>}
        {state.kind === 'error' && <span className="error">Couldn't save the note: {state.message}</span>}
      </div>
    </div>
  );
}

/** Every note you've written, newest first: click one to open it in its game. */
function NotesDialog({ client, onOpen, onClose }: { client: DbClient; onOpen: (n: NoteView) => void; onClose: () => void }) {
  const [notes, setNotes] = useState<NoteView[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { void client.service('allNotes').then(setNotes); }, [client]);
  const shown = (notes ?? []).filter((n) => !q.trim() || n.text.toLowerCase().includes(q.trim().toLowerCase()) || n.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal title={`📝 Your notes${notes ? ` — ${notes.length}` : ''}`} onClose={onClose} wide>
      <input aria-label="Search your notes" placeholder="Search your notes…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
      <ol className="notes-list">
        {notes === null && <li className="note">Loading…</li>}
        {notes !== null && !shown.length && <li className="note">{notes.length ? 'No notes match.' : 'No notes yet — write one in the notes box under a position.'}</li>}
        {shown.map((n) => (
          <li key={`${n.gameId}|${n.ply}`}>
            <button type="button" onClick={() => onOpen(n)}>
              <span className="note">{n.label}</span>
              <span className="note-text">{n.text}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="row modal-buttons"><button type="button" className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

/** onOpenPuzzle(id): Puzzle Review on that puzzle. */
export function ReviewScreen({ r, client, onOpenPuzzle, onPuzzlesChanged }: {
  r: ReviewController; client: DbClient; onOpenPuzzle: (id: string) => void; onPuzzlesChanged: () => void;
}) {
  useSyncExternalStore(r.subscribe, () => r.version);
  const [amazingOpen, setAmazingOpen] = useState(false);
  const [makeOpen, setMakeOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const movesBox = useRef<HTMLOListElement>(null);

  useEffect(() => { if (!r.gamesLoaded) void r.refreshGames(); }, [r]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || amazingOpen || makeOpen || notesOpen) return;
      if (e.key === 'ArrowLeft') r.step(-1);
      if (e.key === 'ArrowRight') r.step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [r, amazingOpen, makeOpen, notesOpen]);

  // keep the current move in view
  const row = r.currentRow();
  useEffect(() => {
    movesBox.current?.querySelector<HTMLElement>(`[data-ply="${row}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [row, r.game]);

  const g = r.game;
  const v = r.view();
  const tone = r.status.tone;
  const statusStyle = typeof tone === 'object' ? { color: tone.color } : undefined;
  const chips = r.topMoveChips();

  return (
    <section className="puzzle-screen">
      <h1>Game Review</h1>
      <p className="lede">Step through your analyzed games: what each move was, where you left your prep, and Stockfish's better moves.</p>
      <div className="puzzles review">
        <div className="card queue-card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h2 style={{ margin: 0, flex: 1 }}>Analyzed games</h2>
            <select aria-label="Games" value={r.filter} onChange={(e) => void r.setFilter(e.target.value)}>
              {Object.keys(TIME_FILTERS).map((f) => <option key={f}>{f}</option>)}
            </select>
          </div>
          <div className="segmented result-filter" role="tablist" aria-label="Result">
            {['All results', 'Wins', 'Losses', 'Draws'].map((x) => <button key={x} type="button" role="tab" aria-selected={r.result === x} aria-checked={r.result === x}
              onClick={() => void r.setResult(x)}>{x === 'All results' ? 'All' : x}</button>)}
          </div>
          <ol className="queue" aria-label="Analyzed games">
            {r.games.map((row) => (
              <li key={row.id}><button type="button" aria-current={g?.id === row.id ? 'true' : undefined} onClick={() => void r.loadGame(row.id)}>{row.label}</button></li>
            ))}
            {r.gamesLoaded && !r.games.length && <li className="note">No analyzed games in this filter yet.</li>}
          </ol>
          <button type="button" className="btn secondary amazing-button" style={{ marginTop: 8 }}
            onClick={() => { setAmazingOpen(true); void r.loadAmazing(); }}>
            {r.amazing ? `!! Your amazing moves (${r.amazing.length})` : '!! Your amazing moves'}</button>
          <button type="button" className="btn secondary" style={{ marginTop: 6 }} onClick={() => setNotesOpen(true)}>📝 Your notes</button>
        </div>

        <div className="card board-card">
          <div className="review-head">
            <div className="note game-label" title={g?.title}>{g ? g.title : 'Pick a game on the left'}</div>
            {g && <div className="note game-label" title={`${g.opening}${g.accuracy ? ` — ${g.accuracy}` : ''}`}
              style={{ color: g.prep && g.prep.departure !== null ? LEFT_PREP : undefined }}>{g.opening}</div>}
            {(() => {
              // is the position shown (your move) already a puzzle?
              const pp = r.positionPuzzle();
              if (!g || r.analysis.active) return <div className="puzzle-flag empty" />;
              if (pp.puzzle) {
                return (
                  <div className="puzzle-flag is-puzzle" role="status">
                    <span>🧩 Already a puzzle{pp.puzzle.pick ? ' (Self made)' : pp.puzzle.type ? ` (${pp.puzzle.type})` : ''}</span>
                    <button type="button" className="btn small" onClick={() => onOpenPuzzle(pp.puzzle!.id)}>Try it</button>
                    {pp.puzzle.pick && <button type="button" className="btn ghost small" onClick={async () => { await r.removePuzzle(); onPuzzlesChanged(); }}>Remove</button>}
                  </div>
                );
              }
              if (pp.canMake) {
                return (
                  <div className="puzzle-flag not-puzzle" role="status">
                    <span>Not a puzzle yet</span>
                    <button type="button" className="btn secondary small" onClick={() => setMakeOpen(true)}>🧩 Make this a puzzle</button>
                  </div>
                );
              }
              return <div className="puzzle-flag empty note">{(r.ply % 2 === 0) === (g.myColor === 'white') ? 'No saved analysis for this move' : "Your opponent's move"}</div>;
            })()}
          </div>
          <div className="board-row">
            <EvalBar cpWhite={r.evalWhite()} mate={r.analysis.active ? r.analysis.evalMate : null} orientation={v.orientation} />
            <Board fen={v.fen} orientation={v.orientation} lastMove={v.lastMove} arrows={v.arrows} badges={v.badges}
              movable={g ? 'both' : null} onMove={(uci) => r.onMove(uci)} />
          </div>
          <div className="row puzzle-buttons">
            {([['⏮', -999, 'Start'], ['←', -1, 'Back'], ['→', 1, 'Forward'], ['⏭', 999, 'End']] as const).map(([t, d, label]) => (
              <button key={t} type="button" className="btn secondary" aria-label={label} onClick={() => r.step(d)} disabled={!g}>{t}</button>
            ))}
            <button type="button" className="btn secondary" onClick={() => r.toggleAnalysis()} disabled={!g}>{r.analysis.active ? 'Back to game' : 'Analyze'}</button>
            <span style={{ flex: 1 }} />
            {!r.analysis.active && <button type="button" className="btn" onClick={() => r.nextMistake()} disabled={!g}>Next mistake</button>}
          </div>
        </div>

        <div className="card commentary-card review-side" aria-label="Commentary">
          {/* the words about this position scroll on their own: a long explanation never hides anything */}
          <div className="review-text">
          {r.analysis.active ? (
            <div className="ideas">
              <div className="row"><strong>{r.analysis.panel.title}</strong><span className="note">{r.analysis.panel.header}</span></div>
              <div className="lines">
                {r.analysis.panel.rows.map((rowText, i) => (
                  <button type="button" key={rowText + i} className="line" onClick={() => r.pickIdea(i)} title="Play this line">
                    <span className="dot" style={{ background: DOT[IDEA_BRUSHES[i] ?? 'grey'] }} />
                    <span className="pv">{rowText}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (<>
            <p className={`status ${typeof tone === 'string' ? tone : ''}`} style={statusStyle} role="status">{r.status.text}</p>
            {r.detail && <p className="explanation">{r.detail}</p>}
            {r.why && <p className={`why ${r.why.startsWith('Working') ? 'note' : ''}`}>{r.why}</p>}
            {r.notice && <p className="ok">{r.notice}</p>}
            <NoteBox r={r} />
            {g?.accuracy && <p className="note">{g.accuracy}</p>}
            {chips.length > 0 && (
              <div className="row top-moves">
                {chips.map((c, i) => <button key={c + i} type="button" className="chip" onClick={() => r.pickIdea(i)}>
                  <span className="dot" style={{ background: DOT[IDEA_BRUSHES[i] ?? 'grey'] }} /> {c}</button>)}
              </div>
            )}
          </>)}
          </div>
          <div className="row graph-head">
            <div className="section" style={{ flex: 1 }}>Evaluation (your point of view)</div>
            <label className="check"><input type="checkbox" checked={r.topMoves} onChange={(e) => void r.setTopMoves(e.target.checked)} /> Stockfish's top moves</label>
          </div>
          <Graph r={r} />
          <div className="section">Moves</div>
          <div className="legend">{LEGEND.map(([t, c]) => <span key={t} style={{ color: c }}>{t}</span>)}</div>
          <ol className="queue moves-list" ref={movesBox} aria-label="Moves">
            {r.moveRows().map((m, i) => (
              <li key={i} data-ply={i}>
                <button type="button" aria-current={i === row ? 'true' : undefined} onClick={() => r.go(i + 1)}
                  style={{ color: i === row ? undefined : m.color ?? undefined }} className={m.muted ? 'muted' : ''}>{m.label}</button>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {makeOpen && <MakePuzzleDialog client={client} onClose={() => setMakeOpen(false)}
        onSave={async (tags) => { if (await r.makePuzzle(tags)) onPuzzlesChanged(); }} />}
      {notesOpen && <NotesDialog client={client} onClose={() => setNotesOpen(false)}
        onOpen={(n) => { setNotesOpen(false); void r.openGame(n.gameId, null, n.ply); }} />}
      {amazingOpen && (
        <Modal title={`!! Your amazing moves${r.amazing ? ` — ${r.amazing.length}` : ''}`} onClose={() => setAmazingOpen(false)}>
          <p className="note">Sound sacrifices: you offered a piece (2+ pawns' worth) with the best or nearly the best move, when you weren't already winning. Click one to see it.</p>
          <ol className="queue games-list">
            {r.amazingBusy && <li className="note">Finding your amazing moves…</li>}
            {(r.amazing ?? []).map((m, i) => (
              <li key={i}><button type="button" onClick={() => { setAmazingOpen(false); void r.openGame(m.gameId, null, m.ply + 1); }}>{m.label}</button></li>
            ))}
            {r.amazing && !r.amazing.length && <li className="note">None yet — analyze more games (Import &amp; Analyze).</li>}
          </ol>
          <div className="row modal-buttons"><button type="button" className="btn" onClick={() => setAmazingOpen(false)}>Close</button></div>
        </Modal>
      )}
    </section>
  );
}
