/**
 * Import & Analyze (puzzle_tab.py's import page): download games from
 * chess.com, let Stockfish find your mistakes (they become puzzles), rebuild
 * the puzzles at another blunder size, and add Lichess puzzles from the
 * packs. The work itself runs in Jobs, so it keeps going on other screens.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import * as lichessPuzzles from '../../core/lichessPuzzles';
import { TIME_FILTERS } from '../../core/models';
import type { DbClient } from '../../data/client';
import type { GamesSummaryView } from '../../data/services';
import { MY_GAMES } from '../../data/services';
import { parallelEngines } from '../../engine/pool';
import type { Jobs } from '../jobs';

const DEFAULT_THRESHOLD_PAWNS = '1.5';
const DEFAULT_GAMES_PER_RUN = '50';
const DEFAULT_IMPORT_MONTHS = '12';
const DEFAULT_LICHESS_COUNT = String(lichessPuzzles.DEFAULT_COUNT);

function summaryText(s: GamesSummaryView | null): string {
  if (!s) return '';
  if (s.total === 0) return 'No games yet. Import from chess.com to get started.';
  const parts = [`${s.total} games imported`, `${s.cached + s.legacy} analyzed`];
  if (s.new) parts.push(`${s.new} waiting`);
  let text = parts.join(' · ');
  if (s.legacy) {
    text += `\n${s.legacy} were analyzed in an older format and need a one-time re-analysis for full data (top 3 engine moves). `
      + 'They keep their puzzles; Analyze new games handles them after new games.';
  }
  return text;
}

interface Props {
  client: DbClient;
  jobs: Jobs;
  /** Puzzle Review's Puzzles dropdown (Lichess puzzles only show when it includes them). */
  puzzleSource: string;
  onFocusChange: (focus: string) => void;
}

export function ImportScreen({ client, jobs, puzzleSource, onFocusChange }: Props) {
  const state = useSyncExternalStore(useCallback((l: () => void) => jobs.subscribe(l), [jobs]), () => jobs.state);
  const [focus, setFocus] = useState('All games');
  const [summary, setSummary] = useState<GamesSummaryView | null>(null);
  const [username, setUsername] = useState('');
  const [months, setMonths] = useState(DEFAULT_IMPORT_MONTHS);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_PAWNS);
  const [perRun, setPerRun] = useState(DEFAULT_GAMES_PER_RUN);
  const [parallel, setParallel] = useState(true);
  const [li, setLi] = useState({ low: '', high: '', count: DEFAULT_LICHESS_COUNT });
  const [liSummary, setLiSummary] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await client.service('getSettings', ['focus_filter', 'chess_com_username', 'import_months', 'threshold_pawns',
        'games_per_run', 'parallel_engines', 'lichess_min_rating', 'lichess_max_rating', 'lichess_count']);
      setFocus(s.focus_filter && s.focus_filter in TIME_FILTERS ? s.focus_filter : 'All games');
      setUsername(s.chess_com_username || '');
      setMonths(s.import_months || DEFAULT_IMPORT_MONTHS);
      setThreshold(s.threshold_pawns || DEFAULT_THRESHOLD_PAWNS);
      setPerRun(s.games_per_run || DEFAULT_GAMES_PER_RUN);
      setParallel(s.parallel_engines !== '0');
      const l = await client.service('lichessSummary');
      setLi({ low: s.lichess_min_rating || String(l.defaults[0]), high: s.lichess_max_rating || String(l.defaults[1]),
        count: s.lichess_count || DEFAULT_LICHESS_COUNT });
    })();
  }, [client]);

  // the games line and the Lichess count: again whenever work finishes
  useEffect(() => {
    void client.service('gameSummary', focus).then(setSummary);
    void client.service('lichessSummary').then((l) => setLiSummary(l.count
      ? `${l.count.toLocaleString()} puzzles added, rated ${l.low}–${l.high}.` : 'None added yet.'));
  }, [client, focus, state.busy, state.puzzlesVersion]);

  const changeFocus = (f: string) => {
    setFocus(f);
    void client.service('setSettings', { focus_filter: f });
    onFocusChange(f);
  };

  const readThreshold = (): number | null => {
    const pawns = Number(threshold);
    if (!threshold.trim() || !Number.isFinite(pawns) || pawns <= 0) {
      setInvalid('Blunder size must be a positive number, e.g. 1.5');
      return null;
    }
    void client.service('setSettings', { threshold_pawns: pawns.toFixed(1) });
    return Math.round(pawns * 100);
  };

  const readPerRun = (): number | null => {
    const n = Number(perRun);
    if (!Number.isInteger(n) || n <= 0) {
      setInvalid('Games per run must be a whole number, e.g. 50');
      return null;
    }
    void client.service('setSettings', { games_per_run: String(n) });
    return n;
  };

  const importGames = () => {
    setInvalid(null);
    const name = username.trim();
    if (!name) { setInvalid('Enter your chess.com username.'); return; }
    const m = Number(months);
    if (!Number.isInteger(m) || m < 0) { setInvalid('Months must be a whole number (0 = all history).'); return; }
    void jobs.importGames(name, m);
  };

  const analyze = () => {
    setInvalid(null);
    const cp = readThreshold();
    const limit = readPerRun();
    if (cp !== null && limit !== null) void jobs.analyze(cp, limit, focus, parallel);
  };

  const regenerate = () => {
    setInvalid(null);
    const cp = readThreshold();
    if (cp !== null) void jobs.regenerate(cp, parallel);
  };

  const addLichess = async () => {
    setInvalid(null);
    const [low, high, count] = [Number(li.low), Number(li.high), Number(li.count)];
    if (![low, high, count].every(Number.isInteger) || low > high || count <= 0) {
      setInvalid('Enter a rating range (low to high) and how many puzzles.');
      return;
    }
    await client.service('setSettings', { lichess_min_rating: String(low), lichess_max_rating: String(high), lichess_count: String(count) });
    await jobs.addLichess(low, high, count);
  };

  const askRemove = async () => {
    const n = (await client.service('lichessSummary')).count;
    if (n) setConfirmRemove(n);
  };

  const busy = state.busy !== null;
  const progress = state.progress;
  const liDone = !state.lichess.busy && state.lichess.text.startsWith('Added ') && puzzleSource === MY_GAMES;
  return (
    <section>
      <h1>Import &amp; Analyze</h1>
      <p className="lede">Download games from chess.com, then let Stockfish find your mistakes. They become puzzles in Puzzle Review.</p>
      {invalid && <p className="error" role="alert">{invalid}</p>}
      <div className="import-cards">
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0, flex: 1 }}>Your games</h2>
            <label className="row"><span className="note">Focus</span>
              <select value={focus} onChange={(e) => changeFocus(e.target.value)}>
                {Object.keys(TIME_FILTERS).map((f) => <option key={f}>{f}</option>)}
              </select>
            </label>
          </div>
          <p className="note pre">{summaryText(summary)}</p>

          <label className="field"><span>Your chess.com username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <button type="button" className="btn wide secondary" onClick={importGames} disabled={busy}>Import games from chess.com</button>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="note">Import last</span>
            <input aria-label="Months to import" value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: 52 }} />
            <span className="note">months (0 = all history)</span>
          </div>

          <div className="section" style={{ marginTop: 16 }}>Find mistakes</div>
          <div className="settings">
            <span>Blunder size</span>
            <input aria-label="Blunder size" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            <span className="note">pawns lost</span>
            <span>Games per run</span>
            <input aria-label="Games per run" value={perRun} onChange={(e) => setPerRun(e.target.value)} />
            <span className="note">newest first</span>
          </div>
          {parallelEngines() > 1 && (
            <label className="check" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={parallel} onChange={(e) => {
                setParallel(e.target.checked);
                void client.service('setSettings', { parallel_engines: e.target.checked ? '1' : '0' });
              }} /> Use two engines side by side (faster; the computer runs warmer)
            </label>
          )}
          <button type="button" className="btn wide" style={{ marginTop: 12 }} onClick={analyze} disabled={busy}>Analyze new games</button>
          {progress && (
            <div className="job" aria-live="polite">
              {state.busy === 'analyze' && (
                <button type="button" className="btn wide secondary" onClick={() => jobs.stop()} disabled={!progress.stoppable}>Stop (keeps finished games)</button>
              )}
              {progress.max ? <progress value={progress.value} max={progress.max} /> : <progress />}
              <p className="note">{progress.text}</p>
            </div>
          )}
          {state.notice && (
            <div className={`notice ${state.notice.ok ? 'ok' : 'error'}`} role="status">
              <span>{state.notice.text}</span>
              {state.notice.offerAnalyze && <button type="button" className="btn small" onClick={() => { jobs.clearNotice(); analyze(); }}>Analyze them now</button>}
              <button type="button" className="btn ghost small" aria-label="Dismiss" onClick={() => jobs.clearNotice()}>×</button>
            </div>
          )}
          <button type="button" className="btn wide secondary" style={{ marginTop: 6 }} onClick={regenerate} disabled={busy}>Apply blunder size (instant)</button>
          <p className="note">Stockfish results are saved, so games are never analyzed twice.</p>
          {state.classify && <p className="note">{state.classify}</p>}
          <p className="note">Games are analyzed in your browser with a lighter Stockfish than the desktop app uses, so a few puzzles may differ.</p>
        </div>

        <div className="card">
          <h2>Lichess puzzles</h2>
          <p className="note">Free puzzles from the Lichess database, kept apart from your own: pick them with Puzzle Review's
            Puzzles dropdown. They earn XP but don't change your stats or weak spots.</p>
          <p>{liSummary}</p>
          <div className="row">
            <span>Rating</span>
            <input aria-label="Lowest rating" value={li.low} onChange={(e) => setLi({ ...li, low: e.target.value })} style={{ width: 64 }} />
            <span className="note">to</span>
            <input aria-label="Highest rating" value={li.high} onChange={(e) => setLi({ ...li, high: e.target.value })} style={{ width: 64 }} />
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span>How many</span>
            <input aria-label="How many puzzles" value={li.count} onChange={(e) => setLi({ ...li, count: e.target.value })} style={{ width: 74 }} />
            <span className="note">puzzles</span>
          </div>
          <button type="button" className="btn wide" style={{ marginTop: 12 }} onClick={() => void addLichess()} disabled={state.lichess.busy}>Add Lichess puzzles</button>
          {state.lichess.busy && <button type="button" className="btn wide secondary" style={{ marginTop: 6 }} onClick={() => jobs.stopLichess()}>Stop (keeps what's added)</button>}
          <p className="note" aria-live="polite">{state.lichess.text}{liDone ? " Choose Lichess in Puzzle Review's Puzzles dropdown." : ''}</p>
          {confirmRemove ? (
            <div className="notice" role="alertdialog" aria-label="Remove Lichess puzzles">
              <span>Remove all {confirmRemove.toLocaleString()} Lichess puzzles? Your XP from them is kept.</span>
              <button type="button" className="btn small" onClick={() => { setConfirmRemove(null); void jobs.removeLichess(); }}>Remove</button>
              <button type="button" className="btn secondary small" onClick={() => setConfirmRemove(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn wide secondary" onClick={() => void askRemove()} disabled={state.lichess.busy}>Remove all Lichess puzzles</button>
          )}
        </div>
      </div>
    </section>
  );
}
