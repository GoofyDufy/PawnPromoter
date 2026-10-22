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
import { DrillController } from './drillController';
import { Jobs } from './jobs';
import { OpeningData } from './openingData';
import { PuzzleController } from './puzzleController';
import { AnalysisScreen } from './screens/AnalysisScreen';
import { DataScreen } from './screens/DataScreen';
import { DrillScreen } from './screens/DrillScreen';
import { ImportScreen } from './screens/ImportScreen';
import { Placeholder } from './screens/Placeholder';
import { PuzzleScreen } from './screens/PuzzleScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { StatsScreen } from './screens/StatsScreen';
import { ProgressScreen } from './screens/ProgressScreen';
import { ScoutScreen } from './screens/ScoutScreen';
import { ReviewController } from './reviewController';
import { TrainerScreen, type Trainers } from './screens/TrainerScreen';
import { SacController } from './trainer/sacController';
import { SpotController } from './trainer/spotController';
import { ThreatController } from './trainer/threatController';

export type ScreenId = 'data' | 'analysis' | 'puzzles' | 'import' | 'tactics' | 'review' | 'drill' | 'stats' | 'progress' | 'scout';

interface ScreenDef {
  id: ScreenId;
  label: string;
  phase?: number;              // not built yet: the phase that brings it
  about?: string;
}

export const SCREENS: ScreenDef[] = [
  { id: 'puzzles', label: 'Puzzle Review' },
  { id: 'tactics', label: 'Tactics & Threats' },
  { id: 'review', label: 'Game Review' },
  { id: 'drill', label: 'Opening Drill' },
  { id: 'stats', label: 'Stats' },
  { id: 'progress', label: 'Progress' },
  { id: 'scout', label: 'Opponent Prep' },
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
  useEffect(() => { if (import.meta.env.MODE === 'e2e') (window as unknown as { jobs: Jobs }).jobs = jobs; }, [jobs]);   // tests/e2e
  const onLevel = useCallback((level: LevelView) => setSummary((s) => (s ? { ...s, level } : s)), []);
  // Puzzle Review keeps its place while you visit other screens; a new one per player
  const current = profiles?.current ?? null;
  const puzzles = useMemo(() => (current ? new PuzzleController(client, sharedEngine(), onLevel) : null), [client, current, onLevel]);
  const trainers = useMemo((): Trainers | null => (current ? {
    spot: new SpotController(client, sharedEngine(), onLevel),
    threat: new ThreatController(client, sharedEngine(), onLevel),
    sac: new SacController(client, sharedEngine(), onLevel),
  } : null), [client, current, onLevel]);
  useEffect(() => {
    if (import.meta.env.MODE === 'e2e' && trainers) (window as unknown as { trainers: Trainers }).trainers = trainers;   // tests/e2e
    return () => { trainers?.spot.dispose(); trainers?.threat.dispose(); trainers?.sac.dispose(); };
  }, [trainers]);
  const review = useMemo(() => (current ? new ReviewController(client, sharedEngine()) : null), [client, current]);
  useEffect(() => {
    if (import.meta.env.MODE === 'e2e' && review) (window as unknown as { review: ReviewController }).review = review;   // tests/e2e
    return () => review?.dispose();
  }, [review]);
  /** "Review game" anywhere: Game Review, at that position. */
  const reviewGame = useCallback((gameId: string, fen: string | null = null) => {
    setScreen('review');
    void review?.openGame(gameId, fen);
  }, [review]);
  const openingData = useMemo(() => new OpeningData(client), [client]);
  const drill = useMemo(() => (current ? new DrillController(client, openingData, onLevel, sharedEngine()) : null), [client, current, openingData, onLevel]);

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

  useEffect(() => {
    if (!drill) return;
    if (import.meta.env.MODE === 'e2e') (window as unknown as { drill: DrillController }).drill = drill;   // tests/e2e reads the line
    void drill.init();
    return () => { openingData.stop(); drill.dispose(); };
  }, [drill, openingData]);

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
        <div className="brand"><img src="./icons/pawn-promoter.svg" alt="" />KingSide Coach</div>
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
          : screen === 'analysis' ? <AnalysisScreen client={client} />
            : screen === 'puzzles' ? (puzzles && <PuzzleScreen c={puzzles} onReview={reviewGame} />)
            : screen === 'review' ? (review && <ReviewScreen r={review} client={client}
              onOpenPuzzle={(id) => { setScreen('puzzles'); void puzzles?.openPuzzle(id); }}
              onPuzzlesChanged={() => { void puzzles?.reloadQueue(); void refresh(); }} />)
            : screen === 'scout' ? (profiles && <ScoutScreen client={client} />)
            : screen === 'progress' ? (profiles && <ProgressScreen client={client} actions={{
              practiceTheme: (tag) => { setScreen('puzzles'); void puzzles?.practiceTheme(tag); },
              openPuzzle: (id) => { setScreen('puzzles'); void puzzles?.openPuzzle(id); },
              reviewGame,
              threats: () => void client.service('setSettings', { trainer_mode: 'Threat?' }).then(() => setScreen('tactics')),
              tactics: () => void client.service('setSettings', { trainer_mode: 'Tactic?' }).then(() => setScreen('tactics')),
              analyze: () => setScreen('import'),
            }} />)
            : screen === 'stats' ? (profiles && <StatsScreen client={client} jobs={jobs} openingData={openingData} onReview={reviewGame}
              onDrill={(i) => { setScreen('drill'); void drill?.drillSuggestion(i); }} onRepertoireChanged={() => void drill?.refreshRepertoires()}
              onPracticeOpening={(key) => { setScreen('drill'); void drill?.practiceOpening(key); }}
              onPractice={(action) => {
                if (action === 'tactics' || action === 'threats') {
                  void client.service('setSettings', { trainer_mode: action === 'tactics' ? 'Tactic?' : 'Threat?' }).then(() => setScreen('tactics'));
                } else if (action === 'drill') setScreen('drill');
                else if (action === 'endgames') { setScreen('puzzles'); void puzzles?.setFilter('type', 'Endgames'); }
                else setScreen('puzzles');
              }} />)
            : screen === 'drill' ? (drill && <DrillScreen c={drill} client={client} onReview={reviewGame} />)
            : screen === 'tactics' ? (trainers && <TrainerScreen client={client} trainers={trainers} onReview={reviewGame} />)
              : screen === 'import' ? (profiles && (
                <ImportScreen client={client} jobs={jobs} puzzleSource={puzzles?.filters.source ?? 'My games'}
                  onFocusChange={(f) => void puzzles?.setFilter('focus', f)} />))
                : <DataScreen client={client} profiles={profiles} summary={summary}
                  onChange={async (view) => { await refresh(view); await puzzles?.reloadQueue(); await drill?.refreshRepertoires(); }} />}
      </main>
    </div>
  );
}
