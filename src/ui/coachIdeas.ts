/**
 * The Coach's 💡 Ideas for whatever position a screen shows (Game Review, Puzzle Review, Tactics &
 * Threats, the Analysis board, Opening Drill): on / off remembered per screen, the board's ideas at
 * once, then again with Stockfish's plan (and, after a move of theirs, what it threatens).
 */
import { scoreToCp } from '../core/analyzer';
import { Board, type Color } from '../core/chess';
import * as coach from '../core/coach';
import { pawnEndingTrades } from '../core/endgame';
import type { Engine } from '../core/engine';
import type { DbClient } from '../data/client';

const PLAN_DEPTH = 12;                           // Stockfish's plan for the position
const THREAT_DEPTH = 10;                         // what their last move threatens
const TOP_MOVES = 3;                             // Stockfish's choices the Coach explains
const STILL_WORKS = 50;
const MAX_TRADES = 2;                            // captures into a pawn ending the engine checks                          // a threat the best move leaves standing costs less than this

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

  /** settingKey: where on / off is remembered. engine: null = the board's ideas only. */
  constructor(
    private readonly client: DbClient,
    private readonly settingKey: string,
    private readonly engine: Engine | null,
    private readonly onChange: () => void,
  ) {}

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
    if (!this.on || !pos) {
      this.ideas = null;
      return;
    }
    const key = `${pos.fen}|${pos.before ?? ''}|${pos.me}|${pos.theirMove ?? ''}|${pos.bestLine?.[0] ?? ''}|${pos.alternatives?.map((a) => a.move).join(',') ?? ''}`;
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
        if (theirMove && faced) threat = faced;
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
    const full = coach.positionIdeas({ fen: pos.fen, me: pos.me, cp, bestLine, alternatives, theirMove, threat, prevents, before: pos.before, recapture: pos.recapture, pawnTrades });
    this.cache.set(key, full);
    this.ideas = full;
    this.onChange();
  }
}
