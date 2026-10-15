/**
 * Spot the Tactic — port of spot.py: each position from your own games first
 * asks "is there a tactic here?", then you play a move.
 *
 * A position HAS a tactic when it's FORCING (checked by Stockfish when the
 * round is set up, not taken from the cache):
 *  - a forced mate in MAX_MATE moves or fewer, or
 *  - a forcing sequence that wins material: every one of your moves until the
 *    material is won is a check, a capture or a direct threat (see isForcing),
 *    the gain is counted after the opponent's reply and has to hold to the end
 *    of the line.
 * A position is QUIET when there's no such win and the second-best move is
 * within MOVE_OK_CP of the best. Anything else is "unclear" and never used.
 * Positions are drawn from two pools of your analyzed games — likely tactics
 * and likely quiet ones — about QUIET_SHARE of rounds quiet.
 *
 * Trivial positions are skipped: being in check, and plain recaptures.
 *
 * Your move: in a TACTIC position only Stockfish's best move counts (or a
 * different move that mates on the spot). In a QUIET position any move within
 * MOVE_OK_CP of the best counts.
 *
 * Engine calls are async here (the browser engine answers by message).
 */
import { MATE_CP, scoreToCp } from './analyzer';
import { Board, type Color, WHITE, opposite } from './chess';
import type { Engine, PovScore } from './engine';
import { VALUES } from './explain';
import { readGame } from './pgn';
import type { Db } from './sqlite';
import { ONLY_MOVE_GAP_CP } from './style';
import { nowIso } from './time';

export const QUIET_SHARE = 1 / 3;
export const MIN_QUIET_PLY = 10;          // quiet positions only after both sides have played 5 moves
export const MIN_GAIN_PAWNS = 1;          // material a forcing line must net
export const FORCING_PLIES = 8;           // how far down the engine line a forcing win is looked for
export const MAX_MATE = 4;                // forced mates up to this many moves count
export const MAX_SOLUTION_MOVES = 4;      // longest sequence you play (FORCING_PLIES covers it)
export const MIN_WINNING_CP = 100;        // ...and the position must actually be good for you after it
export const MOVE_OK_CP = 50;             // quiet positions: a move within half a pawn of the best is good
export const MAX_START_CP = 400;          // skip positions already decided either way
export const CLASSIFY_DEPTH = 14;
export const JUDGE_DEPTH = 12;
export const LINE_DEPTH = 18;             // the walk-through line
export const LINE_PLIES = 12;             // moves shown after the best move
export const EVAL_DEPTH = 12;             // evaluation bar along the line
export const CALL_XP = 3;                 // right answer to the question
export const MOVE_XP = 5;                 // a good move afterwards
export const BATCH = 40;                  // candidates fetched per pool at a time

export interface Candidate {
  game_id: string;
  ply: number;
  fen: string;
  played_uci: string;                     // what you played in the game
}

export class Verdict {
  constructor(
    readonly is_tactic: boolean,
    readonly reason: string,              // "mate" / "material" / "quiet" / "unclear" (not used)
    readonly best: string,
    readonly best_cp: number,             // your point of view
    readonly second_cp: number | null,
    readonly pv: string[] = [],
    readonly mate_in: number | null = null,
    readonly gain = 0,                    // pawns won along the best line
    // what you play: the forcing line (your moves and the replies, ending with
    // yours, up to MAX_SOLUTION_MOVES of yours) — just [best] for quiet positions
    readonly solution: string[] = [],
  ) {}

  get my_moves(): number {
    return Math.floor((this.solution.length + 1) / 2);
  }

  describe(board: Board): string {
    const best = board.san(this.best);
    if (this.reason === 'mate') return `Yes — ${best} forces mate in ${this.mate_in}.`;
    if (this.reason === 'material') return `Yes — ${best} starts a forcing sequence that wins ${pawns(this.gain)}.`;
    return `No tactic — several moves are about equally good (the engine's pick was ${best}).`;
  }
}

function pawns(n: number): string {
  return ({ 1: 'a pawn', 2: 'two pawns', 3: 'a piece', 5: 'a rook', 9: 'a queen' } as Record<number, string>)[n]
    ?? `${n} pawns' worth`;
}

function material(board: Board, color: Color): number {
  let total = 0;
  for (const p of board.pieceMap().values()) total += VALUES[p.role] * (p.color === color ? 1 : -1);
  return total;
}

// ---------- picking positions ----------

/** Random positions from your analyzed games that are likely quiet / likely
 *  tactical (the final call is classify()'s). */
export function candidates(conn: Db, quiet: boolean, exclude: Set<string>, limit = BATCH): Candidate[] {
  let sql: string;
  let args: (string | number)[];
  if (quiet) {
    sql = `SELECT e.game_id, e.ply, e.fen_before, e.move_uci FROM move_evaluations e
           WHERE e.cp_third IS NOT NULL AND e.cp_after IS NOT NULL
             AND abs(e.cp_before) < 300 AND e.cp_before - e.cp_third < 50
             AND e.cp_before - e.cp_after < 50 AND e.ply >= ?
           ORDER BY RANDOM() LIMIT ?`;
    args = [MIN_QUIET_PLY, limit];
  } else {
    // only-move positions, or your opponent's last move just handed you 2+ pawns
    sql = `SELECT e.game_id, e.ply, e.fen_before, e.move_uci FROM move_evaluations e
           LEFT JOIN move_evaluations prev ON prev.game_id = e.game_id AND prev.ply = e.ply - 2
           WHERE e.cp_second IS NOT NULL AND abs(e.cp_before) < ?
             AND (e.cp_before - e.cp_second >= ?
                  OR (prev.cp_after IS NOT NULL AND e.cp_before - prev.cp_after >= 200))
           ORDER BY RANDOM() LIMIT ?`;
    args = [MAX_START_CP, ONLY_MOVE_GAP_CP, limit];
  }
  return conn.all(sql, args)
    .filter((r) => !exclude.has(r.fen_before))
    .map((r) => ({ game_id: r.game_id, ply: r.ply, fen: r.fen_before, played_uci: r.move_uci }));
}

/** The opponent's move that led to this position, and the value of the piece
 *  of yours it captured (0 if it wasn't a capture) — replayed from the PGN. */
export function lastMove(conn: Db, cand: Candidate): [string | null, number] {
  const row = conn.get('SELECT pgn FROM games WHERE id = ?', [cand.game_id]);
  const game = row ? readGame(row.pgn) : null;
  if (!game || cand.ply === 0) return [null, 0];
  const board = Board.fromFen(game.startFen, game.chess960);
  for (const [i, move] of game.mainline.entries()) {
    if (i === cand.ply - 1) {
      if (board.isEnPassant(move)) return [move, VALUES.pawn];
      const victim = board.isCapture(move) ? board.pieceAt(squareOf(move, 2)) : undefined;
      return [move, victim ? VALUES[victim.role] : 0];
    }
    board.push(move);
  }
  return [null, 0];
}

/** Square index of the UCI move's from (offset 0) or to (offset 2) square. */
function squareOf(uci: string, offset: 0 | 2): number {
  return uci.charCodeAt(offset) - 97 + 8 * (uci.charCodeAt(offset + 1) - 49);
}

/** In check (the reply is often forced), or the best move just takes back on
 *  the square the opponent captured on — "yes" would be obvious. */
export function isTrivial(board: Board, best: string, previous: string | null, previousCaptured: number): boolean {
  if (board.isCheck()) return true;
  return previous !== null && !!previousCaptured && board.isCapture(best) && squareOf(best, 2) === squareOf(previous, 2);
}

// ---------- deciding & judging ----------

/** A check, a capture, or a NEW direct threat: after it, if you could move
 *  again you'd mate, or win a piece that's undefended or worth more than the
 *  piece taking it — and that wasn't already possible before the move. */
export function isForcing(board: Board, move: string): boolean {
  if (board.isCapture(move) || board.givesCheck(move)) return true;
  const after = board.copy();
  after.push(move);
  after.pushNull();                       // "if it were your move again"
  const before = threats(board);
  for (const t of threats(after)) if (!before.has(t)) return true;
  return false;
}

/** What the side to move could do right now: 'mate', and the squares of enemy
 *  pieces it could win (undefended, or worth more than the taker). */
function threats(board: Board): Set<string | number> {
  const me = board.turn;
  const found = new Set<string | number>();
  for (const m of board.legalMoves()) {
    board.push(m);
    const mate = board.isCheckmate();
    board.pop();
    if (mate) {
      found.add('mate');
      continue;
    }
    if (board.isCapture(m) && !board.isEnPassant(m)) {
      const to = squareOf(m, 2);
      const victim = board.pieceAt(to);
      const attacker = board.pieceAt(squareOf(m, 0));
      if (!victim || !attacker || victim.color === me) continue;
      const undefended = !board.isAttackedBy(opposite(me), to);
      if (undefended || VALUES[victim.role] > VALUES[attacker.role]) found.add(to);
    }
  }
  return found;
}

/** [material won, plies of the solution] for a forcing sequence along the
 *  engine line: every one of YOUR moves up to the win must be forcing; the
 *  gain is counted after the opponent's reply and must still stand at the end
 *  of the line looked at. [0, 0] if the line isn't forcing or wins nothing. */
export function forcingWin(board: Board, pv: string[], justLost = 0): [number, number] {
  const me = board.turn;
  const b = board.copy();
  const start = material(b, me) + justLost;      // measured from before their capture
  let won = 0;
  let length = 0;
  const plies = Math.min(FORCING_PLIES, pv.length);
  for (const [i, move] of pv.slice(0, plies).entries()) {
    if (!b.isLegal(move)) break;
    if (i % 2 === 0 && !won && !isForcing(b, move)) return [0, 0];   // a quiet move before anything was won
    b.push(move);
    if (i % 2 === 1) {                            // after the opponent's reply
      const gain = material(b, me) - start;
      if (!won && gain >= MIN_GAIN_PAWNS) {
        won = gain;
        length = i;                               // your moves up to (not incl.) this reply
      } else if (won && gain < MIN_GAIN_PAWNS) {
        return [0, 0];                            // given back
      }
    }
  }
  return [won, length];
}

export function forcingGain(board: Board, pv: string[], justLost = 0): number {
  return forcingWin(board, pv, justLost)[0];
}

/** The engine line up to and including the mating move. */
export function mateLine(board: Board, pv: string[]): string[] {
  const b = board.copy();
  const line: string[] = [];
  for (const move of pv.slice(0, 2 * MAX_SOLUTION_MOVES - 1)) {
    if (!b.isLegal(move)) break;
    b.push(move);
    line.push(move);
    if (b.isCheckmate()) break;
  }
  return line;
}

/** The moves to play (yours and the replies, ending with yours): the forcing
 *  line to mate or to the material win, at most MAX_SOLUTION_MOVES of yours —
 *  or just the first move when the position isn't a forcing tactic. */
export function solutionFor(board: Board, pv: string[], score: PovScore, justLost = 0): string[] {
  if (!pv.length) return [];
  const pov = score.pov(board.turn);
  const mate = pov.mate();
  if (pov.isMate() && mate !== null && mate > 0 && mate <= MAX_MATE) {
    const line = mateLine(board, pv);
    if (line.length) return line;
  }
  const [gain, length] = forcingWin(board, pv, justLost);
  if (gain >= MIN_GAIN_PAWNS && length) return pv.slice(0, length);
  return pv.slice(0, 1);
}

/** Tactic = forced mate (MAX_MATE moves or fewer) or a forcing sequence that
 *  wins material. Quiet = neither, and the second-best move is within
 *  MOVE_OK_CP of the best. Anything else is "unclear".
 *  justLost: material the opponent's last move captured from you. */
export async function classify(engine: Engine, board: Board, justLost = 0): Promise<Verdict> {
  const me = board.turn;
  const lines = await engine.analyse(board, { depth: CLASSIFY_DEPTH }, 2);
  const top = lines[0];
  const best = top.pv[0];
  const bestCp = scoreToCp(top.score, me);
  const secondCp = lines.length > 1 && lines[1].pv.length ? scoreToCp(lines[1].score, me) : null;
  const pv = [...top.pv];
  const pov = top.score.pov(me);
  const mate = pov.mate();
  if (pov.isMate() && mate !== null && mate > 0 && mate <= MAX_MATE) {
    const line = mateLine(board, pv);
    return new Verdict(true, 'mate', best, bestCp, secondCp, pv, mate, 0, line.length ? line : [best]);
  }
  const [gain, length] = forcingWin(board, pv, justLost);
  if (gain >= MIN_GAIN_PAWNS && bestCp >= MIN_WINNING_CP) {
    return new Verdict(true, 'material', best, bestCp, secondCp, pv, null, gain, pv.slice(0, length));
  }
  if (secondCp !== null && bestCp - secondCp < MOVE_OK_CP && !pov.isMate()) {
    return new Verdict(false, 'quiet', best, bestCp, secondCp, pv, null, 0, [best]);
  }
  return new Verdict(false, 'unclear', best, bestCp, secondCp, pv, null, 0, [best]);
}

/** [good?, how many centipawns worse than the best move]. Tactic positions:
 *  only the best move (or an immediate mate) is good. Quiet: within MOVE_OK_CP. */
export async function judgeMove(engine: Engine | null, board: Board, verdict: Verdict, move: string): Promise<[boolean, number]> {
  if (move === verdict.best) return [true, 0];
  const after = board.copy();
  after.push(move);
  if (after.isCheckmate()) return [true, 0];
  const [info] = await engine!.analyse(after, { depth: JUDGE_DEPTH });
  const cp = scoreToCp(info.score, board.turn);
  let loss = Math.max(0, verdict.best_cp - cp);
  if (verdict.best_cp >= MATE_CP && cp >= MATE_CP) loss = 0;   // still mating, just slower
  if (verdict.is_tactic) return [false, loss];
  return [loss <= MOVE_OK_CP, loss];
}

/** Best move plus Stockfish's continuation, for stepping through. */
export async function correctLine(engine: Engine, board: Board, verdict: Verdict): Promise<string[]> {
  const after = board.copy();
  after.push(verdict.best);
  if (after.isGameOver()) return [verdict.best];
  const [info] = await engine.analyse(after, { depth: LINE_DEPTH });
  return [verdict.best, ...info.pv.slice(0, LINE_PLIES)];
}

/** Evaluation (White's point of view) of every position along the line:
 *  index i = after the first i moves — for the evaluation bar. */
export async function lineEvals(engine: Engine, board: Board, line: string[]): Promise<number[]> {
  const evals: number[] = [];
  const b = board.copy();
  for (let i = 0; i <= line.length; i++) {
    if (b.isCheckmate()) evals.push(b.turn === WHITE ? -MATE_CP : MATE_CP);
    else if (b.isGameOver()) evals.push(0);
    else {
      const [info] = await engine.analyse(b, { depth: EVAL_DEPTH });
      evals.push(scoreToCp(info.score, WHITE));
    }
    if (i < line.length) b.push(line[i]);
  }
  return evals;
}

// ---------- results ----------

export function record(conn: Db, fen: string, verdict: Verdict, saidTactic: boolean, moveOk: boolean): void {
  conn.run(
    'INSERT INTO spot_attempts (fen, is_tactic, reason, said_tactic, move_ok, attempted_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fen, verdict.is_tactic ? 1 : 0, verdict.reason, saidTactic ? 1 : 0, moveOk ? 1 : 0, nowIso()],
  );
}

export function xp(conn: Db): number {
  const row = conn.get(
    'SELECT COALESCE(SUM(is_tactic = said_tactic), 0) AS calls, COALESCE(SUM(move_ok), 0) AS moves FROM spot_attempts',
  )!;
  return row.calls * CALL_XP + row.moves * MOVE_XP;
}

export class Summary {
  rounds = 0;
  tactics = 0;
  spotted = 0;              // tactic positions you said yes to
  quiet = 0;
  false_alarms = 0;         // quiet positions you said yes to
  moves_ok = 0;
}

export function summary(conn: Db): Summary {
  const s = new Summary();
  for (const r of conn.all('SELECT is_tactic, said_tactic, move_ok FROM spot_attempts')) {
    s.rounds += 1;
    s.moves_ok += r.move_ok;
    if (r.is_tactic) {
      s.tactics += 1;
      s.spotted += r.said_tactic;
    } else {
      s.quiet += 1;
      s.false_alarms += r.said_tactic;
    }
  }
  return s;
}

export function seenFens(conn: Db): Set<string> {
  return new Set(conn.all('SELECT fen FROM spot_attempts').map((r) => r.fen));
}

/** A quiet round needs at least 5 moves played by each side. */
export function usableAsQuiet(cand: Candidate): boolean {
  return cand.ply >= MIN_QUIET_PLY;
}

export function wantQuiet(random: () => number = Math.random): boolean {
  return random() < QUIET_SHARE;
}
