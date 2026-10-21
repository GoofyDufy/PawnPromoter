/**
 * Training plans from the weakness stats (PHASE2.md §P2.1, first version):
 *
 *  1. focuses   — up to three things to work on, from the same numbers the
 *                 Weaknesses page shows: the ranked weak segments (phase,
 *                 colour, clock) and three habits (pieces left hanging,
 *                 missed chances, winning positions not converted), each
 *                 costed in points per game and linked to the app's drills;
 *  2. baseline  — tracking a focus freezes its number, sample size and the
 *                 newest game it was measured on (never changed afterwards);
 *  3. review    — after 30 new analysed games in the same time control and
 *                 14 days (whichever is later), the same number on the new
 *                 games only; a change inside the noise band is "no clear
 *                 change", never success or failure.
 *
 * Pure functions over stats.ts games; no I/O.
 */
import { BIG, CLOCK_BUCKETS, type Game, type Move, type Report, included, materialFlag } from './stats';

export type Practice = 'tactics' | 'threats' | 'drill' | 'endgames' | 'puzzles';

export const PRACTICE_LABEL: Record<Practice, string> = {
  tactics: 'Spot the Tactic', threats: "What's the threat?", drill: 'Opening Drill', endgames: 'Endgame puzzles', puzzles: 'Puzzle Review',
};

export interface Drill { action: Practice; why: string }

export interface Focus {
  key: string;                    // what is measured: 'segment:Middlegame', 'material', 'opportunism', 'conversion'
  title: string;
  why: string;                    // the evidence, in words, with its sample size
  metric: string;                 // the tracked number, in words
  unit: string;
  value: number;
  n: number;                      // moves or opportunities behind the value
  lowerIsBetter: boolean;
  pointsPerGame: number;          // what it costs you, for ordering
  drills: Drill[];
  tip: string;                    // one habit to try in your games
}

export const REVIEW_GAMES = 30;
export const REVIEW_DAYS = 14;
const MIN_N = 30;                  // moves or opportunities a focus needs before it's suggested

// ---------- measuring a focus (the same function for baseline and review) ----------

export interface Measure { value: number; n: number; games: number }

const segmentPredicate = (segment: string, games: Game[]): ((m: Move) => boolean) | null => {
  const phases: Record<string, string> = { Opening: 'opening', Middlegame: 'middlegame', Endgame: 'endgame' };
  if (segment in phases) return (m) => m.phase === phases[segment];
  if (segment === 'As White') return (m) => m.mover_white;
  if (segment === 'As Black') return (m) => !m.mover_white;
  const bucket = CLOCK_BUCKETS.find(([name]) => segment === `Clock ${name}`);
  if (bucket) {
    const timed = new Set(games.filter((g) => g.clockOk).map((g) => g.gid));
    return (m) => timed.has(m.game_id) && m.remaining_before !== null && m.remaining_before >= bucket[1] && m.remaining_before < bucket[2];
  }
  return null;
};

function opportunities(games: Game[]): { reply: Move; opponent: Move }[] {
  const out: { reply: Move; opponent: Move }[] = [];
  for (const g of games) {
    for (let i = 0; i < g.moves.length - 1; i++) {
      const m = g.moves[i];
      const reply = g.moves[i + 1];
      if (m.mover !== 'opponent' || m.book || m.forced || m.no_eval || m.wpl < BIG || reply.forced || reply.no_eval) continue;
      out.push({ reply, opponent: m });
    }
  }
  return out;
}

function flaggedMoves(games: Game[]): { inc: number; flagged: Move[] } {
  let inc = 0;
  const flagged: Move[] = [];
  for (const g of games) {
    for (const m of g.own()) {
      if (!included(m)) continue;
      inc += 1;
      if (m.wpl < BIG) continue;
      const pb = g.positions[m.ply];
      const pa = g.positions[m.ply + 1];
      if (!pa.terminal && materialFlag(pb.fen, pb.pv_uci ?? '', pa.fen, pa.pv_uci ?? '', g.playerWhite)) flagged.push(m);
    }
  }
  return { inc, flagged };
}

function conversionGames(games: Game[]): Game[] {
  return games.filter((g) => g.positions.some((p, i) => p.phase !== 'opening' && (g.playerWinPct(i) ?? 0) >= 80));
}

/** The focus's number on these games, or null when it has nothing to measure. */
export function measure(key: string, games: Game[]): Measure | null {
  if (key.startsWith('segment:')) {
    const pred = segmentPredicate(key.slice(8), games);
    if (!pred) return null;
    const mv = games.flatMap((g) => g.own().filter((m) => included(m) && pred(m)));
    if (!mv.length) return null;
    return { value: (100 * mv.filter((m) => m.wpl >= BIG).length) / mv.length, n: mv.length, games: new Set(mv.map((m) => m.game_id)).size };
  }
  if (key === 'material') {
    const { inc, flagged } = flaggedMoves(games);
    return inc ? { value: (100 * flagged.length) / inc, n: inc, games: games.length } : null;
  }
  if (key === 'opportunism') {
    const ops = opportunities(games);
    return ops.length ? { value: (100 * ops.filter((o) => o.reply.wpl >= BIG).length) / ops.length, n: ops.length, games: new Set(ops.map((o) => o.reply.game_id)).size } : null;
  }
  if (key === 'conversion') {
    const gs = conversionGames(games);
    return gs.length ? { value: (100 * gs.filter((g) => g.row.result === 1).length) / gs.length, n: gs.length, games: gs.length } : null;
  }
  return null;
}

// ---------- suggesting focuses ----------

const SEGMENT_DRILLS: Record<string, { drills: Drill[]; tip: string }> = {
  Opening: { drills: [{ action: 'drill', why: 'Drill the lines you actually play until the first 10 moves are automatic.' }],
    tip: 'Before move 10, ask what your opponent\'s last move changed before you play the "normal" move.' },
  Middlegame: { drills: [{ action: 'tactics', why: 'Positions from your own games where one move wins.' }, { action: 'threats', why: 'Name the threat before you move.' }],
    tip: 'Every move in the middlegame: checks, captures and threats — yours and theirs — before you let go of the piece.' },
  Endgame: { drills: [{ action: 'endgames', why: 'Endgame positions from your games and Lichess.' }],
    tip: 'In the endgame, slow down: count the pawn races and the king steps before you push.' },
  'As White': { drills: [{ action: 'drill', why: 'Your White repertoire.' }, { action: 'tactics', why: 'Positions from your games.' }],
    tip: 'As White you have the first move: aim for a plan, not just development.' },
  'As Black': { drills: [{ action: 'drill', why: 'Your Black repertoire.' }, { action: 'tactics', why: 'Positions from your games.' }],
    tip: 'As Black, equality is a good result out of the opening: don\'t force things early.' },
};
const CLOCK_DRILLS = { drills: [{ action: 'puzzles' as Practice, why: 'Fast pattern practice from your own mistakes.' }],
  tip: 'Use less time in the opening you know, so you have it when the position gets sharp.' };

/** The focuses for this report, most costly first (at most three). */
export function suggest(report: Report, games: Game[]): Focus[] {
  const out: Focus[] = [];
  const nGames = Math.max(games.length, 1);

  // 1. the ranked weak segments: the excess you lose there, beyond your usual rate
  for (const w of report.weaknesses) {
    if (w.expected_points_cost_per_game <= 0 || w.state === 'suppressed' || w.n_moves < MIN_N) continue;
    const kit = w.segment.startsWith('Clock') ? CLOCK_DRILLS : SEGMENT_DRILLS[w.segment];
    if (!kit) continue;
    const where = w.segment.startsWith('Clock') ? `with ${w.segment.slice(6)} on your clock` : w.segment === 'As White' || w.segment === 'As Black' ? w.segment.toLowerCase() : `in the ${w.segment.toLowerCase()}`;
    out.push({
      key: `segment:${w.segment}`, title: `Mistakes ${where}`,
      why: `${w.big_error_per100} mistakes or blunders per 100 moves ${where}, against your ${w.overall_big_error_per100} overall (${w.n_moves} moves in ${w.n_games} games).`,
      metric: `mistakes + blunders per 100 moves ${where}`, unit: '/100 moves', value: w.big_error_per100 ?? 0, n: w.n_moves,
      lowerIsBetter: true, pointsPerGame: w.expected_points_cost_per_game, ...kit,
    });
  }

  // 2. habits: what each one costs you in points per game
  const { inc, flagged } = flaggedMoves(games);
  const flaggedLoss = flagged.reduce((s, m) => s + m.wpl / 100, 0) / nGames;
  if (inc >= MIN_N && flagged.length >= 10 && report.material.value && (report.material.value.share_of_big_errors_pct ?? 0) >= 40) {
    out.push({
      key: 'material', title: 'Pieces left hanging',
      why: `${flagged.length} of your ${report.material.value.big_errors} mistakes and blunders let the engine win material straight away (${report.material.value.share_of_big_errors_pct}%).`,
      metric: 'engine-flagged material losses per 100 moves', unit: '/100 moves', value: (100 * flagged.length) / inc, n: inc,
      lowerIsBetter: true, pointsPerGame: flaggedLoss,
      drills: [{ action: 'threats', why: 'Practise seeing what your opponent attacks.' }, { action: 'puzzles', why: 'Your own blunders, as puzzles.' }],
      tip: 'Before every move: what does my opponent attack, and what does my move leave undefended?',
    });
  }
  const ops = opportunities(games);
  const missed = ops.filter((o) => o.reply.wpl >= BIG);
  if (ops.length >= MIN_N && missed.length / ops.length >= 0.25) {
    out.push({
      key: 'opportunism', title: 'Missed chances',
      why: `Your opponent made ${ops.length} mistakes of 10+ points; you let ${missed.length} of them go (${Math.round((100 * missed.length) / ops.length)}%).`,
      metric: '% of opponent mistakes you let go', unit: '%', value: (100 * missed.length) / ops.length, n: ops.length,
      lowerIsBetter: true, pointsPerGame: missed.reduce((s, o) => s + o.reply.wpl / 100, 0) / nGames,
      drills: [{ action: 'tactics', why: 'Find the move that punishes the mistake.' }],
      tip: 'When your opponent\'s move surprises you, look for a tactic before you look for a safe reply.',
    });
  }
  const conv = conversionGames(games);
  const notWon = conv.filter((g) => g.row.result < 1);
  if (conv.length >= 10 && notWon.length / conv.length > 0.2) {
    out.push({
      key: 'conversion', title: 'Finishing won games',
      why: `You reached a winning position (80%+) in ${conv.length} games and won ${conv.length - notWon.length}; ${notWon.length} slipped (${notWon.reduce((s, g) => s + 1 - g.row.result, 0)} points).`,
      metric: '% of winning positions converted', unit: '%', value: (100 * (conv.length - notWon.length)) / conv.length, n: conv.length,
      lowerIsBetter: false, pointsPerGame: notWon.reduce((s, g) => s + 1 - g.row.result, 0) / nGames,
      drills: [{ action: 'endgames', why: 'Technique in won endgames.' }, { action: 'threats', why: 'Stop counterplay before you go for more.' }],
      tip: 'When winning: trade pieces, not pawns, and ask what your opponent wants before every move.',
    });
  }
  return out.sort((a, b) => b.pointsPerGame - a.pointsPerGame).slice(0, 3);
}

// ---------- reviewing a tracked focus ----------

export interface Tracked {
  id: number;
  created_at: string;
  time_control: string;
  focus_key: string;
  title: string;
  metric: string;
  baseline_value: number;
  baseline_n: number;
  baseline_games: number;
  baseline_through: string;
  status: string;
}

export type ReviewResult =
  | { status: 'collecting'; newGames: number; needGames: number; readyFrom: string }
  | { status: 'ready'; value: number; n: number; games: number; delta: number; band: number; verdict: 'better' | 'worse' | 'no clear change' };

const addDays = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** Two standard errors of the difference between two rates (in points): the noise band. */
export function noiseBand(p0: number, n0: number, p1: number, n1: number): number {
  const p = (p0 * n0 + p1 * n1) / (n0 + n1) / 100;
  return 200 * Math.sqrt(Math.max(p * (1 - p), 1e-6) * (1 / n0 + 1 / n1));
}

/** newGames: analysed games in the plan's time control played after its baseline, newest first. */
export function review(plan: Tracked, newGames: Game[], today: string, lowerIsBetter: boolean): ReviewResult {
  const readyFrom = addDays(plan.created_at, REVIEW_DAYS);
  if (newGames.length < REVIEW_GAMES || today < readyFrom) {
    return { status: 'collecting', newGames: newGames.length, needGames: REVIEW_GAMES, readyFrom };
  }
  const m = measure(plan.focus_key, newGames);
  if (!m) return { status: 'collecting', newGames: newGames.length, needGames: REVIEW_GAMES, readyFrom };
  const delta = m.value - plan.baseline_value;
  const band = noiseBand(plan.baseline_value, plan.baseline_n, m.value, m.n);
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  return { status: 'ready', value: m.value, n: m.n, games: m.games, delta, band,
    verdict: Math.abs(delta) <= band ? 'no clear change' : better ? 'better' : 'worse' };
}

export const lowerIsBetter = (key: string): boolean => key !== 'conversion';

