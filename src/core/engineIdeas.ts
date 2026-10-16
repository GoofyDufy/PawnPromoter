/**
 * Stockfish's ideas for a position, for studying lines (the Tree view in
 * Opening Drill) — port of engine_ideas.py: its top moves with their
 * evaluations and lines, a quick answer first and a deeper one after.
 *
 * Only the newest position is worked on, so clicking through a line never
 * builds a backlog. The desktop's background thread + UI poller becomes an
 * async loop here; results arrive through onResult(fen, depth, ideas). Give it
 * the app's shared engine (engineService.ts), as the desktop does.
 */
import { MATE_CP } from './analyzer';
import { Board, type Color, WHITE } from './chess';
import type { Engine, InfoLine } from './engine';
import { pySigned } from './format';

export const LINES = 3;              // top moves shown
export const QUICK_DEPTH = 12;       // first answer (well under a second)
export const DEEP_DEPTH = 18;        // then this
export const MAX_BEHIND_CP = 300;    // a 2nd / 3rd line further behind the best isn't shown
export const PV_PLIES = 6;           // moves of each line shown

export class Idea {
  constructor(
    readonly move: string,
    readonly pv: string[],
    readonly cp_white: number,       // evaluation from White's point of view (mate = ±MATE_CP)
    readonly mate: number | null,    // moves to mate (positive: White mates), null if none
  ) {}

  evalText(): string {
    if (this.mate !== null) return this.mate > 0 ? `#${this.mate}` : `#-${-this.mate}`;
    return pySigned(this.cp_white / 100, 2);
  }
}

/** '7.Qc2 c6 8.Nbd2' (or '7...c6 8.Nbd2') from this position. */
export function lineText(board: Board, pv: string[]): string {
  const b = board.copy();
  const parts: string[] = [];
  for (const [i, move] of pv.entries()) {
    if (!b.isLegal(move)) break;
    if (b.turn === WHITE) parts.push(`${b.fullmoveNumber}.${b.san(move)}`);
    else parts.push(i === 0 ? `${b.fullmoveNumber}...${b.san(move)}` : b.san(move));
    b.push(move);
  }
  return parts.join(' ');
}

/** The best line, plus the others that are real alternatives for the side to
 *  move: no more than MAX_BEHIND_CP behind it, and not losing when the best is winning. */
export function worthShowing(ideas: Idea[], turn: Color): Idea[] {
  if (!ideas.length) return [];
  const sign = turn === WHITE ? 1 : -1;
  const best = sign * ideas[0].cp_white;
  return [ideas[0], ...ideas.slice(1).filter((i) => best - sign * i.cp_white <= MAX_BEHIND_CP
    && !(best > 0 && sign * i.cp_white < 0))];
}

export function ideaFrom(info: InfoLine): Idea {
  const score = info.score.pov(WHITE);
  const pv = info.pv.slice(0, PV_PLIES);
  const mate = score.isMate() ? score.mate() : null;
  return new Idea(pv[0], pv, score.score(MATE_CP)!, mate);
}

export class IdeasEngine {
  private pending: string | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly engine: Engine,
    private readonly onResult: (fen: string, depth: number, ideas: Idea[]) => void,
    private readonly onError?: (message: string) => void,
  ) {}

  /** Queue a position; anything queued before it and not started is dropped. */
  analyse(fen: string): void {
    this.pending = fen;
    if (!this.running) void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.pending = null;
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.pending !== null && !this.stopped) {
        const fen = this.pending;
        this.pending = null;
        const board = Board.fromFen(fen);
        if (board.isGameOver()) {
          this.onResult(fen, 0, []);
          continue;
        }
        for (const depth of [QUICK_DEPTH, DEEP_DEPTH]) {
          if (this.pending !== null || this.stopped) break;    // moved on already
          const infos = await this.engine.analyse(board, { depth }, LINES);
          if (this.stopped) break;
          this.onResult(fen, depth, worthShowing(infos.filter((i) => i.pv.length).map(ideaFrom), board.turn));
        }
      }
    } catch (e) {
      this.onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
    }
  }
}
