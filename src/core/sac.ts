/**
 * Sacrifice!! — port of sac.py, the third mode of Tactics & Threats: play a
 * sacrifice, then find the follow-up that makes it worth it, move by move,
 * against Stockfish's best defence, until the position is no longer sharp,
 * you're clearly winning, or it's mate.
 *
 * Positions: your own amazing moves (amazing.ts) where you're not worse after
 * the sacrifice, sacrifices you missed in your games, and Lichess puzzles with
 * the "sacrifice" theme (their first solution move is the sacrifice). A round
 * is only used when there's at least one real follow-up to find.
 *
 * Rules (Stockfish):
 *  - their move: Stockfish's best defence;
 *  - your move is right if it keeps (nearly) all the winning chances of the
 *    best one (within OK_WC on Lichess's -1..1 scale), or mates;
 *  - the line ends, on your turn, when you're CLEAR_WIN_CP up, or the best move
 *    no longer stands out (2nd best within CALM_GAP), or after MAX_MOVES of yours.
 */
import * as amazing from './amazing';
import { MATE_CP, scoreToCp, winChances } from './analyzer';
import { Board, type Color } from './chess';
import type { Engine } from './engine';
import { shuffle } from './spot';
import type { Db } from './sqlite';
import { nowIso } from './time';

export const DEPTH = 14;
export const CALM_GAP = 0.12;          // best vs 2nd best (winning chances): closer = several good moves = calm
export const OK_WC = 0.06;             // your move may cost this much winning chance and still count
export const CLEAR_WIN_CP = 300;
export const MAX_MOVES = 10;           // follow-up moves of yours at most
export const MIN_AFTER_CP = -30;       // your own sacrifices: not worse after it (they work)
export const CLEAN_XP = 8;             // made it work without a miss
export const DONE_XP = 3;              // ...with help

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sac_attempts (
    key TEXT,                  -- the position + sacrifice
    source TEXT,               -- "game" / "lichess"
    moves INTEGER,             -- follow-up moves you had to find
    misses INTEGER,
    attempted_at TEXT
);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

export class Candidate {
  constructor(
    readonly fen: string,            // before the sacrifice (your move)
    readonly sac_uci: string,
    readonly source: string,         // "game" / "missed" / "lichess"
    readonly game_id: string | null = null,
    readonly ply: number | null = null,
    readonly label = '',             // where it's from
  ) {}

  get key(): string {
    return `${this.fen.split(/\s+/).slice(0, 4).join(' ')}|${this.sac_uci}`;
  }
}

/** After their reply, your turn: whether the line goes on, and its best move. */
export class Step {
  constructor(
    readonly over: boolean,
    readonly reason = '',            // "mate" / "winning" / "calm" / "max" / "over"
    readonly best: string | null = null,
    readonly best_cp = 0,            // your point of view
    readonly pv: string[] = [],
  ) {}
}

// ---------- positions ----------

export function ownCandidates(found: amazing.Amazing[]): Candidate[] {
  return found.filter((a) => a.cp_after >= MIN_AFTER_CP).map((a) => new Candidate(a.fen, a.uci, 'game', a.game_id, a.ply));
}

/** Sacrifices you missed in your games: now find them (source "missed"). */
export function missedCandidates(missed: amazing.Missed[]): Candidate[] {
  return missed.map((m) => new Candidate(m.fen, m.best_uci, 'missed', m.game_id, m.ply));
}

export function lichessCandidates(conn: Db): Candidate[] {
  return conn.all("SELECT id, fen, solution_ucis, rating FROM lichess_puzzles WHERE ' ' || themes || ' ' LIKE '% sacrifice %'")
    .map((r) => new Candidate(r.fen, r.solution_ucis.split(/\s+/)[0], 'lichess', null, null, `Lichess puzzle, rated ${r.rating}`));
}

export function seen(conn: Db): Set<string> {
  return new Set(conn.all('SELECT key FROM sac_attempts').map((r) => r.key));
}

/** Not done yet first, shuffled; your own games and Lichess mixed. */
export function pick(cands: Candidate[], exclude: Set<string>, random: () => number = Math.random): Candidate[] {
  const fresh = cands.filter((c) => !exclude.has(c.key));
  return shuffle(fresh.length ? fresh : [...cands], random);
}

// ---------- engine work ----------

export async function theirReply(engine: Engine, board: Board): Promise<string | null> {
  if (board.isGameOver()) return null;
  const [info] = await engine.analyse(board, { depth: DEPTH });
  return info.pv.length ? info.pv[0] : null;
}

/** Your turn: is the line over, and what's the move to find? */
export async function step(engine: Engine, board: Board, me: Color, movesDone: number): Promise<Step> {
  if (board.isCheckmate()) return new Step(true, 'mate');
  if (board.isGameOver()) return new Step(true, 'over');
  const lines = await engine.analyse(board, { depth: DEPTH }, 2);
  const cps = lines.filter((l) => l.pv.length).map((l) => scoreToCp(l.score, me));
  const best = lines[0].pv[0];
  if (cps[0] >= CLEAR_WIN_CP && cps[0] < Math.floor(MATE_CP / 2)) return new Step(true, 'winning', best, cps[0]);
  if (cps.length > 1 && winChances(cps[0]) - winChances(cps[1]) < CALM_GAP && cps[0] < Math.floor(MATE_CP / 2)) {
    return new Step(true, 'calm', best, cps[0]);
  }
  if (movesDone >= MAX_MOVES) return new Step(true, 'max', best, cps[0]);
  return new Step(false, '', best, cps[0], [...lines[0].pv]);
}

/** [right?, your evaluation after it]. */
export async function judge(engine: Engine | null, board: Board, move: string, s: Step): Promise<[boolean, number]> {
  if (move === s.best) return [true, s.best_cp];
  const after = board.copy();
  after.push(move);
  if (after.isCheckmate()) return [true, MATE_CP];
  const [info] = await engine!.analyse(after, { depth: DEPTH });
  const cp = scoreToCp(info.score, board.turn);
  if (s.best_cp >= Math.floor(MATE_CP / 2) && cp >= Math.floor(MATE_CP / 2)) return [true, cp];   // a slower mate is still a mate
  return [winChances(s.best_cp) - winChances(cp) <= OK_WC, cp];
}

/** How many follow-up moves this round asks for (0: nothing to find — skip it). */
export async function followUps(engine: Engine, cand: Candidate): Promise<number> {
  const board = Board.fromFen(cand.fen);
  const me = board.turn;
  board.push(cand.sac_uci);
  let n = 0;
  for (;;) {
    const reply = await theirReply(engine, board);
    if (reply === null) return n;
    board.push(reply);
    const s = await step(engine, board, me, n);
    if (s.over) return n;
    board.push(s.best!);
    n += 1;
    if (board.isCheckmate()) return n;
  }
}

// ---------- results ----------

export function record(conn: Db, cand: Candidate, moves: number, misses: number): void {
  conn.run('INSERT INTO sac_attempts (key, source, moves, misses, attempted_at) VALUES (?, ?, ?, ?, ?)',
    [cand.key, cand.source, moves, misses, nowIso()]);
}

export function xp(conn: Db): number {
  const r = conn.get('SELECT COALESCE(SUM(misses = 0), 0) AS clean, COALESCE(SUM(misses > 0), 0) AS helped FROM sac_attempts')!;
  return r.clean * CLEAN_XP + r.helped * DONE_XP;
}

/** [rounds, clean rounds]. */
export function summary(conn: Db): [number, number] {
  const r = conn.get('SELECT COUNT(*) AS n, COALESCE(SUM(misses = 0), 0) AS clean FROM sac_attempts')!;
  return [r.n, r.clean];
}
