/**
 * Stats → Weaknesses: the twelve weakness statistics (SPEC.md, from
 * ~/WeaknessStats) for one time control, the ranked weaknesses with example
 * positions from your games, and a training plan built from them. The games
 * are analysed here at the stats' own fixed engine setting (jobs.analyzeWeak);
 * every number shows its sample size and its state (Early read / Counts only /
 * Not enough data).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { DbClient } from '../../data/client';
import { clockLabel } from '../../core/models';
import type { WindowKey } from '../../data/weakServices';
import type { Example, State } from '../../core/weak/stats';
import { PRACTICE_LABEL, type Practice } from '../../core/weak/training';
import { Board } from '../Board';
import type { Jobs } from '../jobs';
import { SplitBar, StatCard, StateBadge, TrendSpark, WeaknessRow, fmt, plural } from '../StatParts';

const loadReport = (client: DbClient, tc: string, w: WindowKey) => client.service('weakReport', tc, w);
type ReportView = Awaited<ReturnType<typeof loadReport>>;

const VIEWS = ['Overview', 'Training plan', 'Splits', 'How it works'] as const;
type View = (typeof VIEWS)[number];

const SEG_FILTER: Record<string, (e: Example) => boolean> = {
  Opening: (e) => e.phase === 'opening', Middlegame: (e) => e.phase === 'middlegame', Endgame: (e) => e.phase === 'endgame',
  'As White': (e) => e.colour === 'white', 'As Black': (e) => e.colour === 'black',
};

type V = Record<string, number | null> | null;
const val = (p: { value: unknown }) => (p.value ?? null) as V;

export function WeaknessesPage({ client, jobs, onReview, onPractice }: {
  client: DbClient;
  jobs: Jobs;
  onReview: (gameId: string, fen: string) => void;
  onPractice: (action: Practice) => void;
}) {
  const jobsState = useSyncExternalStore(useCallback((l: () => void) => jobs.subscribe(l), [jobs]), () => jobs.state);
  const [tcs, setTcs] = useState<{ list: { time_control: string; games: number; analysed: number }[]; current: string | null } | null>(null);
  const [tc, setTc] = useState<string | null>(null);
  const [win, setWin] = useState<WindowKey>('last50');
  const [view, setView] = useState<View>('Overview');
  const [data, setData] = useState<ReportView | null>(null);
  const [count, setCount] = useState(50);
  const [exKind, setExKind] = useState<'material' | 'opportunism'>('material');
  const [exFilter, setExFilter] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void client.service('weakTimeControls').then((t) => { setTcs(t); setTc((c) => c ?? t.current); });
  }, [client, jobsState.weakVersion]);

  useEffect(() => {
    if (!tc) return;
    void loadReport(client, tc, win).then(setData);
  }, [client, tc, win, jobsState.weakVersion]);

  const chooseTc = (t: string) => {
    setTc(t);
    setExFilter(null);
    void client.service('weakSetTimeControl', t);
  };

  const busy = jobsState.busy === 'weak';
  const otherBusy = jobsState.busy !== null && !busy;
  const current = tcs?.list.find((t) => t.time_control === tc);
  const left = current ? current.games - current.analysed : 0;

  const controls = (
    <div className="weak-controls">
      <label className="note" htmlFor="weak-tc">Time control</label>
      <select id="weak-tc" value={tc ?? ''} onChange={(e) => chooseTc(e.target.value)} disabled={busy}>
        {(tcs?.list ?? []).slice(0, 12).map((t) => <option key={t.time_control} value={t.time_control}>{`${clockLabel(t.time_control)} · ${t.analysed}/${t.games} analysed`}</option>)}
      </select>
      <div className="segmented" role="tablist" aria-label="Games in the report">
        {(['last50', 'all'] as const).map((w) => <button key={w} type="button" role="tab" aria-checked={win === w} onClick={() => setWin(w)}>
          {w === 'last50' ? 'Last 50 games' : 'All analysed'}</button>)}
      </div>
      <span style={{ flex: 1 }} />
      {busy && jobsState.progress ? (
        <span className="weak-job">
          <span className="note">{jobsState.progress.text}</span>
          <progress value={jobsState.progress.value} max={jobsState.progress.max ?? undefined} />
          {jobsState.progress.stoppable && <button type="button" className="btn secondary small" onClick={() => jobs.stop()}>Stop</button>}
        </span>
      ) : left > 0 && tc ? (
        <span className="weak-job">
          <select aria-label="Games to analyse" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} games</option>)}
          </select>
          <button type="button" className="btn small" disabled={otherBusy} title={otherBusy ? 'Wait for the other analysis to finish' : undefined}
            onClick={() => void jobs.analyzeWeak(tc, count)}>Analyse {Math.min(count, left)} more</button>
        </span>
      ) : null}
    </div>
  );

  if (!tcs) return <p className="note">Looking at your games…</p>;
  if (!tcs.list.length) return <p className="note">Import your games on Import &amp; Analyze first.</p>;
  if (!data || !tc) return <>{controls}<p className="note">Working it out…</p></>;

  const R = data.report;
  const w = R.window;
  if (!w.n_games) {
    return (
      <>
        {controls}
        <div className="stat-card weak-empty">
          <h2>No games analysed for {clockLabel(tc)} yet</h2>
          <p className="note">Each game is searched move by move — both sides — so the stats can see your mistakes, your opponent's,
            and what you did with them. About 15–30 seconds a game on this computer; it runs in the background and you can stop any time.</p>
          <div className="row">
            <button type="button" className="btn" disabled={busy || otherBusy} onClick={() => void jobs.analyzeWeak(tc, count)}>
              Analyse my last {Math.min(count, current?.games ?? count)} {clockLabel(tc)} games</button>
          </div>
        </div>
      </>
    );
  }

  const dates = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const early = w.state === 'provisional';

  return (
    <div className="weak-page">
      {controls}
      <p className="note">
        {clockLabel(tc)} · {plural(w.n_games, 'game')}, {dates(w.from)} – {dates(w.to)} · {data.config.engine}, {data.config.limit}
        {data.unchecked ? ` · ${data.unchecked} example positions still to re-check` : ''}
        {early && <> · <StateBadge state="provisional" /> fewer than 30 games: expect these numbers to move</>}
      </p>
      {notice && (
        <div className={`notice ${notice.ok ? 'ok' : 'error'}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className="btn ghost small" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      <div className="segmented weak-views" role="tablist" aria-label="Weaknesses view">
        {VIEWS.map((v) => <button key={v} type="button" role="tab" aria-checked={view === v} onClick={() => setView(v)}>{v}</button>)}
      </div>
      {view === 'Overview' && <Overview R={R} exKind={exKind} setExKind={setExKind} exFilter={exFilter} setExFilter={setExFilter} onReview={onReview} />}
      {view === 'Training plan' && <TrainingPlan data={data} onPractice={onPractice} onTrack={async (key) => {
        setNotice(await client.service('weakTrack', tc, key));
        setData(await loadReport(client, tc, win));
      }} onStop={async (id) => { await client.service('weakUntrack', id); setData(await loadReport(client, tc, win)); }} />}
      {view === 'Splits' && <Splits R={R} />}
      {view === 'How it works' && <Method data={data} />}
    </div>
  );
}

type R = ReportView['report'];

function Overview({ R, exKind, setExKind, exFilter, setExFilter, onReview }: {
  R: R; exKind: 'material' | 'opportunism'; setExKind: (k: 'material' | 'opportunism') => void;
  exFilter: string | null; setExFilter: (f: string | null) => void; onReview: (gameId: string, fen: string) => void;
}) {
  const q = val(R.blunder_mistake_rate);
  const ac = val(R.accuracy);
  const cp = val(R.acpl);
  const wm = val(R.worst_move);
  const cs = R.colour_split as Record<string, { value: V }>;
  const colourSub = (key: string) => (cs.white.value?.[key] != null && cs.black.value?.[key] != null
    ? ` · White ${fmt(cs.white.value[key])} · Black ${fmt(cs.black.value[key])}` : '');
  const top = R.weaknesses.filter((r) => r.expected_points_cost_per_game > 0).slice(0, 3);
  const kinds = { material: R.material, opportunism: R.opportunism } as const;
  const shownOf = (k: 'material' | 'opportunism') => ((kinds[k].examples as Example[] | undefined) ?? []).filter((e) => e.verified !== false);
  let list = shownOf(exKind);
  if (exFilter && SEG_FILTER[exFilter]) list = list.filter(SEG_FILTER[exFilter]);
  const accuracyTrend = R.per_game.filter((g) => g.accuracy !== null).map((g) => ({ date: g.date, value: g.accuracy! }));
  return (
    <>
      <section className="weak-section">
        <div className="weak-head"><h2>How you play</h2><p className="note">Your own moves only. Book moves, forced moves and already-decided positions are left out.</p></div>
        <div className="stat-grid">
          <StatCard title="Accuracy" state={R.accuracy.state} headline={fmt(ac?.mean_game_accuracy)} unit="per game" wide
            games={R.accuracy.n_games} moves={R.accuracy.n_moves_included}
            sub={<>Average per-move accuracy {fmt(ac?.mean_move_accuracy)}. This app's own game formula: not comparable with Lichess or Chess.com.</>}>
            {R.accuracy.state !== 'suppressed' && <TrendSpark points={accuracyTrend} label="Accuracy, rolling 10-game mean" />}
          </StatCard>
          <StatCard title="Worst move per game" state={R.worst_move.state} headline={fmt(wm?.pct_games_max_ge_20, 0)} unit="% of games"
            games={R.worst_move.n_games} moves={R.worst_move.n_moves_included}
            sub={<>had at least one blunder. Your typical worst move gives away {fmt(wm?.mean_max_wpl)} win% points (1 game in 10: {fmt(wm?.p90_max_wpl)}+).</>} />
          <StatCard title="ACPL (capped)" state={R.acpl.state} headline={fmt(cp?.acpl_capped)} unit="centipawns"
            games={R.acpl.n_games} moves={R.acpl.n_moves_included}
            sub={<>Median {fmt(cp?.median_cpl)}. {plural(R.acpl.n_mate_moves, 'move')} near a forced mate left out.</>} />
          <StatCard title="Blunders" state={R.blunder_mistake_rate.state} headline={fmt(q?.blunder_per100)} unit="per 100 moves"
            games={R.blunder_mistake_rate.n_games} moves={R.blunder_mistake_rate.n_moves_included}
            hidden={`${plural(q?.blunders ?? 0, 'blunder')} so far. Fewer than 10 games, so no rate is shown.`}
            sub={<>{fmt(q?.blunder_per_game, 2)} per game{colourSub('blunder_per100')}</>} />
          <StatCard title="Mistakes" state={R.blunder_mistake_rate.state} headline={fmt(q?.mistake_per100)} unit="per 100 moves"
            games={R.blunder_mistake_rate.n_games} moves={R.blunder_mistake_rate.n_moves_included}
            hidden={`${plural(q?.mistakes ?? 0, 'mistake')} so far. Fewer than 10 games, so no rate is shown.`}
            sub={<>{fmt(q?.mistake_per_game, 2)} per game{colourSub('mistake_per100')}</>} />
        </div>
      </section>

      <section className="weak-section">
        <div className="weak-head"><h2>Your top weaknesses</h2>
          <p className="note">Ranked by the points each one costs you per game, beyond your usual error rate. Pick one to see its positions below.</p></div>
        <div className="weak-list">
          {top.length ? top.map((r, i) => (
            <WeaknessRow key={r.segment} rank={i + 1} segment={r.segment} cost={r.expected_points_cost_per_game}
              selected={exFilter === r.segment} onClick={() => setExFilter(exFilter === r.segment ? null : r.segment)}
              detail={`${fmt(r.big_error_per100)} mistakes + blunders per 100 moves vs your ${fmt(r.overall_big_error_per100)} overall · ${plural(r.n_games, 'game')}, ${r.n_moves} moves${r.state === 'provisional' ? ' · early read' : ''}`} />
          )) : <p className="note">No area stands out yet. Each one needs at least 10 games.</p>}
        </div>
      </section>

      <section className="weak-section">
        <div className="weak-head"><h2>Positions to look at</h2>
          <p className="note">{exKind === 'material' ? 'Your mistakes where the engine\'s line wins material from you straight away (engine-flagged).'
            : 'Your opponent gave away 10+ points and your reply let most of it go.'}</p></div>
        <div className="row">
          {(['material', 'opportunism'] as const).map((k) => (
            <button key={k} type="button" className="chip weak-chip" aria-pressed={exKind === k} onClick={() => setExKind(k)}>
              {k === 'material' ? 'Pieces left hanging' : 'Missed chances'} · {shownOf(k).length}</button>
          ))}
          {exFilter && <button type="button" className="chip weak-chip" aria-pressed="true" onClick={() => setExFilter(null)}>{exFilter} ✕</button>}
        </div>
        {list.length ? (
          <div className="weak-examples">
            {list.slice(0, 12).map((e) => <ExampleCard key={`${e.game_id}-${e.ply}`} e={e} kind={exKind} onReview={onReview} />)}
          </div>
        ) : <p className="note">No positions in this group{exFilter ? ' for this filter' : ''} yet.</p>}
      </section>
    </>
  );
}

function ExampleCard({ e, kind, onReview }: { e: Example; kind: 'material' | 'opportunism'; onReview: (gameId: string, fen: string) => void }) {
  return (
    <article className="weak-example">
      <div className="weak-thumb"><Board fen={e.fen} orientation={e.colour} lastMove={null} arrows={[
        { from: e.played_uci.slice(0, 2), to: e.played_uci.slice(2, 4), brush: 'red' },
        ...(e.best_uci ? [{ from: e.best_uci.slice(0, 2), to: e.best_uci.slice(2, 4), brush: 'green' as const }] : []),
      ]} /></div>
      <div className="weak-move">{e.move_number}{e.colour === 'white' ? '.' : '…'} <span className="bad">{e.played}</span>
        {e.best && <span className="best"> · best {e.best}</span>}</div>
      {kind === 'opportunism' && <div className="stat-n">Opponent's mistake: {e.opponent_move} (−{fmt(e.opponent_wpl ?? null)} pts)</div>}
      <div className="stat-n">Engine win% {fmt(e.engine_win_pct_before, 0)} → {fmt(e.engine_win_pct_after, 0)} · {e.phase}
        {e.verified && <> · <span className="state-badge checked" title="Re-searched at the same depth">Re-checked</span></>}</div>
      <button type="button" className="btn secondary small" onClick={() => onReview(e.game_id, e.fen)}>Review this move</button>
    </article>
  );
}

function TrainingPlan({ data, onPractice, onTrack, onStop }: {
  data: ReportView; onPractice: (a: Practice) => void; onTrack: (key: string) => void; onStop: (id: number) => void;
}) {
  const trackedKeys = new Set(data.tracked.map((t) => t.focus_key));
  return (
    <>
      <section className="weak-section">
        <div className="weak-head"><h2>What to work on</h2>
          <p className="note">From your last 50 games: the areas and habits that cost you the most points, each with practice in this app.</p></div>
        {data.focuses.length ? (
          <div className="weak-plan">
            {data.focuses.map((f, i) => (
              <article key={f.key} className="stat-card weak-focus">
                <div className="stat-title"><span>Focus {i + 1}</span><span className="state-badge worse">−{f.pointsPerGame.toFixed(2)} points per game</span></div>
                <h3>{f.title}</h3>
                <p className="weak-why">{f.why}</p>
                <p className="weak-tip"><b>In your games:</b> {f.tip}</p>
                <div className="weak-drills">
                  {f.drills.map((d) => (
                    <div key={d.action} className="weak-drill">
                      <button type="button" className="btn small" onClick={() => onPractice(d.action)}>{PRACTICE_LABEL[d.action]}</button>
                      <span className="stat-n">{d.why}</span>
                    </div>
                  ))}
                </div>
                <div className="row weak-track">
                  <span className="stat-n">Tracked number: {f.metric}, now {fmt(f.value)}{f.unit === '%' ? '%' : ` ${f.unit}`} ({f.n} {f.key === 'conversion' || f.key === 'opportunism' ? 'chances' : 'moves'})</span>
                  {trackedKeys.has(f.key)
                    ? <span className="state-badge checked">Tracking</span>
                    : <button type="button" className="btn secondary small" onClick={() => onTrack(f.key)}>Track my progress</button>}
                </div>
              </article>
            ))}
          </div>
        ) : <p className="note">Nothing stands out enough to build a plan yet. Analyse more games — a focus needs 30+ moves or chances behind it.</p>}
      </section>

      <section className="weak-section">
        <div className="weak-head"><h2>Progress</h2>
          <p className="note">A tracked focus is measured again on new games only, once you've played 30 more and two weeks have passed.
            Changes smaller than the noise in the numbers count as "no clear change".</p></div>
        {data.tracked.length ? data.tracked.map((t) => {
          const r = t.result;
          return (
            <article key={t.id} className="stat-card weak-progress">
              <div className="stat-title"><span>{t.title}</span>
                {r.status === 'ready' && <span className={`state-badge ${r.verdict === 'better' ? 'better' : r.verdict === 'worse' ? 'worse' : 'same'}`}>
                  {r.verdict === 'better' ? 'Improved' : r.verdict === 'worse' ? 'Slipped' : 'No clear change'}</span>}</div>
              <div className="stat-sub">{t.metric}: {fmt(t.baseline_value)} at the start ({new Date(t.created_at).toLocaleDateString()}, {t.baseline_n} moves or chances in {t.baseline_games} games)</div>
              {r.status === 'collecting' ? (
                <>
                  <div className="weak-meter"><div style={{ width: `${Math.min(100, (100 * r.newGames) / r.needGames)}%` }} /></div>
                  <div className="stat-n">{r.newGames} of {r.needGames} new games analysed · ready from {new Date(r.readyFrom).toLocaleDateString()}</div>
                </>
              ) : (
                <div className="stat-sub">Now {fmt(r.value)} on {plural(r.games, 'new game')} ({r.n} moves or chances): {r.delta >= 0 ? '+' : ''}{fmt(r.delta)} (noise ±{fmt(r.band)}).</div>
              )}
              <div className="row"><button type="button" className="btn ghost small" onClick={() => onStop(t.id)}>Stop tracking</button></div>
            </article>
          );
        }) : <p className="note">Nothing tracked yet. Pick a focus above and choose "Track my progress".</p>}
      </section>
    </>
  );
}

function Splits({ R }: { R: R }) {
  const ps = R.phase_split as Record<string, { value: V; n_games: number; state: State }>;
  const cs = R.colour_split as Record<string, { value: V; n_games: number; state: State }> & { gap_black_minus_white: V };
  const q = val(R.blunder_mistake_rate);
  const phRows = (key: string) => (['opening', 'middlegame', 'endgame'] as const).map((ph) => ({
    label: ph[0].toUpperCase() + ph.slice(1), value: ps[ph].value?.[key] ?? null, games: ps[ph].n_games,
    why: ps[ph].state === 'suppressed' ? 'under 10 games' : undefined,
  }));
  const coRows = (key: string) => (['white', 'black'] as const).map((c) => ({
    label: c === 'white' ? 'As White' : 'As Black', value: cs[c].value?.[key] ?? null, games: cs[c].n_games,
    why: cs[c].state === 'suppressed' ? 'under 10 games' : undefined,
  }));
  const gap = cs.gap_black_minus_white;
  const op = R.openings;
  const rows = (op.value ?? []).filter((r) => r.shown);
  const cv = val(R.conversion);
  const rs = val(R.rescue);
  const oppo = val(R.opportunism);
  const mat = val(R.material);
  const ck = R.clock as typeof R.clock & { has_clock?: boolean; uplift_moves?: { under_30s: number; over_60s: number } };
  const ckv = ck.value as { uplift: number | null; buckets: { bucket: string; blunder_per100: number | null; n_games: number }[];
    median_elapsed_s: Record<string, number | null>; pct_games_low_time_lost: number | null } | null;
  return (
    <>
      <section className="weak-section">
        <div className="weak-head"><h2>By game phase</h2><p className="note">Red bars are above your own overall rate (the black tick).</p></div>
        <div className="stat-grid">
          <article className="stat-card"><div className="stat-title"><span>Blunders per 100 moves</span></div><SplitBar rows={phRows('blunder_per100')} overall={q?.blunder_per100} unit="/100" /></article>
          <article className="stat-card"><div className="stat-title"><span>Mistakes per 100 moves</span></div><SplitBar rows={phRows('mistake_per100')} overall={q?.mistake_per100} unit="/100" /></article>
          <article className="stat-card"><div className="stat-title"><span>ACPL (capped)</span></div><SplitBar rows={phRows('acpl')} overall={val(R.acpl)?.acpl_capped} unit="cp" /></article>
        </div>
      </section>
      <section className="weak-section">
        <div className="weak-head"><h2>By colour</h2><p className="note">{gap && gap.blunder_per100 != null && gap.score_pct != null
          ? `As Black you blunder ${fmt(Math.abs(gap.blunder_per100))} ${gap.blunder_per100 >= 0 ? 'more' : 'fewer'} times per 100 moves and score ${fmt(Math.abs(gap.score_pct), 0)} points ${gap.score_pct >= 0 ? 'more' : 'less'} than as White.`
          : 'The colour gap appears once both colours have 10+ games.'}</p></div>
        <div className="stat-grid">
          <article className="stat-card"><div className="stat-title"><span>Blunders per 100 moves</span></div><SplitBar rows={coRows('blunder_per100')} overall={q?.blunder_per100} unit="/100" /></article>
          <article className="stat-card"><div className="stat-title"><span>ACPL (capped)</span></div><SplitBar rows={coRows('acpl')} overall={val(R.acpl)?.acpl_capped} unit="cp" /></article>
          <article className="stat-card"><div className="stat-title"><span>Score</span></div><SplitBar rows={coRows('score_pct')} unit="%" digits={0} /></article>
        </div>
      </section>
      <section className="weak-section">
        <div className="weak-head"><h2>Openings</h2><p className="note">Opening families you've played 20+ times with one colour. "Leaving book" is the engine's
          view when the game leaves the Lichess opening list, from your side (+ is good for you). No opening is marked strong or weak: results alone don't account for who you played.</p></div>
        {rows.length ? (
          <div className="data-table weak-openings">
            <table>
              <thead><tr><th className="wide">Opening</th><th>Colour</th><th>Games</th><th>W / D / L</th><th>Score</th><th>Leaving book</th><th>Engine win%</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={`${r.name}${r.colour}`}>
                  <td className="wide">{r.name} <span className="stat-n">{r.eco}</span></td><td>{r.colour === 'white' ? 'White' : 'Black'}</td><td>{r.n_games}</td>
                  <td><span className="wdl" title={`${r.wins} wins, ${r.draws} draws, ${r.losses} losses`}>
                    <i className="w" style={{ width: `${(100 * r.wins!) / r.n_games}%` }} /><i className="d" style={{ width: `${(100 * r.draws!) / r.n_games}%` }} />
                    <i className="l" style={{ width: `${(100 * r.losses!) / r.n_games}%` }} /></span> {r.wins}/{r.draws}/{r.losses}</td>
                  <td>{fmt(r.score_pct, 0)}%</td><td>{r.exit_cp == null ? '—' : `${r.exit_cp >= 0 ? '+' : '−'}${(Math.abs(r.exit_cp) / 100).toFixed(2)}`}</td>
                  <td>{fmt(r.exit_engine_win_pct, 0)}%</td>
                </tr>))}</tbody>
            </table>
          </div>
        ) : <p className="note">No opening family has 20 games with one colour in this window yet.</p>}
        <p className="stat-n">{String(op.hidden_cells)} opening/colour pairs with fewer than 20 games are hidden.</p>
      </section>
      <section className="weak-section">
        <div className="weak-head"><h2>Turning points</h2><p className="note">Counted from the engine's view of the position during the game, never from the final result.</p></div>
        <div className="stat-grid">
          <StatCard title="Finishing won games" state={R.conversion.state} headline={fmt(cv?.rate_pct, 0)} unit="% won" games={R.conversion.n_games}
            hidden={`${cv?.converted ?? 0} of ${plural(cv?.opportunities ?? 0, 'winning position')} won. Fewer than 10, so no rate is shown.`}
            sub={<>{cv?.converted} of {plural(cv?.opportunities ?? 0, 'game')} where you reached 80% engine win%. {cv?.win_to_draw} drawn, {cv?.win_to_loss} lost: {fmt(cv?.thrown_points)} points thrown away.</>} />
          <StatCard title="Saving bad positions" state={R.rescue.state} headline={fmt(rs?.rate_pct, 0)} unit="% saved" games={R.rescue.n_games}
            hidden={`${rs?.rescued ?? 0} of ${plural(rs?.opportunities ?? 0, 'bad position')} saved. Fewer than 10, so no rate is shown.`}
            sub={<>{rs?.rescued} of {plural(rs?.opportunities ?? 0, 'game')} where you fell to 20% engine win% ended in a draw or win: {fmt(rs?.points_saved)} points saved.</>} />
          <StatCard title="Punishing mistakes" state={R.opportunism.state} headline={fmt(oppo?.punished_pct, 0)} unit="% punished" games={R.opportunism.n_games}
            hidden={`${oppo?.opportunities ?? 0} opponent mistakes so far. Fewer than 10 games, so no rate is shown.`}
            sub={<>Partly {fmt(oppo?.partial_pct, 0)}% · missed {fmt(oppo?.missed_pct, 0)}% of {oppo?.opportunities} times your opponent gave away 10+ points. Missed mates in 5 or fewer: {oppo?.missed_mates}.</>}>
            {oppo?.punished_pct != null && (
              <div className="stack3" role="img" aria-label={`${fmt(oppo.punished_pct, 0)}% punished, ${fmt(oppo.partial_pct, 0)}% partly, ${fmt(oppo.missed_pct, 0)}% missed`}>
                <i className="p" style={{ width: `${oppo.punished_pct}%` }} /><i className="pa" style={{ width: `${oppo.partial_pct}%` }} /><i className="m" style={{ width: `${oppo.missed_pct}%` }} />
              </div>
            )}
          </StatCard>
          <StatCard title="Pieces left hanging" state={R.material.state} headline={fmt(mat?.share_of_big_errors_pct, 0)} unit="% of big errors" games={R.material.n_games}
            moves={R.material.n_moves_included}
            hidden={`${mat?.flagged ?? 0} of ${mat?.big_errors ?? 0} big errors engine-flagged. Fewer than 10 games, so no share is shown.`}
            sub={<>{mat?.flagged} of your {mat?.big_errors} mistakes and blunders were engine-flagged material losses ({fmt(mat?.per100)} per 100 moves).</>} />
          {ck.has_clock && (ck.state === 'insufficient_data' || !ckv ? (
            <StatCard title="Clock" state="insufficient_data" headline="" wide games={ck.n_games}
              hidden={`Not enough timed moves yet: the comparison needs 30+ moves both under 30 seconds (${ck.uplift_moves?.under_30s ?? 0} so far) and over 60 seconds (${ck.uplift_moves?.over_60s ?? 0}), with at least one blunder when you had time.`} />
          ) : (
            <StatCard title="Clock" state={ck.state} headline={`${fmt(ckv.uplift, 1)}×`} unit="blunder rate under 30s vs over 60s" wide games={ck.n_games} moves={ck.n_moves_included}
              sub={<>Typical think time: opening {fmt(ckv.median_elapsed_s.opening)}s · middlegame {fmt(ckv.median_elapsed_s.middlegame)}s · endgame {fmt(ckv.median_elapsed_s.endgame)}s.
                {' '}{fmt(ckv.pct_games_low_time_lost, 0)}% of games ended with under 5% of your time in a lost position.</>}>
              <SplitBar rows={ckv.buckets.map((b) => ({ label: `${b.bucket} left`, value: b.blunder_per100, games: b.n_games, why: 'under 10 games' }))} unit="/100" />
            </StatCard>
          ))}
        </div>
      </section>
    </>
  );
}

function Method({ data }: { data: ReportView }) {
  const c = data.config;
  return (
    <section className="weak-section weak-method">
      <h2>How these numbers are made</h2>
      <dl>
        <dt>Engine</dt><dd>{c.engine}, {c.limit}, {c.hash_mb} MB hash ({c.hash}). Every position gets the same search.</dd>
        <dt>Setting ID</dt><dd>{c.id} (spec {c.spec_version}). A new setting means analysing the games again; settings are never mixed.</dd>
        <dt>Games</dt><dd>One time control at a time: they're never mixed.</dd>
        <dt>Openings</dt><dd>Lichess's opening list (CC0). Positions deep inside it aren't searched: no number uses them.</dd>
      </dl>
      <h3>Win% and move grades</h3>
      <p>Each engine score becomes an engine win% with Lichess's published curve, 100 / (1 + e<sup>−0.00368208 × cp</sup>), using scores capped at ±10 pawns.
        A move is graded by how much engine win% it gave away: under 2 points Excellent, 2–5 Good, 5–10 Inaccuracy, 10–20 Mistake, 20 or more Blunder.
        Raw centipawns never decide a grade.</p>
      <h3>Accuracy</h3>
      <p>Per-move accuracy uses Lichess's published formula. The game figure is this app's own — the average of the harmonic and ordinary means of
        your move accuracies — so it isn't comparable with Lichess's or Chess.com's.</p>
      <h3>What's left out</h3>
      <ul>
        <li>Book moves: moves that stay inside the opening list.</li>
        <li>Forced moves: the only legal move.</li>
        <li>Decided positions: one side's engine win% was 97% or more both before and after the move.</li>
        <li>Moves near a forced mate are left out of ACPL only; they're still graded by win%.</li>
      </ul>
      <h3>How sure each number is</h3>
      <ul>
        <li>Under 30 games: <StateBadge state="provisional" />.</li>
        <li>Under 10 games in a group: counts only, no percentage.</li>
        <li>Openings need 20 games with one colour.</li>
        <li>Example positions are re-searched at the same depth before they're shown.</li>
        <li>Differences under about 20 centipawns between consecutive moves are mostly engine noise.</li>
      </ul>
    </section>
  );
}
