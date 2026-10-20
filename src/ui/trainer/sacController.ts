/**
 * Sacrifice!! (sac_tab.py, rules in sac.ts): find the sacrifice, then each
 * follow-up against Stockfish's best defence until it has paid off — mate, a
 * forced draw, the material back (or a crushing attack). A wrong try gets a
 * hint. Sacrifices from your own games (your !! moves and ones you missed) and
 * Lichess sacrifice puzzles; after a round, the analysis board (and your
 * game's line).
 *
 * Web-app additions: Attack / Defend (the computer sacrifices, you defend), a
 * source filter (all / your games / Lichess), what was played in your game as
 * you go, how it ended (Forced mate / Forced draw / Wins material …), mate
 * scores as M2, Play it out from the end, and Try other defences (replay the
 * line against Stockfish's other reasonable defences, unscored).
 */
import { Board, type Color, opposite, WHITE } from '../../core/chess';
import { pySigned } from '../../core/format';
import * as lichessPuzzles from '../../core/lichessPuzzles';
import * as sac from '../../core/sac';
import type { SacCandidateView } from '../../data/trainerServices';
import { numbered, TrainerBase } from './base';

const REPLY_DELAY_MS = 500;
const THEIR_SAC_DELAY_MS = 900;
const MAX_PREP_TRIES = 30;              // candidates checked for a real follow-up before giving up
const MAX_BRANCHES = 6;                 // other defences offered after a round
const BRANCH_PLIES = 7;                 // ...among their first few defensive moves
export const LICHESS_BATCH = 100;

export type SacSide = 'attack' | 'defend';
export type SacSource = 'all' | 'game' | 'lichess';
export const SAC_SIDES: [SacSide, string][] = [['attack', 'Attack'], ['defend', 'Defend']];
export const SAC_SOURCES: [SacSource, string][] = [['all', 'All'], ['game', 'My games'], ['lichess', 'Lichess']];

type State = 'idle' | 'loading' | 'their_sac' | 'sac' | 'sac_missed' | 'thinking' | 'move' | 'judging' | 'missed' | 'result';

export interface Branch {
  at: number;                           // the index in the main line of the defence it replaces
  move: string;
  label: string;                        // "18... Kh8 instead of 18... Kxh7"
  result: '' | 'clean' | 'helped';
}

const toCand = (v: SacCandidateView) => new sac.Candidate(v.fen, v.sacUci, v.source, v.gameId, v.ply, v.label);
const mateText = (mate: number) => (mate > 0 ? `M${mate}` : `−M${-mate}`);

export class SacController extends TrainerBase {
  title = 'Sacrifice!!';
  intro = 'A sacrifice is only amazing if you follow it up. Attack: find the sacrifice, then each next move against '
    + "Stockfish's best defence until it has paid off — mate, a forced draw, or the material back with interest. "
    + 'Defend: the computer sacrifices and attacks; find the toughest defence, move by move. '
    + 'A wrong try gets a hint.\n\n'
    + 'Sacrifices from your own games (your !! amazing moves and ones you missed) and Lichess sacrifice puzzles. '
    + `+${sac.CLEAN_XP} XP for a clean line, +${sac.DONE_XP} if you needed help.`;
  poolText = '';
  lichessBusy = false;
  side: SacSide = 'attack';
  sourceFilter: SacSource = 'all';
  branches: Branch[] = [];
  branchesNote = '';
  /** Play it out from the end of the line (the screen opens the game window). */
  playing: { fen: string; color: Color; title: string } | null = null;

  private state: State = 'idle';
  private pool: SacCandidateView[] | null = null;
  private ready: SacCandidateView | null = null;
  private preparing = false;
  private prepTries = 0;
  private waiting = false;
  private cand: SacCandidateView | null = null;
  private start: Board = Board.fromFen();
  private board: Board = Board.fromFen();
  private attacker: Color = 'white';
  private me: Color = 'white';
  private lineCtx: sac.Line = sac.Line.from(Board.fromFen());
  private stepInfo: sac.Step | null = null;
  private movesDone = 0;
  private misses = 0;
  private missedHere = false;
  private line: string[] = [];
  private mainLine: string[] = [];
  private practice: number | null = null;   // replaying the line against branches[practice]
  private gameMoves: string[] = [];
  private gameLine: string[] = [];
  private chosen = { side: false, source: false };   // switched before the saved settings arrived: those don't win
  private session = { rounds: 0, clean: 0, streak: 0, best: 0 };

  sessionLine(): string {
    const s = this.session;
    return s.rounds ? `Streak ${s.streak}  ·  best ${s.best}` : 'Streak 0';
  }

  sessionDetail(): string {
    const s = this.session;
    return s.rounds ? `Clean lines ${s.clean}/${s.rounds}` : 'A round counts toward your streak when you find every move yourself.';
  }

  private async refreshScores(): Promise<void> {
    const [rounds, clean] = await this.client.service('sacSummary');
    this.allTime = rounds ? `Sacrifice rounds: ${rounds} · clean ${clean}` : 'No rounds played yet.';
    this.changed();
  }

  async onShown(): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    this.waiting = true;
    this.setStatus('Finding your sacrifices…', 'muted');
    this.changed();
    void this.refreshScores();
    const set = await this.client.service('getSettings', ['sac_side', 'sac_source']);
    if (!this.chosen.side && set.sac_side === 'defend') this.side = 'defend';
    if (!this.chosen.source && SAC_SOURCES.some(([k]) => k === set.sac_source)) this.sourceFilter = set.sac_source as SacSource;
    await this.loadPool();
    void this.prepare();
  }

  /** The sacrifices, not played yet from this side first. */
  private async loadPool(): Promise<void> {
    const p = await this.client.service('sacPool', this.side);
    this.pool = p.pool;
    this.prepTries = 0;
    this.poolText = `${p.own} sacrifices you played · ${p.missed} you missed · ${p.lichess} Lichess sacrifice puzzles `
      + '(rounds with nothing to find afterwards are skipped).';
    this.changed();
  }

  override key(k: string): void {
    if (k === 'Enter' || k === ' ') void this.nextRound();
    else this.exploreKey(k);
  }

  press(id: string): Promise<void> | void {
    if (this.explorePress(id, () => this.redrawResult())) return;
    if (id === 'retry') return this.tryAgain();
    if (id === 'show') return this.showMove();
    if (id === 'next') return this.nextRound();
    if (id === 'gameline' && this.isExploring && this.gameLine.length) {   // the analysis board on your game's moves
      this.explorer.start(this.start, this.gameLine);
      return;
    }
    if (id === 'play') return this.playItOut();
    if (id.startsWith('branch')) return this.playBranch(Number(id.slice(6)));
  }

  gameAt(): { gameId: string; fen: string } | null {
    return this.cand?.gameId ? { gameId: this.cand.gameId, fen: this.cand.fen } : null;
  }

  // ---------- attack / defend, and where the sacrifices come from ----------

  setSide(side: SacSide): void {
    this.chosen.side = true;
    if (side === this.side) return;
    this.side = side;
    void this.client.service('setSettings', { sac_side: side });
    if (this.state === 'idle') return;                // not shown yet: onShown loads it
    this.ready = null;                                // the pool's order is per side: reload it
    void this.loadPool().then(() => this.restart());
  }

  setSource(source: SacSource): void {
    this.chosen.source = true;
    if (source === this.sourceFilter) return;
    this.sourceFilter = source;
    void this.client.service('setSettings', { sac_source: source });
    this.prepTries = 0;
    this.restart();
  }

  private eligible(c: SacCandidateView): boolean {
    return this.sourceFilter === 'all' || (this.sourceFilter === 'lichess') === (c.source === 'lichess');
  }

  /** A new round now (the one on the board is dropped, not scored). */
  private restart(): void {
    if (this.state === 'idle') return;                // not shown yet: onShown starts it
    this.endExplore();
    this.token = {};
    this.playing = null;
    this.state = 'result';
    void this.nextRound();
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
      while (this.prepTries < MAX_PREP_TRIES) {
        const i = this.pool.findIndex((c) => this.eligible(c));
        if (i < 0) break;
        const cand = this.pool.splice(i, 1)[0];
        this.prepTries += 1;
        if ((await sac.followUps(this.engine, toCand(cand))).moves >= 1) {
          this.ready = cand;
          this.prepTries = 0;
          this.preparing = false;
          if (this.waiting) await this.nextRound();
          return;
        }
      }
      if (this.waiting) {
        this.setStatus(this.sourceFilter === 'lichess' ? 'No Lichess sacrifice puzzles to play — add some (button on the left).'
          : this.sourceFilter === 'game' ? 'No sacrifices from your games to play yet — analyze more games, or switch to Lichess.'
            : 'No sacrifices to play yet — analyze more games, or add Lichess sacrifice puzzles.', 'muted');
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
    if (!['idle', 'loading', 'result'].includes(this.state)) return;
    this.endExplore();
    if (this.ready && !this.eligible(this.ready)) {        // the filter changed meanwhile
      this.pool?.unshift(this.ready);
      this.ready = null;
    }
    if (!this.ready) {
      this.state = 'loading';
      this.waiting = true;
      this.buttons = [];
      this.branches = [];
      this.branchesNote = '';
      this.show(null);
      this.evalWhite = null;
      this.setStatus('Finding a sacrifice with a follow-up…', 'muted', '');
      this.changed();
      void this.prepare();
      return;
    }
    this.cand = this.ready;
    this.ready = null;
    this.waiting = false;
    const token = this.token = {};
    this.start = Board.fromFen(this.cand.fen);
    this.board = this.start.copy();
    this.attacker = this.board.turn;
    this.me = this.side === 'defend' ? opposite(this.attacker) : this.attacker;
    this.lineCtx = sac.Line.from(this.start);
    this.movesDone = 0;
    this.misses = 0;
    this.line = [];
    this.mainLine = [];
    this.practice = null;
    this.branches = [];
    this.branchesNote = '';
    this.gameMoves = [];
    this.gameLine = [];
    this.stepInfo = null;
    this.missedHere = false;
    this.playing = null;
    this.orientation = this.me;
    this.evalWhite = null;
    this.source = this.cand.label + (this.side === 'defend' ? ' · you defend' : '');
    void this.client.service('sacGameMoves', this.cand).then((m) => { if (token === this.token) this.gameMoves = m; });
    if (this.side === 'attack') {
      this.state = 'sac';
      this.show(this.board, { movable: this.me });
      this.setStatus(`${this.me === WHITE ? 'White' : 'Black'} to move — find the sacrifice!!`, 'sac',
        'A piece sacrifice works here. Find it, then find each follow-up against the best defence.');
    } else {
      this.state = 'their_sac';
      this.show(this.board);
      this.setStatus(`${this.attacker === WHITE ? 'White' : 'Black'} is about to sacrifice…`, 'sac',
        'Watch the sacrifice, then find the toughest defence — move by move, against Stockfish\'s attack.');
      setTimeout(() => void this.theirSac(token), THEIR_SAC_DELAY_MS);
    }
    this.buttons = [];
    this.changed();
    void this.prepare();                             // the next one, while you play
  }

  /** Defend: they sacrifice; then it's your move. */
  private async theirSac(token: object): Promise<void> {
    if (token !== this.token || this.state !== 'their_sac' || this.noEngine()) return;
    const sacMove = this.cand!.sacUci;
    const san = this.board.san(sacMove);
    const note = this.gameNote(0, sacMove);
    this.push(sacMove);
    this.state = 'thinking';
    this.changed();
    const stepInfo = await sac.step(this.engine!, this.board, this.me, 0, this.lineCtx, true, false);   // you answer it, whatever it is
    if (token !== this.token) return;
    this.stepInfo = stepInfo;
    if (stepInfo.over) {
      await this.finish(stepInfo.reason, stepInfo.best_cp, stepInfo.mate);
      return;
    }
    this.setBar(stepInfo.best_cp, this.me, stepInfo.mate);
    this.state = 'move';
    this.movable = this.me;
    this.setStatus(`They sacrificed: ${san}!! Find the best defence.`, 'sac', `${note ? `${note}\n` : ''}Defence 1 — accept it, or decline it?`);
    this.changed();
  }

  async onMove(move: string): Promise<void> {
    if (this.exploreMove(move)) return;
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
      const note = this.gameNote(0, move);
      this.missedHere = false;
      this.push(move);
      await this.askReply(found, note);
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
    this.lineCtx.add(this.board);
    this.show(this.board, { lastMove: move });
  }

  /** What was played here in your game, while the round still follows it ('' if not). */
  private gameNote(index: number, move: string): string {
    const g = this.gameMoves;
    if (g.length <= index || this.line.slice(0, index).some((m, i) => g[i] !== m) || !this.board.isLegal(g[index])) return '';
    const who = this.board.turn === this.attacker ? 'you' : 'your opponent';   // in your games you were the one sacrificing
    if (g[index] === move) return who === 'you' ? '📖 Same as you played in your game.' : '📖 Your opponent played this in your game too.';
    return `📖 In your game ${who} played ${this.board.san(g[index])} here.`;
  }

  private async askReply(prefix = '', note = ''): Promise<void> {
    this.state = 'thinking';
    this.setStatus(prefix ? `${prefix}their best ${this.side === 'defend' ? 'attacking move' : 'defence'}…` : 'Their reply…', prefix ? 'sac' : 'muted', note);
    this.changed();
    if (this.noEngine()) return;
    if (this.lineCtx.repeats(this.board, true) >= sac.DRAW_REPEATS) {   // your move repeated the position
      await this.finish('draw', 0, null);
      return;
    }
    const token = this.token;
    const reply = await sac.theirReply(this.engine!, this.board);
    let stepInfo: sac.Step | null = null;
    if (reply !== null) {
      const after = this.board.copy();
      after.push(reply);
      stepInfo = await sac.step(this.engine!, after, this.me, this.movesDone, this.lineCtx);
    }
    if (token !== this.token || this.state !== 'thinking') return;
    if (reply === null) {                                 // your move ended the game
      await this.finish(this.board.isCheckmate() ? (this.me === this.attacker ? 'mate' : 'over') : 'draw', null, null);
      return;
    }
    setTimeout(() => void this.showReply(token, reply, stepInfo!, note), REPLY_DELAY_MS);
  }

  private async showReply(token: object, reply: string, stepInfo: sac.Step, note = ''): Promise<void> {
    if (token !== this.token) return;
    const san = this.board.san(reply);
    const theirNote = this.gameNote(this.line.length, reply);
    this.push(reply);
    this.stepInfo = stepInfo;
    this.missedHere = false;
    if (stepInfo.over) {
      await this.finish(stepInfo.reason, stepInfo.best_cp, stepInfo.mate);
      return;
    }
    this.setBar(stepInfo.best_cp, this.me, stepInfo.mate);
    this.state = 'move';
    this.movable = this.me;
    const notes = [note, theirNote].filter(Boolean).join('\n');
    this.setStatus(`They played ${san}. Your move — ${this.side === 'defend' ? 'keep defending' : 'keep it going'}.`, 'normal',
      `${notes ? `${notes}\n` : ''}${this.side === 'defend' ? 'Defence' : 'Follow-up'} ${this.movesDone + 1}. Line so far: ${numbered(this.start, this.line)}`);
    this.changed();
  }

  private async onJudged(move: string, right: boolean, cp: number): Promise<void> {
    if (right) {
      const san = this.board.san(move);
      const note = this.gameNote(this.line.length, move);
      this.push(move);
      this.movesDone += 1;
      this.setStatus(`✓ ${san}`, 'success');
      if (this.board.isCheckmate()) {
        await this.finish(this.me === this.attacker ? 'mate' : 'over', cp, null);
        return;
      }
      await this.askReply('', note);
      return;
    }
    this.state = 'missed';
    if (!this.missedHere) {
      this.misses += 1;
      this.missedHere = true;
    }
    this.setStatus(this.side === 'defend' ? `✗ ${this.board.san(move)} makes it worse — there's a tougher defence.`
      : `✗ ${this.board.san(move)} lets them off the hook.`, 'error', 'Try again (a clean line scores more), or Show the move.');
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
      const token = this.token;
      setTimeout(() => { if (token === this.token && this.state === 'sac') void this.onMove(sacMove); }, 800);
      return;
    }
    if (this.state !== 'missed' || !this.stepInfo?.best) return;
    const best = this.stepInfo.best;
    const cp = this.stepInfo.best_cp;
    this.show(this.board, { arrows: [{ from: best.slice(0, 2), to: best.slice(2, 4), brush: 'green' }] });
    this.buttons = [];
    this.state = 'judging';
    this.changed();
    const token = this.token;
    setTimeout(() => { if (token === this.token && this.state === 'judging') void this.onJudged(best, true, cp); }, 700);
  }

  private async finish(reason: string, cp: number | null, mate: number | null): Promise<void> {
    const cand = this.cand!;
    const token = this.token;
    this.state = 'thinking';                     // 'result' once the verdict is written (below)
    this.movable = null;
    const clean = this.misses === 0;
    const practice = this.practice !== null ? this.branches[this.practice] : null;
    if (practice) practice.result = clean ? 'clean' : 'helped';
    else {
      this.onLevel(await this.client.service('sacRecord', cand, this.movesDone, this.misses, this.side));
      const s = this.session;
      s.rounds += 1;
      s.clean += clean ? 1 : 0;
      s.streak = clean ? s.streak + 1 : 0;
      s.best = Math.max(s.best, s.streak);
    }
    const evaluation = mate !== null ? ` (Stockfish: ${mateText(mate)})`
      : cp !== null && Math.abs(cp) < 5000 ? ` (Stockfish ${pySigned(cp / 100, 1).replace('-', '−')})` : '';
    const mated = this.board.isCheckmate();
    const why = (this.side === 'attack' ? {
      mate: mated ? 'Checkmate!' : `Mate is forced${evaluation}.`,
      draw: 'A forced draw — the same position three times.',
      material: `The material is back, and more${evaluation}.`,
      equal: `The material is back — about level${evaluation}.`,
      attack: `Still down material, but crushing${evaluation}.`,
      max: `A long line — and it's still working${evaluation}.`,
      over: 'The game is over.',
    } : {
      mate: mated ? 'Mated — no defence could stop it.' : `They have a forced mate — no defence stops it${evaluation}.`,
      draw: 'You held — a forced draw.',
      material: `They win the material back${evaluation}.`,
      equal: `You held: the material is level${evaluation}.`,
      attack: `Their attack keeps going${evaluation}.`,
      max: `Their attack keeps going${evaluation}.`,
      over: 'The game is over.',
    } as Record<string, string>)[reason] ?? '';
    const head = (practice ? 'Other defence · ' : '')
      + (clean ? (this.side === 'defend' ? '✓ The toughest defence, every move!' : '✓ You made it work!')
        : `Done — with ${this.misses} hint${this.misses !== 1 ? 's' : ''}`);
    let comparison = '';
    if (!practice && this.side === 'attack') {
      const { moves, text } = await this.client.service('sacGameComparison', cand, this.line);
      this.gameLine = moves;
      comparison = text;
    } else if (this.gameMoves.length) {
      this.gameLine = this.gameMoves.slice(0, this.line.length + 2);
      comparison = `In your game: ${numbered(this.start, this.gameLine)}`;
    }
    if (token !== this.token) return;
    this.state = 'result';
    this.setStatus(`${head} · ${sac.OUTCOMES[reason] ?? 'Done'}. ${why}`, clean ? 'success' : 'warning',
      `The line: ${numbered(this.start, this.line)}${comparison ? `\n${comparison}` : ''}`);
    if (cp !== null) this.setBar(cp, this.me, mate);
    this.movable = null;
    this.resultButtons();
    this.peekAt(this.board);                         // Stockfish's lines here, and Analyze from here
    this.changed();
    void this.refreshScores();
    if (!practice && this.side === 'attack') {
      this.mainLine = [...this.line];
      void this.findDefences(token);
    }
  }

  private resultButtons(): void {
    this.buttons = [{ id: 'next', label: 'Next sacrifice →', primary: true }, { id: 'analyze', label: 'Analyze' },
      { id: 'play', label: 'Play it out' }, ...(this.cand?.gameId ? [{ id: 'review', label: 'Review game' }] : [])];
  }

  // ---------- other defences ----------

  /** After an Attack round: Stockfish's other reasonable defences along the line, to replay against. */
  private async findDefences(token: object): Promise<void> {
    if (!this.engine) return;
    this.branchesNote = 'Looking for other defences…';
    this.changed();
    const found: Branch[] = [];
    try {
      const board = this.start.copy();
      for (const [j, move] of this.mainLine.entries()) {
        if (j % 2 === 1 && j <= BRANCH_PLIES && found.length < MAX_BRANCHES) {
          for (const alt of await sac.otherDefences(this.engine, board, move)) {
            found.push({ at: j, move: alt, label: `${numbered(board, [alt])} instead of ${board.san(move)}`, result: '' });
          }
          if (token !== this.token) return;
        }
        board.push(move);
      }
    } catch {
      /* none offered */
    }
    if (token !== this.token) return;
    this.branches = found.slice(0, MAX_BRANCHES);
    this.branchesNote = this.branches.length ? 'Other defences — try the line against each (not scored):'
      : 'Stockfish found no other reasonable defences here.';
    this.changed();
  }

  /** Replay the main line up to one of their defences, they play the other one, and you go on from there. */
  private async playBranch(i: number): Promise<void> {
    const br = this.branches[i];
    if (!br || this.state !== 'result' || this.noEngine()) return;
    this.endExplore();
    const token = this.token = {};
    this.practice = i;
    this.board = this.start.copy();
    this.lineCtx = sac.Line.from(this.start);
    this.line = [];
    for (const m of this.mainLine.slice(0, br.at)) this.push(m);
    this.movesDone = (br.at - 1) / 2;
    this.misses = 0;
    this.missedHere = false;
    this.playing = null;
    this.state = 'thinking';
    this.buttons = [];
    this.setStatus(`Other defence: they play ${this.board.san(br.move)} instead.`, 'sac', `Line so far: ${numbered(this.start, this.line)}`);
    this.changed();
    const after = this.board.copy();
    after.push(br.move);
    const stepInfo = await sac.step(this.engine!, after, this.me, this.movesDone, this.lineCtx);
    if (token !== this.token) return;
    setTimeout(() => void this.showReply(token, br.move, stepInfo), REPLY_DELAY_MS);
  }

  // ---------- after the round ----------

  private playItOut(): void {
    if (this.state !== 'result') return;
    this.playing = { fen: this.board.fen(), color: this.me, title: 'Play it out — from the end of the line' };
    this.changed();
  }

  closePlay(): void {
    this.playing = null;
    this.changed();
  }

  /** Back from the analysis board: the end of the line. */
  private redrawResult(): void {
    this.show(this.board, { lastMove: this.board.moveStack.at(-1) ?? null });
    this.peekAt(this.board);
  }

  protected override exploreButtons() {
    return this.gameLine.length ? [{ id: 'gameline', label: 'Your game' }] : [];
  }

  protected override explorerTitle(board: Board): string {
    const side = board.turn === WHITE ? 'White' : 'Black';
    const played = board.moveStack.length - this.start.moveStack.length;
    const stack = board.moveStack.slice(this.start.moveStack.length);
    const where = played <= 0 ? 'before the sacrifice'
      : stack.join(' ') === this.line.slice(0, played).join(' ') ? "on the round's line"
        : this.gameLine.length && stack.join(' ') === this.gameLine.slice(0, played).join(' ') ? "your game's line" : 'your own line';
    return `${side} to move · ${where}`;
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
}
