/**
 * The engine interface the core modules use — python-chess's
 * engine.analyse(board, Limit, multipv) and its PovScore, made async because
 * the browser engine (Stockfish WASM in a Web Worker) answers by message.
 * Implemented by the Stockfish worker client in the app and by FakeEngine in tests.
 */
import type { Board, Color } from './chess';

/** chess.engine.Cp / Mate, relative to one side. */
export class Score {
  private constructor(readonly cp: number | null, readonly mateIn: number | null, readonly mateGiven = false) {}

  static cp(cp: number): Score {
    return new Score(cp, null);
  }

  /** Mate(n): n > 0 = mating in n, n < 0 = getting mated in -n, 0 = already mated. */
  static mate(moves: number): Score {
    return new Score(null, moves);
  }

  isMate(): boolean {
    return this.mateIn !== null || this.mateGiven;
  }

  /** .mate(): moves to mate (python-chess: MateGiven -> 0, non-mate -> null). */
  mate(): number | null {
    return this.mateGiven ? 0 : this.mateIn;
  }

  /** .score(mate_score=...): centipawns, mates mapped like python-chess. */
  score(mateScore?: number): number | null {
    if (this.cp !== null) return this.cp;
    if (mateScore === undefined) return null;
    if (this.mateGiven) return mateScore;
    const m = this.mateIn!;
    return m > 0 ? mateScore - m : -mateScore - m;
  }

  /** Negation exactly as python-chess: -Mate(0) is MateGiven. */
  negate(): Score {
    if (this.cp !== null) return Score.cp(-this.cp);
    if (this.mateGiven) return Score.mate(0);
    return this.mateIn === 0 ? new Score(null, null, true) : Score.mate(-this.mateIn!);
  }
}

/** chess.engine.PovScore: a score from the point of view of `turn`. */
export class PovScore {
  constructor(readonly relative: Score, readonly turn: Color) {}

  pov(color: Color): Score {
    return color === this.turn ? this.relative : this.relative.negate();
  }
}

export interface InfoLine {
  pv: string[];            // UCI moves
  score: PovScore;
  depth?: number;
}

/** chess.engine.Limit */
export interface Limit {
  depth?: number;
  /** seconds */
  time?: number;
}

export interface Engine {
  /** Always returns a list (best first); python-chess returns one dict
   *  without multipv — callers take [0] there. rootMoves: search only these
   *  moves (python-chess root_moves, UCI "go ... searchmoves"). */
  analyse(board: Board, limit: Limit, multipv?: number, rootMoves?: string[]): Promise<InfoLine[]>;
  /** UCI "ucinewgame": forget the previous game (clears the hash). Optional: fakes skip it. */
  newGame?(): Promise<void>;
}

/** Turns a UCI "info ... score cp X / mate N ... pv ..." line into an InfoLine,
 *  scores relative to the side to move (`turn`), as UCI reports them. */
export function parseInfo(line: string, turn: Color): (InfoLine & { multipv: number }) | null {
  const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
  if (!score) return null;
  const pv = /\bpv (.*)$/.exec(line);
  const depth = /\bdepth (\d+)/.exec(line);
  const multipv = /\bmultipv (\d+)/.exec(line);
  const value = parseInt(score[2], 10);
  return {
    pv: pv ? pv[1].trim().split(/\s+/) : [],
    score: new PovScore(score[1] === 'cp' ? Score.cp(value) : Score.mate(value), turn),
    depth: depth ? parseInt(depth[1], 10) : undefined,
    multipv: multipv ? parseInt(multipv[1], 10) : 1,
  };
}
