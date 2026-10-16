/**
 * Opening Drill → Add lines → Opening library (library_window.py): every named
 * opening from Lichess's dataset. Browse by family or search by name, ECO code
 * or moves; filter by whether it's in your repertoire and by character
 * (Sharp / Balanced / Quiet); sort by your games; preview a line on the board
 * with what it leads to and how you've done in it; add the ones you pick to a
 * repertoire. The lines ship described (public/openings/library.json).
 */
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerColor } from '../core/models';
import type { DbClient } from '../data/client';
import {
  BEST, BOOK, type LibraryDetail, type LibraryRowView, MOST, SHOW_ALL, SHOW_IN, SHOW_OUT, SHOW_PLAYED, WORST,
} from '../data/libraryServices';
import { Board } from './Board';
import { Modal } from './Modal';
import { SaveDialog } from './SaveDialog';

const ALL = 'All families';
const ANY_CHARACTER = 'Any character';
const SEARCH_DELAY_MS = 250;
const MANY = 40;                 // adding more than this many lines at once asks first
const CHARACTER_COLORS: Record<string, string> = { Sharp: '#E8735E', Balanced: '#E6A94A', Quiet: '#8FB3E8' };

export function LibraryDialog({ client, onAdded, onClose }: { client: DbClient; onAdded: () => Promise<void>; onClose: () => void }) {
  const [status, setStatus] = useState('Opening the library…');
  const [ready, setReady] = useState(false);
  const [families, setFamilies] = useState<[string, number][]>([]);
  const [family, setFamily] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [show, setShow] = useState(SHOW_ALL);
  const [sort, setSort] = useState(BOOK);
  const [character, setCharacter] = useState(ANY_CHARACTER);
  const [rows, setRows] = useState<LibraryRowView[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [detail, setDetail] = useState<LibraryDetail | null>(null);
  const [matching, setMatching] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<number[] | null>(null);
  const [confirmMany, setConfirmMany] = useState<number[] | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [games, setGames] = useState<Awaited<ReturnType<typeof client.service<'gamesList'>>> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // load the library once (from the pre-built file), then match your games to its lines
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!(await client.service('libraryCount'))) {
          setStatus('Loading the opening library…');
          const built = await (await fetch(`${import.meta.env.BASE_URL}openings/library.json`)).json();
          await client.service('libraryLoad', built);
        }
        if (!alive) return;
        setFamilies(await client.service('libraryFamilies'));
        setReady(true);
        setMatching(true);
        const matched = await client.service('libraryMatchGames');
        if (!alive) return;
        setMatching(false);
        if (matched) setReady((r) => r);          // re-search below picks up your records
      } catch (e) {
        setStatus(`Couldn't open the library (${e instanceof Error ? e.message : e}).`);
      }
    })();
    return () => { alive = false; };
  }, [client]);

  const search = useCallback(async () => {
    const result = await client.service('librarySearch', {
      query, family, character: character === ANY_CHARACTER ? null : character, show, sort,
    });
    setRows(result.rows);
    setStatus(result.countText);
    setPicked([]);
  }, [client, query, family, character, show, sort]);

  useEffect(() => {
    if (!ready) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void search(), SEARCH_DELAY_MS);
  }, [ready, search, matching]);

  const preview = async (id: number) => setDetail(await client.service('libraryDetail', id));

  const pick = (i: number, e: MouseEvent) => {
    const id = rows[i].id;
    let next: number[];
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      next = rows.slice(a, b + 1).map((r) => r.id);
    } else if (e.ctrlKey || e.metaKey) {
      next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
      setAnchor(i);
    } else {
      next = [id];
      setAnchor(i);
    }
    setPicked(next);
    void preview(id);
  };

  const add = async (ids: number[]) => {
    if (!ids.length) {
      setNote('Pick one or more lines first.');
      return;
    }
    if (ids.length > MANY && confirmMany === null) {
      setConfirmMany(ids);
      return;
    }
    setConfirmMany(null);
    setNames(await client.service('repertoireNames'));
    setSaving(ids);
  };

  const save = async (name: string, color: PlayerColor): Promise<string | null> => {
    const ids = saving!;
    const added = await client.service('libraryAdd', ids, name, color);
    setSaving(null);
    await onAdded();
    await search();
    if (detail) await preview(detail.id);
    setNote(`Added ${ids.length} line${ids.length !== 1 ? 's' : ''} to '${name}' (${color}) — ${added} new move${added !== 1 ? 's' : ''}. Drill them from Setup.`);
    return null;
  };

  const fit = (() => {
    if (!detail?.character || (detail.style !== 'sharp' && detail.style !== 'quiet')) return '';
    const yours = detail.style === 'sharp' ? 'Sharp' : 'Quiet';
    if (detail.character === yours) return `Fits your style — you score better in ${detail.style} positions (Stats).`;
    if (detail.character === 'Sharp' || detail.character === 'Quiet') return `Against your usual style — you score better in ${detail.style} positions (Stats).`;
    return '';
  })();

  return (
    <Modal title="Opening library" onClose={onClose} wide>
      <div className="library">
        <div className="row library-head">
          <input aria-label="Search" placeholder="Search (name, ECO, or moves like e4 c5 Nf3)" value={query}
            onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 200 }} autoFocus />
          <select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value)}>
            {[SHOW_ALL, SHOW_IN, SHOW_OUT, SHOW_PLAYED].map((o) => <option key={o}>{o}</option>)}
          </select>
          <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            {[BOOK, MOST, BEST, WORST].map((o) => <option key={o}>{o}</option>)}
          </select>
          <select aria-label="Character" value={character} onChange={(e) => setCharacter(e.target.value)}>
            {[ANY_CHARACTER, 'Sharp', 'Balanced', 'Quiet'].map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
        <p className="note">{status}{matching ? '  ·  matching your games to the lines…' : ''}</p>
        <div className="library-cols">
          <div className="library-families">
            <div className="section">Families</div>
            <ol className="queue">
              {[[ALL, 0] as [string, number], ...families].map(([f, n]) => (
                <li key={f}><button type="button" aria-current={(f === ALL ? family === null : family === f) ? 'true' : undefined}
                  onClick={() => setFamily(f === ALL ? null : f)}>{n ? `${f} (${n})` : f}</button></li>
              ))}
            </ol>
            <p className="note">Source: Lichess opening names (CC0)</p>
          </div>
          <div className="library-lines">
            <div className="section">✓ in your repertoire · ◐ partly · ○ not yet · [your score in N games]</div>
            <ol className="queue" aria-label="Lines" aria-multiselectable="true">
              {rows.map((r, i) => (
                <li key={r.id}><button type="button" className={r.flag === 'in' ? 'in-rep' : ''} aria-current={picked.includes(r.id) ? 'true' : undefined}
                  onClick={(e) => pick(i, e)}>{r.label}</button></li>
              ))}
              {ready && !rows.length && <li className="note">Nothing matches — try fewer words, All families, or other filters.</li>}
            </ol>
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn secondary" onClick={() => { setPicked(rows.map((r) => r.id)); if (rows.length) void preview(rows[rows.length - 1].id); }}>Select all shown</button>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" onClick={() => void add(picked)}>Add picked to repertoire…</button>
            </div>
          </div>
          <div className="library-preview">
            {detail ? (<>
              <Board fen={detail.fen} orientation={detail.orientation} />
              <h3>{detail.title}</h3>
              <p className="note">{detail.pgn}{picked.length > 1 ? `   (${picked.length} lines picked)` : ''}</p>
              <p className={`flag ${detail.flag}`}>{detail.flag === 'in' ? `✓ In your ${detail.flagColor} repertoire`
                : detail.flag === 'partly' ? `◐ Partly in your ${detail.flagColor} repertoire (${detail.covered}/${detail.plies})` : '○ Not in your repertoire'}</p>
              {detail.flag !== 'in' && <button type="button" className="btn secondary small" onClick={() => void add([detail.id])}>Add this line…</button>}
              {detail.character && <p className="status" style={{ color: CHARACTER_COLORS[detail.character] }}>{detail.character}
                {detail.evalCp !== null ? `   Stockfish ${detail.evalCp >= 0 ? '+' : '−'}${Math.abs(detail.evalCp / 100).toFixed(2)}` : ''}</p>}
              <p>{detail.description}{fit ? `\n${fit}` : ''}</p>
              <div className="section">Your games</div>
              <p className="pre">{detail.games.length ? detail.games.join('\n')
                : matching ? 'Matching your games to the lines…' : 'None of your games reached this line as its deepest named one.'}</p>
              {detail.gameIds.length > 0 && <button type="button" className="btn secondary small"
                onClick={async () => setGames(await client.service('gamesList', detail.gameIds))}>Review these games…</button>}
            </>) : <p className="note">Pick a line to preview it.</p>}
            {note && <p className="ok">{note}</p>}
          </div>
        </div>
        <div className="row modal-buttons"><button type="button" className="btn" onClick={onClose}>Close</button></div>
      </div>

      {confirmMany && (
        <Modal title="Opening library" onClose={() => setConfirmMany(null)}>
          <p>Add all {confirmMany.length} lines? Big repertoires are harder to drill — you can turn lines off later (Turn lines on/off).</p>
          <div className="row modal-buttons">
            <button type="button" className="btn" onClick={() => { const ids = confirmMany; setConfirmMany(null); void (async () => { setNames(await client.service('repertoireNames')); setSaving(ids); })(); }}>Add them</button>
            <button type="button" className="btn secondary" onClick={() => setConfirmMany(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {saving && <SaveDialog names={names} onSave={save} onClose={() => setSaving(null)} />}
      {games && (
        <Modal title={`${detail?.title ?? ''} — ${games.length} game${games.length !== 1 ? 's' : ''}`} onClose={() => setGames(null)}>
          <p className="note">Each opens on chess.com (Game Review comes in Phase 5).</p>
          <ol className="queue games-list">
            {games.map((g) => <li key={g.id}><a href={g.url} target="_blank" rel="noopener">{`${g.played}  ${({ win: 'W', loss: 'L', draw: 'D' } as Record<string, string>)[g.result] ?? '?'}  vs ${g.opponent}  (${g.timeControl})`}</a></li>)}
          </ol>
          <div className="row modal-buttons"><button type="button" className="btn" onClick={() => setGames(null)}>Close</button></div>
        </Modal>
      )}
    </Modal>
  );
}
