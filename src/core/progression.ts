/**
 * XP and levels — port of progression.py. Nothing is stored: XP is
 * recomputed from the attempts table (every puzzle / opening-line first try),
 * so practice done before this existed counts too, and changing a rule below
 * re-scores everything.
 *
 * Callers notify() after recording an attempt; the level card listens.
 */
import * as db from './db';
import * as spot from './spot';
import type { Db } from './sqlite';

// ---- XP per first try ----
export const PUZZLE_XP: Record<string, number> = { correct: 10, near_best: 5, missed: 2, revealed: 0 };
export const SHARP_BONUS_XP = 5;          // solved a puzzle with only one clearly best move
export const LINE_CLEAN_XP = 15;          // drilled a whole line without a miss
export const LINE_MISSED_XP = 5;
export const WEAK_SPOT_CLEARED_XP = 25;   // solved twice in a row after missing it (leaves Weak spots)
// only the first try at each puzzle / line per day earns XP, so re-solving the
// same easy puzzle can't farm levels (weak-spot bonuses still count)

// ---- levels ----
export const PIECES = ['Pawn', 'Knight', 'Bishop', 'Rook', 'Queen', 'King'];
export const STEPS = ['I', 'II', 'III'];
export const LEVEL_NAMES = PIECES.flatMap((piece) => STEPS.map((step) => `${piece} ${step}`));
export const FIRST_LEVEL_COSTS = [10, 25, 100];   // XP to finish Pawn I, Pawn II, Pawn III
export const LEVEL_GROWTH = 1.3;                  // after that, each level costs 30% more than the last

/** Python's int(round(x)): halves to even. */
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function levelCosts(): number[] {
  const costs = [...FIRST_LEVEL_COSTS];
  while (costs.length < LEVEL_NAMES.length - 1) {   // the top level has no cost — it's the end
    costs.push(pyRound((costs[costs.length - 1] * LEVEL_GROWTH) / 5) * 5);
  }
  return costs;
}

export const LEVEL_COSTS = levelCosts();

export class Level {
  constructor(
    readonly number: number,             // 1-based
    readonly name: string,               // e.g. "Knight II"
    readonly total_xp: number,
    readonly xp_into_level: number,
    readonly xp_for_level: number | null, // null at the top level
  ) {}

  get progress(): number {
    return !this.xp_for_level ? 1.0 : this.xp_into_level / this.xp_for_level;
  }
}

export function levelFor(totalXp: number): Level {
  let remaining = totalXp;
  for (const [i, cost] of LEVEL_COSTS.entries()) {
    if (remaining < cost) return new Level(i + 1, LEVEL_NAMES[i], totalXp, remaining, cost);
    remaining -= cost;
  }
  return new Level(LEVEL_NAMES.length, LEVEL_NAMES[LEVEL_NAMES.length - 1], totalXp, remaining, null);
}

export function totalXp(conn: Db): number {
  return attemptsXp(conn) + spot.xp(conn);    // + Spot the Tactic rounds (own table)
}

function attemptsXp(conn: Db): number {
  const rows = conn.all('SELECT item_type, item_id, correct, outcome, sharp, attempted_at FROM attempts ORDER BY attempted_at');
  let xp = 0;
  const scoredToday = new Set<string>();      // type|id|date already paid out
  const history = new Map<string, number[]>();
  const weak = new Set<string>();             // items currently in Weak spots
  for (const r of rows) {
    const key = `${r.item_type}\t${r.item_id}`;
    const dayKey = `${key}\t${String(r.attempted_at).slice(0, 10)}`;
    const outcome = db.attemptOutcome(r);
    if (!scoredToday.has(dayKey)) {
      scoredToday.add(dayKey);
      if (r.item_type === 'puzzle') {
        xp += PUZZLE_XP[outcome] ?? 0;
        if (outcome === 'correct' && r.sharp) xp += SHARP_BONUS_XP;
      } else {
        xp += r.correct ? LINE_CLEAN_XP : LINE_MISSED_XP;
      }
    }
    // same rule as db.weakItemIds: any miss makes it weak until two right in a row
    if (!history.has(key)) history.set(key, []);
    const results = history.get(key)!;
    results.push(r.correct);
    const n = results.length;
    if (!r.correct) {
      weak.add(key);
    } else if (weak.has(key) && n >= 2 && results[n - 2] === 1 && results[n - 1] === 1) {
      weak.delete(key);
      xp += WEAK_SPOT_CLEARED_XP;
    }
  }
  return xp;
}

// ---- change notifications ----
const listeners: (() => void)[] = [];

export function addListener(callback: () => void): void {
  listeners.push(callback);
}

export function clearListeners(): void {
  listeners.length = 0;
}

/** Call after recording or updating an attempt. */
export function notify(): void {
  for (const callback of [...listeners]) callback();
}
