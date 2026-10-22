/**
 * Puzzle Review's logic — port of puzzle_tab.PuzzleReviewTab without the
 * widgets: the queue and its filters, solving (multi-move lines, near-best
 * tries, retry / reveal), explanations, the step-through main line, tags, and
 * the shared analysis board after a puzzle. The React screen only draws what
 * this holds and forwards clicks; this calls the database worker (services.ts)
 * and the app's shared Stockfish.
 *
 * Async work (solution lines, explanations) carries a token, as on desktop:
 * an answer for a puzzle you've already left is dropped.
 */
import { MATE_CP } from '../core/analyzer';
import { Board, type Color, WHITE } from '../core/chess';
import * as coach from '../core/coach';
import type { Engine } from '../core/engine';
import * as explain from '../core/explain';
import { pyFixed, pySigned } from '../core/format';
import * as lichessPuzzles from '../core/lichessPuzzles';
import type { Puzzle } from '../core/models';
import * as progression from '../core/progression';
import * as puzzleKind from '../core/puzzleKind';
import * as puzzleTags from '../core/puzzleTags';
import type { DbClient } from '../data/client';
import {
  ALL_KINDS, ALL_POSITIONS, ALL_TYPES, BOTH_SOURCES, type LevelView, MY_GAMES, type PuzzleDetails,
  type PuzzleRecordView, THEME_PREFIX,
} from '../data/services';
import { Analysis } from './analysis';
import type { Arrow } from './Board';
import { beforeLast, CoachIdeas, lastWasRecapture } from './coachIdeas';

export const NEAR_BEST_CP = 50;      // a try within half a pawn of the best move is flagged as near-best
export const MAIN_LINE_PLIES = 12;   // how far the step-through main line goes after your best move
export const MAIN_LINE_DEPTH = 18;
export const REPLY_DELAY_MS = 600;   // pause before the opponent's reply in a multi-move puzzle

export type Tone = 'normal' | 'success' | 'error' | 'warning' | 'muted';
type AttemptState = 'solving' | 'pending' | 'reply' | 'wrong' | 'done';

/** Formats a centipawn value as a signed pawns figure, e.g. '+1.5' (mates read as words). */
export function cpToPawns(cp: number | null): string {
  if (cp === null) return '?';
  if (cp >= MATE_CP) return 'a forced mate for you';
  if (cp <= -MATE_CP) return 'a forced mate against you';
  return pySigned(cp / 100, 1);
}

/** '24. Qxd5 Nxd5 25. Bb5+' — numbered from the puzzle position. */
export function lineText(sans: string[], start: Board): string {
  const parts: string[] = [];
  let n = start.fullmoveNumber;
  let white = start.turn === WHITE;
  sans.forEach((san, i) => {
    if (white) parts.push(`${n}. ${san}`);
    else {
      parts.push(i === 0 ? `${n}... ${san}` : san);
      n += 1;
    }
    white = !white;
  });
  return parts.join(' ');
}

/** Queue-row tally of every first try, e.g. '✓2 ◐1 ✗1'. */
export function recordShort(rec: PuzzleRecordView | undefined): string {
  if (!rec) return '';
  return ([['correct', '✓'], ['near_best', '◐'], ['missed', '✗']] as const).filter(([k]) => rec[k]).map(([k, m]) => `${m}${rec[k]}`).join(' ');
}

/** Short label for how costly the mistake was, e.g. '−1.5' or 'allowed mate'. */
export function swingText(p: Puzzle): string {
  if (p.eval_after_cp !== null && p.eval_after_cp <= -MATE_CP) return 'allowed mate';
  if (p.eval_swing_cp === null) return '?';
  return `−${pyFixed(p.eval_swing_cp / 100, 1)}`;
}

export const BLUE = 'blue' as const;      // your game move (GAME_MOVE_COLOR)
export const GREEN = 'green' as const;    // the computer's reply (REPLY_COLOR)

export interface Filters {
  source: string;
  type: string;
  kind: string;
  position: string;
  focus: string;
}

export class PuzzleController {
  // ---- the queue ----
  filters: Filters = { source: MY_GAMES, type: ALL_TYPES, kind: ALL_KINDS, position: ALL_POSITIONS, focus: 'All games' };
  typeOptions: string[] = [ALL_TYPES];
  queue: Puzzle[] = [];
  index = -1;
  records: Record<string, PuzzleRecordView> = {};
  solvedIds = new Set<string>();      // solved on the first try this session
  seenIds = new Set<string>();        // shown this session — Random prefers unseen ones
  emptyText = '';
  loading = true;

  // ---- the puzzle on the board ----
  puzzle: Puzzle | null = null;
  details: PuzzleDetails | null = null;
  board = Board.fromFen();            // what the board shows (its last move highlighted)
  orientation: Color = 'white';
  arrows: Arrow[] = [];
  evalMe: number | null = null;       // your point of view
  status: { text: string; tone: Tone } = { text: '', tone: 'normal' };
  explanation = '';
  state: AttemptState = 'solving';
  retryVisible = false;
  // step-through main line once solved / revealed: best move + engine continuation
  mainLine: string[] = [];
  lineIndex = 0;
  lineVisible = false;
  analysis: Analysis;

  private attemptRecorded = false;
  private attemptId: number | null = null;          // saved first try, while it can still be upgraded
  private runAttemptId: number | null = null;       // the saved first try, for the whole sequence
  private paysXp = false;
  private nearBestFlagged = false;
  // multi-move puzzles: the forcing line to play (yours + replies)
  private solution: string[] = [];
  private solutionReady = false;
  private ply = 0;                                   // index in solution of your next move
  private seqBoard: Board = Board.fromFen();
  private seqMissed = false;
  private solutionToken: object | null = null;
  private explainToken: object | null = null;
  private lineToken: object | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly client: DbClient,
    private readonly engine: Engine | null,
    private readonly onLevel: (level: LevelView) => void = () => {},
  ) {
    this.analysis = new Analysis(engine, {
      title: (b) => {
        const made = b.moveStack.length;
        return `${b.turn === WHITE ? 'White' : 'Black'} to move${made ? ` (${made} move${made !== 1 ? 's' : ''} in)` : ''}`;
      },
      onChange: () => this.changed(),
    });
    this.coachIdeas = new CoachIdeas(client, 'puzzle_ideas', engine, () => this.changed());
  }

  /** The Coach's 💡 Ideas on the puzzle position — offered once it's solved or revealed. */
  readonly coachIdeas: CoachIdeas;

  /** The ideas of the position on the board (the screen calls this when it changes). */
  explainIdeas(): void {
    const p = this.puzzle;
    if (!p || this.state !== 'done') {
      void this.coachIdeas.explain(null);
      return;
    }
    const me = Board.fromFen(p.fen).turn;
    const b = this.board;
    const atStart = b.fen() === Board.fromFen(p.fen).fen();
    void this.coachIdeas.explain({ fen: b.fen(), me, cp: atStart ? p.eval_before_cp : null, theirMove: b.turn === me ? b.moveStack.at(-1) : undefined,
      before: beforeLast(b), recapture: b.turn === me && lastWasRecapture(b) })
      .then(() => this.changed());
  }

  /** Bumped on every change (React's useSyncExternalStore snapshot). */
  version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private changed(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  private setStatus(text: string, tone: Tone = 'normal'): void {
    this.status = { text, tone };
  }

  // ---------- filters & queue ----------

  async init(): Promise<void> {
    const s = await this.client.service('getSettings', ['puzzle_source', 'puzzle_kind_filter', 'focus_filter']);
    this.filters = {
      ...this.filters,
      source: s.puzzle_source && [MY_GAMES, 'Lichess', BOTH_SOURCES].includes(s.puzzle_source) ? s.puzzle_source : MY_GAMES,
      kind: s.puzzle_kind_filter || ALL_KINDS,
      focus: s.focus_filter || 'All games',
    };
    await this.reloadQueue();
  }

  async setFilter(name: keyof Filters, value: string): Promise<void> {
    this.filters = { ...this.filters, [name]: value };
    const setting = { source: 'puzzle_source', kind: 'puzzle_kind_filter', focus: 'focus_filter' }[name as string];
    if (setting) await this.client.service('setSettings', { [setting]: value });
    await this.reloadQueue();
  }

  /** Rebuilds the queue from the database (randomly ordered, no due-date gating). */
  async reloadQueue(): Promise<void> {
    let view;
    try {
      view = await this.client.service('puzzleQueue', this.filters);
    } catch (e) {
      this.loading = false;
      this.setStatus(`Couldn't load the puzzles: ${e instanceof Error ? e.message : e}`, 'error');
      this.changed();
      return;
    }
    this.queue = view.queue;
    this.typeOptions = view.typeOptions;
    this.filters = { ...this.filters, type: view.type };
    this.records = view.records;
    this.emptyText = view.emptyText;
    this.loading = false;
    if (this.queue.length) await this.loadAt(0);
    else {
      this.index = -1;
      this.puzzle = null;
      this.details = null;
      this.arrows = [];
      this.setStatus(this.emptyText, 'muted');
      this.explanation = '';
      this.retryVisible = false;
      this.hideMainLine();
      this.changed();
    }
  }

  /** The queue: every puzzle (yours and Lichess) with this tag, unsolved first (Progress → Themes). */
  async practiceTheme(tag: string): Promise<void> {
    this.filters = { ...this.filters, source: BOTH_SOURCES, kind: ALL_KINDS, position: ALL_POSITIONS, type: THEME_PREFIX + tag };
    await this.reloadQueue();
  }

  /** Shows one of your games' puzzles (filters cleared so it's in the queue). */
  async openPuzzle(puzzleId: string): Promise<boolean> {
    this.filters = { ...this.filters, source: MY_GAMES, kind: ALL_KINDS, position: ALL_POSITIONS, type: ALL_TYPES, focus: 'All games' };
    await this.reloadQueue();
    const i = this.queue.findIndex((p) => p.id === puzzleId);
    if (i < 0) return false;
    await this.loadAt(i);
    return true;
  }

  rowLabel(i: number): string {
    const p = this.queue[i];
    const check = this.solvedIds.has(p.id) ? '✓ ' : '';
    const record = recordShort(this.records[p.id]);
    const detail = p.source === 'lichess' ? (this.filters.source === BOTH_SOURCES ? `Li ${p.rating}` : String(p.rating)) : swingText(p);
    return `${check}${i + 1}.  ${p.puzzle_type || 'Puzzle'}  (${detail})${record ? `   ${record}` : ''}`;
  }

  countText(): string {
    const solved = this.queue.filter((p) => this.solvedIds.has(p.id)).length;
    return `${this.queue.length} puzzle(s)${solved ? ` · ${solved} solved this session` : ''}`;
  }

  next(): Promise<void> {
    return this.queue.length ? this.loadAt((this.index + 1) % this.queue.length) : Promise.resolve();
  }

  previous(): Promise<void> {
    return this.queue.length ? this.loadAt((this.index - 1 + this.queue.length) % this.queue.length) : Promise.resolve();
  }

  /** A random puzzle, preferring ones not shown this session. */
  random(): Promise<void> {
    if (!this.queue.length) return Promise.resolve();
    const others = this.queue.map((_, i) => i).filter((i) => i !== this.index);
    const pool = others.length ? others : [this.index];
    const unseen = pool.filter((i) => !this.seenIds.has(this.queue[i].id));
    const from = unseen.length ? unseen : pool;
    return this.loadAt(from[Math.floor(Math.random() * from.length)]);
  }

  async loadAt(index: number): Promise<void> {
    this.state = 'solving';
    this.retryVisible = false;
    this.explanation = '';
    this.index = index;
    const p = this.queue[index];
    this.puzzle = p;
    this.seenIds.add(p.id);
    this.attemptRecorded = false;
    this.attemptId = null;
    this.nearBestFlagged = false;
    this.explainToken = null;
    this.explainIdeas();
    this.hideMainLine();
    this.startSolution();
    // puzzle positions are always your move — show the board from your side
    this.orientation = Board.fromFen(p.fen).turn;
    this.showStartPosition();
    this.arrows = [];
    this.details = null;
    this.showPrompt();
    this.evalMe = p.eval_before_cp;
    this.changed();
    const details = await this.client.service('puzzleDetails', p);
    if (this.puzzle !== p) return;               // moved on while it loaded
    this.details = details;
    this.changed();
  }

  isLichess(): boolean {
    return this.puzzle?.source === 'lichess';
  }

  /** The puzzle's position; a Lichess puzzle shows the opponent's set-up move as the last move. */
  private showStartPosition(): void {
    const p = this.puzzle!;
    if (p.setup_fen && p.setup_uci) {
      this.board = Board.fromFen(p.setup_fen);
      this.board.push(p.setup_uci);
    } else {
      this.board = Board.fromFen(p.fen);
    }
  }

  private showPrompt(): void {
    const p = this.puzzle!;
    const side = Board.fromFen(p.fen).turn === WHITE ? 'White' : 'Black';
    const setup = p.setup_fen && p.setup_uci ? `Opponent played ${Board.fromFen(p.setup_fen).san(p.setup_uci)}. ` : '';
    this.setStatus(`${setup}Find the best move for ${side}.`);
  }

  gameLabel(): string {
    const p = this.puzzle;
    if (!p) return '';
    if (this.isLichess()) return `Lichess puzzle, rated ${p.rating}${p.opening ? ` — ${p.opening}` : ''}`;
    const g = this.details?.game;
    return g ? `${g.white} (White) vs ${g.black} (Black) — ${g.played}` : '';
  }

  recordLabel(): string {
    if (!this.puzzle) return '';
    const rec = this.records[this.puzzle.id];
    if (!rec || !(rec.correct + rec.near_best + rec.missed)) return 'First try';
    return `You: ✓${rec.correct} ◐${rec.near_best} ✗${rec.missed}`;
  }

  // ---------- attempting a puzzle ----------

  async onMove(uci: string): Promise<void> {
    if (this.analysis.active) {
      this.analysis.play(uci);
      this.board = this.analysis.board.cloneWithHistory();
      this.changed();
      return;
    }
    const p = this.puzzle;
    if (!p || this.state !== 'solving') return;
    if (this.ply > 0) return this.onSequenceMove(uci);

    const playedSan = this.board.san(uci);
    const correct = uci === p.correct_move_uci;
    const [rank, cpAlt] = correct ? [null, null] : this.engineRank(uci);
    this.board.push(uci);
    const firstTry = !this.attemptRecorded;
    // XP is paid once per puzzle per day — only promise a bonus that's real
    const paysXp = firstTry && !(this.details?.triedToday ?? false);
    if (!correct) this.seqMissed = true;

    if (correct) {
      this.seqBoard.push(uci);
      if (firstTry) await this.saveFirstTry(true, 'correct', paysXp);
      if (!this.solutionReady) {
        // the forcing line is still being worked out — continue when it's ready
        this.state = 'pending';
        this.setStatus(`✓ ${playedSan} — checking whether the line continues…`, 'success');
        this.changed();
        return;
      }
      this.afterCorrect(playedSan);
      return;
    }
    this.state = 'wrong';
    if (firstTry) await this.saveFirstTry(false, rank ? 'near_best' : 'missed', paysXp);
    if (rank) {
      this.flagNearBest(playedSan, `the engine's ${rank} choice`);
      if (cpAlt !== null) this.evalMe = cpAlt;
    } else {
      this.setStatus(`Not quite — ${playedSan} isn't the best move here.`, 'error');
    }
    this.retryVisible = true;
    this.explanation = 'Working out why…';
    this.arrows = this.gameMoveArrows();
    this.changed();
    const fen = p.fen;
    this.explainAsync(async (engine) => this.attemptJob(fen, uci, engine));
  }

  /** ['2nd' / '3rd', eval] if the try was one of the engine's saved top choices here. */
  private engineRank(uci: string): [string | null, number | null] {
    const top = this.details?.top;
    if (!top) return [null, null];
    if (top.second === uci) return ['2nd', top.cpSecond];
    if (top.third === uci) return ['3rd', top.cpThird];
    return [null, null];
  }

  private flagNearBest(san: string, what: string): void {
    this.nearBestFlagged = true;
    this.setStatus(`Good find! ${san} is ${what}. There's one even better.`, 'warning');
  }

  /** Once the engine has looked at your try: within NEAR_BEST_CP of the best counts as near-best. */
  private async maybeFlagClose(cpAfter: number): Promise<void> {
    const p = this.puzzle!;
    if (this.nearBestFlagged || p.eval_before_cp === null) return;
    const gap = p.eval_before_cp - cpAfter;
    if (gap > NEAR_BEST_CP) return;
    const attempt = this.board.moveStack.at(-1);
    const start = Board.fromFen(p.fen);
    const san = attempt && start.isLegal(attempt) ? start.san(attempt) : 'That';
    this.flagNearBest(san, `almost as good as the best move (only ${pyFixed(Math.max(gap, 0) / 100, 1)} worse)`);
    if (this.attemptId !== null) {            // it was your first try: save it as near-best
      const r = await this.client.service('updateTry', p, this.attemptId, null, 'near_best');
      this.attemptId = null;
      this.records = { ...this.records, [p.id]: r.record };
      this.onLevel(r.level);
    }
  }

  /** Blue arrow for the move you played in the game — only while that piece is still where it started. */
  private gameMoveArrows(): Arrow[] {
    const p = this.puzzle;
    if (!p || !p.played_move_san) return [];
    const start = Board.fromFen(p.fen);
    const move = start.parseSan(p.played_move_san);
    if (!move) return [];
    const from = move.charCodeAt(0) - 97 + 8 * (move.charCodeAt(1) - 49);
    const before = start.pieceAt(from);
    const now = this.board.pieceAt(from);
    if (!before || !now || before.role !== now.role || before.color !== now.color) return [];
    return [{ from: move.slice(0, 2), to: move.slice(2, 4), brush: BLUE }];
  }

  private async saveFirstTry(correct: boolean, outcome: string, paysXp = false): Promise<void> {
    const p = this.puzzle!;
    this.attemptRecorded = true;
    this.paysXp = paysXp;
    const r = await this.client.service('recordFirstTry', p, correct, outcome);
    this.attemptId = r.attemptId;
    this.runAttemptId = r.attemptId;
    this.records = { ...this.records, [p.id]: r.record };
    if (this.details) this.details = { ...this.details, triedToday: true };
    this.onLevel(r.level);
    this.changed();
  }

  private evalSummary(): string {
    const p = this.puzzle!;
    if (p.eval_before_cp === null) return '';
    return `Evaluation: ${cpToPawns(p.eval_before_cp)} with the best move, ${cpToPawns(p.eval_after_cp)} after ${p.played_move_san} in your game.`;
  }

  private explanationText(correct: boolean): string {
    const p = this.puzzle!;
    if (this.isLichess()) {
      const themes = lichessPuzzles.niceThemes(p.themes);
      return `A Lichess puzzle rated ${p.rating}${themes ? ` — themes: ${themes}` : ''}.${p.opening ? ` Opening: ${p.opening}.` : ''}`;
    }
    const before = cpToPawns(p.eval_before_cp);
    const after = cpToPawns(p.eval_after_cp);
    const swing = p.eval_swing_cp !== null ? pyFixed(p.eval_swing_cp / 100, 1) : '?';
    const allowedMate = p.eval_after_cp !== null && p.eval_after_cp <= -MATE_CP;
    const swingNote = allowedMate ? '' : ` — about a ${swing}-pawn swing`;   // a pawn count means nothing once mate is on the board
    if (p.played_move_san === p.correct_move_san) {         // one you picked yourself, where you found it in the game too
      return `This was the engine's top choice here, keeping the evaluation around ${before} — and you found it in your game too.`;
    }
    if (correct) {
      return `This was the engine's top choice here, keeping the evaluation around ${before}. In your actual game, you played `
        + `${p.played_move_san} instead, which dropped it to ${after}${swingNote}.`;
    }
    return `${p.correct_move_san} keeps the evaluation around ${before}. In your actual game here, you played ${p.played_move_san}, `
      + `which dropped the evaluation to ${after}${swingNote}. That's the mistake this puzzle is testing you on.`;
  }

  // ---------- explanations (Stockfish lines + board facts) ----------

  /** Runs job(engine) with the shared Stockfish (null if none) and shows the
   *  text — unless you've moved on to another puzzle or retried. */
  private explainAsync(job: (engine: Engine | null) => Promise<string | { text: string; arrows: Arrow[]; cp: number | null }>): void {
    const token = {};
    this.explainToken = token;
    void (async () => {
      let result: Awaited<ReturnType<typeof job>> | null = null;
      try {
        result = await job(this.engine);
      } catch {
        try {
          result = await job(null);          // Stockfish failed: the board facts alone
        } catch {
          result = null;
        }
      }
      if (this.explainToken !== token || !result) return;
      if (typeof result === 'string') this.explanation = result;
      else {
        this.explanation = result.text;
        if (this.state === 'wrong') {
          this.arrows = result.arrows;
          if (result.cp !== null) {
            this.evalMe = result.cp;
            await this.maybeFlagClose(result.cp);
          }
          // a good move: drop the "you miss" wording
          if (this.nearBestFlagged) this.explanation = result.text.replace(' — you miss something stronger here', '');
        }
      }
      this.changed();
    })();
  }

  /** Explanation of a wrong try + the computer's reply as a green arrow. */
  private async attemptJob(fen: string, move: string, engine: Engine | null) {
    const { text: words, pv, cp } = await explain.explainAttempt(fen, move, engine);
    let text = words;
    const arrows = this.gameMoveArrows();
    if (pv.length) {
      arrows.push({ from: pv[0].slice(0, 2), to: pv[0].slice(2, 4), brush: GREEN });
      const board = Board.fromFen(fen);
      board.push(move);
      text += `\nGreen arrow: the computer's reply ${board.san(pv[0])}.`;
    }
    if (arrows.some((a) => a.brush === BLUE)) text += ` Blue arrow: your game move ${this.puzzle!.played_move_san}.`;
    // the habit behind the try, when it's a recognisable one (a check for its own sake, a one-move attack…)
    const before = Board.fromFen(fen);
    const habit = coach.habits(before, { fenBefore: fen, move, best: this.puzzle!.correct_move_uci, cpBefore: this.puzzle!.eval_before_cp ?? 0, cpAfter: cp })[0];
    if (habit) text += `\nCoach: ${before.san(move)} ${habit}.`;
    return { text, arrows, cp };
  }

  private explainSolutionAsync(solved: boolean): void {
    const p = this.puzzle!;
    const start = Board.fromFen(p.fen);
    const gameMove = p.played_move_san ? start.parseSan(p.played_move_san) ?? null : null;
    const summary = this.evalSummary();
    // the line so far: everything you played if solved (the board shows its end),
    // else the full solution with the board on its first move
    const played = this.seqBoard.moveStack;
    if (solved && played.length) this.loadMainLine(p.fen, played, played.length);
    else this.loadMainLine(p.fen, this.solution.length ? this.solution : [p.correct_move_uci], 1);
    this.explanation = 'Working out the key line…';
    this.explainAsync(async (engine) => (await explain.explainSolution(p.fen, p.correct_move_uci, gameMove, engine))
      + (summary ? `\n${summary}` : ''));
  }

  // ---------- step-through main line ----------

  /** ◀ ▶ right away (the solution so far), then Stockfish's continuation after it. */
  private loadMainLine(fen: string, start: string[], shown: number): void {
    const token = {};
    this.lineToken = token;
    this.mainLine = [...start];
    this.lineIndex = shown;
    this.lineVisible = true;
    void (async () => {
      let line: string[] = [];
      try {
        const board = Board.fromFen(fen);
        for (const m of start) board.push(m);
        if (this.engine && !board.isGameOver()) {
          const [info] = await this.engine.analyse(board, { depth: MAIN_LINE_DEPTH });
          line = info.pv.slice(0, MAIN_LINE_PLIES);
        }
      } catch {
        line = [];
      }
      if (this.lineToken === token && line.length) {
        this.mainLine = [...start, ...line];
        this.changed();
      }
    })();
  }

  private hideMainLine(): void {
    this.lineToken = null;
    this.mainLine = [];
    this.lineIndex = 0;
    this.lineVisible = false;
    this.stopAnalysis();
  }

  canStepBack(): boolean {
    return this.analysis.active ? this.analysis.board.moveStack.length > this.analysis.floor : this.lineIndex > 0;
  }

  canStepForward(): boolean {
    return this.analysis.active ? true : this.lineIndex < this.mainLine.length;
  }

  stepLine(delta: number): void {
    if (this.analysis.active) {
      this.analysis.step(delta);
      this.board = this.analysis.board.cloneWithHistory();
      this.changed();
      return;
    }
    const p = this.puzzle;
    if (!p || this.state !== 'done' || !this.mainLine.length) return;
    this.lineIndex = Math.max(0, Math.min(this.mainLine.length, this.lineIndex + delta));
    this.showStartPosition();
    const sans: string[] = [];
    for (const m of this.mainLine.slice(0, this.lineIndex)) {
      sans.push(this.board.san(m));
      this.board.push(m);
    }
    const text = sans.length ? lineText(sans, Board.fromFen(p.fen)) : 'the puzzle position';
    const more = this.lineIndex < this.mainLine.length ? ' …' : '';
    this.setStatus(`Main line (${this.lineIndex}/${this.mainLine.length}): ${text}${more}`);
    this.changed();
  }

  // ---------- self-analysis after a puzzle (the shared analysis board) ----------

  toggleAnalysis(): void {
    if (this.analysis.active) {
      this.stopAnalysis();
      this.stepLine(0);                     // back to the solution view
      return;
    }
    if (!this.puzzle || this.state !== 'done') return;
    // from the puzzle's start: ▶ walks the solution, any move branches off
    this.analysis.start(Board.fromFen(this.puzzle.fen), this.mainLine);
    this.board = this.analysis.board.cloneWithHistory();
    this.changed();
  }

  followIdea(i: number): void {
    this.analysis.follow(i);
    this.board = this.analysis.board.cloneWithHistory();
    this.changed();
  }

  private stopAnalysis(): void {
    if (this.analysis.active) this.analysis.stop();
  }

  /** Arrows for the board: the analysis board's ideas while analysing, else the puzzle's. */
  boardArrows(): Arrow[] {
    return this.analysis.active ? this.analysis.arrows() : this.arrows;
  }

  /** The evaluation bar, White's point of view. */
  evalWhite(): number | null {
    if (this.analysis.active) return this.analysis.evalWhite;
    if (this.evalMe === null || !this.puzzle) return null;
    return Board.fromFen(this.puzzle.fen).turn === WHITE ? this.evalMe : -this.evalMe;
  }

  // ---------- multi-move puzzles ----------

  /** The forcing line, worked out in the background (or saved before: instant). */
  private startSolution(): void {
    const p = this.puzzle!;
    const best = p.correct_move_uci;
    const token = {};
    this.solutionToken = token;
    this.solution = [best];
    this.solutionReady = false;
    this.ply = 0;
    this.seqBoard = Board.fromFen(p.fen);
    this.seqMissed = false;
    this.runAttemptId = null;
    if (p.solution_ucis) {
      this.solution = p.solution_ucis.split(/\s+/).filter(Boolean);
      this.solutionReady = true;
      return;
    }
    void (async () => {
      let solution = [best];
      let result: puzzleKind.Result | null = null;
      try {
        if (this.engine) {
          result = await puzzleKind.classify(this.engine, p.fen, best);
          solution = result.solution;
        }
      } catch {
        solution = [best];
      }
      if (result && p.source !== 'lichess') {       // save it: next time it's instant, and filterable
        try {
          await this.client.service('savePuzzleKind', p.id, result.solution, result.kind);
          p.solution_ucis = result.solution.join(' ');
          p.solution_moves = result.moves;
          p.kind = result.kind;
        } catch {
          /* rebuilt meanwhile: it'll be redone */
        }
      }
      if (this.solutionToken !== token) return;
      this.solution = solution;
      this.solutionReady = true;
      if (this.details && p.kind) {
        this.details = { ...this.details, autoTags: puzzleTags.autoTags(p, this.details.sharp, this.details.endgame) };
      }
      if (this.state === 'pending') this.afterCorrect(Board.fromFen(p.fen).san(best));   // first move already played
      this.changed();
    })();
  }

  private solutionText(): string {
    const board = Board.fromFen(this.puzzle!.fen);
    const sans = this.solution.map((m) => { const s = board.san(m); board.push(m); return s; });
    return lineText(sans, Board.fromFen(this.puzzle!.fen));
  }

  /** A right move: finish the puzzle, or play the opponent's reply. */
  private afterCorrect(san: string): void {
    if (this.seqBoard.isCheckmate() || this.ply + 1 >= this.solution.length) {
      this.finishSolved(san);
      return;
    }
    this.state = 'reply';
    this.setStatus(`✓ ${san} — keep going.`, 'success');
    this.changed();
    const token = this.solutionToken;
    setTimeout(() => this.playReply(token), REPLY_DELAY_MS);
  }

  private playReply(token: object | null): void {
    if (token !== this.solutionToken || this.state !== 'reply') return;
    const reply = this.solution[this.ply + 1];
    const san = this.seqBoard.san(reply);
    this.seqBoard.push(reply);
    this.board = this.boardFromSequence();
    this.ply += 2;
    this.state = 'solving';
    this.setStatus(`Opponent played ${san}. Your move.`);
    this.changed();
  }

  /** The board as the sequence stands (the puzzle's start, the set-up move, then the line). */
  private boardFromSequence(): Board {
    this.showStartPosition();
    const b = this.board;
    for (const m of this.seqBoard.moveStack) b.push(m);
    return b;
  }

  /** Your 2nd, 3rd or 4th move: it has to be the line's move (or mate). */
  private async onSequenceMove(uci: string): Promise<void> {
    const san = this.board.san(uci);
    const after = this.seqBoard.copy();
    after.push(uci);
    this.board.push(uci);
    if (uci === this.solution[this.ply] || after.isCheckmate()) {
      this.seqBoard.push(uci);
      this.afterCorrect(san);
      return;
    }
    await this.markSequenceMissed();
    this.state = 'wrong';
    this.setStatus(`Not quite — ${san} isn't the move; the tactic continues differently.`, 'error');
    this.explanation = '';
    this.retryVisible = true;
    this.changed();
  }

  /** A miss after a right first move: the saved first try becomes a miss. */
  private async markSequenceMissed(): Promise<void> {
    if (this.seqMissed) return;
    this.seqMissed = true;
    if (this.runAttemptId !== null) {
      const p = this.puzzle!;
      const r = await this.client.service('updateTry', p, this.runAttemptId, false, 'missed');
      this.records = { ...this.records, [p.id]: r.record };
      this.onLevel(r.level);
    }
  }

  private finishSolved(san: string): void {
    this.state = 'done';
    const clean = !this.seqMissed;
    if (clean) this.solvedIds.add(this.puzzle!.id);
    const bonus = clean && this.paysXp && this.details?.sharp ? `  Sharp position: +${progression.SHARP_BONUS_XP} XP bonus.` : '';
    let text = this.solution.length > 1 ? `Correct — the whole line: ${this.solutionText()}!${bonus}` : `Correct — ${san}!${bonus}`;
    if (!clean) text += '  (Found with retries — only a clean first run counts.)';
    this.setStatus(text, 'success');
    // stay on the position you reached; ◀ steps back through your line
    this.board = this.boardFromSequence();
    this.arrows = this.gameMoveArrows();
    this.evalMe = this.puzzle!.eval_before_cp;
    this.explanation = this.explanationText(true);
    this.explainSolutionAsync(true);
    this.changed();
  }

  retry(): void {
    if (!this.puzzle) return;
    this.state = 'solving';
    this.explainToken = null;
    this.attemptId = null;                    // retries never change the saved first try
    this.nearBestFlagged = false;
    this.explanation = '';
    this.retryVisible = false;
    this.board = this.boardFromSequence();    // where this step of the line starts
    this.arrows = [];
    if (this.ply) this.setStatus('Try again — your move.');
    else {
      this.showPrompt();
      this.evalMe = this.puzzle.eval_before_cp;
    }
    this.changed();
  }

  async reveal(): Promise<void> {
    if (!this.puzzle) return;
    this.state = 'done';
    if (!this.attemptRecorded) await this.saveFirstTry(false, 'revealed');   // revealed without trying = a miss
    await this.markSequenceMissed();
    this.attemptId = null;
    this.retryVisible = false;
    this.showStartPosition();
    this.board.push(this.puzzle.correct_move_uci);
    this.arrows = this.gameMoveArrows();
    this.evalMe = this.puzzle.eval_before_cp;
    this.setStatus(this.solution.length > 1 ? `The solution: ${this.solutionText()}.` : `The best move was ${this.puzzle.correct_move_san}.`);
    this.explanation = this.explanationText(false);
    this.explainSolutionAsync(false);
    this.changed();
  }

  // ---------- tags ----------

  async setTag(tag: string, on: boolean): Promise<void> {
    const p = this.puzzle;
    if (!p || !this.details) return;
    const clean = tag.split(/\s+/).filter(Boolean).join(' ');
    if (!clean) return;
    const view = await this.client.service('changeTag', p, clean, on, this.details.autoTags);
    this.details = { ...this.details, userTags: view.userTags };
    // the Type filter's tag list (without rebuilding the queue you're in)
    this.typeOptions = [...this.typeOptions.filter((t) => !t.startsWith('Tag: ')), ...view.allTags.map((t) => `Tag: ${t}`)];
    this.changed();
  }

  dispose(): void {
    this.analysis.dispose();
    this.solutionToken = this.explainToken = this.lineToken = null;
  }
}
