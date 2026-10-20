/**
 * Tactic? — Spot the Tactic (spot_tab.py, rules in spot.ts): a position from
 * your games, "is there a tactic here?", then your move — the whole forcing
 * line for a tactic (the opponent's replies played for you), one sensible
 * move for a quiet position. Scored, with streaks. The next round is prepared
 * while you play this one.
 *
 * Web-app additions: Hint (what to look for → the piece → the move; a hinted
 * move isn't scored), the board stays where you finished, arrows for your moves
 * (blue) and your game's move (yellow), and Stockfish's top lines after the
 * round, each opening the analysis board.
 */
import { Board, parseSquare, WHITE } from '../../core/chess';
import * as spot from '../../core/spot';
import { pyFixed } from '../../core/format';
import type { Arrow } from '../Board';
import { numbered, pct, TrainerBase } from './base';

// candidates to classify before accepting a round of the other kind: real (forcing)
// tactics are ~1 in 7 of the likely-tactic positions; quiet positions are easy to find
const MAX_TRIES = { quiet: 60, tactic: 15 };       // keyed by what was wanted
const GIVE_UP_TRIES = 120;
const REPLY_DELAY_MS = 600;

type State = 'idle' | 'loading' | 'question' | 'move' | 'judging' | 'missed' | 'reply' | 'result';
const HINT_LABELS = ['Hint  (H)', 'Another hint  (H)', 'Show the move  (H)'];

export class SpotController extends TrainerBase {
  title = 'Spot the Tactic';
  intro = 'Positions from your own games. First decide: is there a tactic? Then play your move.\n\n'
    + 'A tactic means you can force mate, win material by force, or only one move works. '
    + `About ${Math.round(spot.QUIET_SHARE * 3)} in 3 positions are quiet — any sensible move is fine there, `
    + "so don't burn time hunting for something that isn't there.\n\n"
    + `Scoring: +${spot.CALL_XP} XP for the right answer, +${spot.MOVE_XP} XP for a good move — in a tactic position `
    + `only the best move counts; in a quiet one any move within ${pyFixed(spot.MOVE_OK_CP / 100, 1)} pawns of the best.`;

  private state: State = 'idle';
  private pools: { quiet: spot.Candidate[]; tactic: spot.Candidate[] } = { quiet: [], tactic: [] };
  private seen = new Set<string>();
  private ready: { cand: spot.Candidate; verdict: spot.Verdict } | null = null;
  private preparing = false;
  private waiting = false;
  private cand: spot.Candidate | null = null;
  private verdict: spot.Verdict | null = null;
  private board: Board = Board.fromFen();
  private cur: Board = Board.fromFen();
  private saidTactic: boolean | null = null;
  private ply = 0;
  private tries = 0;
  private missedAny = false;
  private lastTry: { before: Board; move: string; loss: number | null } | null = null;
  private line: string[] = [];
  private lineEvals: number[] = [];
  private lineIndex: number | null = null;     // null: where you finished
  private played: string[] = [];               // the moves on the board this round (yours and the replies)
  private tried = new Map<number, string>();   // ply -> your latest try there (right or wrong)
  private hint = 0;                            // hints shown for the current move (0–3)
  private hinted = false;
  private session = { rounds: 0, calls: 0, moves: 0, streak: 0, best: 0 };

  sessionLine(): string {
    const s = this.session;
    return s.rounds ? `Streak ${s.streak}  ·  best ${s.best}` : 'Streak 0';
  }

  sessionDetail(): string {
    const s = this.session;
    return s.rounds ? `Right calls ${s.calls}/${s.rounds} · good moves ${s.moves}/${s.rounds}`
      : 'A round counts toward your streak when both your call and your move are right.';
  }

  private async refreshScores(): Promise<void> {
    const a = await this.client.service('spotSummary');
    this.allTime = !a.rounds ? 'No rounds played yet.'
      : `Tactics spotted: ${pct(a.spotted, a.tactics)} (${a.spotted}/${a.tactics})\n`
        + `False alarms on quiet positions: ${pct(a.false_alarms, a.quiet)} (${a.false_alarms}/${a.quiet})\n`
        + `Good moves: ${pct(a.moves_ok, a.rounds)} (${a.moves_ok}/${a.rounds})`;
    this.changed();
  }

  async onShown(): Promise<void> {
    if (this.state !== 'idle') return;
    this.seen = new Set(await this.client.service('spotSeen'));
    void this.refreshScores();
    await this.nextRound();
  }

  override key(k: string): void {
    if (k === 'y') void this.answer(true);
    else if (k === 'n') void this.answer(false);
    else if (k === 'h') this.giveHint();
    else if (k === 'Enter' || k === ' ') void this.nextRound();
    else if (this.exploreKey(k)) return;
    else if (k === 'ArrowLeft') this.step(-1);
    else if (k === 'ArrowRight') this.step(1);
  }

  press(id: string): Promise<void> | void {
    if (this.explorePress(id, () => this.redrawResult())) return;
    if (id === 'yes') return this.answer(true);
    if (id === 'no') return this.answer(false);
    if (id === 'retry') return this.tryAgain();
    if (id === 'reveal') return this.reveal();
    if (id === 'back') return this.step(-1);
    if (id === 'fwd') return this.step(1);
    if (id === 'next') return this.nextRound();
    if (id === 'hint') return this.giveHint();
  }

  /** The game, for Review game. */
  gameAt(): { gameId: string; fen: string } | null {
    return this.cand ? { gameId: this.cand.game_id, fen: this.cand.fen } : null;
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
    ({ cand: this.cand, verdict: this.verdict } = this.ready);
    this.ready = null;
    this.waiting = false;
    this.token = {};
    this.board = Board.fromFen(this.cand.fen);
    this.cur = this.board.copy();
    this.saidTactic = null;
    this.line = [];
    this.lineEvals = [];
    this.lineIndex = null;
    this.tries = 0;
    this.missedAny = false;
    this.played = [];
    this.tried = new Map();
    this.hint = 0;
    this.hinted = false;
    this.ply = 0;
    this.state = 'question';
    this.seen.add(this.cand.fen);
    this.orientation = this.board.turn;
    this.show(this.board);
    this.evalWhite = null;
    this.source = await this.client.service('gameSource', this.cand.game_id, this.cand.ply);
    this.setStatus(`${this.board.turn === WHITE ? 'White' : 'Black'} to move. Is there a tactic?`, 'normal', '');
    this.buttons = [{ id: 'yes', label: 'Yes — a tactic  (Y)', primary: true }, { id: 'no', label: 'No — nothing  (N)' }];
    this.changed();
    void this.prepare();                // the next one, while you think
  }

  private async answer(saidTactic: boolean): Promise<void> {
    if (this.state !== 'question' || !this.verdict) return;
    this.saidTactic = saidTactic;
    const right = saidTactic === this.verdict.is_tactic;
    const text = right && saidTactic ? "✓ Right — there's a tactic. Find it!"
      : right ? '✓ Right — nothing special here. Play a good, sensible move.'
        : saidTactic ? '✗ Not this time — nothing special here. Play a good, sensible move.'
          : "✗ There IS a tactic here — you'd have missed it. Try to find it!";
    this.setStatus(text, right ? 'success' : 'error', 'Make your move on the board.');
    this.state = 'move';
    this.moveButtons();
    this.movable = this.cur.turn;
    this.changed();
  }

  /** Quiet: one move, judged by Stockfish. Tactics: the whole forcing line, move by move. */
  async onMove(uci: string): Promise<void> {
    if (this.exploreMove(uci)) return;
    if (this.state !== 'move' || !this.verdict) return;
    this.tried.set(this.ply, uci);
    this.buttons = [];
    const before = this.cur.copy();
    const shown = before.copy();
    shown.push(uci);
    this.show(shown, { lastMove: uci });
    this.lastTry = { before, move: uci, loss: null };
    if (this.ply === 0) {
      this.state = 'judging';
      this.detail = 'Checking your move…';
      this.changed();
      if (this.noEngine()) return;
      const token = this.token;
      const [good, loss] = await spot.judgeMove(this.engine, before, this.verdict, uci);
      if (token !== this.token || this.state !== 'judging') return;
      await this.afterTry(before, uci, good, loss);
      return;
    }
    const expected = this.verdict.solution[this.ply];
    await this.afterTry(before, uci, uci === expected || shown.isCheckmate(), null);
  }

  private async afterTry(before: Board, move: string, good: boolean, loss: number | null): Promise<void> {
    const v = this.verdict!;
    this.tries += 1;
    this.lastTry = { before, move, loss };
    const san = before.san(move);
    if (!good) {
      // missed: say so, but reveal nothing yet — Try again or Show answer
      this.missedAny = true;
      this.state = 'missed';
      const text = !v.is_tactic ? `✗ ${san} is ${pyFixed((loss ?? 0) / 100, 1)} pawns worse than the best move — look for something safer.`
        : this.ply === 0 ? `✗ ${san} isn't the tactic.${loss !== null && loss <= spot.MOVE_OK_CP ? " Close in score, but there's something better." : ''}`
          : `✗ ${san} isn't the move — the tactic continues differently.`;
      this.setStatus(text, 'error', 'Try again (only a clean first run is scored), or Show answer.');
      this.buttons = [{ id: 'retry', label: 'Try again', primary: true }, { id: 'reveal', label: 'Show answer' }];
      this.movable = null;
      this.changed();
      return;
    }
    this.cur.push(move);
    this.played.push(move);
    const finished = !v.is_tactic || this.cur.isCheckmate() || this.ply + 1 >= v.solution.length;
    if (finished) {
      await this.showResult(move, true, loss ?? 0);
      return;
    }
    // right, and the line goes on: the opponent's reply, then your next move
    this.state = 'reply';
    this.movable = null;
    this.setStatus(`✓ ${san} — keep going.`, 'success', '');
    this.changed();
    const token = this.token;
    setTimeout(() => this.playReply(token), REPLY_DELAY_MS);
  }

  private playReply(token: object): void {
    if (token !== this.token || this.state !== 'reply') return;
    const reply = this.verdict!.solution[this.ply + 1];
    const san = this.cur.san(reply);
    this.cur.push(reply);
    this.played.push(reply);
    this.ply += 2;
    this.hint = 0;
    this.state = 'move';
    this.show(this.cur, { lastMove: reply, movable: this.cur.turn });
    this.setStatus(`Opponent played ${san}. Your move.`, 'normal', '');
    this.moveButtons();
    this.changed();
  }

  private tryAgain(): void {
    if (this.state !== 'missed') return;
    this.state = 'move';
    this.show(this.cur, { movable: this.cur.turn, lastMove: this.played.at(-1) ?? null, arrows: this.hintArrows() });
    this.setStatus(`Try again — ${this.cur.turn === WHITE ? 'White' : 'Black'} to move.`, 'normal', this.hint ? this.hintText() : 'Make your move on the board.');
    this.moveButtons();
    this.changed();
  }

  // ---------- hints ----------

  private moveButtons(): void {
    this.buttons = [{ id: 'hint', label: HINT_LABELS[Math.min(this.hint, HINT_LABELS.length - 1)], disabled: this.hint >= HINT_LABELS.length }];
  }

  /** The move a hint points at: the tactic's next move, or the engine's pick in a quiet position. */
  private hintMove(): string {
    const v = this.verdict!;
    return v.is_tactic ? v.solution[this.ply] : v.best;
  }

  /** Each press shows more: what to look for, then the piece (a circle), then the move (an arrow). */
  private giveHint(): void {
    if (this.state !== 'move' || !this.verdict || this.hint >= HINT_LABELS.length) return;
    this.hint += 1;
    this.hinted = true;
    this.arrows = this.hintArrows();
    this.detail = this.hintText();
    this.moveButtons();
    this.changed();
  }

  private hintArrows(): Arrow[] {
    if (this.hint < 2) return [];
    const m = this.hintMove();
    return [{ from: m.slice(0, 2), to: this.hint >= 3 ? m.slice(2, 4) : m.slice(0, 2), brush: 'green' }];
  }

  private hintText(): string {
    const v = this.verdict!;
    const m = this.hintMove();
    const lines: string[] = [];
    if (!v.is_tactic) lines.push('💡 Nothing forcing here — look for a safe, useful move: improve your worst piece, or stop what your opponent wants.');
    else if (this.ply > 0) lines.push('💡 Keep forcing — checks and captures first.');
    else if (v.reason === 'mate') lines.push(`💡 You can force mate${v.mate_in ? ` in ${v.mate_in}` : ''}. Start with checks.`);
    else lines.push('💡 You can win material by force. Look at checks, captures and threats — and anything left undefended.');
    if (this.hint >= 2) {
      const piece = this.cur.pieceAt(parseSquare(m.slice(0, 2))!);
      lines.push(`💡 Move your ${piece?.role ?? 'piece'} on ${m.slice(0, 2)} (circled).`);
    }
    if (this.hint >= 3) lines.push(`💡 The move: ${this.cur.san(m)} (arrow).`);
    lines.push('A move found with a hint isn\'t scored.');
    return lines.join('\n');
  }

  private async reveal(): Promise<void> {
    if (this.state !== 'missed' || !this.lastTry) return;
    await this.showResult(this.lastTry.move, false, this.lastTry.loss, this.lastTry.before);
  }

  /** good: the latest move was right. Scored: a clean run (no misses). */
  private async showResult(move: string, good: boolean, loss: number | null, before: Board | null = null): Promise<void> {
    const v = this.verdict!;
    const cand = this.cand!;
    this.state = 'result';
    const callRight = this.saidTactic === v.is_tactic;
    const scoredGood = !this.missedAny && !this.hinted;
    this.onLevel(await this.client.service('spotRecord', cand.fen, v.is_tactic, v.reason, !!this.saidTactic, scoredGood));
    const s = this.session;
    s.rounds += 1;
    s.calls += callRight ? 1 : 0;
    s.moves += scoredGood ? 1 : 0;
    s.streak = callRight && scoredGood ? s.streak + 1 : 0;
    s.best = Math.max(s.best, s.streak);

    const multi = v.is_tactic && v.my_moves > 1;
    const lineText = numbered(this.board, v.solution);
    let verdictMove: string;
    if (multi) {
      verdictMove = good && scoredGood ? `✓ Solved — all ${v.my_moves} moves right.`
        : good ? `✓ Solved, with ${this.hinted ? 'a hint' : 'retries'} (only a clean run scores the moves).` : `✗ Not solved. The line: ${lineText}.`;
    } else {
      const san = (before ?? this.board).san(move);
      const l = loss ?? 0;
      verdictMove = good && !scoredGood ? `✓ ${san} — found it ${this.hinted ? 'with a hint' : `on try ${this.tries}`} (only a clean first try scores the move).`
        : good && move === v.best ? `✓ ${san} — the best move.`
          : good ? `✓ ${san} — a good move (only ${pyFixed(l / 100, 1)} pawns off the best).`
            : v.is_tactic && l <= spot.MOVE_OK_CP ? `✗ ${san} is decent (${pyFixed(l / 100, 1)} pawns off), but not the tactic: ${this.board.san(v.best)}.`
              : `✗ ${san} is ${pyFixed(l / 100, 1)} pawns worse than the best move.`;
    }
    this.setStatus(`${callRight ? '✓' : '✗'} Your call · ${verdictMove}`,
      callRight && scoredGood ? 'success' : callRight || good ? 'warning' : 'error');
    let detail = v.describe(this.board);
    if (multi) detail += `\nThe whole line: ${lineText}.`;
    this.detail = `${detail}\nOn the starting position (◀): green — the best move · blue — your move · yellow — what you played in the game.`;
    const first = this.tried.get(0) ?? move;
    const arrows: Arrow[] = [];
    if (cand.played_uci !== v.best && cand.played_uci !== first && this.board.isLegal(cand.played_uci)) arrows.push(arrowOf(cand.played_uci, 'yellow'));
    if (first !== v.best) arrows.push(arrowOf(first, 'blue'));
    arrows.push(arrowOf(v.best, 'green'));
    this.resultArrows = arrows;
    this.line = v.pv.length ? [...v.pv] : [v.best];          // replaced by a deeper line in a moment
    this.setBar(multi ? v.best_cp : v.best_cp - (loss ?? 0), this.board.turn);
    if (good) this.showFinished();                           // stay where you finished
    else this.showStep(0);                                   // missed: the start, with the arrows
    this.updateButtons();
    this.changed();
    void this.refreshScores();
    const token = this.token;
    if (this.engine) {
      try {
        const line = await spot.correctLine(this.engine, this.board, v);
        if (token !== this.token) return;
        this.line = line;
        if (this.lineIndex !== null && this.lineIndex > line.length) this.lineIndex = line.length;
        if (!this.liveAnalysis()) {                          // not while the analysis board is open
          if (this.state === 'result' && this.lineIndex !== null) this.showStep(this.lineIndex);
          this.updateButtons();
        }
        this.changed();
        const evals = await spot.lineEvals(this.engine, this.board, line);
        if (token !== this.token) return;
        this.lineEvals = evals;
        if (this.lineIndex !== null && !this.liveAnalysis()) this.evalWhite = evals[Math.min(this.lineIndex, evals.length - 1)];
        this.changed();
      } catch {
        /* the saved line stays */
      }
    }
  }

  private resultArrows: Arrow[] = [];


  private updateButtons(): void {
    const at = this.lineIndex;
    this.buttons = [
      { id: 'back', label: '◀', disabled: !(at === null || at > 0) },
      { id: 'fwd', label: '▶', disabled: !(at === null || at < this.line.length) },
      { id: 'next', label: 'Next position →', primary: true },
      { id: 'analyze', label: 'Analyze' },
      { id: 'review', label: 'Review game' },
    ];
  }

  /** How far along the correct line you finished, if your moves are its start. */
  private finishedOnLine(): number | null {
    return this.played.every((m, i) => this.line[i] === m) ? this.played.length : null;
  }

  /** The position you finished on: your last move highlighted, and as a blue arrow. */
  private showFinished(): void {
    this.lineIndex = null;
    const b = this.board.copy();
    for (const m of this.played) b.push(m);
    const last = this.played.at(-1) ?? null;
    const mine = this.played.length % 2 === 1 ? last : this.played.at(-2) ?? null;
    this.show(b, { lastMove: last, arrows: mine && last === mine ? [arrowOf(mine, 'blue')] : [] });
    this.peekAt(b);
  }

  /** The correct line after `index` moves; your move there (if different) in blue, the right one in green. */
  private showStep(index: number): void {
    this.lineIndex = index;
    const b = this.board.copy();
    for (const m of this.line.slice(0, index)) b.push(m);
    let arrows: Arrow[] = [];
    if (index === 0) arrows = this.resultArrows;
    else {
      const mine = this.tried.get(index);
      if (mine && mine !== this.line[index] && this.line[index] && b.isLegal(mine)) arrows = [arrowOf(mine, 'blue'), arrowOf(this.line[index], 'green')];
    }
    this.show(b, { lastMove: index ? this.line[index - 1] : null, arrows });
    this.peekAt(b);
  }

  /** Back from the analysis board: the result as it was. */
  private redrawResult(): void {
    if (this.lineIndex === null) this.showFinished();
    else this.showStep(this.lineIndex);
  }

  /** ◀ / ▶ after the round: from where you finished, one move back / on along the correct
   *  line (or to the start / the best move if you left it); then along the line. */
  private step(delta: number): void {
    if (this.state !== 'result' || !this.line.length) return;
    const at = this.finishedOnLine();
    const index = this.lineIndex === null ? Math.max(0, Math.min(this.line.length, at === null ? (delta < 0 ? 0 : 1) : at + delta))
      : Math.max(0, Math.min(this.line.length, this.lineIndex + delta));
    this.showStep(index);
    if (index < this.lineEvals.length) this.evalWhite = this.lineEvals[index];
    else this.setBar(this.verdict!.best_cp, this.board.turn);    // until the line's evaluations arrive
    const text = index ? numbered(this.board, this.line.slice(0, index)) : 'the starting position';
    this.setStatus(`Correct line (${index}/${this.line.length}): ${text}${index < this.line.length ? ' …' : ''}`, 'normal');
    this.updateButtons();
    this.changed();
  }

  // ---------- preparing rounds ----------

  /** Classify candidates in the background until one of the wanted kind (about 1 in 3 quiet) is ready. */
  private async prepare(): Promise<void> {
    if (this.ready || this.preparing) return;
    if (!this.engine) {
      if (this.waiting) this.noEngine();
      return;
    }
    this.preparing = true;
    let quiet = spot.wantQuiet();
    try {
      for (let tries = 0; tries < GIVE_UP_TRIES; tries++) {
        const kind = quiet ? 'quiet' : 'tactic';
        if (!this.pools[kind].length) this.pools[kind] = await this.client.service('spotCandidates', quiet, [...this.seen]);
        if (!this.pools[kind].length) {
          const other = quiet ? 'tactic' : 'quiet';
          if (!this.pools[other].length) this.pools[other] = await this.client.service('spotCandidates', !quiet, [...this.seen]);
          if (!this.pools[other].length) {
            if (this.waiting) {
              this.setStatus('No positions yet — import and analyze some games first (Import & Analyze).', 'muted');
              this.changed();
            }
            return;
          }
          quiet = !quiet;
        }
        const cand = this.pools[quiet ? 'quiet' : 'tactic'].pop()!;
        const last = await this.client.service('lastMoveOf', cand.game_id, cand.ply);
        const board = Board.fromFen(cand.fen);
        if (board.isGameOver()) continue;
        const verdict = await spot.classify(this.engine, board, last.captured);
        const trivial = spot.isTrivial(board, verdict.best, last.uci, last.captured);
        const usable = !trivial && verdict.reason !== 'unclear' && (verdict.is_tactic || spot.usableAsQuiet(cand));
        // take it if it's the wanted kind — or, after MAX_TRIES misses, any usable position
        if (usable && (verdict.is_tactic !== quiet || tries + 1 >= MAX_TRIES[quiet ? 'quiet' : 'tactic'])) {
          this.ready = { cand, verdict };
          this.preparing = false;
          if (this.waiting) await this.nextRound();
          return;
        }
      }
      if (this.waiting) {
        this.setStatus("Couldn't find a suitable position — analyze more games (Import & Analyze), then try again.", 'muted');
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
