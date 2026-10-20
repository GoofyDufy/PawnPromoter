/**
 * Threat? — What's the threat? (threat_tab.py, rules in threat.ts): right after
 * your opponent moved, name their threat (play the move THEY want to make
 * next, or No threat), then answer it with your move.
 *
 * Web-app additions: after you name the threat the board waits (Now answer it →)
 * so you can see whether you were right; after your answer it stays on your
 * move, says why a weak answer is weak (explain.ts, as in Game Review), and ▶
 * steps through how your opponent punishes it; then Stockfish's top lines and
 * the analysis board.
 */
import { Board, WHITE } from '../../core/chess';
import * as explain from '../../core/explain';
import { pyFixed } from '../../core/format';
import * as threat from '../../core/threat';
import type { Arrow } from '../Board';
import { pct, TrainerBase } from './base';

const MAX_TRIES = 30;                    // candidates checked before taking either kind
const GIVE_UP_TRIES = 80;

type State = 'idle' | 'loading' | 'naming' | 'judging_threat' | 'named' | 'answering' | 'judging_answer' | 'result';
const PUNISH_DEPTH = 14;
const PUNISH_PLIES = 5;

export class ThreatController extends TrainerBase {
  title = "What's the threat?";
  intro = "Most mistakes start with not noticing what the opponent's last move threatens. "
    + 'Positions from your own games, right after your opponent moved.\n\n'
    + '1. Name the threat: play the move THEY want to make next (you can move their pieces), or press No threat.\n'
    + '2. Then answer it with your move.\n\n'
    + `About ${Math.round(threat.NO_THREAT_SHARE * 4)} in 4 positions have no real threat. `
    + `+${threat.FOUND_XP} XP for naming the threat (or rightly saying there's none), `
    + `+${threat.ANSWER_XP} XP for a good answer (within ${pyFixed(threat.MOVE_OK_CP / 100, 1)} pawns of the best).`;

  private state: State = 'idle';
  private pools: { yes: threat.Candidate[]; no: threat.Candidate[] } = { yes: [], no: [] };
  private seen = new Set<string>();
  private ready: { cand: threat.Candidate; assessment: threat.Assessment; previous: string; previousSan: string | null } | null = null;
  private preparing = false;
  private waiting = false;
  private cand: threat.Candidate | null = null;
  private assessment: threat.Assessment | null = null;
  private board: Board = Board.fromFen();
  private previous: string | null = null;
  private found = false;
  private shownThreat: threat.Threat | null = null;
  private named: { board: Board; arrows: Arrow[]; lastMove: string | null } | null = null;
  // the result: [your answer, then how they punish it]; 0 = the start (with the arrows), 1 = after your answer
  private resultLine: string[] = [];
  private view = 1;
  private resultArrows: Arrow[] = [];
  private answerGood = true;
  private session = { rounds: 0, found: 0, answers: 0, streak: 0, best: 0 };

  sessionLine(): string {
    const s = this.session;
    return s.rounds ? `Streak ${s.streak}  ·  best ${s.best}` : 'Streak 0';
  }

  sessionDetail(): string {
    const s = this.session;
    return s.rounds ? `Threats named ${s.found}/${s.rounds} · good answers ${s.answers}/${s.rounds}`
      : 'A round counts toward your streak when you name the threat and answer it well.';
  }

  private async refreshScores(): Promise<void> {
    const a = await this.client.service('threatSummary');
    this.allTime = !a.rounds ? 'No rounds played yet.'
      : `Threats spotted: ${pct(a.found, a.threats)} (${a.found}/${a.threats})\n`
        + `Calm positions called right: ${pct(a.calm_right, a.calm)} (${a.calm_right}/${a.calm})\n`
        + `Good answers: ${pct(a.answers_ok, a.rounds)} (${a.answers_ok}/${a.rounds})`;
    this.changed();
  }

  async onShown(): Promise<void> {
    if (this.state !== 'idle') return;
    this.seen = new Set(await this.client.service('threatSeen'));
    void this.refreshScores();
    await this.nextRound();
  }

  override key(k: string): void {
    if (k === 'n') void this.noThreat();
    else if ((k === 'Enter' || k === ' ') && this.state === 'named') this.startAnswer();
    else if (k === 'Enter' || k === ' ') void this.nextRound();
    else if (this.exploreKey(k)) return;
    else if (k === 'ArrowLeft') this.step(-1);
    else if (k === 'ArrowRight') this.step(1);
  }

  press(id: string): Promise<void> | void {
    if (this.explorePress(id, () => this.showView(this.view))) return;
    if (id === 'none') return this.noThreat();
    if (id === 'answer') return this.startAnswer();
    if (id === 'back') return this.step(-1);
    if (id === 'fwd') return this.step(1);
    if (id === 'next') return this.nextRound();
  }

  gameAt(): { gameId: string; fen: string } | null {
    return this.cand ? { gameId: this.cand.game_id, fen: this.cand.fen } : null;
  }

  private threatArrows(): Arrow[] {
    const t = this.shownThreat;
    return t ? [{ from: t.move.slice(0, 2), to: t.move.slice(2, 4), brush: 'red' }] : [];
  }

  // ---------- rounds ----------

  async nextRound(): Promise<void> {
    if (!['idle', 'result', 'loading'].includes(this.state)) return;
    this.endExplore();
    if (!this.ready) {
      this.state = 'loading';
      this.waiting = true;
      this.buttons = [];
      this.show(null);
      this.evalWhite = null;
      this.source = '';
      this.setStatus('Finding a position…', 'muted', '');
      this.changed();
      void this.prepare();
      return;
    }
    const r = this.ready;
    this.ready = null;
    this.waiting = false;
    this.token = {};
    this.cand = r.cand;
    this.assessment = r.assessment;
    this.previous = r.previous;
    this.board = Board.fromFen(r.cand.fen);
    this.found = false;
    this.shownThreat = null;
    this.seen.add(r.cand.fen);
    this.state = 'naming';
    this.orientation = this.board.turn;
    // their move: the position with you passing, so you can move their pieces
    const passed = threat.passed(this.board);
    this.show(passed, { lastMove: this.previous, movable: passed.turn });
    this.evalWhite = null;
    this.source = await this.client.service('gameSource', r.cand.game_id, r.cand.ply);
    const them = this.board.turn === WHITE ? 'Black' : 'White';
    this.setStatus(`${them}${r.previousSan ? ` played ${r.previousSan}` : ''}. What does it threaten?`, 'normal',
      `Play the move ${them} wants to make next — or press No threat.`);
    this.buttons = [{ id: 'none', label: 'No threat  (N)' }];
    this.changed();
    void this.prepare();
  }

  private async noThreat(): Promise<void> {
    if (this.state !== 'naming') return;
    this.threatNamed(null, false, 0);
  }

  async onMove(uci: string): Promise<void> {
    if (this.exploreMove(uci)) return;
    const a = this.assessment;
    if (!a) return;
    if (this.state === 'naming') {
      const shown = threat.passed(this.board);
      shown.push(uci);
      this.show(shown, { lastMove: uci });
      this.state = 'judging_threat';
      this.detail = 'Checking…';
      this.changed();
      if (this.noEngine()) return;
      const token = this.token;
      const [real, gain] = await threat.judgeThreat(this.engine!, this.board, a, uci);
      if (token === this.token && this.state === 'judging_threat') this.threatNamed(uci, real, gain);
    } else if (this.state === 'answering') {
      const shown = this.board.copy();
      shown.push(uci);
      this.show(shown, { lastMove: uci, arrows: this.threatArrows() });
      this.state = 'judging_answer';
      this.detail = 'Checking your answer…';
      this.changed();
      const token = this.token;
      const [good, loss] = await threat.judgeAnswer(this.engine, this.board, a, uci);
      if (token === this.token && this.state === 'judging_answer') await this.answered(uci, good, loss);
    }
  }

  /** Step 1 done: say whether you saw it, show the threat, then ask for your answer. */
  private threatNamed(move: string | null, real: boolean, gain: number): void {
    const a = this.assessment!;
    let text: string;
    if (move === null) {                                   // "No threat"
      this.found = !a.has_threat;
      text = this.found ? '✓ Right — no real threat here.' : `✗ There is one: ${threat.describe(this.board, a.threats[0])}.`;
      this.shownThreat = a.has_threat ? a.threats[0] : null;
    } else if (real) {
      this.found = true;
      this.shownThreat = { move, gain, mate_in: null };
      text = `✓ Yes — ${threat.describe(this.board, this.shownThreat)}.`;
    } else {
      this.found = false;
      this.shownThreat = a.has_threat ? a.threats[0] : null;
      const san = threat.passed(this.board).san(move);
      text = a.has_threat ? `✗ ${san} isn't much of a threat. The real one: ${threat.describe(this.board, a.threats[0])}.`
        : `✗ No real threat here — ${san} wouldn't gain them much.`;
    }
    // stay on it so you can see: your move kept if it was the threat, else your guess (blue) and theirs (red)
    const passed = threat.passed(this.board);
    if (move !== null && real) {
      const after = passed.copy();
      after.push(move);
      this.named = { board: after, lastMove: move, arrows: [] };
    } else {
      const arrows: Arrow[] = move !== null ? [arrowOf(move, 'blue')] : [];
      this.named = { board: passed, lastMove: this.previous, arrows: [...arrows, ...this.threatArrows()] };
    }
    this.setStatus(text, this.found ? 'success' : 'error',
      move !== null && !real ? 'Blue: your guess' + (this.shownThreat ? ' · red: their real threat.' : '.') : '');
    this.state = 'named';
    this.show(this.named.board, { lastMove: this.named.lastMove, arrows: this.named.arrows });
    this.buttons = [{ id: 'answer', label: 'Now answer it →  (Enter)', primary: true }];
    this.changed();
  }

  /** Step 2: back to the position, your move. */
  private startAnswer(): void {
    if (this.state !== 'named') return;
    this.state = 'answering';
    this.setStatus(this.shownThreat ? `Now deal with it: ${threat.describe(this.board, this.shownThreat)}.` : 'Now play a good move.', 'normal',
      this.shownThreat ? 'Your move. Red arrow: their threat.' : 'Your move.');
    this.show(this.board, { lastMove: this.previous, arrows: this.threatArrows(), movable: this.board.turn });
    this.buttons = [];
    this.changed();
  }

  private async answered(move: string, good: boolean, loss: number): Promise<void> {
    const a = this.assessment!;
    const cand = this.cand!;
    this.state = 'result';
    this.onLevel(await this.client.service('threatRecord', cand.fen, a.has_threat, this.found, good));
    const s = this.session;
    s.rounds += 1;
    s.found += this.found ? 1 : 0;
    s.answers += good ? 1 : 0;
    s.streak = this.found && good ? s.streak + 1 : 0;
    s.best = Math.max(s.best, s.streak);
    const san = this.board.san(move);
    const best = this.board.san(a.best);
    const verdict = good && move === a.best ? `✓ ${san} — the best answer.`
      : good ? `✓ ${san} — a good answer (only ${pyFixed(loss / 100, 1)} pawns off ${best}).`
        : `✗ ${san} is ${pyFixed(loss / 100, 1)} pawns worse than ${best}.`;
    this.setStatus(`${this.found ? '✓ Threat' : '✗ Threat'} · ${verdict}`,
      this.found && good ? 'success' : this.found || good ? 'warning' : 'error');
    const detail: string[] = [];
    if (this.shownThreat) detail.push(`Their threat: ${threat.describe(this.board, this.shownThreat)}.`);
    const played = cand.played_uci;
    if (this.board.isLegal(played)) {
      detail.push(`In your game you played ${this.board.san(played)}`
        + (played === move ? ' — the same.' : cand.expect_threat ? ' — the mistake this position comes from.' : '.'));
    }
    detail.push('On the starting position (◀): green — the best answer · red — their threat · blue — your answer · yellow — your game move.');
    const arrows: Arrow[] = [...this.threatArrows()];
    if (played !== a.best && played !== move && this.board.isLegal(played)) arrows.push(arrowOf(played, 'yellow'));
    if (move !== a.best) arrows.push(arrowOf(move, 'blue'));
    arrows.push(arrowOf(a.best, 'green'));
    this.resultArrows = arrows;
    this.resultLine = [move];
    this.answerGood = good;
    this.detail = `${detail.join('\n')}\n\n${good && move === a.best ? 'Why it works' : 'Why'}: working it out…`;
    this.setBar(a.best_cp - loss, this.board.turn);
    this.showView(1);                                     // stay on your answer
    this.changed();
    void this.refreshScores();
    void this.explainAnswer(move, good, detail);
  }

  /** Why your answer was weak (or why the best one works), and the line that punishes a weak one. */
  private async explainAnswer(move: string, good: boolean, detail: string[]): Promise<void> {
    const a = this.assessment!;
    const token = this.token;
    let why: string;
    let punish: string[] = [];
    try {
      why = await explain.explainSolution(this.board.fen(), a.best, move === a.best ? null : move, this.engine, false);
    } catch (e) {
      why = `(Couldn't work it out: ${e instanceof Error ? e.message : e})`;
    }
    if (!good && this.engine) {
      try {
        const after = this.board.copy();
        after.push(move);
        if (!after.isGameOver()) punish = (await this.engine.analyse(after, { depth: PUNISH_DEPTH }))[0]?.pv.slice(0, PUNISH_PLIES) ?? [];
      } catch {
        /* no line to step through; the explanation stays */
      }
    }
    if (token !== this.token || this.state !== 'result') return;
    this.resultLine = [move, ...punish];
    const steps = punish.length ? `\n▶ steps through how ${this.board.turn === WHITE ? 'Black' : 'White'} punishes ${this.board.san(move)}.` : '';
    this.setResultDetail(`${detail.join('\n')}\n\n${good && move === a.best ? 'Why it works' : 'Why'}: ${why}${steps}`);
    if (!this.isExploring) this.updateButtons();
    this.changed();
  }

  private updateButtons(): void {
    this.buttons = [
      { id: 'back', label: '◀', disabled: this.view <= 0 },
      { id: 'fwd', label: '▶', disabled: this.view >= this.resultLine.length },
      { id: 'next', label: 'Next position →', primary: true },
      { id: 'analyze', label: 'Analyze' },
      { id: 'review', label: 'Review game' },
    ];
  }

  private step(delta: number): void {
    if (this.state !== 'result') return;
    this.showView(Math.max(0, Math.min(this.resultLine.length, this.view + delta)));
    this.changed();
  }

  /** 0: the start with the arrows; 1: after your answer (their punishing reply in red); then along that line. */
  private showView(i: number): void {
    this.view = i;
    const b = this.board.copy();
    for (const m of this.resultLine.slice(0, i)) b.push(m);
    let arrows: Arrow[] = [];
    if (i === 0) arrows = this.resultArrows;
    else if (i < this.resultLine.length && !this.answerGood) arrows = [arrowOf(this.resultLine[i], 'red')];
    this.show(b, { lastMove: i === 0 ? this.previous : this.resultLine[i - 1], arrows });
    this.updateButtons();
    this.peekAt(b);
  }

  // ---------- preparing rounds ----------

  private async prepare(): Promise<void> {
    if (this.ready || this.preparing) return;
    if (!this.engine) {
      if (this.waiting) this.noEngine();
      return;
    }
    this.preparing = true;
    let want = threat.wantThreat();
    try {
      for (let tries = 0; tries < GIVE_UP_TRIES; tries++) {
        const kind = want ? 'yes' : 'no';
        if (!this.pools[kind].length) this.pools[kind] = await this.client.service('threatCandidates', want, [...this.seen]);
        if (!this.pools[kind].length) {
          const other = want ? 'no' : 'yes';
          if (!this.pools[other].length) this.pools[other] = await this.client.service('threatCandidates', !want, [...this.seen]);
          if (!this.pools[other].length) {
            if (this.waiting) {
              this.setStatus('No positions yet — import and analyze some games first (Import & Analyze).', 'muted');
              this.changed();
            }
            return;
          }
          want = !want;
        }
        const cand = this.pools[want ? 'yes' : 'no'].pop()!;
        const last = await this.client.service('lastMoveOf', cand.game_id, cand.ply);
        const board = Board.fromFen(cand.fen);
        const assessment = board.isGameOver() ? null : await threat.assess(this.engine, board);
        if (assessment && last.uci && (assessment.has_threat === want || tries + 1 >= MAX_TRIES)) {
          this.ready = { cand, assessment, previous: last.uci, previousSan: last.san };
          this.preparing = false;
          if (this.waiting) await this.nextRound();
          return;
        }
      }
      if (this.waiting) {
        this.setStatus("Couldn't find a suitable position — analyze more games, then try again.", 'muted');
        this.changed();
      }
    } catch (e) {
      this.setStatus(`Engine error: ${e instanceof Error ? e.message : e}`, 'error');
      this.changed();
    } finally {
      this.preparing = false;
    }
  }
}

const arrowOf = (uci: string, brush: Arrow['brush']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), brush });
