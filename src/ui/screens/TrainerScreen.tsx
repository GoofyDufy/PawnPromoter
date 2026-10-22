/**
 * Tactics & Threats (trainer_page.py): Tactic? / Threat? / Sacrifice!! as three
 * modes of one page, the mode remembered. Same layout as Puzzle Review: what
 * the drill is and your scores on the left, the board in the centre, the
 * commentary on the right. The drills' logic is in src/ui/trainer/.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DbClient } from '../../data/client';
import { IDEA_BRUSHES, RANKS } from '../analysis';
import { Board } from '../Board';
import { EvalBar } from '../EvalBar';
import { CLOCK_MAX, CLOCK_PRESETS, type TrainerBase } from '../trainer/base';
import { PlayDialog } from '../PlayDialog';
import { IdeasPanel, plusCoach, useCoachFocus } from '../SquareText';
import { LICHESS_BATCH, SAC_SIDES, SAC_SOURCES, SacController } from '../trainer/sacController';
import type { SpotController } from '../trainer/spotController';
import type { ThreatController } from '../trainer/threatController';

export const TACTIC = 'Tactic?';
export const THREAT = 'Threat?';
export const SACRIFICE = 'Sacrifice!!';
const MODES = [TACTIC, THREAT, SACRIFICE];
const OLD_NAMES: Record<string, string> = { 'Is there a tactic?': TACTIC, "What's the threat?": THREAT, 'Make it work': SACRIFICE };
const DOT: Record<string, string> = { green: '#15781b', blue: '#003088', grey: '#8d8d8d' };
const NO_SQUARES: string[] = [];

const clockText = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Timed mode: off, a preset, or your own number of seconds per decision (shared by the three drills). */
function ClockPicker({ t }: { t: TrainerBase }) {
  const [custom, setCustom] = useState(false);
  const isPreset = CLOCK_PRESETS.includes(t.clockLimit);
  const showInput = custom || !isPreset;
  return (
    <div className="clock-picker">
      <label htmlFor="trainer-clock" className="note">Clock</label>
      <select id="trainer-clock" value={showInput ? 'custom' : String(t.clockLimit)}
        onChange={(e) => {
          if (e.target.value === 'custom') { setCustom(true); if (isPreset) t.setClock(t.clockLimit || 15); return; }
          setCustom(false);
          t.setClock(Number(e.target.value));
        }}>
        {CLOCK_PRESETS.map((sec) => <option key={sec} value={sec}>{sec ? `${sec} seconds` : 'Off — untimed'}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {showInput && (
        <input type="number" aria-label="Seconds per decision" min={1} max={CLOCK_MAX} value={t.clockLimit || ''}
          onChange={(e) => t.setClock(Number(e.target.value))} />
      )}
      {showInput && <span className="note">seconds</span>}
    </div>
  );
}

/** The time left for this decision: a draining bar (amber under 5 s, red under 3 s). */
function ClockBar({ t }: { t: TrainerBase }) {
  if (t.clockLeft === null || !t.clockLimit) return null;
  const left = t.clockLeft;
  const tone = left <= 3000 ? 'low' : left <= 5000 ? 'short' : '';
  return (
    <div className={`trainer-clock ${tone}`} role="timer" aria-label={`${Math.ceil(left / 1000)} seconds left`}>
      <span className="clock-time">⏱ {clockText(left)}</span>
      {!t.clockRunning && left > 0 && <span className="note">paused</span>}
      <span className="clock-track"><span style={{ width: `${Math.max(0, Math.min(100, (100 * left) / (t.clockLimit * 1000)))}%` }} /></span>
    </div>
  );
}

export interface Trainers {
  spot: SpotController;
  threat: ThreatController;
  sac: SacController;
}

export function TrainerScreen({ client, trainers, onReview }: {
  client: DbClient;
  trainers: Trainers;
  onReview: (gameId: string, fen: string) => void;
}) {
  const [mode, setMode] = useState<string | null>(null);

  useEffect(() => {
    void client.service('getSettings', ['trainer_mode']).then((s) => {
      const saved = OLD_NAMES[s.trainer_mode ?? ''] ?? s.trainer_mode;
      setMode(saved && MODES.includes(saved) ? saved : TACTIC);
    });
  }, [client]);

  const t: TrainerBase | null = mode === THREAT ? trainers.threat : mode === SACRIFICE ? trainers.sac : mode ? trainers.spot : null;
  useSyncExternalStore(t ? t.subscribe : () => () => {}, () => t?.version ?? 0);
  // the Coach's ideas once the answer is shown; squares light while you point at them
  const { lit, litArrows, setLit } = useCoachFocus();
  const answerShown = !!t && !t.liveAnalysis() && !!t.stockfishLines();
  useEffect(() => { if (t) void t.coachIdeas.load(); }, [t]);
  useEffect(() => { setLit(null); t?.explainIdeas(); }, [t, answerShown, t?.fen]);

  useEffect(() => { if (t) void t.loadClock().then(() => t.onShown()); }, [t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (!t || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.altKey || e.metaKey) return;
      if (['y', 'n', 'h', 'Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
        t.key(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t]);

  const choose = (m: string) => {
    setMode(m);
    void client.service('setSettings', { trainer_mode: m });
  };

  if (!t) return <section className="puzzle-screen"><h1>Tactics &amp; Threats</h1></section>;
  const press = (id: string) => {
    if (id === 'review') {
      const g = t.gameAt();
      if (g) onReview(g.gameId, g.fen);
      return;
    }
    void t.press(id);
  };
  const sac = t instanceof SacController ? t : null;
  const live = t.liveAnalysis();
  const lines = live ? null : t.stockfishLines();

  return (
    <section className="puzzle-screen">
      <h1>Tactics &amp; Threats</h1>
      <p className="lede">Three drills on positions from your own games.</p>
      <div className="puzzles">
        <div className="card queue-card trainer-info">
          <div className="segmented" role="tablist" aria-label="Drill">
            {MODES.map((m) => <button key={m} type="button" role="tab" aria-selected={mode === m} aria-checked={mode === m} onClick={() => choose(m)}>{m}</button>)}
          </div>
          <ClockPicker t={t} />
          <h2>{t.title}</h2>
          {sac && <div className="sac-switches">
            <div className="segmented" role="radiogroup" aria-label="Side">
              {SAC_SIDES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={sac.side === k} onClick={() => sac.setSide(k)}>{label}</button>)}
            </div>
            <div className="segmented" role="radiogroup" aria-label="Sacrifices from">
              {SAC_SOURCES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={sac.sourceFilter === k} onClick={() => sac.setSource(k)}>{label}</button>)}
            </div>
          </div>}
          <p className="note pre">{t.intro}</p>
          <div className="section">This session</div>
          <div className="stat-line">{t.sessionLine()}</div>
          <p className="note">{t.sessionDetail()}</p>
          <div className="section">All time</div>
          <p className="pre">{t.allTime}</p>
          {sac && <>
            <p className="note">{sac.poolText}</p>
            <button type="button" className="btn secondary" disabled={sac.lichessBusy} onClick={() => void sac.addLichess()}>
              {sac.lichessBusy ? 'Adding Lichess sacrifices…' : `+ ${LICHESS_BATCH} Lichess sacrifice puzzles`}</button>
          </>}
        </div>

        <div className="card board-card">
          <div className="row puzzle-head"><span className="note game-label">{t.source}</span><ClockBar t={t} /></div>
          <div className="board-row">
            <EvalBar cpWhite={t.evalWhite} mate={t.evalWhite === null ? null : t.evalMate} orientation={t.orientation} blank={t.evalWhite === null} />
            <Board fen={t.fen ?? '8/8/8/8/8/8/8/8 w - - 0 1'} orientation={t.orientation} lastMove={t.lastMove} arrows={plusCoach(t.arrows, litArrows)}
              movable={t.fen ? t.movable : null} onMove={(uci) => void t.onMove(uci)} highlights={lit ?? NO_SQUARES} />
          </div>
          <div className="row puzzle-buttons">
            {t.buttons.map((b) => (
              <button key={b.id} type="button" className={`btn ${b.primary ? '' : 'secondary'}`} disabled={b.disabled}
                aria-label={b.label === '◀' ? 'Back' : b.label === '▶' ? 'Forward' : undefined} onClick={() => press(b.id)}>{b.label}</button>
            ))}
          </div>
        </div>

        <div className="card commentary-card" aria-label="Commentary">
          {live ? (
            <div className="ideas">
              <div className="row"><strong>{live.panel.title}</strong><span className="note">{live.panel.header}</span></div>
              <div className="lines">
                {live.panel.rows.map((row, i) => (
                  <button type="button" key={row + i} className="line" onClick={() => live.follow(i)} title="Play this line">
                    <span className="dot" style={{ background: DOT[IDEA_BRUSHES[i] ?? 'grey'] }} />
                    <span className="pv">{row}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (<>
            <p className={`status ${t.status.tone}`} role="status">{t.status.text}</p>
            {t.detail && <p className="explanation">{t.detail}</p>}
            {sac?.branchesNote && (
              <div className="sac-branches">
                <p className="note">{sac.branchesNote}</p>
                {sac.branches.map((b, i) => (
                  <button key={b.label} type="button" className="btn secondary" onClick={() => void sac.press(`branch${i}`)}>
                    {b.result === 'clean' ? '✓ ' : b.result === 'helped' ? '✓ (with help) ' : ''}{b.label}
                  </button>
                ))}
              </div>
            )}
            {lines && <IdeasPanel ideas={t.coachIdeas} onToggle={(on) => void t.coachIdeas.set(on)} onSquares={setLit} fen={t.fen} />}
            {lines && (
              <div className="ideas stockfish-lines">
                <div className="row"><strong>Stockfish</strong><span className="note">{lines.header}</span></div>
                <div className="lines">
                  {lines.rows.map((row, i) => (
                    <button type="button" key={row + i} className="line" onClick={() => void t.press(`line${i}`)} title="Explore this line on the board">
                      <span className="rank">{RANKS[i]}</span>
                      <span className="pv">{row}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>)}
        </div>
      </div>
      {sac?.playing && <PlayDialog fen={sac.playing.fen} title={sac.playing.title} myColor={sac.playing.color} onClose={() => sac.closePlay()} />}
    </section>
  );
}
