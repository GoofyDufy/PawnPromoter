/**
 * What's the threat? — port of threat.py: a drill for the habit most mistakes
 * come from, not noticing what your opponent's last move threatens.
 *
 * A round: a position from your games right after your opponent's move.
 *  1. Name the threat: play the move your opponent wants to make next (the
 *     board lets you move their pieces), or say "No threat".
 *  2. Answer it: your move in the real position, judged by Stockfish.
 *
 * The threat is Stockfish's: if you could pass, what would your opponent gain?
 * Any of their moves that would gain at least THREAT_CP counts. About 1 in 4
 * positions have no threat (they'd gain under NO_THREAT_CP).
 *
 * Positions with a threat come from your puzzles that face one (Defensive /
 * Counterattack, not in check); positions without one from quiet moments.
 */
import { MATE_CP, scoreToCp } from './analyzer';
import { BLACK, Board, opposite } from './chess';
import type { Engine } from './engine';
import { pyFixed } from './format';
import * as spot from './spot';
import type { Db } from './sqlite';
import { nowIso } from './time';

export const THREAT_CP = 150;          // what a threat must be worth to your opponent (1.5 pawns)
export const NO_THREAT_CP = 50;        // "no threat": passing would cost you less than this
export const NO_THREAT_SHARE = 1 / 4;
export const DEPTH = 12;
export const THREAT_LINES = 3;         // their best moves after your pass, checked as threats
export const MOVE_OK_CP = spot.MOVE_OK_CP;   // your answer: within half a pawn of the best move
export const FOUND_XP = 3;             // named the threat (or rightly said there's none)
export const ANSWER_XP = 5;            // a good answer
export const BATCH = 40;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS threat_attempts (
    fen TEXT,
    had_threat INTEGER,
    found INTEGER,             -- named a real threat, or rightly said "no threat"
    move_ok INTEGER,
    attempted_at TEXT
);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

export interface Threat {
  move: string;              // the opponent's move, played after your pass
  gain: number;              // what it gains them, centipawns
  mate_in: number | null;
}

export class Assessment {
  constructor(
    readonly threats: Threat[],      // most dangerous first; empty = no threat
    readonly best: string,           // your best answer in the real position
    readonly best_cp: number,        // its evaluation, your point of view
    readonly pv: string[] = [],
  ) {}

  get has_threat(): boolean {
    return this.threats.length > 0;
  }
}

/** The position with you passing: your opponent to move (no history). */
export function passed(board: Board): Board {
  const b = board.copy();
  b.pushNull();
  return Board.fromFen(b.fen());
}

const toSquare = (uci: string) => uci.charCodeAt(2) - 97 + 8 * (uci.charCodeAt(3) - 49);

/** '...Nxe4, taking your knight' — board is the real position (you to move). */
export function describe(board: Board, threat: Threat): string {
  const afterPass = passed(board);
  const san = afterPass.san(threat.move);
  const dots = afterPass.turn === BLACK ? '...' : '';
  let what: string;
  if (threat.mate_in) what = threat.mate_in === 1 ? 'with mate' : `forcing mate in ${threat.mate_in}`;
  else if (afterPass.isCapture(threat.move) && afterPass.pieceAt(toSquare(threat.move))) {
    what = `taking your ${afterPass.pieceAt(toSquare(threat.move))!.role}`;
  } else what = `winning about ${pyFixed(threat.gain / 100, 1)} pawns`;
  return `${dots}${san}, ${what}`;
}

// ---------- picking positions ----------

export interface Candidate {
  game_id: string;
  ply: number;
  fen: string;
  played_uci: string;        // what you played in the game
  expect_threat: boolean;
}

export function candidates(conn: Db, wantThreatHere: boolean, exclude: Set<string>, limit = BATCH): Candidate[] {
  const rows: [string, number, string, string][] = wantThreatHere
    ? conn.all(
      `SELECT e.game_id, e.ply, e.fen_before, e.move_uci FROM puzzles p
       JOIN move_evaluations e ON e.game_id = p.source_game_id AND e.fen_before = p.fen
       WHERE p.kind IN ('Defensive', 'Counterattack')
       ORDER BY RANDOM() LIMIT ?`, [limit]).map((r) => [r.game_id, r.ply, r.fen_before, r.move_uci])
    : spot.candidates(conn, true, exclude, limit).map((c) => [c.game_id, c.ply, c.fen, c.played_uci]);
  return rows.filter(([, , fen]) => !exclude.has(fen) && !Board.fromFen(fen).isCheck())
    .map(([game_id, ply, fen, played_uci]) => ({ game_id, ply, fen, played_uci, expect_threat: wantThreatHere }));
}

export function wantThreat(random: () => number = Math.random): boolean {
  return random() >= NO_THREAT_SHARE;
}

// ---------- engine work ----------

/** The threats in a position (you to move) and your best answer. null if it's
 *  neither a clear threat nor clearly calm (it isn't used). */
export async function assess(engine: Engine, board: Board): Promise<Assessment | null> {
  const me = board.turn;
  const [info] = await engine.analyse(board, { depth: DEPTH });
  const pv = [...info.pv];
  if (!pv.length) return null;
  const now = scoreToCp(info.score, me);
  const afterPass = passed(board);
  if (!Board.isValidFen(afterPass.fen())) return null;
  const threats: Threat[] = [];
  let worst: number | null = null;
  for (const line of await engine.analyse(afterPass, { depth: DEPTH }, THREAT_LINES)) {
    if (!line.pv.length) continue;
    const gain = now - scoreToCp(line.score, me);          // what passing costs you, via this move
    worst = worst === null ? gain : Math.max(worst, gain);
    if (gain >= THREAT_CP) {
      const pov = line.score.pov(opposite(me));
      const mate = pov.mate();
      threats.push({ move: line.pv[0], gain, mate_in: pov.isMate() && mate !== null && mate > 0 ? mate : null });
    }
  }
  if (worst === null || (!threats.length && worst >= NO_THREAT_CP)) return null;   // a small threat: neither kind
  return new Assessment(threats, pv[0], now, pv);
}

/** Your guess at their threat (their move, after your pass): [a real threat?, its gain]. */
export async function judgeThreat(engine: Engine, board: Board, assessment: Assessment, move: string): Promise<[boolean, number]> {
  for (const t of assessment.threats) if (t.move === move) return [true, t.gain];
  const after = passed(board);
  after.push(move);
  if (after.isCheckmate()) return [true, MATE_CP];
  const [info] = await engine.analyse(after, { depth: DEPTH });
  const gain = assessment.best_cp - scoreToCp(info.score, board.turn);
  return [gain >= THREAT_CP, gain];
}

/** Your move in the real position: [good?, centipawns worse than the best]. */
export async function judgeAnswer(engine: Engine | null, board: Board, assessment: Assessment, move: string): Promise<[boolean, number]> {
  if (move === assessment.best) return [true, 0];
  const after = board.copy();
  after.push(move);
  if (after.isCheckmate()) return [true, 0];
  const [info] = await engine!.analyse(after, { depth: DEPTH });
  const cp = scoreToCp(info.score, board.turn);
  let loss = Math.max(0, assessment.best_cp - cp);
  if (assessment.best_cp >= MATE_CP && cp >= MATE_CP) loss = 0;
  return [loss <= MOVE_OK_CP, loss];
}

// ---------- results ----------

export function record(conn: Db, fen: string, hadThreat: boolean, found: boolean, moveOk: boolean): void {
  conn.run('INSERT INTO threat_attempts (fen, had_threat, found, move_ok, attempted_at) VALUES (?, ?, ?, ?, ?)',
    [fen, hadThreat ? 1 : 0, found ? 1 : 0, moveOk ? 1 : 0, nowIso()]);
}

export function xp(conn: Db): number {
  const r = conn.get('SELECT COALESCE(SUM(found), 0) AS f, COALESCE(SUM(move_ok), 0) AS m FROM threat_attempts')!;
  return r.f * FOUND_XP + r.m * ANSWER_XP;
}

export class Summary {
  rounds = 0;
  threats = 0;
  found = 0;                 // threats named
  calm = 0;
  calm_right = 0;            // "no threat" rightly said
  answers_ok = 0;
}

export function summary(conn: Db, since: string | null = null): Summary {
  const s = new Summary();
  for (const r of conn.all('SELECT had_threat, found, move_ok FROM threat_attempts WHERE attempted_at >= ?', [since || ''])) {
    s.rounds += 1;
    s.answers_ok += r.move_ok;
    if (r.had_threat) {
      s.threats += 1;
      s.found += r.found;
    } else {
      s.calm += 1;
      s.calm_right += r.found;
    }
  }
  return s;
}

export function seenFens(conn: Db): Set<string> {
  return new Set(conn.all('SELECT fen FROM threat_attempts').map((r) => r.fen));
}
