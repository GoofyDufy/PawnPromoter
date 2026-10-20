/**
 * What the three Tactics & Threats drills share (spot_tab / threat_tab /
 * sac_tab): the board they show, the status and detail lines, the buttons,
 * the evaluation bar (blank until the answer, so it can't give it away), and
 * this session's streak. Each drill is a subclass; the screen draws it.
 */
import { Board, type Color, WHITE } from '../../core/chess';
import type { Engine } from '../../core/engine';
import type { DbClient } from '../../data/client';
import type { LevelView } from '../../data/level';
import { Analysis, ideaRows } from '../analysis';
import type { Arrow } from '../Board';

export type Tone = 'normal' | 'success' | 'error' | 'warning' | 'muted' | 'sac';

export interface ButtonDef {
  id: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}

export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–');

/** '24. Qh4 g6 25. Qxe4' — numbered from the position's real move number. */
export function numbered(start: Board, moves: string[]): string {
  const b = start.copy();
  return moves.map((m, i) => {
    const n = b.fullmoveNumber;
    const text = b.turn === WHITE ? `${n}. ${b.san(m)}` : i === 0 ? `${n}... ${b.san(m)}` : b.san(m);
    b.push(m);
    return text;
  }).join(' ');
}

export abstract class TrainerBase {
  version = 0;
  source = '';
  status: { text: string; tone: Tone } = { text: '', tone: 'muted' };
  detail = '';
  fen: string | null = null;              // null: an empty board (finding a position)
  orientation: Color = 'white';
  lastMove: string | null = null;
  arrows: Arrow[] = [];
  movable: Color | 'both' | null = null;
  evalWhite: number | null = null;        // null: blank (grey)
  evalMate: number | null = null;         // moves to mate, White's point of view (the bar shows M2 / −M2)
  buttons: ButtonDef[] = [];
  allTime = '';
  protected token: object = {};           // the current round; stale engine answers are dropped
  private listeners = new Set<() => void>();

  /** After a round: Stockfish's top lines for the position shown, and the analysis board from it. */
  protected readonly explorer: Analysis;
  private exploring = false;
  private beforeExplore: { status: TrainerBase['status']; detail: string; buttons: ButtonDef[]; evalWhite: number | null; evalMate: number | null; restore: () => void } | null = null;
  private shownBoard: Board | null = null;
  private peekFen = '';

  constructor(
    protected readonly client: DbClient,
    protected readonly engine: Engine | null,
    protected readonly onLevel: (level: LevelView) => void,
  ) {
    this.explorer = new Analysis(engine, {
      title: (b) => this.explorerTitle(b),
      hint: 'click a line, then ▶ · ◀ takes back',
      onChange: () => {
        if (this.exploring) {
          this.show(this.explorer.board, { lastMove: this.explorer.board.moveStack.at(-1) ?? null, arrows: this.explorer.arrows(), movable: 'both' });
          this.evalWhite = this.explorer.evalWhite;
          this.evalMate = this.explorer.evalMate;
          this.changed();
        } else if (this.explorer.peeking) this.changed();
      },
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  protected changed(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  protected setStatus(text: string, tone: Tone = 'normal', detail?: string): void {
    this.status = { text, tone };
    if (detail !== undefined) this.detail = detail;
  }

  protected show(board: Board | null, opts: { arrows?: Arrow[]; lastMove?: string | null; movable?: Color | 'both' | null } = {}): void {
    this.fen = board ? board.fen() : null;
    this.arrows = opts.arrows ?? [];
    this.lastMove = opts.lastMove ?? null;
    this.movable = opts.movable ?? null;
  }

  /** Evaluation bar from `me`'s point of view. */
  protected setBar(cpMe: number | null, me: Color, mateMe: number | null = null): void {
    this.evalWhite = cpMe === null ? null : me === WHITE ? cpMe : -cpMe;
    this.evalMate = mateMe === null || cpMe === null ? null : me === WHITE ? mateMe : -mateMe;
  }

  protected noEngine(): boolean {
    if (this.engine) return false;
    this.setStatus('Stockfish not found.', 'error');
    this.changed();
    return true;
  }

  abstract title: string;
  abstract intro: string;
  abstract sessionLine(): string;
  abstract sessionDetail(): string;
  abstract onShown(): Promise<void>;
  abstract onMove(uci: string): Promise<void>;
  abstract press(id: string): Promise<void> | void;
  /** The game this position is from (Review game), if any. */
  abstract gameAt(): { gameId: string; fen: string } | null;
  /** The analysis board while it's open (the commentary shows its Stockfish lines), else null. */
  liveAnalysis(): Analysis | null {
    return this.exploring ? this.explorer : null;
  }

  /** Stockfish's top lines for the position on the board after a round (click one: press(`line<i>`)), else null. */
  stockfishLines(): { header: string; rows: string[] } | null {
    if (this.exploring || !this.explorer.peeking) return null;
    const rows = this.explorer.ideas.length ? ideaRows(this.peekFen, this.explorer.ideas) : [];
    return { header: rows.length ? 'top moves here · click one to explore it' : this.explorer.peekPanel.header, rows };
  }

  /** After a round: list Stockfish's lines for this position (the one the board shows). */
  protected peekAt(board: Board): void {
    this.shownBoard = board;
    if (!this.engine) return;
    this.peekFen = board.fen();
    this.explorer.peek(board);
  }

  /** A new round: close the analysis board, no more Stockfish lines. */
  protected endExplore(): void {
    if (this.exploring) {
      this.exploring = false;
      this.explorer.stop();
    }
    this.beforeExplore = null;
    this.explorer.unpeek();
  }

  /** The Analyze / Stockfish-line / ◀ ▶ Back buttons; true when handled. restore: redraws the
   *  round's result when the analysis board closes (and calls peekAt again). */
  protected explorePress(id: string, restore: () => void): boolean {
    if (id === 'analyze') this.openExplorer(null, restore);
    else if (/^line\d+$/.test(id)) this.openExplorer(Number(id.slice(4)), restore);
    else if (!this.exploring) return false;
    else if (id === 'aback') this.explorer.step(-1);
    else if (id === 'afwd') this.explorer.step(1);
    else if (id === 'done') this.closeExplorer();
    else return false;
    return true;
  }

  protected exploreKey(k: string): boolean {
    if (!this.exploring) return false;
    if (k === 'ArrowLeft') this.explorer.step(-1);
    else if (k === 'ArrowRight') this.explorer.step(1);
    else return false;
    return true;
  }

  protected exploreMove(uci: string): boolean {
    if (!this.exploring) return false;
    this.explorer.play(uci);
    return true;
  }

  protected get isExploring(): boolean {
    return this.exploring;
  }

  /** The analysis board's heading (a drill may say where on its line the board is). */
  protected explorerTitle(board: Board): string {
    return `${board.turn === WHITE ? 'White' : 'Black'} to move`;
  }

  /** More buttons for the analysis board (before Back). */
  protected exploreButtons(): ButtonDef[] {
    return [];
  }

  /** The round's commentary changed while the analysis board is open: kept for when it closes. */
  protected setResultDetail(text: string): void {
    if (this.exploring && this.beforeExplore) this.beforeExplore.detail = text;
    else this.detail = text;
  }

  private openExplorer(i: number | null, restore: () => void): void {
    if (this.exploring || !this.shownBoard) return;
    const pv = i !== null ? this.explorer.ideas[i]?.pv ?? null : null;   // read before unpeek / start clear the ideas
    this.beforeExplore = { status: this.status, detail: this.detail, buttons: this.buttons, evalWhite: this.evalWhite, evalMate: this.evalMate, restore };
    this.explorer.unpeek();
    this.exploring = true;
    this.buttons = [{ id: 'aback', label: '◀' }, { id: 'afwd', label: '▶' }, ...this.exploreButtons(), { id: 'done', label: 'Back' },
      ...this.buttons.filter((b) => b.id === 'next')];
    this.explorer.start(this.shownBoard);
    if (pv?.length && this.explorer.play(pv[0])) this.explorer.ahead = pv.slice(1);   // the clicked line: ▶ plays on along it
    this.changed();
  }

  private closeExplorer(): void {
    const b = this.beforeExplore;
    if (!this.exploring || !b) return;
    this.exploring = false;
    this.explorer.stop();
    this.status = b.status;
    this.detail = b.detail;
    this.buttons = b.buttons;
    this.evalWhite = b.evalWhite;
    this.evalMate = b.evalMate;
    b.restore();
    this.changed();
  }
  /** Keyboard: y / n / h / Enter / space / ← → (each drill uses what it needs). */
  key(_key: string): void {}
  dispose(): void {
    this.token = {};
    this.explorer.dispose();
  }
}
