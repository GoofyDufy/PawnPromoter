/**
 * Weakness statistics over your imported games — port of stats.py. Pure
 * functions, no UI.
 *
 * Sources:
 *  - PGN headers chess.com includes (ECOUrl, Termination) — every game
 *  - [%clk] comments in the PGN — clock left after each move
 *  - move_evaluations (the Stockfish cache) — only analyzed games
 */
import { timeClass } from './models';
import type { Db } from './sqlite';

export const BLUNDER_CP = 300;
/** cap per-move loss so a single mate-clamp (±10000) doesn't swamp averages */
export const MAX_LOSS_CP = 1000;
export const OPENING_MAX_MOVE = 12;
/** non-pawn, non-king material (both sides, Q=9 R=5 B/N=3) at or below this = endgame */
export const ENDGAME_MATERIAL = 13;

const CLK_RE = /%clk (\d+):(\d+):(\d+(?:\.\d+)?)/g;
const HEADER_RE = /^\[([\p{L}\p{N}_]+) "((?:[^"\\]|\\.)*)"\]/gmu;

/** A PGN's tag pairs, read with a regex (much faster than a full parse, which
 *  matters over thousands of games). */
export function pgnHeaders(pgn: string): Map<string, string> {
  const i = pgn.indexOf('\n\n');
  const head = i < 0 ? pgn : pgn.slice(0, i);
  const out = new Map<string, string>();
  for (const [, k, v] of head.matchAll(HEADER_RE)) out.set(k, v.replaceAll('\\"', '"').replaceAll('\\\\', '\\'));
  return out;
}

export const CLOCK_BUCKETS: [number, string][] = [
  [10, '< 10 s'], [30, '10–30 s'], [60, '30–60 s'], [180, '1–3 min'], [Infinity, '> 3 min'],
];

export class Record {
  wins = 0;
  draws = 0;
  losses = 0;

  get games(): number {
    return this.wins + this.draws + this.losses;
  }

  /** Chess score: win = 1, draw = 0.5, as a fraction of games. */
  get score(): number {
    return this.games ? (this.wins + 0.5 * this.draws) / this.games : 0.0;
  }

  add(result: string): void {
    if (result === 'win') this.wins += 1;
    else if (result === 'loss') this.losses += 1;
    else this.draws += 1;
  }
}

export class PhaseStat {
  moves = 0;
  total_loss = 0;
  blunders = 0;

  get avg_loss(): number {
    return this.moves ? this.total_loss / this.moves : 0.0;
  }

  get blunder_rate(): number {
    return this.moves ? this.blunders / this.moves : 0.0;
  }
}

/** Key for (opening name, colour) pairs — Python used tuples as dict keys. */
export const openingKey = (name: string, color: string) => `${name}\t${color}`;
export const splitOpeningKey = (key: string): [string, string] => key.split('\t') as [string, string];

export interface Stats {
  total_games: number;
  engine_games: number;
  /** openingKey(name, color) -> record, in first-seen order */
  openings: Map<string, Record>;
  /** time class -> reason -> count (losses only) */
  loss_reasons: Map<string, Map<string, number>>;
  phases: Map<string, PhaseStat>;
  clock: Map<string, PhaseStat>;
}

/** Short opening family from chess.com's ECOUrl, e.g.
 *  '.../Queens-Gambit-Declined-Queens-Knight-Variation-3...Nf6' ->
 *  'Queens Gambit Declined Queens'. Cut at the first move-sequence token and
 *  at 4 words, so games group into families instead of exact lines. */
export function openingName(headers: Map<string, string>): string {
  const url = headers.get('ECOUrl') ?? '';
  const slug = url ? url.replace(/\/+$/, '').split('/').pop()! : '';
  const words: string[] = [];
  for (const w of slug.split('-')) {
    if (!w || /\p{Nd}/u.test(w)) break;
    words.push(w);
  }
  return words.slice(0, 4).join(' ') || (headers.get('ECO') ?? 'Unknown');
}

export function lossReason(termination: string): string {
  const t = termination.toLowerCase();
  if (t.includes('checkmate')) return 'Checkmated';
  if (t.includes('resignation')) return 'Resigned';
  if (t.includes('on time')) return 'Timeout';
  if (t.includes('abandon')) return 'Abandoned';
  return 'Other';
}

/** Seconds left after each ply, in ply order (empty if no clock data). */
export function clocks(pgn: string): number[] {
  return [...pgn.matchAll(CLK_RE)].map(([, h, m, s]) => +h * 3600 + +m * 60 + parseFloat(s));
}

const LETTER_POINTS: [string, number][] = [['q', 9], ['r', 5], ['b', 3], ['n', 3]];

/** Non-pawn, non-king material of both sides, read straight from the FEN. */
function material(fen: string): number {
  const placement = fen.split(' ', 1)[0].toLowerCase();
  let total = 0;
  for (const [letter, points] of LETTER_POINTS) total += (placement.split(letter).length - 1) * points;
  return total;
}

export function phase(ply: number, fen: string): string {
  if (Math.floor(ply / 2) + 1 <= OPENING_MAX_MOVE) return 'Opening';
  return material(fen) <= ENDGAME_MATERIAL ? 'Endgame' : 'Middlegame';
}

/** Little non-pawn material left (see ENDGAME_MATERIAL). */
export function isEndgame(fen: string): boolean {
  return material(fen) <= ENDGAME_MATERIAL;
}

export function clockBucket(seconds: number): string {
  for (const [limit, label] of CLOCK_BUCKETS) if (seconds < limit) return label;
  return CLOCK_BUCKETS[CLOCK_BUCKETS.length - 1][1];
}

/** timeClasses: only include games in these classes; null = every game. */
export function compute(db: Db, timeClasses: Set<string> | null = null): Stats {
  const stats: Stats = {
    total_games: 0, engine_games: 0, openings: new Map(), loss_reasons: new Map(),
    phases: new Map(['Opening', 'Middlegame', 'Endgame'].map((p) => [p, new PhaseStat()])),
    clock: new Map(CLOCK_BUCKETS.map(([, label]) => [label, new PhaseStat()])),
  };
  const clocksByGame = new Map<string, number[]>();

  for (const g of db.all('SELECT id, pgn, my_color, result, time_control FROM games')) {
    const tc = timeClass(g.time_control);
    if (timeClasses && !timeClasses.has(tc)) continue;
    stats.total_games += 1;
    const headers = pgnHeaders(g.pgn);
    const key = openingKey(openingName(headers), g.my_color);
    if (!stats.openings.has(key)) stats.openings.set(key, new Record());
    stats.openings.get(key)!.add(g.result);
    if (g.result === 'loss') {
      if (!stats.loss_reasons.has(tc)) stats.loss_reasons.set(tc, new Map());
      const reasons = stats.loss_reasons.get(tc)!;
      const reason = lossReason(headers.get('Termination') ?? '');
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    clocksByGame.set(g.id, clocks(g.pgn));
  }

  const engineGames = new Set<string>();
  for (const ev of db.all('SELECT game_id, ply, fen_before, cp_before, cp_after FROM move_evaluations')) {
    if (ev.cp_after === null) continue;            // decisive position, second engine call skipped
    if (!clocksByGame.has(ev.game_id)) continue;   // game filtered out by time class
    engineGames.add(ev.game_id);
    const loss = Math.min(Math.max(0, ev.cp_before - ev.cp_after), MAX_LOSS_CP);
    const blunder = loss >= BLUNDER_CP;

    const targets = [stats.phases.get(phase(ev.ply, ev.fen_before))!];
    const gameClocks = clocksByGame.get(ev.game_id) ?? [];
    if (ev.ply < gameClocks.length) targets.push(stats.clock.get(clockBucket(gameClocks[ev.ply]))!);
    for (const t of targets) {
      t.moves += 1;
      t.total_loss += loss;
      t.blunders += blunder ? 1 : 0;
    }
  }
  stats.engine_games = engineGames.size;
  return stats;
}
