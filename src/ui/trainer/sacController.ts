/**
 * Sacrifice!! (sac_tab.py, rules in sac.ts): find the sacrifice, then each
 * follow-up against Stockfish's best defence until it's mate, you're clearly
 * winning, or the position calms down. A wrong try gets a hint. Sacrifices
 * from your own games (your !! moves and ones you missed) and Lichess
 * sacrifice puzzles; after a round, the analysis board (and your game's line).
 */
import { Board, WHITE } from '../../core/chess';
import { pySigned } from '../../core/format';
import * as lichessPuzzles from '../../core/lichessPuzzles';
import * as sac from '../../core/sac';
import type { SacCandidateView } from '../../data/trainerServices';
import { Analysis } from '../analysis';
import type { Arrow } from '../Board';
import { numbered, TrainerBase } from './base';

const REPLY_DELAY_MS = 500;
const MAX_PREP_TRIES = 30;              // candidates checked for a real follow-up before giving up
export const LICHESS_BATCH = 100;

type State = 'idle' | 'loading' | 'sac' | 'sac_missed' | 'thinking' | 'move' | 'judging' | 'missed' | 'result' | 'analysis';

const toCand = (v: SacCandidateView) => new sac.Candidate(v.fen, v.sacUci, v.source, v.gameId, v.ply, v.label);

export class SacController extends TrainerBase {
  title = 'Sacrifice!!';
  intro = 'A sacrifice is only amazing if you follow it up. Find the sacrifice, then find each next move against '
    + "Stockfish's best defence — until it's mate, you're clearly winning, or the position calms down (several good "
    + 'moves instead of one). A wrong try gets a hint (which piece).\n\n'
    + 'Sacrifices from your own games (your !! amazing moves) and Lichess sacrifice puzzles. '
    + `+${sac.CLEAN_XP} XP for a clean line, +${sac.DONE_XP} if you needed help.`;
  poolText = '';
  lichessBusy = false;
  analysis: Analysis;

  private state: State = 'idle';
  private pool: SacCandidateView[] | null = null;
  private ready: SacCandidateView | null = null;
  private preparing = false;
  private prepTries = 0;
  private waiting = false;
  private cand: SacCandidateView | null = null;
  private start: Board = Board.fromFen();
  private board: Board = Board.fromFen();
  private me: 'white' | 'black' = 'white';
  private stepInfo: sac.Step | null = null;
  private movesDone = 0;
  private misses = 0;
  private missedHere = false;
  private line: string[] = [];
  private gameLine: string[] = [];
  private resultTexts: [{ text: string; tone: TrainerBase['status']['tone'] }, string] = [{ text: '', tone: 'normal' }, ''];
  private session = { rounds: 0, clean: 0, streak: 0, best: 0 };

  constructor(...args: ConstructorParameters<typeof TrainerBase>) {
    super(...args);
    this.analysis = new Analysis(this.engine, {
      title: (b) => this.analysisTitle(b),
      hint: 'click a line, then ▶ · ◀ takes back',
      onChange: () => {
        if (this.state !== 'analysis') return;
        this.show(this.analysis.board, { lastMove: this.analysis.board.moveStack.at(-1) ?? null, arrows: this.analysis.arrows(), movable: 'both' });
        this.evalWhite = this.analysis.evalWhite;
        this.changed();
      },
    });
  }

  sessionLine(): string {
    const s = this.session;
    return s.rounds ? `Streak ${s.streak}  ·  best ${s.best}` : 'Streak 0';
  }

  sessionDetail(): string {
    const s = this.session;
    return s.rounds ? `Clean lines ${s.clean}/${s.rounds}` : 'A round counts toward your streak when you find every follow-up yourself.';
  }

  analysing(): boolean {
    return this.state === 'analysis';
  }

  private async refreshScores(): Promise<void> {
    const [rounds, clean] = await this.client.service('sacSummary');
    this.allTime = rounds ? `Sacrifices made to work: ${rounds} · clean ${clean}` : 'No rounds played yet.';
    this.changed();
  }

  async onShown(): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    this.waiting = true;
    this.setStatus('Finding your sacrifices…', 'muted');
    this.changed();
    void this.refreshScores();
    const p = await this.client.service('sacPool');
    this.pool = p.pool;
    this.poolText = `${p.own} sacrifices you played · ${p.missed} you missed · ${p.lichess} Lichess sacrifice puzzles `
      + '(rounds with nothing to find afterwards are skipped).';
    this.changed();
    void this.prepare();
  }

  override key(k: string): void {
    if (k === 'Enter' || k === ' ') void this.nextRound();
    else if (this.state === 'analysis' && k === 'ArrowLeft') this.analysis.step(-1);
    else if (this.state === 'analysis' && k === 'ArrowRight') this.analysis.step(1);
  }

  press(id: string): Promise<void> | void {
    if (id === 'retry') return this.tryAgain();
    if (id === 'show') return this.showMove();
    if (id === 'next') return this.nextRound();
    if (id === 'analyze') return this.startAnalysis();
    if (id === 'aback') { this.analysis.step(-1); return; }
    if (id === 'afwd') { this.analysis.step(1); return; }
    if (id === 'gameline') return this.analyseGameLine();
    if (id === 'done') return this.stopAnalysis();
  }

  gameAt(): { gameId: string; fen: string } | null {
    return this.cand?.gameId ? { gameId: this.cand.gameId, fen: this.cand.fen } : null;
  }

  // ---------- positions ----------

  private async prepare(): Promise<void> {
    if (this.ready || this.preparing || this.pool === null) return;
    if (!this.engine) {
      if (this.waiting) this.noEngine();
      return;
    }
    this.preparing = true;
    try {
      while (this.pool.length && this.prepTries < MAX_PREP_TRIES) {
        const cand = this.pool.shift()!;
        this.prepTries += 1;
        if ((await sac.followUps(this.engine, toCand(cand))) >= 1) {
          this.ready = cand;
          this.prepTries = 0;
          this.preparing = false;
          if (this.waiting) await this.nextRound();
          return;
        }
      }
      if (this.waiting) {
        this.setStatus('No sacrifices to play yet — analyze more games, or add Lichess sacrifice puzzles.', 'muted');
        this.changed();
      }
    } catch (e) {
      this.setStatus(`Engine error: ${e instanceof Error ? e.message : e}`, 'error');
      this.changed();
    } finally {
      this.preparing = false;
    }
  }

  // ---------- a round ----------

  async nextRound(): Promise<void> {
    if (this.state === 'analysis') this.stopAnalysis();
    if (!['idle', 'loading', 'result'].includes(this.state)) return;
    if (!this.ready) {
      this.state = 'loading';
      this.waiting = true;
      this.buttons = [];
      this.show(null);
      this.setStatus('Finding a sacrifice with a follow-up…', 'muted', '');
      this.changed();
      void this.prepare();
      return;
    }
    this.cand = this.ready;
    this.ready = null;
    this.waiting = false;
    this.token = {};
    this.start = Board.fromFen(this.cand.fen);
    this.board = this.start.copy();
    this.me = this.board.turn;
    this.movesDone = 0;
    this.misses = 0;
    this.line = [];
    this.stepInfo = null;
    this.missedHere = false;
    this.state = 'sac';
    this.orientation = this.me;
    this.show(this.board, { movable: this.me });
    this.evalWhite = null;
    this.source = this.cand.label;
    this.setStatus(`${this.me === WHITE ? 'White' : 'Black'} to move — find the sacrifice!!`, 'sac',
      'A piece sacrifice works here. Find it, then find each follow-up against the best defence.');
    this.buttons = [];
    this.changed();
    void this.prepare();                             // the next one, while you play
  }

  async onMove(move: string): Promise<void> {
    if (this.state === 'analysis') {
      this.analysis.play(move);
      return;
    }
    if (this.state === 'sac') {
      const sacMove = this.cand!.sacUci;
      if (move !== sacMove) {
        // not it: a miss (once), a hint — which piece — then Try again or Show the sacrifice
        const shown = this.board.copy();
        shown.push(move);
        this.show(shown, { lastMove: move });
        if (!this.missedHere) {
          this.misses += 1;
          this.missedHere = true;
        }
        const piece = this.board.pieceAt(sacMove.charCodeAt(0) - 97 + 8 * (sacMove.charCodeAt(1) - 49))!.role;
        this.state = 'sac_missed';
        this.setStatus(`✗ ${this.board.san(move)} isn't the sacrifice.`, 'error', `Hint: the sacrifice is a ${piece} move.`);
        this.buttons = [{ id: 'retry', label: 'Try again', primary: true }, { id: 'show', label: 'Show the sacrifice' }];
        this.changed();
        return;
      }
      const found = `✓ ${this.board.san(move)}!! — `;
      this.missedHere = false;
      this.push(move);
      await this.askReply(found);
    } else if (this.state === 'move') {
      const shown = this.board.copy();
      shown.push(move);
      this.show(shown, { lastMove: move });
      this.state = 'judging';
      this.detail = 'Checking…';
      this.changed();
      const token = this.token;
      const [right, cp] = await sac.judge(this.engine, this.board, move, this.stepInfo!);
      if (token === this.token && this.state === 'judging') await this.onJudged(move, right, cp);
    }
  }

  private push(move: string): void {
    this.board.push(move);
    this.line.push(move);
    this.show(this.board, { lastMove: move });
  }

  private async askReply(prefix = ''): Promise<void> {
    this.state = 'thinking';
    this.setStatus(prefix ? `${prefix}their best defence…` : 'Their best defence…', prefix ? 'sac' : 'muted', '');
    this.changed();
    if (this.noEngine()) return;
    const token = this.token;
    const reply = await sac.theirReply(this.engine!, this.board);
    let stepInfo: sac.Step | null = null;
    if (reply !== null) {
      const after = this.board.copy();
      after.push(reply);
      stepInfo = await sac.step(this.engine!, after, this.me, this.movesDone);
    }
    if (token !== this.token || this.state !== 'thinking') return;
    if (reply === null) {                                 // your move ended the game
      await this.finish(this.board.isCheckmate() ? 'mate' : 'over', null);
      return;
    }
    setTimeout(() => void this.showReply(token, reply, stepInfo!), REPLY_DELAY_MS);
  }

  private async showReply(token: object, reply: string, stepInfo: sac.Step): Promise<void> {
    if (token !== this.token) return;
    const san = this.board.san(reply);
    this.push(reply);
    this.stepInfo = stepInfo;
    this.missedHere = false;
    if (stepInfo.over) {
      await this.finish(stepInfo.reason, stepInfo.best_cp);
      return;
    }
    this.setBar(stepInfo.best_cp, this.me);
    this.state = 'move';
    this.movable = this.me;
    this.setStatus(`They played ${san}. Your move — keep it going.`, 'normal',
      `Follow-up ${this.movesDone + 1}. Line so far: ${numbered(this.start, this.line)}`);
    this.changed();
  }

  private async onJudged(move: string, right: boolean, cp: number): Promise<void> {
    if (right) {
      const san = this.board.san(move);
      this.push(move);
      this.movesDone += 1;
      this.setStatus(`✓ ${san}`, 'success');
      if (this.board.isCheckmate()) {
        await this.finish('mate', cp);
        return;
      }
      await this.askReply();
      return;
    }
    this.state = 'missed';
    if (!this.missedHere) {
      this.misses += 1;
      this.missedHere = true;
    }
    this.setStatus(`✗ ${this.board.san(move)} lets them off the hook.`, 'error', 'Try again (a clean line scores more), or Show the move.');
    this.buttons = [{ id: 'retry', label: 'Try again', primary: true }, { id: 'show', label: 'Show the move' }];
    this.changed();
  }

  private tryAgain(): void {
    if (this.state === 'sac_missed') {                     // the sacrifice itself
      this.state = 'sac';
      this.show(this.board, { movable: this.me, lastMove: this.board.moveStack.at(-1) ?? null });
      this.setStatus('Try again — find the sacrifice!!', 'sac');
      this.buttons = [];
      this.changed();
      return;
    }
    if (this.state !== 'missed') return;
    this.state = 'move';
    this.show(this.board, { movable: this.me, lastMove: this.board.moveStack.at(-1) ?? null });
    this.setStatus('Try again — your move.', 'normal', `Line so far: ${numbered(this.start, this.line)}`);
    this.buttons = [];
    this.changed();
  }

  private showMove(): void {
    if (this.state === 'sac_missed') {                     // reveal the sacrifice and play it
      const sacMove = this.cand!.sacUci;
      this.show(this.board, { arrows: [{ from: sacMove.slice(0, 2), to: sacMove.slice(2, 4), brush: 'red' }] });
      this.buttons = [];
      this.state = 'sac';
      this.changed();
      setTimeout(() => { if (this.state === 'sac') void this.onMove(sacMove); }, 800);
      return;
    }
    if (this.state !== 'missed' || !this.stepInfo?.best) return;
    const best = this.stepInfo.best;
    this.show(this.board, { arrows: [{ from: best.slice(0, 2), to: best.slice(2, 4), brush: 'green' }] });
    this.buttons = [];
    this.state = 'judging';
    this.changed();
    setTimeout(() => void this.onJudged(best, true, this.stepInfo!.best_cp), 700);
  }

  private async finish(reason: string, cp: number | null): Promise<void> {
    const cand = this.cand!;
    this.state = 'result';
    this.onLevel(await this.client.service('sacRecord', cand, this.movesDone, this.misses));
    const clean = this.misses === 0;
    const s = this.session;
    s.rounds += 1;
    s.clean += clean ? 1 : 0;
    s.streak = clean ? s.streak + 1 : 0;
    s.best = Math.max(s.best, s.streak);
    const evaluation = cp !== null && Math.abs(cp) < 5000 ? ` (Stockfish ${pySigned(cp / 100, 1).replace('-', '−')})` : '';
    const why = ({
      mate: 'Checkmate!',
      winning: `You're clearly winning now${evaluation}.`,
      calm: `The position has calmed down — the sacrifice paid off${evaluation}.`,
      max: `A long line — and it's still working${evaluation}.`,
      over: 'The game is over.',
    } as Record<string, string>)[reason] ?? '';
    const head = clean ? '✓ You made it work!' : `Done — with ${this.misses} hint${this.misses !== 1 ? 's' : ''}`;
    const { moves, text } = await this.client.service('sacGameComparison', cand, this.line);
    this.gameLine = moves;
    this.setStatus(`${head}  ${why}`, clean ? 'success' : 'warning', `The line: ${numbered(this.start, this.line)}${text ? `\n${text}` : ''}`);
    if (cp !== null && Math.abs(cp) < 5000) this.setBar(cp, this.me);
    this.movable = null;
    this.resultButtons();
    this.changed();
    void this.refreshScores();
  }

  private resultButtons(): void {
    this.buttons = [{ id: 'next', label: 'Next sacrifice →', primary: true }, { id: 'analyze', label: 'Analyze' },
      ...(this.cand?.gameId ? [{ id: 'review', label: 'Review game' }] : [])];
  }

  // ---------- analysis after the round ----------

  private startAnalysis(): void {
    if (this.state !== 'result') return;
    this.resultTexts = [this.status, this.detail];
    this.state = 'analysis';
    this.buttons = [{ id: 'aback', label: '◀' }, { id: 'afwd', label: '▶' },
      ...(this.gameLine.length ? [{ id: 'gameline', label: 'Your game' }] : []), { id: 'done', label: 'Back' }];
    this.analysis.start(this.board);                // the whole line: ◀ goes back before the sacrifice
    this.changed();
  }

  private analyseGameLine(): void {
    if (this.state !== 'analysis' || !this.gameLine.length) return;
    this.analysis.start(this.start, this.gameLine);
  }

  private stopAnalysis(): void {
    if (this.state !== 'analysis') return;
    this.state = 'result';
    this.analysis.stop();
    [this.status, this.detail] = this.resultTexts;
    this.show(this.board, { lastMove: this.board.moveStack.at(-1) ?? null });
    this.resultButtons();
    this.changed();
  }

  private analysisTitle(board: Board): string {
    const side = board.turn === WHITE ? 'White' : 'Black';
    const played = board.moveStack.length - this.start.moveStack.length;
    const stack = board.moveStack.slice(this.start.moveStack.length);
    const where = played <= 0 ? 'before the sacrifice'
      : stack.join(' ') === this.line.slice(0, played).join(' ') ? "on the round's line"
        : this.gameLine.length && stack.join(' ') === this.gameLine.slice(0, played).join(' ') ? "your game's line" : 'your own line';
    return `${side} to move · ${where}`;
  }

  /** Arrows: the analysis board's ideas while analysing. */
  boardArrows(): Arrow[] {
    return this.state === 'analysis' ? this.analysis.arrows() : this.arrows;
  }

  // ---------- more Lichess sacrifices ----------

  async addLichess(): Promise<void> {
    if (this.lichessBusy) return;
    this.lichessBusy = true;
    this.changed();
    try {
      const s = await this.client.service('lichessSummary');
      const set = await this.client.service('getSettings', ['lichess_min_rating', 'lichess_max_rating']);
      const low = Number(set.lichess_min_rating) || s.defaults[0];
      const high = Number(set.lichess_max_rating) || s.defaults[1];
      const skip = new Set(await this.client.service('lichessIds'));
      const rows = await lichessPuzzles.packRows(low, high, `${import.meta.env.BASE_URL}lichess/`, fetch, 'sacrifice');
      const saves: Promise<void>[] = [];
      const added = await lichessPuzzles.download(low, high, LICHESS_BATCH, skip, (b) => { saves.push(this.client.service('lichessSave', b)); },
        () => false, rows, undefined, 500, 'sacrifice');
      await Promise.all(saves);
      if (added && this.pool !== null) {
        const fresh = await this.client.service('sacLichess');
        const known = new Set(this.pool.map((c) => c.key));
        this.pool.push(...fresh.filter((c) => !known.has(c.key)));
      }
      this.poolText = `Added ${added} Lichess sacrifice puzzles.`;
      if (this.waiting) {
        this.prepTries = 0;
        void this.prepare();
      }
    } catch (e) {
      this.poolText = `Couldn't load the Lichess puzzles (${e instanceof Error ? e.message : e}).`;
    }
    this.lichessBusy = false;
    this.changed();
  }

  override dispose(): void {
    super.dispose();
    this.analysis.dispose();
  }
}
