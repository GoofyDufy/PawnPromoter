/**
 * Are you improving? (a web-app addition: Stats → Improvement.) From the saved
 * analysis of your games — one Stockfish verdict per move of yours, each with a
 * date — month by month: your accuracy in the opening, the middlegame and the
 * endgame, and in tactics (sharp positions: one clearly best move) plus your
 * blunders per game; then what's improved, what's slipped, your strengths and
 * weaknesses, and what to practise.
 */
import { moveAccuracy } from './amazing';
import { inTimeFilter } from './models';
import type { Db } from './sqlite';
import { phase } from './stats';
import { isSharp } from './style';

export const AREAS = ['Openings', 'Middlegame', 'Endgame', 'Tactics'] as const;
export type Area = (typeof AREAS)[number];
export const MIN_MOVES = 25;          // a month needs this many moves in an area to count
export const RECENT_MONTHS = 3;       // "recently" = the last 3 months with data, against the 3 before
export const CHANGE_POINTS = 1.5;     // accuracy points that count as a real change
export const BLUNDER_CP = 300;

const PHASE_AREA: Record<string, Area> = { Opening: 'Openings', Middlegame: 'Middlegame', Endgame: 'Endgame' };

interface Acc { sum: number; n: number }
const acc = (): Acc => ({ sum: 0, n: 0 });

export interface MonthPoint { month: string; value: number; moves: number }

export interface AreaTrend {
  area: Area;
  series: MonthPoint[];             // accuracy (%) per month with enough moves
  overall: number | null;           // accuracy over all the games in the filter
  recent: number | null;            // the last RECENT_MONTHS months
  before: number | null;            // the RECENT_MONTHS before those
  change: number | null;            // recent − before (accuracy points)
  moves: number;
}

export interface Improvement {
  games: number;
  months: number;
  areas: AreaTrend[];
  blunders: MonthPoint[];           // blunders per game, per month
  blundersRecent: number | null;
  blundersBefore: number | null;
  strengths: string[];
  weaknesses: string[];
  trends: string[];
  practice: { text: string; action: 'tactics' | 'threats' | 'drill' | 'endgames' | 'puzzles' }[];
}

const average = (a: Acc) => (a.n ? a.sum / a.n : null);
const fmt = (x: number) => x.toFixed(1);

/** timeClasses: only these time controls (null: every game). */
export function compute(conn: Db, timeClasses: Set<string> | null = null): Improvement {
  // month -> area -> accuracy; month -> [blunders, games]
  const byMonth = new Map<string, Map<Area, Acc>>();
  const blunderMonths = new Map<string, { blunders: number; games: Set<string> }>();
  const totals = new Map<Area, Acc>(AREAS.map((a) => [a, acc()]));
  const games = new Set<string>();
  const rows = conn.all(`SELECT e.game_id, e.ply, e.fen_before, e.cp_before, e.cp_after, e.cp_second, g.played_at, g.time_control
    FROM move_evaluations e JOIN games g ON g.id = e.game_id WHERE e.cp_after IS NOT NULL`);
  for (const r of rows) {
    if (!inTimeFilter(r.time_control, timeClasses)) continue;
    const month = String(r.played_at).slice(0, 7);
    games.add(r.game_id);
    const a = moveAccuracy(r.cp_before, r.cp_after);
    const m = byMonth.get(month) ?? new Map<Area, Acc>(AREAS.map((x) => [x, acc()]));
    byMonth.set(month, m);
    const add = (area: Area) => {
      m.get(area)!.sum += a;
      m.get(area)!.n += 1;
      totals.get(area)!.sum += a;
      totals.get(area)!.n += 1;
    };
    add(PHASE_AREA[phase(r.ply, r.fen_before)]);
    if (isSharp(r as { cp_second: number | null; cp_before: number; fen_before: string })) add('Tactics');
    const b = blunderMonths.get(month) ?? { blunders: 0, games: new Set<string>() };
    blunderMonths.set(month, b);
    b.games.add(r.game_id);
    if (r.cp_before - r.cp_after >= BLUNDER_CP) b.blunders += 1;
  }

  const months = [...byMonth.keys()].sort();
  const areas: AreaTrend[] = AREAS.map((area) => {
    const series = months.map((month) => ({ month, a: byMonth.get(month)!.get(area)! }))
      .filter(({ a }) => a.n >= MIN_MOVES).map(({ month, a }) => ({ month, value: a.sum / a.n, moves: a.n }));
    const pooled = (points: MonthPoint[]) => {
      const total = points.reduce((s, p) => s + p.moves, 0);
      return total ? points.reduce((s, p) => s + p.value * p.moves, 0) / total : null;
    };
    const recentPts = series.slice(-RECENT_MONTHS);
    const beforePts = series.slice(-2 * RECENT_MONTHS, -RECENT_MONTHS);
    const recent = pooled(recentPts);
    const before = beforePts.length ? pooled(beforePts) : null;
    return { area, series, overall: average(totals.get(area)!), recent, before,
      change: recent !== null && before !== null ? recent - before : null, moves: totals.get(area)!.n };
  });

  const blunders = months.filter((m) => blunderMonths.get(m)!.games.size >= 3)
    .map((month) => ({ month, value: blunderMonths.get(month)!.blunders / blunderMonths.get(month)!.games.size, moves: blunderMonths.get(month)!.games.size }));
  const perGame = (pts: MonthPoint[]) => {
    const g = pts.reduce((s, p) => s + p.moves, 0);
    return g ? pts.reduce((s, p) => s + p.value * p.moves, 0) / g : null;
  };
  const blundersRecent = perGame(blunders.slice(-RECENT_MONTHS));
  const blundersBefore = blunders.length > RECENT_MONTHS ? perGame(blunders.slice(-2 * RECENT_MONTHS, -RECENT_MONTHS)) : null;

  return { games: games.size, months: months.length, areas, blunders, blundersRecent, blundersBefore, ...commentary(areas, blundersRecent, blundersBefore) };
}

const AREA_WORDS: Record<Area, string> = {
  Openings: 'the opening', Middlegame: 'the middlegame', Endgame: 'the endgame', Tactics: 'sharp, tactical positions',
};

/** Strengths, weaknesses, what's changed, and what to practise. */
export function commentary(areas: AreaTrend[], blundersRecent: number | null, blundersBefore: number | null)
  : Pick<Improvement, 'strengths' | 'weaknesses' | 'trends' | 'practice'> {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const trends: string[] = [];
  const practice: Improvement['practice'] = [];
  // phases compared with each other (tactics is harder for everyone: it's judged on its own)
  const phases = areas.filter((a) => a.area !== 'Tactics' && a.overall !== null && a.moves >= MIN_MOVES)
    .sort((a, b) => b.overall! - a.overall!);
  if (phases.length >= 2) {
    const best = phases[0];
    const worst = phases[phases.length - 1];
    if (best.overall! - worst.overall! >= CHANGE_POINTS) {
      strengths.push(`You play ${AREA_WORDS[best.area]} best: ${fmt(best.overall!)}% accuracy, against ${fmt(worst.overall!)}% in ${AREA_WORDS[worst.area]}.`);
      weaknesses.push(`${AREA_WORDS[worst.area].charAt(0).toUpperCase()}${AREA_WORDS[worst.area].slice(1)} is where you lose the most: ${fmt(worst.overall!)}% accuracy.`);
      practice.push(worst.area === 'Endgame'
        ? { text: 'Practise endgames: Puzzle Review → Type: Endgames, then Play it out to convert them.', action: 'endgames' }
        : worst.area === 'Openings'
          ? { text: 'Drill your openings, and check My games for where you leave your prep.', action: 'drill' }
          : { text: 'Middlegames: Puzzle Review → Weak spots, and What\'s the threat? to stop missing your opponent\'s ideas.', action: 'threats' });
    } else {
      strengths.push(`You're about equally strong in every phase (${phases.map((p) => `${AREA_WORDS[p.area]} ${fmt(p.overall!)}%`).join(', ')}).`);
    }
  }
  const tactics = areas.find((a) => a.area === 'Tactics')!;
  const quiet = phases.length ? phases.reduce((s, p) => s + p.overall! * p.moves, 0) / phases.reduce((s, p) => s + p.moves, 0) : null;
  if (tactics.overall !== null && tactics.moves >= MIN_MOVES && quiet !== null) {
    const gap = quiet - tactics.overall;
    if (gap >= 12) {
      weaknesses.push(`Sharp positions — where only one move works — cost you the most: ${fmt(tactics.overall)}% accuracy there, against ${fmt(quiet)}% overall.`);
      practice.push({ text: 'Spot the Tactic trains exactly this: is there a tactic, and what is it?', action: 'tactics' });
    } else {
      strengths.push(`You hold up well in sharp positions: ${fmt(tactics.overall)}% accuracy when only one move works.`);
    }
  }
  // what's changed: the last 3 months against the 3 before
  for (const a of areas) {
    if (a.change === null) continue;
    if (a.change >= CHANGE_POINTS) trends.push(`📈 ${a.area}: improving — ${fmt(a.before!)}% → ${fmt(a.recent!)}% over the last ${RECENT_MONTHS} months.`);
    else if (a.change <= -CHANGE_POINTS) trends.push(`📉 ${a.area}: slipping — ${fmt(a.before!)}% → ${fmt(a.recent!)}% over the last ${RECENT_MONTHS} months.`);
    else trends.push(`➡️ ${a.area}: steady at about ${fmt(a.recent!)}%.`);
  }
  if (blundersRecent !== null && blundersBefore !== null) {
    const d = blundersRecent - blundersBefore;
    trends.push(d <= -0.15 ? `📈 Blunders: down from ${blundersBefore.toFixed(2)} to ${blundersRecent.toFixed(2)} per game.`
      : d >= 0.15 ? `📉 Blunders: up from ${blundersBefore.toFixed(2)} to ${blundersRecent.toFixed(2)} per game.`
        : `➡️ Blunders: about ${blundersRecent.toFixed(2)} per game.`);
    if (blundersRecent >= 1 && !practice.some((p) => p.action === 'tactics')) {
      practice.push({ text: `About ${blundersRecent.toFixed(1)} blunders a game: Puzzle Review on your own mistakes is the quickest fix.`, action: 'puzzles' });
    }
  }
  const slipping = areas.filter((a) => a.change !== null && a.change <= -CHANGE_POINTS);
  if (slipping.length) weaknesses.push(`Lately ${slipping.map((a) => AREA_WORDS[a.area]).join(' and ')} ${slipping.length > 1 ? 'have' : 'has'} slipped — worth some attention.`);
  const rising = areas.filter((a) => a.change !== null && a.change >= CHANGE_POINTS);
  if (rising.length) strengths.push(`Your work is paying off in ${rising.map((a) => AREA_WORDS[a.area]).join(' and ')}.`);
  return { strengths, weaknesses, trends, practice };
}
