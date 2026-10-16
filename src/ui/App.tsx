/**
 * The app shell (gui.py's role): sidebar with every screen, the level card and
 * the player switcher; the screen on the right. Screens from later phases say
 * what they'll do and when.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { DbClient } from '../data/client';
import type { ProfilesView } from '../data/dbWorker';
import type { LevelView, Summary } from '../data/services';
import { sharedEngine } from '../engine/stockfish';
import { Jobs } from './jobs';
import { PuzzleController } from './puzzleController';
import { AnalysisScreen } from './screens/AnalysisScreen';
import { DataScreen } from './screens/DataScreen';
import { ImportScreen } from './screens/ImportScreen';
import { Placeholder } from './screens/Placeholder';
import { PuzzleScreen } from './screens/PuzzleScreen';

export type ScreenId = 'data' | 'analysis' | 'puzzles' | 'import' | 'tactics' | 'review' | 'drill' | 'stats' | 'progress' | 'scout';

interface ScreenDef {
  id: ScreenId;
  label: string;
  phase?: number;              // not built yet: the phase that brings it
  about?: string;
}

export const SCREENS: ScreenDef[] = [
  { id: 'puzzles', label: 'Puzzle Review' },
  { id: 'tactics', label: 'Tactics & Threats', phase: 5,
    about: "Three drills: Is there a tactic?, What's the threat?, and Sacrifice!! — find the follow-up that makes a sacrifice work." },
  { id: 'review', label: 'Game Review', phase: 5,
    about: 'Step through any analyzed game: evaluation graph, move badges (!!, !, ✓, ?!, ?, ??), accuracy, and where it left your prep.' },
  { id: 'drill', label: 'Opening Drill', phase: 4,
    about: 'Your repertoire, drilled against the moves real players at your level make — plus the opening library, the tree, and My games.' },
  { id: 'stats', label: 'Stats', phase: 5,
    about: 'Results by opening, how you lose, accuracy by phase, time pressure, your playing style, and repertoire gaps.' },
  { id: 'progress', label: 'Progress', phase: 5,
    about: 'Rating against your goal, blunders per game, your themes weakest first, and your week in review.' },
  { id: 'scout', label: 'Opponent Prep', phase: 5,
    about: "Scout any chess.com player's openings and see whether your repertoire covers them." },
  { id: 'import', label: 'Import & Analyze' },
  { id: 'analysis', label: 'Analysis board' },
  { id: 'data', label: 'Your data' },
];

export function App({ client }: { client: DbClient }) {
  const [screen, setScreen] = useState<ScreenId>('puzzles');
  const [profiles, setProfiles] = useState<ProfilesView | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the long-running work (import, analysis, Lichess) outlives screen switches
  const jobs = useMemo(() => new Jobs(client), [client]);
  const jobsState = useSyncExternalStore(useCallback((l: () => void) => jobs.subscribe(l), [jobs]), () => jobs.state);
  const onLevel = useCallback((level: LevelView) => setSummary((s) => (s ? { ...s, level } : s)), []);
  // Puzzle Review keeps its place while you visit other screens; a new one per player
  const current = profiles?.current ?? null;
  const puzzles = useMemo(() => (current ? new PuzzleController(client, sharedEngine(), onLevel) : null), [client, current, onLevel]);

  const refresh = useCallback(async (view?: ProfilesView) => {
    try {
      setProfiles(view ?? (await client.profiles()));
      setSummary(await client.service('summary'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    client.init().then(refresh).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, refresh]);

  useEffect(() => {
    if (!puzzles) return;
    if (import.meta.env.MODE === 'e2e') (window as unknown as { puzzles: PuzzleController }).puzzles = puzzles;   // tests/e2e reads the puzzle shown
    void puzzles.init();
    // puzzles left without a kind (e.g. a stopped run): sorted in the background
    const timer = setTimeout(() => void jobs.classify(), 3000);
    return () => { clearTimeout(timer); jobs.pauseClassifying(); puzzles.dispose(); };
  }, [puzzles, jobs]);

  // new or rebuilt puzzles: the queue again, and the level / counts
  useEffect(() => {
    if (puzzles && jobsState.puzzlesVersion) {
      void puzzles.reloadQueue();
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsState.puzzlesVersion]);

  // puzzles from an analysis still running: shown at once if the queue is empty
  // (a queue you're working through is left alone until the run ends)
  useEffect(() => {
    if (puzzles && jobsState.puzzlesFound && !puzzles.queue.length) void puzzles.reloadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsState.puzzlesFound]);

  const shown = SCREENS.find((s) => s.id === screen)!;
  const level = summary?.level;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><img src="./icons/pawn-promoter.svg" alt="" />Pawn Promoter</div>
        <nav className="nav" aria-label="Screens">
          {SCREENS.map((s) => (
            <button key={s.id} type="button" aria-current={s.id === screen ? 'page' : undefined} onClick={() => setScreen(s.id)}>
              <span>{s.label}</span>{s.phase && <span className="soon">Phase {s.phase}</span>}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {level && (
          <div className="level-card" aria-label="Your level">
            <div className="name">{level.name}</div>
            <div className="xp">{level.totalXp} XP{level.xpForLevel ? ` · ${level.xpIntoLevel}/${level.xpForLevel} to the next level` : ''}</div>
            <div className="progress"><div style={{ width: `${Math.round(level.progress * 100)}%` }} /></div>
          </div>
        )}
        {profiles && (
          <div className="player">
            <label htmlFor="player">Player</label>
            <select id="player" value={profiles.current} disabled={jobsState.busy !== null || jobsState.lichess.busy}
              title={jobsState.busy ? 'Wait for the import / analysis to finish' : undefined}
              onChange={async (e) => refresh(await client.switchProfile(e.target.value))}>
              {profiles.players.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        )}
      </aside>
      <main className="main">
        {error && <p className="error" role="alert">Something went wrong with your database: {error}</p>}
        {!profiles && !error && (
          <p className="note" role="status">
            Opening your database… The first visit sets up storage on this device and can take a few seconds.
          </p>
        )}
        {shown.phase ? <Placeholder title={shown.label} phase={shown.phase} about={shown.about!} />
          : screen === 'analysis' ? <AnalysisScreen />
            : screen === 'puzzles' ? (puzzles && <PuzzleScreen c={puzzles} />)
              : screen === 'import' ? (profiles && (
                <ImportScreen client={client} jobs={jobs} puzzleSource={puzzles?.filters.source ?? 'My games'}
                  onFocusChange={(f) => void puzzles?.setFilter('focus', f)} />))
                : <DataScreen client={client} profiles={profiles} summary={summary}
                  onChange={async (view) => { await refresh(view); await puzzles?.reloadQueue(); }} />}
      </main>
    </div>
  );
}
