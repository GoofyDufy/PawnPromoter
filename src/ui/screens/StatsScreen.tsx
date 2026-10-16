/**
 * Stats (stats_tab.py): three pages of tables that point at your weaknesses —
 * Overview (results by opening, how you lose, accuracy by phase, blunders vs
 * time left), Playing style (your style, tactical indicators, results by game
 * type, your openings' character, openings that fit your style) and
 * Repertoire (where your games leave your prep, popular Lichess moves your
 * prep doesn't answer, lines you face most). Recomputed when shown.
 */
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { TIME_FILTERS } from '../../core/models';
import type { DbClient } from '../../data/client';
import type { Table } from '../../data/statsServices';
import type { Improvement } from '../../core/improvement';
import { LineChart, MultiLineChart } from '../Charts';
import { DataTable } from '../DataTable';
import { Modal } from '../Modal';
import type { OpeningData } from '../openingData';

const PAGES = ['Overview', 'Playing style', 'Improvement', 'Repertoire'] as const;
const AREA_COLORS: Record<string, string> = { Openings: '#5B8DEF', Middlegame: '#E6A94A', Endgame: '#4FB3A5', Tactics: '#E8735E' };
const ALL_FIRST_MOVES = 'All first moves';
const GAPS_FROM_GAMES = 'Gaps in your games';
const GAPS_FROM_LICHESS = 'Popular on Lichess';

type Overview = { summary: string; openings: Table; losses: Table; phases: Table; clock: Table };
type StyleView = { verdict: string; note: string; indicators: Table; gameTypes: Table; character: Table; recommend: Table };
type RepView = { note: string; firstMoves: [string, number][]; gaps: Table; common: Table };

function Section({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <div className="card stats-card">
      <h2>{title}</h2>
      <p className="note">{help}</p>
      {children}
    </div>
  );
}

export type PracticeAction = Improvement['practice'][number]['action'];

export function StatsScreen({ client, openingData, onReview, onDrill, onRepertoireChanged, onPractice }: {
  client: DbClient;
  openingData: OpeningData;
  onReview: (gameId: string, fen: string) => void;
  onDrill: (catalogIndex: number) => void;
  onRepertoireChanged: () => void;
  onPractice: (action: PracticeAction) => void;
}) {
  const [page, setPage] = useState<(typeof PAGES)[number]>('Overview');
  const [filter, setFilter] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [styleView, setStyleView] = useState<StyleView | null>(null);
  const [rep, setRep] = useState<RepView | null>(null);
  const [firstMove, setFirstMove] = useState<string | null>(null);
  const [source, setSource] = useState(GAPS_FROM_GAMES);
  const [popular, setPopular] = useState<{ status: string | null; table: Table } | null>(null);
  const [popularProgress, setPopularProgress] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [games, setGames] = useState<{ title: string; fen: string; games: { id: string; label: string; result: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [improve, setImprove] = useState<Improvement | null>(null);

  useEffect(() => {
    void client.service('getSettings', ['stats_filter']).then((s) => setFilter(s.stats_filter && s.stats_filter in TIME_FILTERS ? s.stats_filter : 'All games'));
  }, [client]);

  // Overview and Playing style: when the filter changes
  useEffect(() => {
    if (!filter) return;
    setBusy(true);
    void (async () => {
      setOverview(await client.service('statsOverview', filter));
      setStyleView(await client.service('statsStyle', filter));
      setBusy(false);
    })();
  }, [client, filter]);

  const loadRepertoire = useCallback(async () => {
    if (!filter) return;
    setRep(await client.service('statsRepertoire', filter, firstMove));
    setSelected(null);
  }, [client, filter, firstMove]);

  useEffect(() => { if (page === 'Repertoire') void loadRepertoire(); }, [page, filter]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (page !== 'Improvement' || !filter) return;
    setImprove(null);
    void client.service('statsImprovement', filter).then(setImprove);
  }, [client, page, filter]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (page !== 'Repertoire' || !rep) return;
    void client.service('statsRepertoireRender', firstMove).then((v) => v && setRep(v));
  }, [firstMove]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** Popular-gap list from cached Lichess data, downloading what's missing first (then the reply positions). */
  const loadPopular = useCallback(async () => {
    const first = await client.service('statsPopular', firstMove);
    setPopular(first);
    if (!first.opponentFens.length) return;
    const progress = (done: number, total: number) => setPopularProgress(`Downloading Lichess opening data: ${done} / ${total} positions…`);
    const [, error] = await openingData.fetchFens(first.opponentFens, progress);
    const second = await client.service('statsPopular', firstMove);
    setPopular(second);
    if (error) {
      setPopularProgress(`Couldn't download Lichess data: ${error}`);
      return;
    }
    const [, error2] = await openingData.fetchFens(second.replyFens, progress);
    setPopular(await client.service('statsPopular', firstMove));
    setPopularProgress(error2 ? `Couldn't download Lichess data: ${error2}` : null);
  }, [client, firstMove, openingData]);

  useEffect(() => { if (page === 'Repertoire' && source === GAPS_FROM_LICHESS) void loadPopular(); }, [page, source, firstMove]);   // eslint-disable-line react-hooks/exhaustive-deps

  const showGames = async (id: string | null) => {
    if (!id) { setNotice({ ok: false, text: 'Select a line in the table first.' }); return; }
    const r = await client.service('statsGames', id);
    if ('message' in r) setNotice({ ok: false, text: r.message });
    else setGames(r);
  };

  const add = async (id: string | null) => {
    if (!id) { setNotice({ ok: false, text: 'Select a line in the table first.' }); return; }
    const r = await client.service('statsAdd', id);
    setNotice(r);
    if (r.ok) {
      onRepertoireChanged();
      await loadRepertoire();
    }
  };

  const repActions = (
    <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
      <button type="button" className="btn secondary" onClick={() => void showGames(selected)}>Show games</button>
      <button type="button" className="btn" onClick={() => void add(selected)}>Add selected to repertoire</button>
    </div>
  );

  return (
    <section className="stats-screen">
      <div className="row stats-top">
        <h1 style={{ margin: 0 }}>Stats</h1>
        <div className="segmented" role="tablist" aria-label="Page">
          {PAGES.map((p) => <button key={p} type="button" role="tab" aria-selected={page === p} aria-checked={page === p} onClick={() => setPage(p)}>{p}</button>)}
        </div>
        <span style={{ flex: 1 }} />
        <span className="note">Games</span>
        <select aria-label="Games" value={filter ?? 'All games'} onChange={(e) => setFilter(e.target.value)}>
          {Object.keys(TIME_FILTERS).map((f) => <option key={f}>{f}</option>)}
        </select>
      </div>
      <p className="note">{busy ? 'Working it out…' : overview?.summary}</p>
      {notice && (
        <div className={`notice ${notice.ok ? 'ok' : 'error'}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className="btn ghost small" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      {page === 'Overview' && overview && (
        <div className="stats-column">
          <Section title="Results by opening" help="Openings with 3+ games. Click a column to sort.">
            <DataTable table={overview.openings} maxRows={12} />
          </Section>
          <Section title="How you lose" help="Lots of timeouts means clock trouble, not chess trouble.">
            <DataTable table={overview.losses} />
          </Section>
          <Section title="Accuracy by game phase" help="Average pawns lost per move (lower is better). Stockfish-analyzed games only.">
            <DataTable table={overview.phases} />
          </Section>
          <Section title="Blunders vs. time left" help="Share of moves losing 3+ pawns, by clock remaining.">
            <DataTable table={overview.clock} />
          </Section>
        </div>
      )}

      {page === 'Playing style' && styleView && (
        <div className="stats-column">
          <div className="card style-verdict">
            <div className="section">Your style</div>
            <h2>{styleView.verdict}</h2>
            <p className="note">{styleView.note}</p>
          </div>
          <Section title="Tactical indicators" help="Sharp = the engine saw one clearly best move. Everyone loses more in sharp positions, so compare these over time rather than to each other.">
            <DataTable table={styleView.indicators} />
          </Section>
          <Section title="Results by game type" help="Your score by the kind of game it turned into (sharp/quiet split at your own averages).">
            <DataTable table={styleView.gameTypes} />
          </Section>
          <Section title="Your openings' character" help="How sharp your games with each opening get (moves 9–30). 3+ analyzed games.">
            <DataTable table={styleView.character} maxRows={12} />
          </Section>
          <Section title="Openings that fit your style" help="Double-click one (or select it and click Drill) to practice it in Opening Drill.">
            <DataTable table={styleView.recommend} maxRows={10} selected={recommended} onSelect={setRecommended}
              onOpen={(id) => onDrill(Number(id))} />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <button type="button" className="btn" disabled={recommended === null} onClick={() => recommended !== null && onDrill(Number(recommended))}>Drill selected opening</button>
            </div>
          </Section>
        </div>
      )}

      {page === 'Improvement' && !improve && <p className="note">Looking through your analyzed games…</p>}
      {page === 'Improvement' && improve && (
        <div className="stats-column">
          {improve.months < 2 ? <p>Not enough analyzed games yet to see a trend — analyze more on Import &amp; Analyze.</p> : (<>
            <div className="improve-grid">
              <div className="card stats-card improve-strengths">
                <h2>💪 Strengths</h2>
                {improve.strengths.length ? <ul>{improve.strengths.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="note">Nothing stands out yet.</p>}
              </div>
              <div className="card stats-card improve-weaknesses">
                <h2>🎯 To work on</h2>
                {improve.weaknesses.length ? <ul>{improve.weaknesses.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="note">No clear weak spot — keep it up.</p>}
              </div>
            </div>
            <div className="card stats-card">
              <h2>Accuracy by month</h2>
              <p className="note">Stockfish's verdict on every move of yours, as accuracy (100% = you kept all your winning chances), from {improve.games} analyzed games.
                Tactics = sharp positions, where only one move works. Endgames often come in decided positions, which flatters their accuracy a little.</p>
              <MultiLineChart series={improve.areas.map((a) => ({ name: a.area, color: AREA_COLORS[a.area], points: a.series.map((p) => [p.month, p.value] as [string, number]) }))}
                format={(v) => `${v.toFixed(0)}%`} />
              <DataTable table={{ columns: ['Area', 'Overall', `${3} months before`, 'Last 3 months', 'Change', 'Moves'], rows: improve.areas.map((a) => ({
                cells: [a.area, a.overall !== null ? `${a.overall.toFixed(1)}%` : '–', a.before !== null ? `${a.before.toFixed(1)}%` : '–',
                  a.recent !== null ? `${a.recent.toFixed(1)}%` : '–', a.change !== null ? `${a.change >= 0 ? '+' : ''}${a.change.toFixed(1)}` : '–', String(a.moves)],
                tone: a.change !== null && a.change <= -1.5 ? 'weak' as const : undefined })) }} />
            </div>
            <div className="card stats-card">
              <h2>What's changed</h2>
              <ul className="trend-list">{improve.trends.map((t) => <li key={t}>{t}</li>)}</ul>
              <h2 style={{ marginTop: 12 }}>Blunders per game (by month)</h2>
              <LineChart points={improve.blunders.map((p) => [p.month, p.value])} color="var(--bad)" format={(v) => v.toFixed(1)} height={150}
                empty="Not enough analyzed games per month yet" />
            </div>
            {improve.practice.length > 0 && (
              <div className="card stats-card">
                <h2>What to practise</h2>
                {improve.practice.map((p) => (
                  <div key={p.text} className="mistake-row">
                    <div>{p.text}</div>
                    <button type="button" className="btn small" onClick={() => onPractice(p.action)}>
                      {({ tactics: 'Spot the Tactic', threats: "What's the threat?", drill: 'Opening Drill', endgames: 'Endgame puzzles', puzzles: 'Puzzle Review' } as Record<string, string>)[p.action]}</button>
                  </div>
                ))}
              </div>
            )}
          </>)}
        </div>
      )}

      {page === 'Repertoire' && (
        <div className="stats-column">
          <div className="row">
            <div className="segmented" role="tablist" aria-label="Gaps">
              {[GAPS_FROM_GAMES, GAPS_FROM_LICHESS].map((s) => <button key={s} type="button" role="tab" aria-selected={source === s} aria-checked={source === s}
                onClick={() => { setSource(s); setSelected(null); }}>{s}</button>)}
            </div>
            <span style={{ flex: 1 }} />
            <span className="note">First move</span>
            <select aria-label="First move" value={firstMove ?? ALL_FIRST_MOVES} onChange={(e) => setFirstMove(e.target.value === ALL_FIRST_MOVES ? null : e.target.value)}>
              <option>{ALL_FIRST_MOVES}</option>
              {(rep?.firstMoves ?? []).map(([san, n]) => <option key={san} value={san}>{`1.${san}  (${n})`}</option>)}
            </select>
          </div>
          <p className="note">{source === GAPS_FROM_LICHESS ? (popularProgress ?? popular?.status ?? 'Looking at your repertoire…') : rep?.note ?? 'Working it out…'}</p>
          {source === GAPS_FROM_GAMES ? (
            <Section title="Where your games leave your repertoire" help="The first move in each game that your prep doesn't cover, most frequent first. Select one and click Add to put it (with a suggested reply) in your repertoire.">
              {rep && <DataTable table={rep.gaps} maxRows={12} selected={selected} onSelect={setSelected} onOpen={(id) => void showGames(id)} />}
              {repActions}
            </Section>
          ) : (
            <Section title="Popular moves your prep doesn't answer" help="Moves Lichess players at your level often choose at positions in your repertoire, with no reply in your lines yet — most likely to face first. Select one and click Add.">
              {popular && <DataTable table={popular.table} maxRows={12} selected={selected} onSelect={setSelected} onOpen={(id) => void showGames(id)} />}
              {repActions}
            </Section>
          )}
          <Section title="Lines you face most (first 3 moves)" help="Your most common openings. ✓ = already covered by your repertoire.">
            {rep && <DataTable table={rep.common} maxRows={12} selected={selected} onSelect={setSelected} onOpen={(id) => void showGames(id)} wide={[0, 1]} />}
            {repActions}
          </Section>
        </div>
      )}

      {games && (
        <Modal title={games.title} onClose={() => setGames(null)}>
          <p className="note">{games.games.length} game(s), newest first. Click one to review it from this position.</p>
          <ol className="queue games-list">
            {games.games.map((g) => (
              <li key={g.id}><button type="button" className={g.result} onClick={() => { setGames(null); onReview(g.id, games.fen); }}>{g.label}</button></li>
            ))}
          </ol>
          <div className="row modal-buttons"><button type="button" className="btn" onClick={() => setGames(null)}>Close</button></div>
        </Modal>
      )}
    </section>
  );
}
