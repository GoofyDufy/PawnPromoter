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
 *  - the line ends when the sacrifice has paid off one way or another (web-app
 *    rule; the desktop stopped as soon as the best move no longer stood out):
 *    mate; a forced draw (the same position a 3rd time); the material back and
 *    CLEAR_WIN_CP up, or crushing even without it; or, once the material is
 *    back, a calm position (2nd best within CALM_GAP); else after MAX_MOVES.
 *    While you're still down material a calm position doesn't end it.
 *  - Defend (web-app addition): the same positions from the other side — the
 *    computer sacrifices and attacks, you find the best defence.
 */
import * as amazing from './amazing';
import { MATE_CP, scoreToCp, winChances } from './analyzer';
import { Board, type Color, type Role } from './chess';
import type { Engine } from './engine';
import { shuffle } from './spot';
import type { Db } from './sqlite';
import { nowIso } from './time';

export const DEPTH = 14;
export const CALM_GAP = 0.12;          // best vs 2nd best (winning chances): closer = several good moves = calm
export const OK_WC = 0.06;             // your move may cost this much winning chance and still count
export const CLEAR_WIN_CP = 300;
export const MAX_MOVES = 15;           // follow-up moves of yours at most
export const DRAW_REPEATS = 3;         // the same position this often: a forced draw
export const ADVANTAGE_CP = 150;       // material back and this much better: it won material
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
    // "mate" / "draw" / "material" (the material back, and better) / "equal" (back, level) /
    // "attack" (crushing while still down material) / "max" / "over"
    readonly reason = '',
    readonly best: string | null = null,
    readonly best_cp = 0,            // your point of view
    readonly pv: string[] = [],
    readonly mate: number | null = null,   // moves to mate, your point of view (negative: you're mated)
  ) {}
}

/** How a round ended, in a word (the attacker's point of view). */
export const OUTCOMES: Record<string, string> = {
  mate: 'Forced mate', draw: 'Forced draw', material: 'Wins material', equal: 'Material back',
  attack: 'Crushing attack', max: 'Lasting attack', over: 'Game over',
};

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

/** Material for `color` minus the other side's. */
export function materialFor(board: Board, color: Color): number {
  let total = 0;
  for (const p of board.pieceMap().values()) total += VALUE[p.role] * (p.color === color ? 1 : -1);
  return total;
}

/** A position for repetition: pieces, side to move, castling, en passant. */
export const posKey = (board: Board) => board.fen().split(' ').slice(0, 4).join(' ');

/** The round so far: who sacrificed, their material before it, and every position (for repetition). */
export class Line {
  readonly history: string[];
  constructor(readonly attacker: Color, readonly startMaterial: number, history: string[]) {
    this.history = [...history];
  }

  /** From the position before the sacrifice. */
  static from(start: Board): Line {
    return new Line(start.turn, materialFor(start, start.turn), [posKey(start)]);
  }

  add(board: Board): void {
    this.history.push(posKey(board));
  }

  /** How often this position has come up, counting it once more if it's not added yet. */
  repeats(board: Board, added = false): number {
    const key = posKey(board);
    return this.history.filter((k) => k === key).length + (added ? 0 : 1);
  }

  /** The attacker's material against before the sacrifice: ≥ 0 means it's back. */
  materialBack(board: Board): number {
    return materialFor(board, this.attacker) - this.startMaterial;
  }

  copy(): Line {
    return new Line(this.attacker, this.startMaterial, this.history);
  }
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

/** Keys of the rounds played, from one side (Defend rounds are stored as "key|defend"). */
export function seen(conn: Db, side: 'attack' | 'defend' = 'attack'): Set<string> {
  const keys = conn.all('SELECT key FROM sac_attempts').map((r) => String(r.key));
  return new Set(side === 'defend' ? keys.filter((k) => k.endsWith('|defend')).map((k) => k.slice(0, -'|defend'.length))
    : keys.filter((k) => !k.endsWith('|defend')));
}

/** Not done yet first, shuffled; your own games and Lichess mixed. The ones done follow
 *  (the desktop dropped them while any were new; kept so a source filter still finds some). */
export function pick(cands: Candidate[], exclude: Set<string>, random: () => number = Math.random): Candidate[] {
  return [...shuffle(cands.filter((c) => !exclude.has(c.key)), random), ...shuffle(cands.filter((c) => exclude.has(c.key)), random)];
}

// ---------- engine work ----------

export async function theirReply(engine: Engine, board: Board): Promise<string | null> {
  if (board.isGameOver()) return null;
  const [info] = await engine.analyse(board, { depth: DEPTH });
  return info.pv.length ? info.pv[0] : null;
}

/** Your turn (me: the side to move — the attacker, or the defender in Defend): is the line
 *  over, and what's the move to find? `line` holds the positions so far (board not added yet
 *  unless `added`); the ending is judged from the attacker's point of view. canEnd false: only mate
 *  or a draw ends it (Defend: you always get to answer the sacrifice itself). */
export async function step(engine: Engine, board: Board, me: Color, movesDone: number, line: Line, added = false, canEnd = true): Promise<Step> {
  if (board.isCheckmate()) return new Step(true, board.turn === line.attacker ? 'over' : 'mate');
  if (line.repeats(board, added) >= DRAW_REPEATS) return new Step(true, 'draw');
  if (board.isGameOver()) return new Step(true, 'draw');
  const lines = await engine.analyse(board, { depth: DEPTH }, 2);
  const cps = lines.filter((l) => l.pv.length).map((l) => scoreToCp(l.score, me));
  const best = lines[0].pv[0];
  const mate = lines[0].score.pov(me).isMate() ? lines[0].score.pov(me).mate() : null;
  const at = (reason: string) => new Step(true, reason, best, cps[0], [...lines[0].pv], mate);
  const attackerCp = me === line.attacker ? cps[0] : -cps[0];
  const mating = Math.abs(cps[0]) >= Math.floor(MATE_CP / 2);
  const back = line.materialBack(board);
  if (!mating && canEnd) {
    if (attackerCp >= CLEAR_WIN_CP && (back >= 0 || attackerCp >= 2 * CLEAR_WIN_CP)) return at(back >= 0 ? 'material' : 'attack');
    const calm = cps.length > 1 && winChances(cps[0]) - winChances(cps[1]) < CALM_GAP;
    if (calm && back >= 0) return at(attackerCp >= ADVANTAGE_CP ? 'material' : 'equal');
  }
  if (movesDone >= MAX_MOVES) return at(mating && attackerCp > 0 ? 'mate' : 'max');
  return new Step(false, '', best, cps[0], [...lines[0].pv], mate);
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

/** How many follow-up moves this round asks for (0: nothing to find — skip it), and how it ends. */
export async function followUps(engine: Engine, cand: Candidate): Promise<{ moves: number; outcome: string }> {
  const board = Board.fromFen(cand.fen);
  const me = board.turn;
  const line = Line.from(board);
  board.push(cand.sac_uci);
  line.add(board);
  let n = 0;
  for (;;) {
    const reply = await theirReply(engine, board);
    if (reply === null) return { moves: n, outcome: board.isCheckmate() ? 'mate' : 'draw' };
    board.push(reply);
    const s = await step(engine, board, me, n, line);
    line.add(board);
    if (s.over) return { moves: n, outcome: s.reason };
    board.push(s.best!);
    line.add(board);
    n += 1;
    if (board.isCheckmate()) return { moves: n, outcome: 'mate' };
  }
}

/** Their other reasonable defences at a point of the line (Try other defences): replies
 *  that don't give up much more than the best one (from their side), best first. */
export async function otherDefences(engine: Engine, board: Board, played: string, count = 2): Promise<string[]> {
  if (board.isGameOver()) return [];
  const lines = (await engine.analyse(board, { depth: DEPTH }, count + 1)).filter((l) => l.pv.length);
  if (!lines.length) return [];
  const them = board.turn;
  const best = winChances(scoreToCp(lines[0].score, them));
  return lines.filter((l) => l.pv[0] !== played && best - winChances(scoreToCp(l.score, them)) <= ALT_DEFENCE_WC)
    .slice(0, count).map((l) => l.pv[0]);
}
export const ALT_DEFENCE_WC = 0.3;     // a defence this much worse (winning chances) still counts as one to try

// ---------- results ----------

/** side 'defend': kept apart (key ends "|defend"), so a position played from one side is still new from the other. */
export function record(conn: Db, cand: Candidate, moves: number, misses: number, side: 'attack' | 'defend' = 'attack'): void {
  conn.run('INSERT INTO sac_attempts (key, source, moves, misses, attempted_at) VALUES (?, ?, ?, ?, ?)',
    [side === 'defend' ? `${cand.key}|defend` : cand.key, cand.source, moves, misses, nowIso()]);
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
