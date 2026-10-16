/**
 * Progress (progress_tab.py, progress_views.py): is the training working?
 * Overview — rating over time against your goal, blunders per game, puzzle
 * practice per week; Themes — "seeing the board" skills and your puzzle themes,
 * weakest first (Practice, + Lichess); This week — your week in review, your
 * costliest mistakes, the pattern, and what to practise next.
 */
import { useCallback, useEffect, useState } from 'react';
import * as lichessPuzzles from '../../core/lichessPuzzles';
import type { DbClient } from '../../data/client';
import { TIME_CLASSES, type ThemeRowView, type WeekView } from '../../data/progressServices';
import type { Progress } from '../../core/progressData';
import { BarChart, LineChart } from '../Charts';

const VIEWS = ['Overview', 'Themes', 'This week'] as const;
const LICHESS_BATCH = 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-05' -> 'Oct 05' (strftime "%b %d") */
const label = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(8, 10)}`;
const rateColor = (r: number) => (r >= 0.7 ? 'var(--good)' : r >= 0.45 ? 'var(--gold)' : 'var(--bad)');

export interface ProgressActions {
  practiceTheme: (tag: string) => void;
  openPuzzle: (id: string) => void;
  reviewGame: (gameId: string, fen: string) => void;
  threats: () => void;
  tactics: () => void;
  analyze: () => void;
}

function Bar({ hits, total, rated }: { hits: number; total: number; rated: boolean }) {
  const rate = total ? hits / total : 0;
  return <span className="progress-bar"><span style={{ width: `${Math.round(rate * 100)}%`, background: rated && total ? rateColor(rate) : 'var(--line)' }} /></span>;
}

export function ProgressScreen({ client, actions }: { client: DbClient; actions: ProgressActions }) {
  const [view, setView] = useState<(typeof VIEWS)[number]>('Overview');
  const [tclass, setTclass] = useState<string | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [data, setData] = useState<(Progress & { goalText: string }) | null>(null);
  const [themes, setThemes] = useState<{ skills: { name: string; hits: number; total: number }[]; rows: ThemeRowView[] } | null>(null);
  const [week, setWeek] = useState<WeekView | null>(null);
  const [lichessStatus, setLichessStatus] = useState<Record<string, string>>({});
  const [busyTheme, setBusyTheme] = useState<string | null>(null);

  const loadOverview = useCallback(async (t: string | null, g: string | null) => {
    const d = await client.service('progressOverview', t, g);
    setData(d);
    setTclass(d.time_class);
    setGoal((cur) => cur ?? d.goalText);
  }, [client]);

  useEffect(() => {
    if (view === 'Overview') void loadOverview(tclass, goal);
    if (view === 'Themes') void client.service('progressThemes').then(setThemes);
    if (view === 'This week') void client.service('progressWeek').then(setWeek);
  }, [view]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** + Lichess: a batch of that theme's puzzles at your rating. */
  const addLichess = async (r: ThemeRowView) => {
    if (busyTheme) return;
    setBusyTheme(r.tag);
    setLichessStatus((s) => ({ ...s, [r.tag]: `Adding Lichess ${r.tag.toLowerCase()} puzzles…` }));
    try {
      const sum = await client.service('lichessSummary');
      const set = await client.service('getSettings', ['lichess_min_rating', 'lichess_max_rating']);
      const low = Number(set.lichess_min_rating) || sum.defaults[0];
      const high = Number(set.lichess_max_rating) || sum.defaults[1];
      const skip = new Set(await client.service('lichessIds'));
      const rows = await lichessPuzzles.packRows(low, high, `${import.meta.env.BASE_URL}lichess/`, fetch, r.lichessTheme);
      const saves: Promise<void>[] = [];
      const found = await lichessPuzzles.download(low, high, LICHESS_BATCH, skip, (b) => { saves.push(client.service('lichessSave', b)); }, () => false, rows,
        (f, scanned) => setLichessStatus((s) => ({ ...s, [r.tag]: `${f} found · ${scanned.toLocaleString()} Lichess puzzles checked…` })), 500, r.lichessTheme);
      await Promise.all(saves);
      setLichessStatus((s) => ({ ...s, [r.tag]: `Added ${found} — press Practice.` }));
    } catch (e) {
      setLichessStatus((s) => ({ ...s, [r.tag]: `Couldn't load the Lichess puzzles (${e instanceof Error ? e.message : e}).` }));
    }
    setBusyTheme(null);
  };

  const tiles = data ? [
    [data.current_rating ? String(data.current_rating) : '–', `current ${data.time_class.toLowerCase()} rating${data.current_rating ? ` (peak ${data.peak_rating})` : ''}`],
    [data.change_30_days !== null ? `${data.change_30_days >= 0 ? '+' : ''}${data.change_30_days}` : '–', 'last 30 days'],
    [data.to_goal !== null ? String(data.to_goal) : '–', data.goal ? `to go to ${data.goal}` : 'set a goal'],
    [`${data.puzzles_this_week.solved}/${data.puzzles_this_week.tried}`, 'puzzles solved this week'],
    [String(data.weak_spots), 'weak spots to fix'],
  ] : [];

  return (
    <section className="stats-screen">
      <div className="row stats-top">
        <h1 style={{ margin: 0 }}>Progress</h1>
        <div className="segmented" role="tablist" aria-label="View">
          {VIEWS.map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} aria-checked={view === v} onClick={() => setView(v)}>{v}</button>)}
        </div>
        <span style={{ flex: 1 }} />
        {view === 'Overview' && <>
          <span className="note">Goal</span>
          <input aria-label="Goal" value={goal ?? ''} style={{ width: 70 }} onChange={(e) => setGoal(e.target.value)}
            onBlur={() => void loadOverview(tclass, goal)} onKeyDown={(e) => { if (e.key === 'Enter') void loadOverview(tclass, goal); }} />
          <select aria-label="Time control" value={tclass ?? 'Rapid'} onChange={(e) => { setTclass(e.target.value); void loadOverview(e.target.value, goal); }}>
            {TIME_CLASSES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </>}
      </div>

      {view === 'Overview' && data && (
        <div className="stats-column">
          <div className="tiles">
            {tiles.map(([value, caption]) => (
              <div key={caption} className="card tile">
                <div className="stat-line" style={{ color: value.startsWith('+') ? 'var(--good)' : value.startsWith('-') ? 'var(--bad)' : undefined }}>{value}</div>
                <div className="note">{caption}</div>
              </div>
            ))}
          </div>
          <div className="card stats-card">
            <h2>Rating over time (weekly)</h2>
            <LineChart points={data.weekly_ratings.map(([d, r]) => [label(d), r])} goal={data.goal} empty={`No ${data.time_class.toLowerCase()} games yet`} />
          </div>
          <div className="two-charts">
            <div className="card stats-card">
              <h2>Blunders per game (weekly avg, analyzed games)</h2>
              <LineChart points={data.blunders_per_game_weekly.map(([d, v]) => [label(d), v])} color="var(--bad)" format={(v) => v.toFixed(1)}
                empty="Analyze more games to see this" height={150} />
            </div>
            <div className="card stats-card">
              <h2>Puzzle practice per week</h2>
              <BarChart bars={data.puzzle_weeks.map(([d, a, c]) => [label(d), a, c])} labels={['tried', 'solved']} empty="Solve some puzzles to see this" />
            </div>
          </div>
        </div>
      )}

      {view === 'Themes' && themes && (
        <div className="stats-column">
          <div className="card stats-card">
            <h2>Seeing the board</h2>
            <p className="note">From the Tactics &amp; Threats page: do you notice what's going on before you move?</p>
            {themes.skills.map((s) => (
              <div key={s.name} className="theme-row">
                <span className="theme-name">{s.name}</span>
                <Bar hits={s.hits} total={s.total} rated />
                <span className="theme-rate">{s.total ? `${Math.round((100 * s.hits) / s.total)}%  (${s.hits}/${s.total})` : 'not tried yet'}</span>
                <span className="theme-note" />
                <span className="theme-buttons">
                  <button type="button" className="btn small" onClick={s.name.includes('threat') ? actions.threats : actions.tactics}>Drill</button>
                </span>
              </div>
            ))}
          </div>
          <div className="card stats-card">
            <h2>Puzzle themes — weakest first</h2>
            <p className="note">Your first tries at puzzles, by tag (rated after 3 tries). Practice: every puzzle with that tag, unsolved first.
              + Lichess: add {LICHESS_BATCH} Lichess puzzles of that theme at your rating.</p>
            {!themes.rows.length && <p>Solve some puzzles in Puzzle Review to see your themes here.</p>}
            {themes.rows.map((r) => {
              const rated = r.tries >= 3;
              return (
                <div key={r.tag} className="theme-row">
                  <span className="theme-name">{r.tag}{r.yours ? '  (your tag)' : ''}</span>
                  <Bar hits={r.solved} total={r.tries} rated={rated} />
                  <span className="theme-rate">{r.tries ? `${Math.round((100 * r.solved) / r.tries)}%  (${r.solved}/${r.tries})${rated ? '' : ' · too few'}` : 'not tried yet'}</span>
                  <span className="theme-note note">{lichessStatus[r.tag] ?? (r.recentTries ? `30 days: ${r.recentSolved}/${r.recentTries}` : '')}</span>
                  <span className="theme-buttons">
                    <button type="button" className="btn small" onClick={() => actions.practiceTheme(r.tag)}>Practice</button>
                    {r.lichessTheme && <button type="button" className="btn secondary small" disabled={!!busyTheme} onClick={() => void addLichess(r)}>+ Lichess</button>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'This week' && week && (
        <div className="stats-column">
          <div className="card stats-card">
            <h2>Your week: {label(week.start)} – {label(week.end)}</h2>
            <div className="tiles">
              {[
                [String(week.games), `games · ${week.wins} won, ${week.losses} lost, ${week.draws} drawn`],
                [week.rating_from !== null ? `${week.rating_to} (${week.rating_to! - week.rating_from >= 0 ? '+' : ''}${week.rating_to! - week.rating_from})` : '–',
                  week.rating_class ? `${week.rating_class.toLowerCase()} rating` : 'rating'],
                [String(week.mistake_count), `mistakes in ${week.analyzed} analyzed game(s)`],
                [`${week.puzzles_solved}/${week.puzzles_tried}`, `puzzles solved · plus ${week.spot_rounds} tactic, ${week.threat_rounds} threat rounds${week.lines_drilled ? `, ${week.lines_drilled} lines` : ''}`],
              ].map(([v, c]) => <div key={c} className="card tile"><div className="stat-line">{v}</div><div className="note">{c}</div></div>)}
            </div>
            {!week.games && <p>No games in the last 7 days — import your latest games on Import &amp; Analyze.</p>}
          </div>
          {week.mistakes.length > 0 && (
            <div className="card stats-card">
              <h2>Your costliest mistakes</h2>
              <p className="note">The moves that threw away the most of your winning chances (going from winning to losing counts most; a blunder when already lost hardly counts).
                Puzzle: try the position again. Review: see it in the game.</p>
              {week.mistakes.map((m) => (
                <div key={m.puzzleId} className="mistake-row">
                  <div><div>{m.text}</div><div className="note">{m.note}</div></div>
                  <span className="theme-buttons">
                    <button type="button" className="btn small" onClick={() => actions.openPuzzle(m.puzzleId)}>Puzzle</button>
                    <button type="button" className="btn secondary small" onClick={() => actions.reviewGame(m.gameId, m.fen)}>Review</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {week.mistake_count > 0 && (
            <div className="card stats-card">
              <h2>The pattern</h2>
              <p className="pre">{[
                `${week.facing_threat} of your ${week.mistake_count} mistakes (${Math.round((100 * week.facing_threat) / week.mistake_count)}%) came when your opponent had a threat (Defensive / Counterattack puzzles).`,
                ...(week.common_type ? [`Most common: ${week.common_type} (${week.common_type_count}).`] : []),
                ...(week.endgame ? [`${week.endgame} in the endgame.`] : []),
              ].join('\n')}</p>
            </div>
          )}
          <div className="card stats-card">
            <h2>What to practise next</h2>
            {week.suggestions.map((s) => {
              const [text, run] = ({
                threats: ['Drill threats', actions.threats],
                tactics: ['Spot the Tactic', actions.tactics],
                analyze: ['Import & Analyze', actions.analyze],
                theme: ['Practice', () => actions.practiceTheme(s.arg)],
              } as Record<string, [string, () => void]>)[s.action];
              return (
                <div key={s.text} className="mistake-row">
                  <div>{s.text}</div>
                  <span className="theme-buttons"><button type="button" className="btn small" onClick={run}>{text}</button></span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
