/**
 * Drives an opening drill — port of drill.py.
 *
 * Design: at the start of each round, one full line (root to leaf) is selected
 * at random from the repertoire tree and shown by name up front. A move-list
 * recap is available once you finish.
 *
 * Book-move detection is informational only: when you miss, we separately
 * check whether your move matches some OTHER line in the repertoire at this
 * position (matched by board position, not database ancestry). This only
 * flags DrillResult.in_book for messaging; it never changes which line is
 * drilled or accepts the move as correct.
 *
 * Real-world opponents: with Lichess data (moveShare, see explorer.ts), the
 * whole line is picked at once, weighted by how likely real players near your
 * rating are to follow it — the product of the opponent's move shares along it
 * (each with a floor, so rare lines still come up). Lines that differ only in
 * YOUR moves split that weight evenly. Without data, a line is picked uniformly.
 *
 * Wrong moves don't auto-correct: attemptMyMove() leaves the board untouched
 * on a miss, so you can try again, or call revealAndAdvance().
 */
import { Board } from './chess';
import * as db from './db';
import type { OpeningLine, PlayerColor } from './models';
import type { Db } from './sqlite';

/** a reply played in under this share of games is still drilled this often */
export const MIN_REPLY_WEIGHT = 0.05;

/** (fen, uci) -> share of games where that move was played there, or null if unknown */
export type ShareLookup = (fen: string, uci: string) => number | null;

/** A random number in [0, 1) — Math.random, or a seeded generator in tests. */
export type Random = () => number;

export interface DrillResult {
  correct: boolean;
  played_san: string | null;     // what you played (null if not a legal chess move at all)
  correct_san: string | null;    // the expected move at this position (only meaningful on a miss)
  line_complete: boolean;
  in_book: boolean;              // informational only: matched some OTHER line here
}

/** FEN without the move counters, so transpositions count as one position. */
function position(fen: string): string {
  return fen.split(/\s+/).slice(0, 4).join(' ');
}

const choice = <T>(items: T[], random: Random): T => items[Math.floor(random() * items.length)];

/** random.choices(items, weights)[0] */
function weightedChoice<T>(items: T[], weights: number[], random: Random): T {
  const total = weights.reduce((a, b) => a + b, 0);
  const r = random() * total;
  let cumulative = 0;
  for (const [i, w] of weights.entries()) {
    cumulative += w;
    if (r < cumulative) return items[i];
  }
  return items[items.length - 1];
}

export class OpeningDrillSession {
  board = Board.fromFen();
  target_path: OpeningLine[] = [];
  line_name: string | null = null;
  path_index = 0;

  constructor(
    readonly conn: Db,
    readonly repertoire_name: string,
    readonly my_color: PlayerColor,
    readonly move_share: ShareLookup | null = null,
    readonly random: Random = Math.random,
  ) {}

  /** Selects one full line to drill this round — random across the repertoire,
   *  or within the chosen line when rootId is given (its own sub-branches are
   *  still picked randomly). Returns false if there's nothing to drill. */
  start(rootId: string | null = null): boolean {
    let roots = db.rootLines(this.conn, this.repertoire_name, this.my_color);
    if (rootId !== null) roots = roots.filter((r) => r.id === rootId);
    if (!roots.length) return false;

    let path = this.move_share !== null ? this.weightedLine(roots) : null;
    if (path === null) {
      path = [choice(roots, this.random)];
      path.push(...this.treeContinuationFrom(path[0]));
    }

    this.target_path = path;
    this.line_name = path[0].line_name || path[0].repertoire_name;
    this.board = Board.fromFen();
    this.path_index = 0;
    return true;
  }

  /** Drill exactly this line (e.g. picked in the Tree view). */
  startLine(path: OpeningLine[]): boolean {
    if (!path.length) return false;
    this.target_path = [...path];
    this.line_name = path[0].line_name || path[0].repertoire_name;
    this.board = Board.fromFen();
    this.path_index = 0;
    return true;
  }

  /** Same line again from the first move. */
  restart(): void {
    this.board = Board.fromFen();
    this.path_index = 0;
  }

  /** Random walk downward from (not including) node to a leaf, following
   *  database parent-child links — stays within node's own imported line. */
  private treeContinuationFrom(node: OpeningLine): OpeningLine[] {
    const continuation: OpeningLine[] = [];
    let current = node;
    for (;;) {
      const children = db.childrenOf(this.conn, current.id);
      if (!children.length) break;
      current = choice(children, this.random);
      continuation.push(current);
    }
    return continuation;
  }

  /** Every root-to-leaf path under these roots. */
  private allLines(roots: OpeningLine[]): OpeningLine[][] {
    const lines: OpeningLine[][] = [];
    const walk = (path: OpeningLine[]): void => {
      const children = db.childrenOf(this.conn, path[path.length - 1].id);
      if (!children.length) lines.push(path);
      for (const child of children) walk([...path, child]);
    };
    for (const root of roots) walk([root]);
    return lines;
  }

  /** A whole line, picked with the chance a game would follow it: only where
   *  your lines SPLIT does a choice count. At an opponent's split, each reply
   *  your lines cover gets its share among those replies (with a floor so rare
   *  ones still come up); at your own split, each option in proportion to the
   *  lines that go that way. A position where all your lines go the same way
   *  changes nothing — so long lines aren't penalised for having more moves.
   *  null when there's no Lichess data at any of the opponent's splits. */
  private weightedLine(roots: OpeningLine[]): OpeningLine[] | null {
    const lines = this.allLines(roots);
    const offered = new Map<string, Set<string>>();   // position -> moves your lines play from it
    const through = new Map<string, number>();        // "position\tmove" -> lines going that way
    for (const line of lines) {
      for (const node of line) {
        if (!node.fen_before_move) continue;
        const pos = position(node.fen_before_move);
        if (!offered.has(pos)) offered.set(pos, new Set());
        offered.get(pos)!.add(node.move_uci);
        const key = `${pos}\t${node.move_uci}`;
        through.set(key, (through.get(key) ?? 0) + 1);
      }
    }
    const weights: number[] = [];
    let known = false;
    for (const line of lines) {
      let weight = 1.0;
      for (const node of line) {
        if (!node.fen_before_move) continue;
        const pos = position(node.fen_before_move);
        const alts = [...offered.get(pos)!];
        if (alts.length < 2) continue;              // no choice here
        if (this.isMine(node.fen_before_move)) {
          // your options: in proportion to the lines each one leads to
          weight *= through.get(`${pos}\t${node.move_uci}`)! / alts.reduce((s, a) => s + through.get(`${pos}\t${a}`)!, 0);
          continue;
        }
        const shares = new Map(alts.map((a) => [a, this.move_share!(node.fen_before_move!, a)]));
        if ([...shares.values()].every((v) => v === null)) {
          weight /= alts.length;
          continue;
        }
        known = true;
        const floor = new Map([...shares].map(([a, v]) => [a, Math.max(v || 0.0, MIN_REPLY_WEIGHT)]));
        weight *= floor.get(node.move_uci)! / [...floor.values()].reduce((s, v) => s + v, 0);
      }
      weights.push(weight);
    }
    if (!known) return null;
    return weightedChoice(lines, weights, this.random);
  }

  private isMine(fen: string): boolean {
    return Board.fromFen(fen).turn === this.my_color;
  }

  /** Informational: does this move match some OTHER line at this position? */
  private isBookElsewhere(move: string): boolean {
    return db.linesAtFen(this.conn, this.repertoire_name, this.my_color, this.board.fen()).some((c) => c.move_uci === move);
  }

  isMyTurn(): boolean {
    return this.board.turn === this.my_color;
  }

  isFinished(): boolean {
    return this.path_index >= this.target_path.length;
  }

  /** Plays the next (predetermined) opponent move. Returns its SAN, or null
   *  if the line is already finished. */
  playOpponentMove(): string | null {
    if (this.isFinished()) return null;
    const node = this.target_path[this.path_index];
    this.board.push(node.move_uci);
    this.path_index += 1;
    return node.move_san;
  }

  /** Your move on your turn. Only the exact move on the line being drilled
   *  counts — theory in a DIFFERENT line is still a miss here. On a miss,
   *  nothing is pushed; try again, or revealAndAdvance(). */
  attemptMyMove(move: string): DrillResult {
    if (this.isFinished()) {
      return { correct: false, played_san: null, correct_san: null, line_complete: true, in_book: false };
    }
    const expected = this.target_path[this.path_index];
    if (move === expected.move_uci) {
      this.board.push(move);
      this.path_index += 1;
      return { correct: true, played_san: expected.move_san, correct_san: expected.move_san,
        line_complete: this.isFinished(), in_book: true };
    }
    const playedSan = this.board.isLegal(move) ? this.board.san(move) : null;
    return { correct: false, played_san: playedSan, correct_san: expected.move_san, line_complete: false,
      in_book: this.isBookElsewhere(move) };
  }

  /** Plays the correct move for you after a miss, and advances. Returns its
   *  SAN, or null if there's nothing left to reveal. */
  revealAndAdvance(): string | null {
    if (this.isFinished()) return null;
    const node = this.target_path[this.path_index];
    this.board.push(node.move_uci);
    this.path_index += 1;
    return node.move_san;
  }

  /** The PGN comment on the most recently played move of the line, if any. */
  lastMoveNote(): string | null {
    if (this.path_index === 0) return null;
    return this.target_path[this.path_index - 1].notes;
  }

  /** SAN move list for the whole drilled line — for the end-of-line recap. */
  fullLineSan(): string[] {
    const board = Board.fromFen();
    return this.target_path.map((node) => {
      const san = board.san(node.move_uci);
      board.push(node.move_uci);
      return san;
    });
  }
}

/** ['d4', 'd5', 'c4', 'e6'] -> '1. d4 d5 2. c4 e6' (lines always start with White's move). */
export function formatMoveList(sans: string[]): string {
  return sans.map((san, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${san}` : san)).join(' ');
}
