/**
 * The weakness statistics: SPEC §5 exclusions, the twelve §6 stats, the §7
 * payload rules and the weakness ranking — port of
 * ~/WeaknessStats/weakstats/stats.py (the reference implementation; the
 * golden test compares the two on the same stored rows). Reads stored rows
 * only, no engine calls. Field names stay snake_case, as in the prototype's
 * stats.json, so the two outputs compare key for key.
 *
 * One addition over the prototype: positions deep inside the opening book
 * may be stored without an evaluation (the analysis skips them, see
 * weakAnalysis.ts); every stat treats such a position as having no eval.
 */
import { Board } from '../chess';
import { pyFixed } from '../format';
import * as ec from './evalcore';
import { family } from './book';
import { material, see } from './see';

export const BIG = 10;           // mistakes + blunders, WPL pp
export const BLUNDER = 20;
export const CLOCK_BUCKETS: [string, number, number][] = [['<10s', 0, 10], ['10–30s', 10, 30], ['30–60s', 30, 60], ['>60s', 60, Infinity]];

export type State = 'ok' | 'provisional' | 'suppressed' | 'insufficient_data';

/** One weak_positions row (SPEC §2). */
export interface PositionRow {
  game_id: string;
  ply: number;
  fen: string;
  side_to_move: 'white' | 'black';
  move_number: number;
  move_uci: string | null;
  move_san: string | null;
  mover: 'player' | 'opponent' | null;
  score_type: 'cp' | 'mate' | null;     // null: not searched (deep in the book)
  score_value: number | null;
  best_move_uci: string | null;
  pv_uci: string | null;
  phase: ec.Phase;
  clock_after_s: number | null;
  emt_s: number | null;
  cp_raw_white: number | null;
  cp_cap_white: number | null;
  mate_white: number | null;
  n_legal: number;
  is_book: number;
  terminal: string | null;
}

/** One weak_games row. */
export interface GameRow {
  game_id: string;
  player_colour: 'white' | 'black';
  result: number;
  eco_code: string;
  opening_name: string;
  eco_source: string;
  time_control: string;
  base_s: number;
  increment_s: number;
  date: string;
  clock_coverage: number;
  clock_valid: number;
}

export interface Move {
  game_id: string;
  ply: number;
  mover: 'player' | 'opponent';
  mover_white: boolean;
  san: string;
  uci: string;
  fen_before: string;
  phase: ec.Phase;
  cap_before: number | null;
  cap_after: number | null;
  mate_involved: boolean;
  wpl: number;
  cpl: number | null;
  acc: number;
  book: boolean;
  forced: boolean;
  dead: boolean;
  no_eval: boolean;
  clock_after: number | null;
  emt: number | null;
  remaining_before: number | null;
  elapsed: number | null;
}

/** Passes the quality exclusions (stats 1–5, 7). */
export const included = (m: Move): boolean => !(m.book || m.forced || m.dead || m.no_eval);

export class Game {
  moves: Move[] = [];
  constructor(readonly row: GameRow, readonly positions: PositionRow[]) {}

  get gid(): string { return this.row.game_id; }
  get playerWhite(): boolean { return this.row.player_colour === 'white'; }
  own(): Move[] { return this.moves.filter((m) => m.mover === 'player'); }

  playerWinPct(ply: number): number | null {
    const cap = this.positions[ply]?.cp_cap_white;
    return cap == null ? null : ec.winPct(ec.moverPov(cap, this.playerWhite));
  }

  get clockOk(): boolean { return !!this.row.clock_valid && this.row.clock_coverage >= 0.80; }
}

export function buildMoves(game: Game): void {
  const pos = game.positions;
  const { base_s: base, increment_s: inc } = game.row;
  const lastClock = { true: base, false: base } as Record<string, number>;
  game.moves = [];
  for (let p = 0; p < pos.length - 1; p++) {
    const b = pos[p];
    const a = pos[p + 1];
    const mw = b.side_to_move === 'white';
    const noEval = b.cp_cap_white == null || a.cp_cap_white == null;
    const mate = b.score_type === 'mate' || a.score_type === 'mate';
    const w = noEval ? 0 : ec.wpl(b.cp_cap_white!, a.cp_cap_white!, mw);
    const m: Move = {
      game_id: game.gid, ply: p, mover: b.mover!, mover_white: mw, san: b.move_san!, uci: b.move_uci!,
      fen_before: b.fen, phase: b.phase, cap_before: b.cp_cap_white, cap_after: a.cp_cap_white, mate_involved: mate,
      wpl: w, cpl: noEval ? null : ec.cpl(b.cp_cap_white!, a.cp_cap_white!, mw, mate), acc: ec.moveAccuracy(w),
      book: !!b.is_book, forced: b.n_legal === 1, dead: !noEval && ec.inDeadZone(b.cp_cap_white!, a.cp_cap_white!, mw),
      no_eval: noEval, clock_after: b.clock_after_s, emt: b.emt_s, remaining_before: null, elapsed: null,
    };
    if (m.clock_after != null) {
      // v1.2 F3: [%clk] already includes the increment
      m.remaining_before = lastClock[String(mw)];
      m.elapsed = m.emt != null ? m.emt : m.remaining_before - m.clock_after + inc;
      lastClock[String(mw)] = m.clock_after;
    }
    game.moves.push(m);
  }
}

// ---------- §7 payloads ----------

export interface Ctx { time_control: string; config_id: string; spec_version: string; window_games: number }

export function stateFor(nGames: number, percentCell = true): State {
  if (percentCell && nGames < 10) return 'suppressed';
  if (nGames < 30) return 'provisional';
  return 'ok';
}

const COUNT_KEYS = new Set(['blunders', 'mistakes', 'opportunities', 'converted', 'win_to_draw', 'win_to_loss',
  'rescued', 'flagged', 'big_errors', 'missed_mates']);

export interface Payload<V = Record<string, unknown>> {
  value: V | null;
  n_games: number;
  n_moves_included: number;
  n_mate_moves: number;
  time_control: string;
  engine_config_id: string;
  spec_version: string;
  state: State;
  [extra: string]: unknown;
}

export function payload<V>(ctx: Ctx, value: V, nGames: number, opts: {
  nMoves?: number; nMate?: number; state?: State | null; percentCell?: boolean; extra?: Record<string, unknown>;
} = {}): Payload<V> {
  const st = opts.state ?? stateFor(nGames, opts.percentCell ?? true);
  let v: V | null = value;
  if (st === 'insufficient_data') v = null;
  else if (st === 'suppressed') {
    // show counts, never a rate (UI.md "Suppressed")
    v = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([k, x]) => [k, COUNT_KEYS.has(k) ? x : null])) as V
      : null;
  }
  return { value: v, n_games: nGames, n_moves_included: opts.nMoves ?? 0, n_mate_moves: opts.nMate ?? 0,
    time_control: ctx.time_control, engine_config_id: ctx.config_id, spec_version: ctx.spec_version, state: st, ...opts.extra };
}

/** Python's round(x, nd) (half-even on the exact decimal), as the prototype writes it. */
export const r1 = (x: number | null | undefined, nd = 1): number | null => (x == null ? null : Number(pyFixed(x, nd)));

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function pct(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const k = q * (sorted.length - 1);
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

// ---------- stats 1–4 (+ 5, 7 reuse them on a subset of moves) ----------

export function quality(moves: Move[], nGames: number) {
  const inc = moves.filter(included);
  const n = inc.length;
  const bl = inc.filter((m) => m.wpl >= BLUNDER).length;
  const mi = inc.filter((m) => m.wpl >= BIG && m.wpl < BLUNDER).length;
  const cpls = inc.map((m) => m.cpl).filter((c): c is number => c !== null);
  return {
    n_moves: n, n_mate: inc.filter((m) => m.cpl === null).length, blunders: bl, mistakes: mi,
    blunder_per100: n ? r1((100 * bl) / n) : null,
    mistake_per100: n ? r1((100 * mi) / n) : null,
    blunder_per_game: nGames ? r1(bl / nGames, 2) : null,
    mistake_per_game: nGames ? r1(mi / nGames, 2) : null,
    acpl: cpls.length ? r1(mean(cpls)) : null,
    median_cpl: cpls.length ? r1(median(cpls)) : null,
  };
}

const gamesTouching = (moves: Move[]): number => new Set(moves.filter(included).map((m) => m.game_id)).size;

export interface Example {
  game_id: string; ply: number; fen: string; played: string; played_uci: string; best: string | null; best_uci: string | null;
  wpl: number | null; move_number: number; colour: 'white' | 'black'; phase: ec.Phase; cap_before_white: number | null;
  engine_win_pct_before: number | null; engine_win_pct_after: number | null;
  opponent_move?: string; opponent_wpl?: number | null; verified?: boolean; verified_wpl?: number;
}

function example(g: Game, m: Move, extra: Partial<Example> = {}): Example {
  const board = Board.fromFen(m.fen_before);
  const best = g.positions[m.ply].best_move_uci;
  return {
    game_id: g.gid, ply: m.ply, fen: m.fen_before, played: m.san, played_uci: m.uci,
    best: best && board.isLegal(best) ? board.san(best) : null, best_uci: best, wpl: r1(m.wpl),
    move_number: board.fullmoveNumber, colour: m.mover_white ? 'white' : 'black', phase: m.phase, cap_before_white: m.cap_before,
    engine_win_pct_before: m.cap_before == null ? null : r1(ec.winPct(ec.moverPov(m.cap_before, m.mover_white))),
    engine_win_pct_after: m.cap_after == null ? null : r1(ec.winPct(ec.moverPov(m.cap_after, m.mover_white))),
    ...extra,
  };
}

export function statQualityBlock(ctx: Ctx, games: Game[]) {
  const own = games.flatMap((g) => g.own());
  const q = quality(own, games.length);
  const n = games.length;
  const perGame = games.map((g) => {
    const inc = g.own().filter(included);
    const worst = inc.reduce<Move | null>((w, m) => (!w || m.wpl > w.wpl ? m : w), null);
    return { g, acc: ec.gameAccuracy(inc.map((m) => m.acc)), worst };
  });
  const accs = perGame.map((x) => x.acc).filter((a): a is number => a !== null);
  const worsts = perGame.filter((x) => x.worst).map((x) => x.worst!.wpl).sort((a, b) => a - b);
  const incOwn = own.filter(included);
  const byWorst = [...perGame].sort((a, b) => (b.worst?.wpl ?? 0) - (a.worst?.wpl ?? 0));
  return {
    blunder_mistake_rate: payload(ctx, {
      blunder_per100: q.blunder_per100, mistake_per100: q.mistake_per100, blunder_per_game: q.blunder_per_game,
      mistake_per_game: q.mistake_per_game, blunders: q.blunders, mistakes: q.mistakes,
    }, n, { nMoves: q.n_moves, nMate: q.n_mate }),
    acpl: payload(ctx, { acpl_capped: q.acpl, median_cpl: q.median_cpl }, n,
      { nMoves: q.n_moves, nMate: q.n_mate, extra: { label: 'ACPL (capped)' } }),
    accuracy: payload(ctx, {
      mean_game_accuracy: accs.length ? r1(mean(accs)) : null,
      mean_move_accuracy: q.n_moves ? r1(mean(incOwn.map((m) => m.acc))) : null,
    }, n, { nMoves: q.n_moves, nMate: q.n_mate, extra: { accuracy_aggregation: 'hm_am_v1', label: 'Accuracy' } }),
    worst_move: payload(ctx, {
      mean_max_wpl: worsts.length ? r1(mean(worsts)) : null,
      p90_max_wpl: worsts.length ? r1(pct(worsts, 0.9)) : null,
      pct_games_max_ge_20: worsts.length ? r1((100 * worsts.filter((w) => w >= BLUNDER).length) / worsts.length) : null,
    }, n, { nMoves: q.n_moves, nMate: q.n_mate, extra: {
      examples: byWorst.slice(0, 5).filter((x) => x.worst).map((x) => example(x.g, x.worst!)) } }),
    per_game: perGame.map(({ g, acc }) => ({
      game_id: g.gid, date: g.row.date, accuracy: r1(acc),
      blunders: g.own().filter((m) => included(m) && m.wpl >= BLUNDER).length, result: g.row.result,
    })),
  };
}

// ---------- 5. phase split, 7. colour split ----------

export function statPhaseSplit(ctx: Ctx, games: Game[]) {
  const out: Record<string, Payload> = {};
  for (const ph of ['opening', 'middlegame', 'endgame'] as const) {
    const mv = games.flatMap((g) => g.own().filter((m) => m.phase === ph));
    const ng = gamesTouching(mv);
    const q = quality(mv, ng);
    out[ph] = payload(ctx, { blunder_per100: q.blunder_per100, mistake_per100: q.mistake_per100, acpl: q.acpl, median_cpl: q.median_cpl },
      ng, { nMoves: q.n_moves, nMate: q.n_mate });
  }
  return out;
}

const scorePct = (games: Game[]): number | null => (games.length ? r1((100 * games.reduce((s, g) => s + g.row.result, 0)) / games.length) : null);

export function statColourSplit(ctx: Ctx, games: Game[]) {
  const out: Record<string, unknown> = {};
  const vals: Record<string, Record<string, number | null> | null> = {};
  for (const colour of ['white', 'black'] as const) {
    const gs = games.filter((g) => g.row.player_colour === colour);
    const q = quality(gs.flatMap((g) => g.own()), gs.length);
    const p = payload(ctx, { blunder_per100: q.blunder_per100, mistake_per100: q.mistake_per100, acpl: q.acpl, score_pct: scorePct(gs) },
      gs.length, { nMoves: q.n_moves, nMate: q.n_mate });
    out[colour] = p;
    vals[colour] = p.value;
  }
  const w = vals.white;
  const b = vals.black;
  // the prototype tests the dicts for truthiness: a suppressed (all-null) dict still counts
  out.gap_black_minus_white = w && b
    ? Object.fromEntries(Object.keys(w).map((k) => [k, b[k] != null && w[k] != null ? r1(b[k]! - w[k]!) : null]))
    : null;
  return out;
}

// ---------- 6. opening report ----------

/** Ply of the first non-book position (v1.2 F2/F8); fallback after ply 30. */
export function exitPly(g: Game): number {
  for (const m of g.moves) if (!m.book) return m.ply + 1;
  return Math.min(30, g.positions.length - 1);
}

export function statOpenings(ctx: Ctx, games: Game[]) {
  // grouped by opening family × colour (the user's choice over strict ECO codes)
  const cells = new Map<string, Game[]>();
  for (const g of games) {
    const key = `${family(g.row.opening_name)}\u0000${g.row.player_colour}`;
    cells.set(key, [...(cells.get(key) ?? []), g]);
  }
  const rows = [...cells.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, gs]) => {
    const [name, colour] = key.split('\u0000');
    const ecos = new Map<string, number>();
    for (const g of gs) ecos.set(g.row.eco_code, (ecos.get(g.row.eco_code) ?? 0) + 1);
    const eco = [...ecos.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const pov = gs.map((g) => {
      const c = g.positions[exitPly(g)]?.cp_cap_white;
      return c == null ? null : ec.moverPov(c, g.playerWhite);
    }).filter((c): c is number => c !== null);
    const shown = gs.length >= 20;
    return {
      eco, name, colour, n_games: gs.length, shown,
      score_pct: shown ? scorePct(gs) : null,
      exit_cp: shown && pov.length ? r1(mean(pov), 0) : null,
      exit_engine_win_pct: shown && pov.length ? r1(mean(pov.map(ec.winPct))) : null,
      wins: shown ? gs.filter((g) => g.row.result === 1).length : null,
      draws: shown ? gs.filter((g) => g.row.result === 0.5).length : null,
      losses: shown ? gs.filter((g) => g.row.result === 0).length : null,
    };
  });
  const sources = new Map<string, number>();
  for (const g of games) sources.set(g.row.eco_source, (sources.get(g.row.eco_source) ?? 0) + 1);
  const src = [...sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return payload(ctx, rows, games.length, { percentCell: false, extra: {
    eco_source: src, cell_gate: 20, badges: false, grouping: 'family', hidden_cells: rows.filter((r) => !r.shown).length } });
}

// ---------- 8–10 state stats (engine state, never backwards from the result) ----------

function firstCrossing(g: Game, test: (w: number) => boolean): number | null {
  for (let p = 0; p < g.positions.length; p++) {
    if (g.positions[p].phase === 'opening') continue;
    const w = g.playerWinPct(p);
    if (w !== null && test(w)) return p;
  }
  return null;
}

export function statConversion(ctx: Ctx, games: Game[]) {
  const opp = games.filter((g) => firstCrossing(g, (w) => w >= 80) !== null);
  const won = opp.filter((g) => g.row.result === 1).length;
  const n = opp.length;
  return payload(ctx, {
    rate_pct: n ? r1((100 * won) / n) : null, opportunities: n, converted: won,
    win_to_draw: opp.filter((g) => g.row.result === 0.5).length,
    win_to_loss: opp.filter((g) => g.row.result === 0).length,
    thrown_points: r1(opp.reduce((s, g) => s + (1 - g.row.result), 0), 1),
  }, n, { state: n ? null : 'insufficient_data' });
}

export function statRescue(ctx: Ctx, games: Game[]) {
  const opp = games.filter((g) => firstCrossing(g, (w) => w <= 20) !== null);
  const saved = opp.filter((g) => g.row.result >= 0.5).length;
  const n = opp.length;
  return payload(ctx, {
    rate_pct: n ? r1((100 * saved) / n) : null, opportunities: n, rescued: saved,
    points_saved: r1(opp.reduce((s, g) => s + g.row.result, 0), 1),
  }, n, { state: n ? null : 'insufficient_data' });
}

export function statOpportunism(ctx: Ctx, games: Game[]) {
  const cats = { punished: 0, partial: 0, missed: 0 };
  const examples: Example[] = [];
  let missedMates = 0;
  const ng = new Set<string>();
  for (const g of games) {
    const mv = g.moves;
    for (let i = 0; i < mv.length - 1; i++) {
      const m = mv[i];
      const reply = mv[i + 1];
      if (m.mover !== 'opponent' || m.book || m.forced || m.no_eval || m.wpl < BIG || reply.forced || reply.no_eval) continue;
      ng.add(g.gid);
      const cat = reply.wpl < 5 ? 'punished' : reply.wpl < BIG ? 'partial' : 'missed';
      cats[cat] += 1;
      if (cat === 'missed') examples.push(example(g, reply, { opponent_move: m.san, opponent_wpl: r1(m.wpl) }));
      // missed mate: best was mate in <= 5 for the player, the played move keeps no mate
      const before = g.positions[reply.ply];
      const after = g.positions[reply.ply + 1];
      const mb = before.mate_white == null ? null : ec.moverPov(before.mate_white, g.playerWhite);
      const ma = after.mate_white == null ? null : ec.moverPov(after.mate_white, g.playerWhite);
      const stillMate = after.terminal === 'checkmate' || (ma !== null && ma > 0);
      if (mb !== null && mb > 0 && mb <= 5 && !stillMate && reply.wpl >= BIG) missedMates += 1;
    }
  }
  const n = cats.punished + cats.partial + cats.missed;
  const val = {
    punished_pct: n ? r1((100 * cats.punished) / n) : null,
    partial_pct: n ? r1((100 * cats.partial) / n) : null,
    missed_pct: n ? r1((100 * cats.missed) / n) : null,
    opportunities: n, missed_mates: missedMates,
  };
  examples.sort((a, b) => (b.opponent_wpl ?? 0) - (a.opponent_wpl ?? 0));
  return payload(ctx, val, ng.size, { nMoves: n, state: n ? null : 'insufficient_data', extra: { examples: examples.slice(0, 20) } });
}

// ---------- 11. material / tactical share (v1.2 F7) ----------

function pvBoard(fen: string, pv: string[], plies: number): Board {
  const b = Board.fromFen(fen);
  for (const u of pv.slice(0, plies)) {
    if (!b.isLegal(u)) break;
    b.push(u);
  }
  return b;
}

/** §6.11 detector. afterPv: the PV of the position after the player's move. */
export function materialFlag(fenBefore: string, bestPv: string, fenAfter: string, afterPv: string, playerWhite: boolean): boolean {
  const pv = afterPv.split(/\s+/).filter(Boolean);
  if (!pv.length) return false;
  const board = Board.fromFen(fenAfter);
  const player = playerWhite ? 'white' : 'black';
  let captureSee: number | null = null;
  for (let i = 0; i < Math.min(3, pv.length); i++) {
    const u = pv[i];
    if (!board.isLegal(u)) break;
    if ((i === 0 || i === 2) && board.isCapture(u)) captureSee = Math.max(captureSee || -1e6, see(board, u));   // PV ply 1 or 3, opponent's moves
    board.push(u);
  }
  if (captureSee === null) return false;
  if (captureSee >= 100) return true;
  const line = material(pvBoard(fenAfter, pv, 4), player);
  const best = material(pvBoard(fenBefore, bestPv.split(/\s+/).filter(Boolean), 5), player);
  return best - line >= 100;
}

export function statMaterial(ctx: Ctx, games: Game[]) {
  let big = 0;
  let flagged = 0;
  let nInc = 0;
  const examples: Example[] = [];
  for (const g of games) {
    for (const m of g.own()) {
      if (!included(m)) continue;
      nInc += 1;
      if (m.wpl < BIG) continue;
      big += 1;
      const pb = g.positions[m.ply];
      const pa = g.positions[m.ply + 1];
      if (pa.terminal) continue;
      if (materialFlag(pb.fen, pb.pv_uci ?? '', pa.fen, pa.pv_uci ?? '', g.playerWhite)) {
        flagged += 1;
        examples.push(example(g, m));
      }
    }
  }
  examples.sort((a, b) => (b.wpl ?? 0) - (a.wpl ?? 0));
  return payload(ctx, {
    share_of_big_errors_pct: big ? r1((100 * flagged) / big) : null,
    per100: nInc ? r1((100 * flagged) / nInc) : null,
    flagged, big_errors: big,
  }, games.length, { nMoves: nInc, extra: { label: 'engine-flagged', examples: examples.slice(0, 20) } });
}

// ---------- 12. clock profile (v1.2 F3, F8) ----------

export function statClock(ctx: Ctx, games: Game[]) {
  const timed = games.filter((g) => g.clockOk);
  if (!timed.length) return payload(ctx, null, 0, { state: 'insufficient_data', extra: { has_clock: false } });
  const buckets = new Map<string, Move[]>(CLOCK_BUCKETS.map(([name]) => [name, []]));
  const elapsedByPhase = new Map<string, number[]>();
  let lowTimeLost = 0;
  for (const g of timed) {
    const own = g.own().filter((m) => m.remaining_before !== null);
    for (const m of own) {
      if (m.elapsed !== null) elapsedByPhase.set(m.phase, [...(elapsedByPhase.get(m.phase) ?? []), m.elapsed]);
      if (!included(m)) continue;
      for (const [name, lo, hi] of CLOCK_BUCKETS) if (m.remaining_before! >= lo && m.remaining_before! < hi) buckets.get(name)!.push(m);
    }
    if (own.length) {
      const last = own[own.length - 1];
      const w = g.playerWinPct(last.ply + 1);
      if (last.clock_after! < 0.05 * g.row.base_s && w !== null && w <= 20) lowTimeLost += 1;
    }
  }
  const rows = CLOCK_BUCKETS.map(([name]) => {
    const mv = buckets.get(name)!;
    const ng = new Set(mv.map((m) => m.game_id)).size;
    const bl = mv.filter((m) => m.wpl >= BLUNDER).length;
    return { bucket: name, n_moves: mv.length, n_games: ng, blunders: bl, state: stateFor(ng),
      blunder_per100: mv.length && ng >= 10 ? r1((100 * bl) / mv.length) : null };
  });
  const under30 = [...buckets.get('<10s')!, ...buckets.get('10–30s')!];
  const over60 = buckets.get('>60s')!;
  let uplift: number | null = null;
  let ustate: State | null = 'insufficient_data';
  if (under30.length >= 30 && over60.length >= 30) {
    const rHi = over60.filter((m) => m.wpl >= BLUNDER).length / over60.length;
    if (rHi > 0) {
      const rLo = under30.filter((m) => m.wpl >= BLUNDER).length / under30.length;
      uplift = r1(rLo / rHi, 2);
      ustate = null;
    }
  }
  return payload(ctx, {
    uplift, buckets: rows,
    median_elapsed_s: Object.fromEntries([...elapsedByPhase.entries()].map(([ph, v]) => [ph, r1(median(v))])),
    pct_games_low_time_lost: r1((100 * lowTimeLost) / timed.length),
  }, timed.length, { nMoves: rows.reduce((s, r) => s + r.n_moves, 0), state: ustate, extra: {
    has_clock: true, uplift_moves: { under_30s: under30.length, over_60s: over60.length } } });
}

// ---------- §7 weakness ranking (v1.2 F5) ----------

export interface WeaknessRow {
  segment: string;
  expected_points_cost_per_game: number;
  big_error_per100: number | null;
  overall_big_error_per100: number | null;
  n_moves: number;
  n_games: number;
  state: State;
}

export function weaknessRanking(games: Game[]): WeaknessRow[] {
  const inc = games.flatMap((g) => g.own().filter(included));
  const big = inc.filter((m) => m.wpl >= BIG);
  if (!inc.length || !big.length) return [];
  const rAll = big.length / inc.length;
  const mAll = mean(big.map((m) => m.wpl / 100));
  const segs: [string, (m: Move) => boolean][] = (['opening', 'middlegame', 'endgame'] as const)
    .map((ph) => [ph[0].toUpperCase() + ph.slice(1), (m: Move) => m.phase === ph]);
  segs.push(['As White', (m) => m.mover_white], ['As Black', (m) => !m.mover_white]);
  if (games.some((g) => g.clockOk)) {
    const clockGames = new Set(games.filter((g) => g.clockOk).map((g) => g.gid));
    for (const [name, lo, hi] of CLOCK_BUCKETS) {
      segs.push([`Clock ${name}`, (m) => clockGames.has(m.game_id) && m.remaining_before !== null && m.remaining_before >= lo && m.remaining_before < hi]);
    }
  }
  const out: WeaknessRow[] = [];
  for (const [name, pred] of segs) {
    const mv = inc.filter(pred);
    const ng = new Set(mv.map((m) => m.game_id)).size;
    if (ng < 10) continue;
    const bs = mv.filter((m) => m.wpl >= BIG);
    const loss = bs.reduce((s, m) => s + m.wpl / 100, 0);
    const expected = mv.length * rAll * mAll;
    const cost = Math.max(0, loss - expected) / games.length;
    out.push({ segment: name, expected_points_cost_per_game: Number(pyFixed(cost, 3)),
      big_error_per100: mv.length ? r1((100 * bs.length) / mv.length) : null,
      overall_big_error_per100: r1(100 * rAll), n_moves: mv.length, n_games: ng, state: stateFor(ng) });
  }
  // stable sort, as Python's
  return out.map((r, i) => ({ r, i })).sort((a, b) => b.r.expected_points_cost_per_game - a.r.expected_points_cost_per_game || a.i - b.i).map((x) => x.r);
}

// ---------- the whole report ----------

export type Report = ReturnType<typeof computeAll>;

/** games: newest first, already limited to the window. */
export function computeAll(ctx: Ctx, games: Game[]) {
  const q = statQualityBlock(ctx, games);
  const { per_game: perGame, ...quality } = q;
  return {
    window: {
      requested: ctx.window_games, n_games: games.length,
      from: games.length ? games[games.length - 1].row.date : null,
      to: games.length ? games[0].row.date : null,
      state: (games.length ? stateFor(games.length, false) : 'empty') as State | 'empty',
    },
    ...quality,
    phase_split: statPhaseSplit(ctx, games),
    openings: statOpenings(ctx, games),
    colour_split: statColourSplit(ctx, games),
    conversion: statConversion(ctx, games),
    rescue: statRescue(ctx, games),
    opportunism: statOpportunism(ctx, games),
    material: statMaterial(ctx, games),
    clock: statClock(ctx, games),
    weaknesses: weaknessRanking(games),
    per_game: [...perGame].reverse(),
  };
}
