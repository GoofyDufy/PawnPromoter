/**
 * Puzzle Review (puzzle_tab.py's board card and queue card): the board with
 * your game / Lichess line, tags and your record above it, the buttons and
 * the explanation below, and the queue with its filters on the right. All the
 * logic is in PuzzleController; this draws it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { KINDS } from '../../core/puzzleKind';
import * as puzzleTags from '../../core/puzzleTags';
import { TIME_FILTERS } from '../../core/models';
import {
  ALL_KINDS, ALL_POSITIONS, BOTH_SOURCES, LICHESS, MULTI_STEP, MY_GAMES, QUIET_ONLY, SHARP_ONLY,
} from '../../data/services';
import { IDEA_BRUSHES } from '../analysis';
import { Board } from '../Board';
import { EvalBar } from '../EvalBar';
import { PlayDialog } from '../PlayDialog';
import { type Filters, PuzzleController } from '../puzzleController';

const SOURCE_OPTIONS = [MY_GAMES, LICHESS, BOTH_SOURCES];
const KIND_OPTIONS = [ALL_KINDS, ...KINDS, MULTI_STEP];
const POSITION_OPTIONS = [ALL_POSITIONS, SHARP_ONLY, QUIET_ONLY];
const DOT = { green: '#15781b', blue: '#003088', grey: '#8d8d8d' };

function useController(c: PuzzleController): number {
  // the controller bumps its version on every change: React re-renders and reads its fields
  return useSyncExternalStore(c.subscribe, () => c.version);
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="filter">
      <span className="note">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </label>
  );
}

/** "+ Tag": this puzzle's tags, suggested tags to click on / off, and your own. */
function TagPicker({ c, onClose }: { c: PuzzleController; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const auto = c.details?.autoTags ?? [];
  const mine = c.details?.userTags ?? [];
  const have = new Set(auto.map((t) => t.toLowerCase()));
  const offered = [...puzzleTags.SUGGESTED.filter((t) => !have.has(t.toLowerCase())), ...mine.filter((t) => !puzzleTags.SUGGESTED.includes(t))];
  const add = () => {
    if (typed.trim()) void c.setTag(typed, true);
    setTyped('');
  };
  return (
    <div className="tag-picker card" role="dialog" aria-label="Tags" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="section">This puzzle</div>
      <p>{auto.join(', ') || 'No tags yet'}</p>
      <div className="section">Your tags — click to add or remove</div>
      <div className="tag-grid">
        {offered.map((tag) => {
          const on = mine.includes(tag);
          return <button key={tag} type="button" className={`tag-choice ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => void c.setTag(tag, !on)}>{tag}</button>;
        })}
      </div>
      <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <span className="note">Your own</span>
        <input autoFocus aria-label="Your own tag" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: 180 }} />
        <button type="submit" className="btn secondary">Add</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onClose}>Done</button>
      </form>
    </div>
  );
}

export function PuzzleScreen({ c }: { c: PuzzleController }) {
  useController(c);
  const [picker, setPicker] = useState(false);
  const [playing, setPlaying] = useState(false);
  const p = c.puzzle;

  useEffect(() => setPicker(false), [p?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || playing) return;
      if (e.key === 'ArrowLeft') void c.previous();
      if (e.key === 'ArrowRight') void c.next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [c, playing]);

  const setFilter = (name: keyof Filters) => (v: string) => void c.setFilter(name, v);
  const review = () => {
    const url = c.isLichess() ? p?.game_url : c.details?.game?.url;
    if (url) window.open(url, '_blank', 'noopener');
  };
  const done = c.state === 'done';
  const analysing = c.analysis.active;
  const last = c.board.moveStack.at(-1) ?? null;
  const auto = c.details?.autoTags ?? [];
  const mine = c.details?.userTags ?? [];
  const evalWhite = c.evalWhite();

  return (
    <section>
      <h1>Puzzle Review</h1>
      <p className="lede">Your own mistakes as puzzles. Find the move you missed — ← and → go to the previous and next puzzle.</p>
      <div className="puzzles">
        <div className="card board-card">
          <div className="row puzzle-head">
            <span className="note game-label">{c.gameLabel()}</span>
            <span style={{ flex: 1 }} />
            {p && <button type="button" className="btn secondary small" onClick={review}
              disabled={c.isLichess() ? !p.game_url : !c.details?.game?.url}
              title={c.isLichess() ? undefined : 'Opens the game on chess.com (Game Review comes in Phase 5)'}>
              {c.isLichess() ? 'Open on Lichess' : 'Review game'}</button>}
            {p && <button type="button" className="btn secondary small" onClick={() => setPlaying(true)}>Play it out</button>}
          </div>
          {p && (
            <div className="row tag-row">
              <div className="tags">
                {auto.slice(0, 1).map((t) => <span key={t} className="chip">{t}</span>)}
                {mine.map((t) => (
                  <button key={t} type="button" className="chip yours" title="Remove this tag" onClick={() => void c.setTag(t, false)}>{t}  ×</button>
                ))}
                {auto.slice(1).map((t) => <span key={t} className="chip">{t}</span>)}
                <button type="button" className="chip add" onClick={() => setPicker(!picker)} aria-expanded={picker}>+ Tag</button>
              </div>
              <span className="note">{c.recordLabel()}</span>
              {picker && <TagPicker c={c} onClose={() => setPicker(false)} />}
            </div>
          )}
          <div className="board-row">
            <EvalBar cpWhite={evalWhite} mate={analysing ? c.analysis.evalMate : null} orientation={c.orientation} />
            <Board fen={c.board.fen()} orientation={c.orientation} lastMove={last} arrows={c.boardArrows()}
              movable={analysing ? 'both' : p && c.state === 'solving' ? c.board.turn : null}
              onMove={(uci) => void c.onMove(uci)} />
          </div>
          <div className="row puzzle-buttons">
            <button type="button" className="btn secondary" onClick={() => void c.previous()} disabled={!c.queue.length}>← Prev</button>
            {done && c.lineVisible && <>
              <button type="button" className="btn secondary" aria-label="Back" onClick={() => c.stepLine(-1)} disabled={!c.canStepBack()}>◀</button>
              <button type="button" className="btn secondary" aria-label="Forward" onClick={() => c.stepLine(1)} disabled={!c.canStepForward()}>▶</button>
              <button type="button" className="btn secondary" onClick={() => c.toggleAnalysis()}>{analysing ? 'Stop analysis' : 'Analyze'}</button>
            </>}
            {c.retryVisible && <>
              <button type="button" className="btn secondary" onClick={() => c.retry()}>Try again</button>
              <button type="button" className="btn secondary" onClick={() => void c.reveal()}>Show answer</button>
            </>}
            <span style={{ flex: 1 }} />
            <button type="button" className="btn secondary" onClick={() => void c.random()} disabled={!c.queue.length}>Random</button>
            <button type="button" className="btn" onClick={() => void c.next()} disabled={!c.queue.length}>Next →</button>
          </div>
          <p className={`status ${c.status.tone}`} role="status">{c.status.text}</p>
          {c.explanation && <p className="explanation">{c.explanation}</p>}
          {analysing && (
            <div className="ideas">
              <div className="row"><strong>{c.analysis.panel.title}</strong><span className="note">{c.analysis.panel.header}</span></div>
              <div className="lines">
                {c.analysis.panel.rows.map((row, i) => (
                  <button type="button" key={row + i} className="line" onClick={() => c.followIdea(i)} title="Play this line">
                    <span className="dot" style={{ background: DOT[IDEA_BRUSHES[i] ?? 'grey'] }} />
                    <span className="pv">{row}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="card queue-card">
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0, flex: 1 }}>Puzzle queue</h2>
            <select aria-label="Type" value={c.filters.type} onChange={(e) => setFilter('type')(e.target.value)}>
              {(c.typeOptions.includes(c.filters.type) ? c.typeOptions : [...c.typeOptions, c.filters.type]).map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <Select label="Puzzles" value={c.filters.source} options={SOURCE_OPTIONS} onChange={setFilter('source')} />
          <Select label="Kind" value={c.filters.kind} options={KIND_OPTIONS} onChange={setFilter('kind')} />
          <Select label="Position" value={c.filters.position} options={POSITION_OPTIONS} onChange={setFilter('position')} />
          <Select label="Games" value={c.filters.focus} options={Object.keys(TIME_FILTERS)} onChange={setFilter('focus')} />
          <ol className="queue" aria-label="Puzzle queue">
            {c.queue.map((q, i) => (
              <li key={q.id}>
                <button type="button" aria-current={i === c.index ? 'true' : undefined} onClick={() => void c.loadAt(i)}>{c.rowLabel(i)}</button>
              </li>
            ))}
          </ol>
          <p className="note">{c.loading ? 'Loading puzzles…' : c.queue.length ? c.countText() : c.emptyText}</p>
        </div>
      </div>
      {playing && p && (
        <PlayDialog fen={p.fen} title={`Play it out — ${p.puzzle_type || 'puzzle'}`} onClose={() => setPlaying(false)} />
      )}
    </section>
  );
}
