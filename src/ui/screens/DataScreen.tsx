/**
 * Your data: what's stored for the current player, importing a desktop
 * chessprep.db (into this player or as a new one), backing up the database,
 * and adding players. Importing games from chess.com and analyzing them are on
 * Import & Analyze.
 */
import { useRef, useState } from 'react';
import type { DbClient } from '../../data/client';
import type { ProfilesView } from '../../data/dbWorker';
import type { Summary } from '../../data/services';
import { engineStrength, setEngineStrength, type Strength } from '../../engine/stockfish';

interface Props {
  client: DbClient;
  profiles: ProfilesView | null;
  summary: Summary | null;
  onChange: (view?: ProfilesView) => Promise<void>;
}

export function DataScreen({ client, profiles, summary, onChange }: Props) {
  const file = useRef<HTMLInputElement>(null);
  const [asNewPlayer, setAsNewPlayer] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState('');

  const run = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await work() });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const importFile = (f: File) => run('Importing…', async () => {
    const view = await client.importDb(new Uint8Array(await f.arrayBuffer()), asNewPlayer);
    await onChange(view);
    return `Imported ${f.name} for ${view.current}.`;
  });

  const backup = () => run('Preparing the backup…', async () => {
    const bytes = await client.exportDb();
    const name = `pawn-promoter-${(profiles?.current ?? 'player').replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.db`;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/x-sqlite3' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return `Saved ${name} (${(bytes.byteLength / 1e6).toFixed(1)} MB).`;
  });

  const addPlayer = () => run('Adding…', async () => {
    const view = await client.addProfile(newName);
    setNewName('');
    await onChange(view);
    return `${view.current} added — each player has their own games, puzzles and progress.`;
  });

  const s = summary;
  return (
    <section>
      <h1>Your data</h1>
      <p className="lede">
        Everything stays in this browser: your games, analysis, puzzles and repertoire are stored on this device and
        never uploaded. Bring over what you've built in the desktop app, and back it up from here.
      </p>
      <div className="grid">
        <div className="card">
          <h2>{profiles?.current ?? 'Player'}{s?.username ? ` · ${s.username} on chess.com` : ''}</h2>
          {s ? (
            <div className="stats">
              <Stat n={s.games} l="games" />
              <Stat n={s.analyzed} l="analyzed" />
              <Stat n={s.puzzles} l="puzzles" />
              <Stat n={s.lichessPuzzles} l="Lichess puzzles" />
              <Stat n={s.repertoireMoves} l="repertoire moves" />
              <Stat n={s.attempts} l="puzzle & drill tries" />
            </div>
          ) : <p className="note">Opening your database…</p>}
        </div>

        <div className="card">
          <h2>Import from the desktop app</h2>
          <p className="note">Pick your <code>chessprep.db</code> (next to King Coach). It's copied into this browser as-is.</p>
          <div className="row">
            <label className="row note">
              <input type="checkbox" checked={asNewPlayer} onChange={(e) => setAsNewPlayer(e.target.checked)} />
              As a new player (keeps {profiles?.current ?? 'this player'}'s data)
            </label>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={!!busy} onClick={() => file.current?.click()}>
              Import chessprep.db…
            </button>
            <input ref={file} type="file" accept=".db,.sqlite,.sqlite3,application/x-sqlite3" hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
          </div>
          {!asNewPlayer && (s?.games ?? 0) > 0 && (
            <p className="note">This replaces {profiles?.current}'s current data — back it up first if you need it.</p>
          )}
        </div>

        <div className="card">
          <h2>Back up</h2>
          <p className="note">
            Browsers can clear a site's data (for example when you clear browsing data), so keep a copy. The file opens
            in the desktop app too.
          </p>
          <button type="button" className="btn secondary" disabled={!!busy} onClick={backup}>Back up my database</button>
        </div>

        <EngineCard />

        <div className="card">
          <h2>Players</h2>
          <p className="note">Several people can share the app; each gets their own database.</p>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void addPlayer(); }}>
            <input aria-label="New player's name" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" className="btn secondary" disabled={!!busy || !newName.trim()}>+ New player</button>
          </form>
        </div>
      </div>
      <p className="note" aria-live="polite" style={{ marginTop: 16 }}>
        {busy ?? (message && <span className={message.ok ? 'ok' : 'error'}>{message.text}</span>)}
      </p>
    </section>
  );
}

/** Stockfish's strength on this device (the engine choice is per browser, not per player). */
function EngineCard() {
  const [strength, setStrength] = useState<Strength>(engineStrength);
  const choose = (s: Strength) => { setStrength(s); setEngineStrength(s); };
  return (
    <div className="card">
      <h2>Engine</h2>
      <p className="note">
        Stockfish for analysis boards, explanations, puzzles, the trainers and Play it out. Analyzing your games always
        uses the standard engine, several at once.
      </p>
      <div className="segmented" role="radiogroup" aria-label="Engine strength">
        {(['standard', 'strong'] as const).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={strength === s}
            className={strength === s ? 'active' : ''} onClick={() => choose(s)}>
            {s === 'standard' ? 'Standard' : 'Strong'}
          </button>
        ))}
      </div>
      <p className="note">
        {strength === 'standard'
          ? 'Standard: a 1.8 MB download, ready in about a second.'
          : 'Strong: Stockfish\'s full network — a 95 MB download the first time (about 20 s), then kept by the browser. Finds the best move more often; uses more memory.'}
      </p>
    </div>
  );
}

function Stat({ n, l }: { n: number; l: string }) {
  return <div className="stat"><div className="n">{n.toLocaleString()}</div><div className="l">{l}</div></div>;
}
