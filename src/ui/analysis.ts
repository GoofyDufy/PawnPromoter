/**
 * The analysis board shared by Puzzle Review (and, in later phases,
 * Sacrifice!! and Game Review) — port of analysis_board.py's Analysis, kept
 * free of React so it can be tested like the desktop's.
 *
 * A board of its own from any position. Moves can be played for either side;
 * ◀ takes back (not past `floor`), ▶ plays the next move of `ahead` (the game /
 * the solution / a clicked Stockfish line), else Stockfish's best move.
 * peek(board): just Stockfish's lines for a position the screen shows.
 * Stockfish runs through the core's IdeasEngine; the screen redraws on change.
 */
import { Board, WHITE } from '../core/chess';
import type { Engine } from '../core/engine';
import { type Idea, IdeasEngine, lineText } from '../core/engineIdeas';

export type IdeaBrush = 'green' | 'blue' | 'grey';
export const IDEA_BRUSHES: IdeaBrush[] = ['green', 'blue', 'grey'];   // Stockfish's 1st / 2nd / 3rd move
export const RANKS = ['Best', '2nd', '3rd'];

/** What the panel shows: a heading line, then up to three Stockfish lines. */
export interface PanelState {
  title: string;
  header: string;
  rows: string[];
}

export function ideaRows(fen: string, ideas: Idea[]): string[] {
  const board = Board.fromFen(fen);
  return ideas.map((idea) => `${idea.evalText()}   ${lineText(board, idea.pv)}`);
}

/** Short form, one move each: '+0.32 d5'. */
export function ideaChips(fen: string, ideas: Idea[]): string[] {
  const board = Board.fromFen(fen);
  return ideas.map((idea) => `${idea.evalText()} ${board.san(idea.move)}`);
}

export function gameOverText(board: Board): string {
  if (board.isCheckmate()) return `Game over: ${board.turn === WHITE ? 'Black' : 'White'} wins.`;
  return 'Game over: draw.';
}

export interface AnalysisOptions {
  title?: (board: Board) => string;
  hint?: string;
  onShown?: (board: Board) => void;
  /** Called whenever the board, the panel or the ideas change. */
  onChange?: () => void;
}

export class Analysis {
  active = false;
  peeking = false;                    // ideas for a position shown elsewhere (see peek)
  board = Board.fromFen();
  floor = 0;                          // moves on the board ◀ can't take back
  ahead: string[] = [];               // ▶ plays these first
  ideas: Idea[] = [];
  panel: PanelState = { title: '', header: '', rows: [] };
  peekPanel: PanelState = { title: '', header: '', rows: [] };
  /** Evaluation for the bar (White's point of view), from the best idea. */
  evalWhite: number | null = null;
  evalMate: number | null = null;
  private fen: string | null = null;
  private readonly engine: IdeasEngine | null;
  private readonly title: (board: Board) => string;
  private readonly hint: string;

  constructor(engine: Engine | null, private readonly options: AnalysisOptions = {}) {
    this.title = options.title ?? ((b) => `${b.turn === WHITE ? 'White' : 'Black'} to move`);
    this.hint = options.hint ?? 'click a line, then ▶';
    this.engine = engine ? new IdeasEngine(engine, (fen, depth, ideas) => this.onIdeas(fen, depth, ideas),
      (message) => this.onError(message)) : null;
    if (!engine) this.noEngine = true;
  }

  private noEngine = false;

  private changed(): void {
    this.options.onChange?.();
  }

  /** Moves played on the analysis board (its move list). */
  get moves(): string[] {
    return this.board.moveStack;
  }

  // ---------- the board ----------

  /** Analyse from this position (the board is copied, its moves kept); shows it. */
  start(board: Board, ahead: string[] = [], floor = 0): void {
    this.active = true;
    this.board = board.cloneWithHistory();
    this.ahead = [...ahead];
    this.floor = floor;
    this.show();
  }

  stop(): void {
    this.active = false;
    this.fen = null;
    this.ideas = [];
    this.changed();
  }

  /** A move on the board (either side). The `ahead` line is kept if it was its next move. */
  play(move: string): boolean {
    if (!this.active || !this.board.isLegal(move)) return false;
    const uci = this.board.normalizeUci(move) ?? move;
    this.ahead = this.ahead.length && this.ahead[0] === uci ? this.ahead.slice(1) : [];
    this.board.push(uci);
    this.show();
    return true;
  }

  /** ◀ (delta < 0) / ▶ (delta > 0) one move; false when there's nothing to do. */
  step(delta: number, show = true): boolean {
    if (!this.active) return false;
    if (delta < 0) {
      if (this.board.moveStack.length <= this.floor) return false;
      this.ahead.unshift(this.board.pop());          // ▶ plays it again
    } else {
      const move = this.ahead.length ? this.ahead[0] : this.ideas.length ? this.ideas[0].move : null;
      if (!move || !this.board.isLegal(move)) return false;
      this.ahead = this.ahead.slice(1);
      this.board.push(move);
      this.ideas = [];                               // a new position: fresh ideas before ▶ follows them
    }
    if (show) this.show();
    return true;
  }

  /** Several steps (⏮ / ⏭), the board shown once at the end. */
  walk(steps: number): void {
    for (let i = 0; i < Math.min(Math.abs(steps), 999); i++) {
      if (!this.step(steps > 0 ? 1 : -1, false)) break;
    }
    this.show();
  }

  /** A Stockfish line clicked: play its first move; ▶ plays on along it. */
  follow(i: number): void {
    if (!this.active || i >= this.ideas.length) return;
    const pv = [...this.ideas[i].pv];
    if (this.play(pv[0])) {
      this.ahead = pv.slice(1);
      this.changed();
    }
  }

  show(): void {
    const board = this.board;
    this.panel = { ...this.panel, title: `Analysis — ${this.title(board)}` };
    this.fen = board.fen();
    this.ideas = [];
    this.options.onShown?.(board);
    if (board.isGameOver()) {
      this.panel = { ...this.panel, header: gameOverText(board), rows: [] };
    } else if (this.noEngine) {
      this.panel = { ...this.panel, header: 'Stockfish not found — the analysis board needs the engine.', rows: [] };
    } else {
      this.panel = { ...this.panel, header: 'Stockfish is thinking…', rows: [] };
      this.engine!.analyse(this.fen);
    }
    this.changed();
  }

  /** Stockfish's top moves for a position the screen shows itself. */
  peek(board: Board): void {
    this.peeking = true;
    this.fen = board.fen();
    this.ideas = [];
    if (board.isGameOver()) this.peekPanel = { title: '', header: gameOverText(board), rows: [] };
    else {
      this.peekPanel = { title: '', header: 'Stockfish is thinking…', rows: [] };
      this.engine?.analyse(this.fen);
    }
    this.changed();
  }

  unpeek(): void {
    this.peeking = false;
    if (!this.active) {
      this.fen = null;
      this.ideas = [];
    }
    this.changed();
  }

  /** Arrows for the ideas: [from, to, brush], best last (drawn on top). */
  arrows(): { from: string; to: string; brush: IdeaBrush }[] {
    return this.ideas.map((idea, i) => ({ from: idea.move.slice(0, 2), to: idea.move.slice(2, 4), brush: IDEA_BRUSHES[i] })).reverse();
  }

  dispose(): void {
    this.engine?.stop();
  }

  // ---------- Stockfish ----------

  private onIdeas(fen: string, depth: number, ideas: Idea[]): void {
    if (!(this.active || this.peeking) || fen !== this.fen || !ideas.length) return;   // moved on / stopped
    this.ideas = ideas;
    if (this.active) {
      this.panel = { ...this.panel, header: `Stockfish depth ${depth} · ${this.hint}`, rows: ideaRows(fen, ideas) };
      this.evalWhite = ideas[0].cp_white;
      this.evalMate = ideas[0].mate;
    } else {
      this.peekPanel = { title: '', header: 'Stockfish:', rows: ideaChips(fen, ideas) };
    }
    this.changed();
  }

  private onError(message: string): void {
    if (this.active) this.panel = { ...this.panel, header: message, rows: [] };
    else this.peekPanel = { ...this.peekPanel, header: message, rows: [] };
    this.changed();
  }
}

