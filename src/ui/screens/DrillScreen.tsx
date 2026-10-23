/**
 * Opening Drill (drill_tab.py): Setup / Plans / Add lines on the left, the
 * board in the centre, the commentary on the right — the same layout as
 * Puzzle Review. All the logic is in DrillController; this draws it, plus
 * the small dialogs (save to repertoire, paste a line, turn lines on/off,
 * delete, connect Lichess).
 */
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as explorer from '../../core/explorer';
import type { PlayerColor } from '../../core/models';
import type { DbClient } from '../../data/client';
import type { allLines } from '../../data/drillServices';
import type { Node } from '../../core/openingTree';
import type { MyDeviationView } from '../../data/myGamesServices';
import { IDEA_BRUSHES } from '../analysis';
import { Board } from '../Board';
import { ADD_LINES, type DrillController, MY_GAMES, TREE, VIEWS } from '../drillController';
import { ALL } from '../myGamesController';
import { TreeMoves } from '../TreeMoves';
import { TreeView } from '../TreeView';
import { headOf, moveLabel, variationName } from '../treeHelpers';
import { LibraryDialog } from '../LibraryDialog';
import { Modal } from '../Modal';
import { PlayDialog } from '../PlayDialog';
import { SaveDialog } from '../SaveDialog';
import { IdeasPanel, plusCoach, useCoachFocus } from '../SquareText';

type Dialog =
  | { kind: 'save'; text: string; source: 'file' | 'paste' }
  | { kind: 'paste' }
  | { kind: 'lines' }
  | { kind: 'delete'; label: string; detail: string }
  | { kind: 'lichess' }
  | { kind: 'disconnect' }
  | { kind: 'play'; fen: string; myColor: 'white' | 'black'; title: string }
  | { kind: 'analyze'; fen: string; title: string }
  | { kind: 'games'; d: MyDeviationView }
  | { kind: 'library' }
  | null;

const DOT: Record<string, string> = { green: '#15781b', blue: '#003088', grey: '#8d8d8d' };
const NO_SQUARES: string[] = [];

function PasteDialog({ onNext, onClose }: { onNext: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  return (
    <Modal title="Paste an opening line" onClose={onClose}>
      <p className="note pre">{'Type or paste moves in standard notation, e.g.:\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6\n'
        + 'Sidelines in parentheses become branches, e.g. 2. Nf3 (2. Nc3 Nc6)'}</p>
      <textarea aria-label="Moves" rows={5} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <div className="row modal-buttons">
        <button type="button" className="btn" disabled={!text.trim()} onClick={() => onNext(text.trim())}>Import this line</button>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** Lines switched off are left out of drilling but stay saved. */
function LinesDialog({ client, onClose }: { client: DbClient; onClose: () => void }) {
  const [list, setList] = useState<ReturnType<typeof allLines> | null>(null);
  useEffect(() => { void client.service('allLines').then(setList); }, [client]);
  const toggle = async (id: string, on: boolean) => {
    await client.service('setLineEnabled', id, on);
    setList(list!.map((r) => ({ ...r, lines: r.lines.map((l) => (l.id === id ? { ...l, enabled: on } : l)) })));
  };
  return (
    <Modal title="Turn lines on/off" onClose={onClose}>
      <p className="note">Uncheck a line to exclude it from drilling — it stays saved.</p>
      <div className="lines-list">
        {!list ? <p className="note">Loading…</p> : !list.length ? <p className="note">Import a repertoire first.</p> : list.map((r) => (
          <div key={`${r.name}|${r.color}`}>
            <h3>{r.name} ({r.color})</h3>
            {r.lines.map((l) => (
              <label key={l.id} className="check"><input type="checkbox" checked={l.enabled} onChange={(e) => void toggle(l.id, e.target.checked)} /> {l.label}</label>
            ))}
          </div>
        ))}
      </div>
      <div className="row modal-buttons"><button type="button" className="btn" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

/** Paste a Lichess personal access token, check it, and save it. */
function LichessDialog({ onSaved, onClose }: { onSaved: (token: string, username: string) => Promise<void>; onClose: () => void }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const save = async () => {
    const t = token.trim();
    if (!t) { setStatus({ text: 'Paste the token first.', error: true }); return; }
    setStatus({ text: 'Checking with Lichess…', error: false });
    try {
      const username = await explorer.checkToken(t);
      await onSaved(t, username);
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };
  return (
    <Modal title="Connect Lichess" onClose={onClose}>
      <p className="note pre">{'The Lichess Opening Explorer needs a free personal access token:\n'
        + '1. Sign in at lichess.org and open the token page (link below).\n'
        + '2. Click New personal access token, name it King Side Coach, leave every permission box unchecked, and create it.\n'
        + '3. Copy the token and paste it here.\n\n'
        + "It's saved only in this player's database in this browser."}</p>
      <p><a href={explorer.TOKEN_PAGE} target="_blank" rel="noopener">Open the Lichess token page</a></p>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input type="password" aria-label="Lichess token" value={token} onChange={(e) => setToken(e.target.value)} autoFocus
          style={{ width: '100%' }} autoComplete="off" />
        {status && <p className={status.error ? 'error' : 'note'}>{status.text}</p>}
        <div className="row modal-buttons">
          <button type="submit" className="btn">Check &amp; save</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

/** A question from the tree (a name for a new branch, or yes / no). */
function PromptDialog({ c }: { c: DrillController }) {
  const p = c.prompt!;
  const [value, setValue] = useState('');
  return (
    <Modal title={p.title} onClose={() => c.answer(p.kind === 'name' ? null : false)}>
      <form onSubmit={(e) => { e.preventDefault(); c.answer(p.kind === 'name' ? value : true); }}>
        <p className="pre">{p.text}</p>
        {p.kind === 'name' && <input aria-label="Name" value={value} onChange={(e) => setValue(e.target.value)} autoFocus style={{ width: '100%' }}
          placeholder={p.suggestion} />}
        <div className="row modal-buttons">
          <button type="submit" className="btn">{p.kind === 'name' ? 'Save' : 'Yes'}</button>
          <button type="button" className="btn secondary" onClick={() => c.answer(p.kind === 'name' ? null : false)}>{p.kind === 'name' ? 'Cancel' : 'No'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** The games where you played a deviation (newest first): pick one for Game Review at that position. */
function GamesDialog({ c, d, onClose, onReview }: { c: DrillController; d: MyDeviationView; onClose: () => void; onReview: (gameId: string, fen: string) => void }) {
  const [rows, setRows] = useState<Awaited<ReturnType<DrillController['myGames']['games']>> | null>(null);
  useEffect(() => { void c.myGames.games(d).then(setRows); }, [c, d]);
  const marks: Record<string, string> = { win: 'W', loss: 'L', draw: 'D' };
  return (
    <Modal title={`${d.line} — with ${d.playedSan}`} onClose={onClose}>
      <p className="note">{rows ? `${rows.length} game${rows.length !== 1 ? 's' : ''}. ` : ''}Click one to open it in Game Review at this position.</p>
      <ol className="queue games-list">
        {(rows ?? []).map((r) => (
          <li key={r.id}><button type="button" onClick={() => { onClose(); onReview(r.id, d.fen); }}>{`${r.played}  ${marks[r.result] ?? '?'}  vs ${r.opponent}  (${r.timeControl})`}</button></li>
        ))}
      </ol>
      <div className="row modal-buttons"><button type="button" className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

/** Right-click in the tree: where an opening starts, or delete a branch. */
function TreeMenu({ c, node, x, y, onClose }: { c: DrillController; node: Node; x: number; y: number; onClose: () => void }) {
  const t = c.tree;
  const reps = t.contextRepertoires(node);
  const label = node.move === null ? 'the starting position' : moveLabel(node);
  const first = node.move !== null ? t.branchStart(node) : null;
  const item = (text: string, run: () => void) => (
    <button type="button" role="menuitem" onClick={() => { onClose(); run(); }}>{text}</button>
  );
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <>
      <div className="menu-veil" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="context-menu" role="menu" style={{ left: Math.min(x, window.innerWidth - 340), top: Math.min(y, window.innerHeight - 260) }}>
        {reps.map((name) => item(node.move ? `${name} starts here (after ${label})` : `${name} starts at move 1`, () => void t.setOpeningStart(name, node)))}
        <hr />
        {reps.map((name) => item(`${name}: use the default start (where its lines still agree)`, () => void t.setOpeningStart(name, null)))}
        {node.move !== null && <>
          <hr />
          {item(`Delete ${label} and everything after it…`, () => void t.deleteBranch(node))}
          {first && first !== node && item(`Delete the whole branch from ${moveLabel(first)}…`, () => void t.deleteBranch(first))}
        </>}
      </div>
    </>
  );
}

/** The tree drawing over the whole screen, with the board small beside it. */
function ExpandedTree({ c, onClose, onContext }: { c: DrillController; onClose: () => void; onContext: (node: Node, x: number, y: number) => void }) {
  const t = c.tree;
  const b = c.board();
  return (
    <Modal title="Tree" onClose={onClose} wide>
      <div className="tree-expanded">
        <TreeView t={t} version={c.version} onSelect={(n) => void t.select(n)} onDeviation={(n, u) => void t.onDeviation(n, u)}
          onStar={(d) => void t.onStar(d)} onContext={onContext} onWheel={(d) => void t.step(d)} />
        <div className="tree-expanded-side">
          <Board fen={b.fen} orientation={b.orientation} lastMove={b.lastMove} movable={b.movable} arrows={b.arrows} onMove={(uci) => void c.onMove(uci)} />
          <strong>{t.lineLabel}</strong>
          <p className="note">{t.movesLabel}</p>
          {t.devLabel && <p className="note dev-label">{t.devLabel}</p>}
          <div className="row">
            <button type="button" className="btn secondary" aria-label="Back" onClick={() => void t.step(-1)}>◀</button>
            <button type="button" className="btn secondary" aria-label="Forward" onClick={() => void t.step(1)}>▶</button>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Filter the openings in the tree: a search box, and a button per opening (click: hide / show;
 *  double-click: only that one). */
function TreeFilter({ c }: { c: DrillController }) {
  const t = c.tree;
  const [text, setText] = useState(t.filterText);
  useEffect(() => setText(t.filterText), [t.filterText]);
  // filter as you type, a moment after the last key
  useEffect(() => {
    if (text === t.filterText) return;
    const timer = setTimeout(() => void t.setFilterText(text), 250);
    return () => clearTimeout(timer);
  }, [text, t]);
  return (
    <div className="tree-filter">
      <div className="row">
        <input aria-label="Filter openings" placeholder="Filter openings… (e.g. Slav, Exchange)" value={text}
          onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        {t.filtering() && <button type="button" className="btn ghost small" onClick={() => { setText(''); void t.clearFilter(); }}>Clear</button>}
      </div>
      {t.openingNames.length > 1 && (
        <div className="opening-chips" role="group" aria-label="Openings shown">
          {t.openingNames.map((n) => (
            <button key={n} type="button" className={`chip ${t.hiddenOpenings.has(n) ? 'off' : 'on'}`} aria-pressed={!t.hiddenOpenings.has(n)}
              title="Click to hide or show · double-click to show only this one"
              onClick={() => void t.toggleOpening(n)} onDoubleClick={() => void t.onlyOpening(n)}>{n}</button>
          ))}
        </div>
      )}
      {t.filtering() && <p className="note">Showing {t.lineCounts.shown} of {t.lineCounts.total} lines.</p>}
    </div>
  );
}

function TreePanel({ c }: { c: DrillController }) {
  const t = c.tree;
  const [menu, setMenu] = useState<{ node: Node; x: number; y: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const context = (node: Node, x: number, y: number) => setMenu({ node, x, y });
  return (
    <div className="drill-view tree-panel">
      <div className="row tree-head">
        <select aria-label="Tree" value={t.scope} onChange={(e) => void t.setScope(e.target.value)} disabled={!t.scopeOptions.length}>
          {t.scopeOptions.map((o) => <option key={o}>{o}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <div className="segmented" role="tablist" aria-label="Show as">
          {(['moves', 'drawing'] as const).map((m) => <button key={m} type="button" role="tab" aria-selected={t.mode === m} aria-checked={t.mode === m}
            onClick={() => void t.setMode(m)}>{m === 'moves' ? 'Moves' : 'Drawing'}</button>)}
        </div>
        <button type="button" className="btn secondary small" onClick={() => setExpanded(true)} title="The tree drawing over the whole screen">Expand</button>
      </div>
      <TreeFilter c={c} />
      {t.mode === 'moves' ? <TreeMoves t={t} onContext={context} /> : (
        <TreeView t={t} version={c.version} onSelect={(n) => void t.select(n)} onDeviation={(n, u) => void t.onDeviation(n, u)}
          onStar={(d) => void t.onStar(d)} onContext={context} onWheel={(d) => void t.step(d)} />
      )}
      {expanded && <ExpandedTree c={c} onClose={() => setExpanded(false)} onContext={context} />}
      <strong>{t.lineLabel}</strong>
      <p className="note">{t.movesLabel}</p>
      {t.devLabel && <p className="note dev-label">{t.devLabel}</p>}
      <div className="row tree-toggles">
        <label className="check"><input type="checkbox" checked={t.showBefore} onChange={(e) => void t.setShowBefore(e.target.checked)} /> Other openings</label>
        <label className="check"><input type="checkbox" checked={t.ideasOn} onChange={(e) => void t.setIdeas(e.target.checked)} /> Stockfish's ideas</label>
        {t.mode === 'drawing' && <label className="check"><input type="checkbox" checked={t.zoom} onChange={(e) => void t.setZoom(e.target.checked)} /> Zoom in</label>}
      </div>
      <div className="row">
        <button type="button" className="btn secondary" aria-label="Back" onClick={() => void t.step(-1)}>◀</button>
        <button type="button" className="btn secondary" aria-label="Forward" onClick={() => void t.step(1)}>▶</button>
        {t.draft.length ? <>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={() => void t.saveDraft()}>Save branch</button>
          <button type="button" className="btn secondary" onClick={() => t.discardDraft()}>Discard</button>
        </> : <button type="button" className="btn" style={{ flex: 1 }} onClick={() => void t.drillThisLine()} disabled={!t.focus.length}>Drill this line</button>}
      </div>
      {menu && <TreeMenu c={c} {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function MyGamesPanel({ c, onGames, onAnalyze }: { c: DrillController; onGames: (d: MyDeviationView) => void; onAnalyze: (fen: string, title: string) => void }) {
  const g = c.myGames;
  if (g.loading) return <div className="drill-view"><p className="note">Looking through your games…</p></div>;
  const cur = g.current;
  return (
    <div className="drill-view my-games">
      <p className="note">{g.summary()}</p>
      <div className="section">Your most played openings</div>
      <ol className="queue short" aria-label="Your openings">
        {[ALL, ...g.openings.map((o) => g.openingRow(o))].map((label, i) => (
          <li key={label + i}><button type="button" aria-current={i === g.opening ? 'true' : undefined} onClick={() => g.setOpening(i)}>{label}</button></li>
        ))}
      </ol>
      <div className="section">Where you leave your prep</div>
      <ol className="queue" aria-label="Where you leave your prep">
        {g.shown.length ? g.shown.map((d) => (
          <li key={d.key}><button type="button" aria-current={cur?.key === d.key ? 'true' : undefined} onClick={() => void c.openMyDeviation(d)}>{g.row(d)}</button></li>
        )) : <li className="note">{g.emptyText()}</li>}
      </ol>
      <div className="row">
        <button type="button" className="btn secondary" disabled={!cur} onClick={() => void c.myDeviationOnTree()}>Show on the tree</button>
        <button type="button" className="btn secondary" disabled={!cur} onClick={() => cur && onGames(cur)}>Review games…</button>
        <button type="button" className="btn secondary" disabled={!cur} onClick={() => cur && onAnalyze(g.board!.fen, `Analyze — ${cur.line}`)}>Analyze</button>
      </div>
    </div>
  );
}

export function DrillScreen({ c, client, onReview }: { c: DrillController; client: DbClient; onReview: (gameId: string, fen: string | null) => void }) {
  useSyncExternalStore(c.subscribe, () => c.version);
  const data = useSyncExternalStore(c.openingData.subscribe, () => c.openingData.state);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [names, setNames] = useState<{ name: string; colors: PlayerColor[] }[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || dialog || c.prompt) return;
      if (e.key === 'ArrowLeft') c.arrowKey(-1);
      if (e.key === 'ArrowRight') c.arrowKey(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [c, dialog]);

  const askSave = async (text: string, source: 'file' | 'paste') => {
    setNames(await client.service('repertoireList'));
    setDialog({ kind: 'save', text, source });
  };

  const saveTo = async (name: string, color: PlayerColor): Promise<string | null> => {
    if (dialog?.kind !== 'save') return null;
    const pgn = dialog.source === 'paste' ? `[Event "${name}"]\n\n${dialog.text} *\n` : dialog.text;
    try {
      const count = await c.importPgn(pgn, name, color);
      if (!count && dialog.source === 'paste') {
        return 'No new moves were imported — check the notation, or this line may already be in that repertoire.';
      }
      setNotice({ ok: true, text: count ? `Imported ${count} positions into '${name}'.`
        : `These lines are already in '${name}' — their move notes were updated.` });
      setDialog(null);
      return null;
    } catch (e) {
      return `Import failed: ${e instanceof Error ? e.message : e}`;
    }
  };

  const askDelete = async () => {
    const entry = c.variations[c.variation];
    if (entry?.kind !== 'line' || !entry.rootId) {
      setNotice({ ok: false, text: 'Select a line in the Variation list first (not Any line / Weak lines).' });
      return;
    }
    const sel = c.selected()!;
    const { moves, ends } = await client.service('lineSize', entry.rootId);
    const detail = ends > 1 ? ` — it has ${ends} lines (sidelines included)` : '';
    setDialog({ kind: 'delete', label: entry.label, detail: `Delete “${entry.label}” from ${entry.repertoire ?? sel.name}${detail}? `
      + `${moves} moves are removed. Other lines aren't touched. This can't be undone (re-import the PGN file to get it back).` });
  };

  const board = c.board();
  const buttons = c.buttons();
  const full = c.fullLine();
  const d = c.drill;
  // the Coach's ideas once a line is finished; squares light while you point at them
  const { lit, litArrows, setLit } = useCoachFocus();
  const lineOver = !!d?.finished;
  useEffect(() => { void c.coachIdeas.load(); }, [c]);
  useEffect(() => { setLit(null); c.explainIdeas(); }, [c, lineOver, board.fen, c.view]);
  const lichessText = !c.lichess ? '' : !c.lichess.connected
    ? "Not connected: when your lines branch, the computer picks the opponent's reply at random. Connect Lichess to have it reply as often as real players at your level do."
    : `Connected: the computer picks the opponent's replies as often as Lichess players ${c.lichess.describe} play them (blitz and rapid).`;

  return (
    <section className="puzzle-screen">
      <h1>Opening Drill</h1>
      <p className="lede">Your repertoire, drilled: the computer plays the other side, and only the line's own moves count.</p>
      <div className={`puzzles drill ${c.view === TREE || c.view === MY_GAMES ? 'wide-side' : ''}`}>
        <div className="card queue-card drill-side">
          <div className="segmented" role="tablist" aria-label="Views">
            {VIEWS.map((v) => (
              <button key={v} type="button" role="tab" aria-selected={c.view === v} aria-checked={c.view === v} onClick={() => c.setView(v)}>{v}</button>
            ))}
          </div>

          {c.view === 'Setup' && (
            <div className="drill-view">
              <div className="section">Repertoire</div>
              <select aria-label="Repertoire" value={c.repertoire} onChange={(e) => void c.setRepertoire(e.target.value)} disabled={!c.repertoires.length}>
                {c.repertoires.map((r) => <option key={r.label}>{r.label}</option>)}
              </select>
              <div className="section" style={{ marginTop: 10 }}>Variation</div>
              <ol className="queue variations" aria-label="Variations">
                {c.variations.map((v, i) => {
                  // grouped under the opening's name, each line by its variation alone (the full name on hover)
                  const head = v.kind === 'line' ? headOf(v.label) : null;
                  const prev = i > 0 && c.variations[i - 1].kind === 'line' ? headOf(c.variations[i - 1].label) : null;
                  return (
                    <Fragment key={`${v.kind}${v.rootId}`}>
                      {head && head !== prev && <li className="family" aria-hidden="true">{head}</li>}
                      <li className={head ? 'in-family' : undefined}>
                        <button type="button" aria-current={i === c.variation ? 'true' : undefined} title={v.label}
                          onClick={() => void c.selectVariation(i)} onDoubleClick={() => void c.start()}>{head ? variationName(v.label) : v.label}</button>
                      </li>
                    </Fragment>
                  );
                })}
              </ol>
              {c.preview && <p className="note">{c.preview}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="btn" style={{ flex: 1 }} onClick={() => void c.start()} disabled={!c.repertoires.length}>{c.startLabel}</button>
                <button type="button" className="btn secondary" onClick={() => void askDelete()} disabled={!c.repertoires.length}>Delete…</button>
              </div>
              <p className="note">Pick a variation (double-click to start), or leave it on Any line for a random one. The computer plays the other side.</p>
            </div>
          )}

          {c.view === 'Plans' && (
            <div className="drill-view plans">
              {!c.plans ? (<>
                <h2>Plans</h2>
                <p className="note">No plan notes for this opening yet. Pick a variation, or start a drill, to see its ideas here.</p>
              </>) : (<>
                <h2>{c.plans.title}</h2>
                <p>{c.plans.idea}</p>
                {c.plans.sides.map((s) => (
                  <div key={s.heading}><div className="section">{s.heading}</div><ul>{s.items.map((it) => <li key={it}>{it}</li>)}</ul></div>
                ))}
                <div className="section">Pawn structure</div>
                <p>{c.plans.structure}</p>
                <div className="section">Watch out for</div>
                <ul>{c.plans.watchOut.map((it) => <li key={it}>{it}</li>)}</ul>
              </>)}
            </div>
          )}

          {c.view === TREE && <TreePanel c={c} />}
          {c.view === MY_GAMES && <MyGamesPanel c={c} onGames={(d) => setDialog({ kind: 'games', d })}
            onAnalyze={(fen, title) => setDialog({ kind: 'analyze', fen, title })} />}

          {c.view === ADD_LINES && (
            <div className="drill-view">
              <h2>Add or edit lines</h2>
              <button type="button" className="btn wide" onClick={() => setDialog({ kind: 'library' })}>Opening library — all named openings…</button>
              <button type="button" className="btn wide secondary" onClick={() => file.current?.click()}>Import PGN file…</button>
              <input ref={file} type="file" accept=".pgn,text/plain" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) await askSave(await f.text(), 'file');
              }} />
              <button type="button" className="btn wide secondary" onClick={() => setDialog({ kind: 'paste' })}>Paste / type a line…</button>
              <button type="button" className="btn wide secondary" onClick={() => setDialog({ kind: 'lines' })}>Turn lines on/off…</button>

              <h2 style={{ marginTop: 18 }}>Real opponents (Lichess)</h2>
              <p className="note">{lichessText}{data.progress ? `\n${data.progress}` : ''}</p>
              <button type="button" className="btn wide secondary" onClick={() => setDialog({ kind: c.lichess?.connected ? 'disconnect' : 'lichess' })}>
                {c.lichess?.connected ? 'Disconnect Lichess' : 'Connect Lichess…'}</button>
            </div>
          )}
        </div>

        <div className="card board-card">
          <div className="row puzzle-head">
            <strong className="game-label line-title" title={c.drill?.lineName}>{c.lineTitle()}</strong>
            <span style={{ flex: 1 }} />
            {buttons.steps && <>
              <button type="button" className="btn secondary small" aria-label="Back" onClick={() => c.stepPreview(-1)}>◀</button>
              <button type="button" className="btn secondary small" aria-label="Forward" onClick={() => c.stepPreview(1)}>▶</button>
            </>}
          </div>
          <div className="board-row">
            <Board fen={board.fen} orientation={board.orientation} lastMove={board.lastMove} movable={board.movable}
              arrows={plusCoach(board.arrows, litArrows)} snapBack={c.misses} onMove={(uci) => void c.onMove(uci)} highlights={lit ?? NO_SQUARES} />
          </div>
          <div className="row puzzle-buttons">
            {buttons.toggle && <button type="button" className="btn secondary" onClick={() => c.toggleFullLine()}>{c.showFullLine ? 'Hide full line' : 'Show full line'}</button>}
            {buttons.retry && <button type="button" className="btn secondary" onClick={() => void c.reveal()}>Show correct move</button>}
            {(buttons.restart || buttons.end) && <>
              <button type="button" className="btn secondary" onClick={() => void c.sameLine()}>Same line</button>
              <button type="button" className="btn" onClick={() => void c.newRandomLine()}>New random line</button>
            </>}
            {buttons.end && <button type="button" className="btn secondary" onClick={() => d && setDialog({ kind: 'play', fen: d.fen, myColor: d.myColor, title: `Play it out — ${d.lineName}` })}>Play it out</button>}
          </div>
        </div>

        <div className="card commentary-card" aria-label="Commentary">
          {notice && (
            <div className={`notice ${notice.ok ? 'ok' : 'error'}`} role="status">
              <span>{notice.text}</span>
              <button type="button" className="btn ghost small" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
            </div>
          )}
          <p className={`status ${c.statusLine().tone}`} role="status">{c.statusLine().text}</p>
          {c.moveNote && <p className="move-note">{c.moveNote}</p>}
          {c.recap && <p className="explanation">{c.recap}</p>}
          {full && (
            <div className="full-line" aria-label="Full line">
              <div className="note">Full line — click a move to see it:</div>
              {full.pairs.map((p) => (
                <span key={p.n} className="move-pair">
                  <span className="num">{p.n}.</span>
                  {p.moves.map((m) => (
                    <button key={m.i} type="button" className={`mv${m.i < full.played ? ' played' : ''}${m.i + 1 === full.at ? ' at' : ''}`}
                      onClick={() => c.previewTo(m.i + 1)}>{m.san}</button>
                  ))}
                </span>
              ))}
            </div>
          )}
          {lineOver && c.view !== TREE && <IdeasPanel ideas={c.coachIdeas} onToggle={(on) => void c.coachIdeas.set(on)} onSquares={setLit} fen={board.fen} />}
          {c.view === TREE && c.tree.showsIdeas() && (
            <div className="ideas">
              <div className="note">{c.tree.ideasHeader}</div>
              <div className="lines">
                {c.tree.ideasRows.map((row, i) => (
                  <button type="button" key={row + i} className="line" onClick={() => void c.tree.followIdea(i)} title="Play this line">
                    <span className="dot" style={{ background: DOT[IDEA_BRUSHES[i] ?? 'grey'] }} />
                    <span className="pv">{row}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {c.view === MY_GAMES && c.myGames.current && <p className="explanation">{c.myGames.text}</p>}
        </div>
      </div>

      {dialog?.kind === 'save' && <SaveDialog repertoires={names} onSave={saveTo} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'paste' && <PasteDialog onNext={(text) => void askSave(text, 'paste')} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'lines' && <LinesDialog client={client} onClose={() => { setDialog(null); void c.refreshRepertoires(); }} />}
      {dialog?.kind === 'delete' && (
        <Modal title="Delete line" onClose={() => setDialog(null)}>
          <p>{dialog.detail}</p>
          <div className="row modal-buttons">
            <button type="button" className="btn" onClick={async () => { setDialog(null); await c.deleteVariation(); }}>Delete</button>
            <button type="button" className="btn secondary" onClick={() => setDialog(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'lichess' && (
        <LichessDialog onClose={() => setDialog(null)} onSaved={async (token, username) => {
          await client.service('setLichessToken', token);
          setDialog(null);
          setNotice({ ok: true, text: `Lichess connected as ${username}.` });
          await c.lichessChanged();
        }} />
      )}
      {dialog?.kind === 'disconnect' && (
        <Modal title="Disconnect Lichess" onClose={() => setDialog(null)}>
          <p>Remove the saved Lichess token? Downloaded opening data is kept.</p>
          <div className="row modal-buttons">
            <button type="button" className="btn" onClick={async () => {
              setDialog(null);
              c.openingData.stop();
              await client.service('setLichessToken', null);
              await c.lichessChanged();
            }}>Disconnect</button>
            <button type="button" className="btn secondary" onClick={() => setDialog(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {c.prompt && <PromptDialog key={c.prompt.title + c.prompt.text} c={c} />}
      {dialog?.kind === 'library' && <LibraryDialog client={client} onAdded={() => c.refreshRepertoires()} onClose={() => setDialog(null)}
        onReview={(id, fen) => { setDialog(null); onReview(id, fen); }} />}
      {dialog?.kind === 'games' && <GamesDialog c={c} d={dialog.d} onClose={() => setDialog(null)} onReview={onReview} />}
      {dialog?.kind === 'analyze' && <PlayDialog fen={dialog.fen} title={dialog.title} analyze onClose={() => setDialog(null)} />}
      {dialog?.kind === 'play' && (
        // the position when you opened it: the drill may move on behind the window
        <PlayDialog fen={dialog.fen} myColor={dialog.myColor} title={dialog.title} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}
