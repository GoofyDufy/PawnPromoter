/**
 * How hard a puzzle is, as a Lichess puzzle rating ("≈1650"): from what the solution asks of you — how many moves,
 * whether the first is a check, a capture or a quiet move, its motif (a fork, a pin …), whether it's a sacrifice,
 * and whether it ends in mate. The ratings for each kind come from rated Lichess puzzles
 * (public/benchmarks/puzzle-difficulty.json, built by tests/puzzleDifficultyBuild.test.ts), so a puzzle from your own
 * games gets the typical rating of Lichess puzzles that ask the same of you.
 *
 * Not shown in the app yet: on unseen Lichess puzzles it errs by ~370 (~450 with only the first move) against ~630
 * guessing, but puzzles from your games don't map well — most are "the safe move you missed", which Lichess puzzles
 * (always forcing tactics) rate as hard, and the tactical ones mostly fall in one ~2000 bucket. Players' own solve
 * rates would rate them better.
 */
import { Board } from './chess';
import { moveReasons } from './coach';
import { see } from './weak/see';

export interface DifficultyTable {
  /** key → [median rating, puzzles]; keys from most to least specific (keysFor). */
  table: Record<string, [number, number]>;
  overall: number;
  /** How well it did on puzzles it hadn't seen: mean error, against guessing the overall median. */
  mae: number;
  baseline_mae: number;
  /** The same, when only the first move is known (no solution length). */
  mae_first_move?: number;
}

export interface Features { moves: number; first: 'mate' | 'check' | 'capture' | 'quiet'; motif: string; sacrifice: boolean; mate: boolean }

/** fen: the position where it's your move; line: your moves and the replies (uci), yours first. wholeLine: false when
 *  only the first move is known (a puzzle whose solution isn't worked out yet) — then its length isn't used. */
export function features(fen: string, line: string[], wholeLine = true): Features | null {
  const b = Board.fromFen(fen);
  const first = line[0];
  if (!first || !b.isLegal(first)) return null;
  const reasons = moveReasons(b, first);
  const has = (re: RegExp) => reasons.some((r) => re.test(r));
  const motif = has(/^gives double check/) ? 'double check' : has(/^gives a discovered check|^uncovers/) ? 'discovered'
    : has(/^forks/) ? 'fork' : has(/^pins/) ? 'pin' : has(/^removes the only defender/) ? 'defender' : has(/^traps/) ? 'trap' : 'none';
  const sacrifice = b.isCapture(first) ? see(b, first) < -50 : (() => { const a = b.copy(); a.push(first); return a.isAttackedBy(a.turn, parseSq(first.slice(2, 4))) && !a.isAttackedBy(b.turn, parseSq(first.slice(2, 4))); })();
  const end = b.copy();
  for (const m of line) {
    if (!end.isLegal(m)) break;
    end.push(m);
  }
  const mate = end.isCheckmate();
  const kind = (() => { const a = b.copy(); a.push(first); return a.isCheckmate() ? 'mate' : b.givesCheck(first) ? 'check' : b.isCapture(first) ? 'capture' : 'quiet'; })();
  return { moves: wholeLine ? Math.ceil(line.length / 2) : 0, first: kind, motif, sacrifice, mate: wholeLine && mate };
}

const parseSq = (s: string) => s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);

/** The table keys for a puzzle, most specific first (the estimate backs off to the first one with enough puzzles). */
export function keysFor(f: Features): string[] {
  const n = f.moves ? Math.min(f.moves, 4) : '*';                 // '*': the length isn't known
  return [
    `${n}|${f.first}|${f.motif}|${f.sacrifice ? 's' : '-'}|${f.mate ? 'm' : '-'}`,
    `${n}|${f.first}|${f.motif}|${f.sacrifice ? 's' : '-'}`,
    `${n}|${f.first}|${f.mate ? 'm' : '-'}`,
    `${n}|${f.first}`,
    `${n}`,
  ];
}

/** The estimated Lichess puzzle rating, or null without a table / for a puzzle it can't read. */
export function estimate(t: DifficultyTable | null, fen: string, line: string[], wholeLine = true): number | null {
  if (!t) return null;
  const f = features(fen, line, wholeLine);
  if (!f) return null;
  for (const k of keysFor(f)) if (t.table[k]) return t.table[k][0];
  return t.overall;
}
