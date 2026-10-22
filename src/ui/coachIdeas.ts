/**
 * The Coach's 💡 Ideas for whatever position a screen shows (Game Review, Puzzle Review, Tactics &
 * Threats, the Analysis board, Opening Drill): on / off remembered per screen, the board's ideas at
 * once, then again with Stockfish's plan (and, after a move of theirs, what it threatens).
 */
import { MATE_CP, scoreToCp } from '../core/analyzer';
import { Board, type Color, parseSquare } from '../core/chess';
import * as coach from '../core/coach';
import { pawnEndingTrades } from '../core/endgame';
import type { Engine, InfoLine } from '../core/engine';
import type { DbClient } from '../data/client';

const PLAN_DEPTH = 12;                           // Stockfish's plan for the position
const THREAT_DEPTH = 10;                         // what their last move threatens
const TOP_MOVES = 3;                             // Stockfish's choices the Coach explains
const STILL_WORKS = 50;
const MAX_TRADES = 2;                            // captures into a pawn ending the engine checks                          // a threat the best move leaves standing costs less than this
const CHECK_DEPTH = 10;                          // the advice check: the best move that follows a piece of advice …
const CHECK_MARGIN = 100;                        // … more than this worse than Stockfish's best: the advice is wrong here
const MAX_CHECKS = 4;                            // searches per position (the rest stay unchecked)
const MAX_TACTIC_CHECKS = 3;                     // their tactics checked per position
const TACTIC_GAIN = 100;                         // a tactic of theirs is real when it gains them at least this
const DEEP_DEPTH = 18;                           // the deep coach: Stockfish's good lines, read further
const DEEP_TIME = 20;                            // … but never longer than this (seconds) on a slow device

// The deep coach, on or off: per device (it costs time), shared by every screen's Ideas
const DEEP_KEY = 'pawnpromoter.deepCoach';
const deepListeners = new Set<() => void>();

export function deepCoach(): boolean {
  try { return localStorage.getItem(DEEP_KEY) === '1'; } catch { return false; }
}

export function setDeepCoach(on: boolean): void {
  try { localStorage.setItem(DEEP_KEY, on ? '1' : '0'); } catch { /* this session only */ }
  for (const f of deepListeners) f();
}

/** Calls f when the deep coach is switched; returns the unsubscribe. */
export function onDeepCoach(f: () => void): () => void {
  deepListeners.add(f);
  return () => deepListeners.delete(f);
}

/** What Stockfish says about one piece of the Coach's advice in a position. */
export interface AdviceVerdict { rule: string; text: string; verdict: 'agrees' | 'contradicted' | 'unverifiable'; gap?: number; moves?: string[] }

/** The Coach's advice against Stockfish (your move only): a piece of advice agrees when one of Stockfish's top moves
 *  follows it, or when the best move that follows it (searched among just those moves) is within CHECK_MARGIN of its
 *  best; it's contradicted when that best move is clearly worse — the principle is right in general, wrong here.
 *  Advice no legal move follows can't be checked. */
export async function checkAdvice(engine: Engine, board: Board, ideas: coach.Ideas, me: Color,
  alternatives: { move: string; cp: number | null }[] | undefined): Promise<AdviceVerdict[]> {
  const best = alternatives?.[0]?.cp;
  if (board.turn !== me || best === null || best === undefined || board.isGameOver()) return [];
  const legal = board.legalMoves();
  const out: AdviceVerdict[] = [];
  let searches = 0;
  const seen = new Set<string>();
  for (const p of [...ideas.points].filter((x) => x.advice).sort((a, b) => b.weight - a.weight)) {
    if (seen.has(p.rule)) continue;
    seen.add(p.rule);
    const follows = legal.filter((m) => p.advice!(m));
    if (!follows.length) { out.push({ rule: p.rule, text: p.text, verdict: 'unverifiable' }); continue; }
    if (alternatives!.some((a) => follows.includes(a.move) && a.cp !== null && a.cp >= best - STILL_WORKS)) { out.push({ rule: p.rule, text: p.text, verdict: 'agrees', moves: follows }); continue; }
    if (searches >= MAX_CHECKS) { out.push({ rule: p.rule, text: p.text, verdict: 'unverifiable' }); continue; }
    searches += 1;
    const [info] = await engine.analyse(board, { depth: CHECK_DEPTH }, 1, follows);
    if (!info) { out.push({ rule: p.rule, text: p.text, verdict: 'unverifiable' }); continue; }
    const cp = scoreToCp(info.score, me);
    const gap = best - cp;
    const mateLost = best >= MATE_CP / 2 && cp < MATE_CP / 2;
    out.push({ rule: p.rule, text: p.text, verdict: gap > CHECK_MARGIN || mateLost ? 'contradicted' : 'agrees', gap, moves: follows });
  }
  return out;
}

/** What Stockfish says about one of their tactics on the board (a fork, a pin they can win, a skewer). */
export interface TacticVerdict { rule: string; text: string; verdict: 'works' | 'fails'; why?: string }

/** Their tactics against Stockfish (your move only): with you passing, the best of the moves that cash the tactic in
 *  (searched among just those) — it works when that gains them at least a pawn. When none of those moves is legal, the
 *  piece is pinned. A tactic that fails is said again with the reason, lower down. */
export async function checkTactics(engine: Engine, board: Board, ideas: coach.Ideas, me: Color, cp: number | null): Promise<TacticVerdict[]> {
  if (board.turn !== me || cp === null || board.isCheck()) return [];
  const passed = coach.passTurn(board);
  if (!passed || passed.isGameOver()) return [];
  const out: TacticVerdict[] = [];
  for (const p of ideas.points.filter((x) => x.cash?.length).slice(0, MAX_TACTIC_CHECKS)) {
    const legal = p.cash!.filter((m) => passed.isLegal(m));
    if (!legal.length) {
      const sq = p.cash![0].slice(0, 2);
      const role = passed.pieceAt(parseSquare(sq)!)?.role ?? 'piece';
      out.push({ rule: p.rule, text: p.text, verdict: 'fails', why: `the ${role} on ${sq} is pinned, so it can't take` });
      continue;
    }
    const [info] = await engine.analyse(passed, { depth: CHECK_DEPTH }, 1, legal);
    if (!info?.pv.length) continue;
    const gain = scoreToCp(info.score, passed.turn) + cp;
    if (gain >= TACTIC_GAIN) { out.push({ rule: p.rule, text: p.text, verdict: 'works' }); continue; }
    // the line that shows it: their capture and your answer
    const b = passed.copy();
    const sans: string[] = [];
    for (const m of info.pv.slice(0, 2)) {
      if (!b.isLegal(m)) break;
      sans.push(b.san(m));
      b.push(m);
    }
    // (still better after it: no real threat; about level: it wins them nothing)
    const after = -scoreToCp(info.score, passed.turn);
    out.push({ rule: p.rule, text: p.text, verdict: 'fails', why: after >= 100
      ? `it isn't a real threat: even after ${sans.join(' ')} you're still better`
      : `it doesn't win them anything: after ${sans.join(' ')} it's about level` });
  }
  return out;
}

/** Their tactics that don't work, said again with the reason and out of the key ideas (positionIdeas' `revised`). */
function revisedTactics(verdicts: TacticVerdict[]): Record<string, { text: string; weight: number }> {
  return Object.fromEntries(verdicts.filter((v) => v.verdict === 'fails')
    .map((v) => [v.text, { text: `${v.text.replace(/\.$/, '')} — but ${v.why}.`, weight: 30 }]));
}

type Stoppable = { stoppable(board: Board, limit: { depth?: number; time?: number }, multipv?: number): { result: Promise<InfoLine[]>; stop: () => void } };

/** The position before the board's last move, if it has one (its move history). */
export function beforeLast(board: Board): string | undefined {
  if (!board.moveStack.length) return undefined;
  const b = board.cloneWithHistory();
  b.pop();
  return b.fen();
}

/** The board's last move recaptured: the move before it captured on the same square. */
export function lastWasRecapture(board: Board): boolean {
  if (board.moveStack.length < 2) return false;
  const b = board.cloneWithHistory();
  const last = b.pop();
  const prev = b.pop();
  return last.slice(2, 4) === prev.slice(2, 4) && b.isCapture(prev);
}

export interface IdeasPosition {
  fen: string;
  me: Color;                                     // whose side "you" is
  cp?: number | null;                            // the evaluation, your point of view
  /** Your opponent's move that led here (for "What your opponent wants"). */
  theirMove?: string | null;
  /** Stockfish's line, when the screen already has one (then the engine isn't asked). */
  bestLine?: string[];
  /** The position before the last move (what's new gets said first). */
  before?: string;
  /** Their last move was a recapture (lastWasRecapture). */
  recapture?: boolean;
  /** Stockfish's top moves, when the screen already has them (cp: your point of view; line: its line). */
  alternatives?: { move: string; cp: number | null; line?: string[] }[];
}

export class CoachIdeas {
  on = false;
  ideas: coach.Ideas | null = null;
  private cache = new Map<string, coach.Ideas>();
  private token: object | null = null;
  private last: IdeasPosition | null = null;
  /** Stockfish's verdict on each piece of advice in the position shown (for the audit). */
  adviceVerdicts: AdviceVerdict[] = [];
  /** … and on each of their tactics on the board. */
  tacticVerdicts: TacticVerdict[] = [];
  /** The deep coach is reading Stockfish's lines for the position shown. */
  deepPending = false;
  private stopDeep: (() => void) | null = null;

  /** settingKey: where on / off is remembered. engine: null = the board's ideas only. */
  constructor(
    private readonly client: DbClient,
    private readonly settingKey: string,
    private readonly engine: Engine | null,
    private readonly onChange: () => void,
  ) {
    onDeepCoach(() => { if (this.on && this.last) void this.explain(this.last).then(() => this.onChange()); });
  }

  async load(): Promise<void> {
    const s = await this.client.service('getSettings', [this.settingKey]);
    this.on = s[this.settingKey] === '1';
    if (this.on && this.last) await this.explain(this.last);
    this.onChange();
  }

  async set(on: boolean): Promise<void> {
    this.on = on;
    void this.client.service('setSettings', { [this.settingKey]: on ? '1' : '0' });
    await this.explain(this.last);
    this.onChange();
  }

  /** The ideas of this position (null: nothing to explain right now). */
  async explain(pos: IdeasPosition | null): Promise<void> {
    this.last = pos;
    this.token = null;
    this.stopDeep?.();                           // the position changed: the deep search for the last one is off
    this.stopDeep = null;
    this.deepPending = false;
    if (!this.on || !pos) {
      this.ideas = null;
      return;
    }
    const deep = deepCoach();
    const key = `${deep ? 'deep|' : ''}${pos.fen}|${pos.before ?? ''}|${pos.me}|${pos.theirMove ?? ''}|${pos.bestLine?.[0] ?? ''}|${pos.alternatives?.map((a) => a.move).join(',') ?? ''}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.ideas = cached;
      return;
    }
    const token = {};
    this.token = token;
    let cp = pos.cp ?? null;
    const theirMove = pos.theirMove;           // undefined: no "What your opponent wants"
    this.ideas = coach.positionIdeas({ fen: pos.fen, me: pos.me, cp, theirMove, bestLine: pos.bestLine, alternatives: pos.alternatives, before: pos.before, recapture: pos.recapture });
    this.onChange();                             // the board's ideas now, Stockfish's plan when it's ready
    const board = Board.fromFen(pos.fen);
    let bestLine = pos.bestLine;
    let alternatives = pos.alternatives;
    let threat: { move: string; gain: number; line?: string[] } | null = null;
    let prevents: { move: string; gain: number } | null = null;
    const pawnTrades: { move: string; cp: number | null }[] = [];
    if (this.engine && !board.isGameOver()) {
      try {
        if (!bestLine || !alternatives || cp === null) {
          // the top three moves: the plan, the evaluation, and whether the best move is the only good one
          const lines = (await this.engine.analyse(board, { depth: PLAN_DEPTH }, TOP_MOVES)).filter((l) => l.pv.length);
          bestLine ??= lines[0]?.pv;
          alternatives ??= lines.map((l) => ({ move: l.pv[0], cp: scoreToCp(l.score, pos.me), line: l.pv }));
          if (cp === null && lines[0]) cp = scoreToCp(lines[0].score, pos.me);
        }
        // what the side to move would face if it passed: their threat (after a move of theirs) …
        const mover = board.turn;
        const forMover = (v: number | null) => (v === null ? null : mover === pos.me ? v : -v);
        const passed = coach.passTurn(board);
        let faced: { move: string; gain: number; line?: string[] } | null = null;
        if (passed && !passed.isGameOver()) {
          const [info] = await this.engine.analyse(passed, { depth: THREAT_DEPTH });
          if (info?.pv.length) faced = { move: info.pv[0], gain: scoreToCp(info.score, passed.turn) + (forMover(cp) ?? 0), line: info.pv };
        }
        if (theirMove !== undefined && faced) threat = faced;    // (null: it's your move after theirs, the move itself unknown)
        // … and whether the best move stops it (prophylaxis)
        const best = bestLine?.[0];
        if (faced && faced.gain >= coach.THREAT_CP && best && board.isLegal(best)) {
          const after = Board.fromFen(pos.fen);
          after.push(best);
          const bestCp = forMover(alternatives?.find((a) => a.move === best)?.cp ?? cp);
          if (!after.isLegal(faced.move)) prevents = faced;
          else if (bestCp !== null) {
            after.push(faced.move);
            const [reply] = after.isGameOver() ? [] : await this.engine.analyse(after, { depth: THREAT_DEPTH });
            if (reply && scoreToCp(reply.score, mover) >= bestCp - STILL_WORKS) prevents = faced;
          }
        }
        // captures that would trade into a pawn ending: what Stockfish thinks of that pawn ending
        for (const m of pawnEndingTrades(board).slice(0, MAX_TRADES)) {
          const known = alternatives?.find((a) => a.move === m);
          if (known) pawnTrades.push({ move: m, cp: known.cp });
          else {
            const [info] = await this.engine.analyse(board, { depth: PLAN_DEPTH }, 1, [m]);
            if (info) pawnTrades.push({ move: m, cp: scoreToCp(info.score, pos.me) });
          }
        }
      } catch {
        /* the board's ideas only */
      }
    }
    if (token !== this.token) return;            // moved on meanwhile
    const draft = { fen: pos.fen, me: pos.me, cp, bestLine, alternatives, theirMove, threat, prevents, before: pos.before, recapture: pos.recapture, pawnTrades };
    let full = coach.positionIdeas(draft);
    // the check: advice Stockfish contradicts here is left out
    let overruled: string[] = [];
    let verified: string[] = [];
    let revised: Record<string, { text: string; weight: number }> = {};
    this.adviceVerdicts = [];
    this.tacticVerdicts = [];
    if (this.engine && !board.isGameOver()) {
      try {
        this.adviceVerdicts = await checkAdvice(this.engine, board, full, pos.me, alternatives);
        this.tacticVerdicts = await checkTactics(this.engine, board, full, pos.me, cp);
      } catch {
        /* unchecked */
      }
      if (token !== this.token) return;
      overruled = this.adviceVerdicts.filter((v) => v.verdict === 'contradicted').map((v) => v.rule);
      revised = revisedTactics(this.tacticVerdicts);
      verified = this.adviceVerdicts.filter((v) => v.verdict === 'agrees').map((v) => v.rule);
      if (overruled.length || verified.length || Object.keys(revised).length) full = coach.positionIdeas({ ...draft, overruled, verified, revised });
    }
    this.ideas = full;
    const engine = this.engine as (Engine & Partial<Stoppable>) | null;
    if (!deep || !engine?.stoppable || board.isGameOver()) {
      this.cache.set(key, full);
      this.onChange();
      return;
    }
    // the deep coach: the quick ideas now, then Stockfish's top lines at depth 18, read for the plan they share
    this.deepPending = true;
    this.onChange();
    const search = engine.stoppable(board, { depth: DEEP_DEPTH, time: DEEP_TIME }, TOP_MOVES);
    this.stopDeep = search.stop;
    let lines: InfoLine[] = [];
    try {
      lines = (await search.result).filter((l) => l.pv.length);
    } catch {
      lines = [];
    }
    if (token !== this.token) return;
    this.deepPending = false;
    this.stopDeep = null;
    if (lines.length && (lines[0].depth ?? 0) >= 14) {           // (cut short by the time cap: still deeper than the quick pass)
      const deepLines = lines.map((l) => ({ line: l.pv, cp: scoreToCp(l.score, pos.me) }));
      const plan = coach.deepPlan(pos.fen, deepLines, pos.me);
      const deepAlts = deepLines.map((l) => ({ move: l.line[0], cp: l.cp, line: l.line }));
      const deepDraft = { ...draft, cp: deepLines[0].cp ?? cp, bestLine: lines[0].pv, alternatives: deepAlts, deep: plan,
        deepLine: lines[0].pv.slice(0, coach.DEEP_PLIES) };
      // the check again, against the deeper lines (the plan comes from them, so the advice beside it should too)
      let checked = { overruled, verified, revised };
      try {
        const raw = coach.positionIdeas(deepDraft);
        const advice = await checkAdvice(engine, board, raw, pos.me, deepAlts);
        const tactics = await checkTactics(engine, board, raw, pos.me, deepDraft.cp);
        if (token !== this.token) return;
        this.adviceVerdicts = advice;
        this.tacticVerdicts = tactics;
        checked = { overruled: advice.filter((v) => v.verdict === 'contradicted').map((v) => v.rule),
          verified: advice.filter((v) => v.verdict === 'agrees').map((v) => v.rule), revised: revisedTactics(tactics) };
      } catch {
        /* the quick check's verdicts stand */
      }
      const deeper = coach.positionIdeas({ ...deepDraft, ...checked });
      this.cache.set(key, deeper);
      this.ideas = deeper;
    }
    this.onChange();
  }
}
