/**
 * Opponent Prep (scout_tab.py): scout any chess.com player's openings before
 * you play them — what they play as White and as Black, how they score, and
 * whether your repertoire covers it. Their games are downloaded into memory
 * only, never saved to your database.
 */
import { useEffect, useState } from 'react';
import { fetchAllGames } from '../../core/chessCom';
import type { Game } from '../../core/models';
import { TIME_FILTERS } from '../../core/models';
import type { DbClient } from '../../data/client';
import type { Table } from '../../data/statsServices';
import { DataTable } from '../DataTable';

const MIN_GAMES = 2;

export function ScoutScreen({ client }: { client: DbClient }) {
  const [username, setUsername] = useState('');
  const [months, setMonths] = useState('6');
  const [filter, setFilter] = useState('All games');
  const [games, setGames] = useState<{ name: string; list: Game[] } | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "Enter an opponent's username to see how they open." });
  const [busy, setBusy] = useState(false);
  const [tables, setTables] = useState<{ white: Table; black: Table } | null>(null);

  const scout = async () => {
    const name = username.trim();
    if (!name || busy) return;
    const m = Math.max(1, parseInt(months, 10) || 6);
    setBusy(true);
    setStatus({ text: `Downloading ${name}'s games...` });
    try {
      const list = await fetchAllGames(name, m, (done, total) => setStatus({ text: `Downloading ${name}'s games — month ${done} of ${total}...` }));
      setGames({ name, list });
    } catch (e) {
      setStatus({ text: `Couldn't download ${name}'s games: ${e instanceof Error ? e.message : e}`, error: true });
    }
    setBusy(false);
  };

  useEffect(() => {
    if (!games) return;
    void client.service('scoutLines', games.list, filter).then((data) => {
      const table = (rows: typeof data.white): Table => ({
        columns: ['Line (first 3 moves each)', 'Games', 'Their W / D / L', 'Their score', 'Your prep'],
        rows: rows.map((r) => ({ cells: [r.line, String(r.games), `${r.wins} / ${r.draws} / ${r.losses}`, `${Math.round(100 * r.score)}%`,
          r.covered_by_your_repertoire ? '✓ covered' : 'not covered'] })),
      });
      setTables({ white: table(data.white), black: table(data.black) });
      setStatus({ text: `${games.name}: ${data.games} games in this filter. Lines played at least ${MIN_GAMES} times. `
        + "'Your prep' checks your own repertoire for the other color." });
    });
  }, [client, games, filter]);

  return (
    <section className="stats-screen">
      <h1 style={{ margin: 0 }}>Opponent Prep</h1>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void scout(); }}>
        <span className="note">chess.com username</span>
        <input aria-label="Opponent's chess.com username" value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: 180 }} />
        <span className="note">months</span>
        <input aria-label="Months" value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: 48 }} />
        <button type="submit" className="btn" disabled={busy || !username.trim()}>Scout player</button>
        <span style={{ flex: 1 }} />
        <select aria-label="Games" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {Object.keys(TIME_FILTERS).map((f) => <option key={f}>{f}</option>)}
        </select>
      </form>
      <p className={status.error ? 'error' : 'note'}>{status.text}</p>
      {tables && (
        <div className="stats-column">
          <div className="card stats-card"><h2>When they have White</h2><DataTable table={tables.white} maxRows={10} /></div>
          <div className="card stats-card"><h2>When they have Black</h2><DataTable table={tables.black} maxRows={10} /></div>
        </div>
      )}
    </section>
  );
}
