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
  buttons: ButtonDef[] = [];
  allTime = '';
  protected token: object = {};           // the current round; stale engine answers are dropped
  private listeners = new Set<() => void>();

  constructor(
    protected readonly client: DbClient,
    protected readonly engine: Engine | null,
    protected readonly onLevel: (level: LevelView) => void,
  ) {}

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
  protected setBar(cpMe: number | null, me: Color): void {
    this.evalWhite = cpMe === null ? null : me === WHITE ? cpMe : -cpMe;
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
  /** Keyboard: y / n / Enter / space / ← → (each drill uses what it needs). */
  key(_key: string): void {}
  dispose(): void {
    this.token = {};
  }
}
