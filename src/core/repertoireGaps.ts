/**
 * Which opening variations actually come up in your games, and where your
 * games leave your repertoire — port of repertoire_gaps.py. Pure functions,
 * no UI, no engine runs.
 *
 * For every game, the first MAX_PLY half-moves are replayed against ALL your
 * enabled repertoire lines for the color you had (matched by position, so
 * transpositions count). The first position that isn't covered is a "gap":
 *  - opponent's move at a covered position isn't in your prep -> you need an
 *    answer to it (the actionable case: "Add to repertoire")
 *  - your own move isn't your prep -> you left your own repertoire
 *  - no repertoire at all for that color -> gap at move 1
 *
 * Gaps are grouped by (position, move played) and sorted by how often they
 * happen. A suggested reply comes from the Stockfish cache (its best move in
 * that position, in any of your analyzed games) or, failing that, the move you
 * most often played there.
 */
import { Board, type Color } from './chess';
import type { PositionStats } from './explorer';
import { inTimeFilter } from './models';
import type { Db } from './sqlite';
import { Record, openingName, pgnHeaders } from './stats';

export const MAX_PLY = 20;          // only look at the first 10 moves
export const COMMON_PLIES = 6;      // "common lines" are grouped by the first 3 moves each
export const MIN_GAMES = 2;

const COMMENT_RE = /\{[^}]*\}|\([^)]*\)/g;
const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

/** FEN without the move counters, so transpositions match. */
export function positionKey(fen: string): string {
  return fen.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
}

/** collections.Counter with most_common(1)'s tie-break (first counted wins). */
export class Counter<K> extends Map<K, number> {
  add(key: K, n = 1): void {
    this.set(key, (this.get(key) ?? 0) + n);
  }

  mostCommon(): K | undefined {
    let best: K | undefined;
    let bestN = -Infinity;
    for (const [k, n] of this) if (n > bestN) { best = k; bestN = n; }
    return best;
  }
}

/** First maxPly SAN tokens of a PGN, fast (no full game parse). */
export function openingMoves(pgn: string, maxPly: number): string[] {
  const i = pgn.indexOf('\n\n');
  const body = i < 0 ? pgn : pgn.slice(i + 2);
  const tokens: string[] = [];
  for (let tok of body.replace(COMMENT_RE, ' ').split(/\s+/)) {
    tok = tok.replace(/^\d+\.+/, '');
    if (!tok || RESULTS.has(tok) || tok.startsWith('$')) continue;
    tokens.push(tok);
    if (tokens.length >= maxPly) break;
  }
  return tokens;
}

export function formatLine(sans: string[], startPly = 0): string {
  return sans.map((san, j) => {
    const i = j + startPly;
    if (i % 2 === 0) return `${Math.floor(i / 2) + 1}. ${san}`;
    if (i === startPly) return `${Math.floor(i / 2) + 1}... ${san}`;
    return san;
  }).join(' ');
}

/** Replays SAN moves from the start; throws on an illegal one (like push_san). */
function boardAfter(sans: string[]): Board {
  const board = Board.fromFen();
  for (const san of sans) board.pushSan(san);
  return board;
}

/** board.san(Move.from_uci(uci)) inside try/except: null for an illegal move. */
function sanOrNull(board: Board, uci: string): string | null {
  return board.isLegal(uci) ? board.san(uci) : null;
}

export class Gap {
  record = new Record();
  opening = '';
  suggestion: string | null = null;        // your reply (SAN), opponent gaps only
  suggestion_source = '';                  // "engine" / "your usual"
  game_ids: string[] = [];                 // games this happened in

  constructor(
    readonly color: string,                // your color in these games
    readonly prefix: string[],             // SAN moves up to the uncovered position
    readonly move: string,                 // the move played there
    readonly by_opponent: boolean,
    readonly covered = true,               // false = your repertoire has nothing at this position
  ) {}

  get line(): string {
    return formatLine([...this.prefix, this.move]);
  }

  /** The position where the game left your prep (before the gap move). */
  get review_fen(): string {
    return boardAfter(this.prefix).fen();
  }

  get who(): string {
    if (this.by_opponent) return 'Opponent';
    return this.covered ? 'You (left prep)' : 'You (no prep)';
  }
}

export class CommonLine {
  record = new Record();
  opening = '';
  game_ids: string[] = [];

  constructor(readonly color: string, readonly sans: string[], readonly in_repertoire = false) {}
}

export class GapReport {
  games = 0;
  gaps: Gap[] = [];
  common: CommonLine[] = [];
  has_repertoire: { [color: string]: boolean } = {};
  first_moves = new Map<string, number>();   // SAN of move 1 -> games
}

/** [positions in your repertoire, "position\tuci" moves played from them]. */
export function repertoire(conn: Db, color: string): [Set<string>, Set<string>] {
  const positions = new Set<string>();
  const moves = new Set<string>();
  for (const r of conn.all('SELECT fen_before_move, move_uci FROM opening_lines WHERE my_color = ? AND is_enabled = 1', [color])) {
    const key = positionKey(r.fen_before_move);
    positions.add(key);
    moves.add(`${key}\t${r.move_uci}`);
  }
  return [positions, moves];
}

const turnOf = (color: string): Color => (color === 'white' ? 'white' : 'black');

export function compute(conn: Db, timeClasses: Set<string> | null = null): GapReport {
  const report = new GapReport();
  const reps = { white: repertoire(conn, 'white'), black: repertoire(conn, 'black') } as Record2;
  report.has_repertoire = { white: reps.white[0].size > 0, black: reps.black[0].size > 0 };

  const gaps = new Map<string, Gap>();
  const gapOpenings = new Map<string, Counter<string>>();
  const common = new Map<string, CommonLine>();
  const commonOpenings = new Map<string, Counter<string>>();
  // my replies at positions right after an opponent gap: key -> Counter(uci)
  const myReplies = new Map<string, Counter<string>>();
  const gapAfterKeys = new Map<string, string>();
  const counter = <K>(m: Map<K, Counter<string>>, k: K) => {
    if (!m.has(k)) m.set(k, new Counter());
    return m.get(k)!;
  };

  for (const g of conn.all('SELECT id, pgn, my_color, result, time_control FROM games')) {
    if (!inTimeFilter(g.time_control, timeClasses)) continue;
    report.games += 1;
    const color: string = g.my_color;
    const myTurn = turnOf(color);
    const [positions, repMoves] = reps[color];
    const name = openingName(pgnHeaders(g.pgn));

    const board = Board.fromFen();
    const sans: string[] = [];
    let gapKey: string | null = null;
    for (const san of openingMoves(g.pgn, MAX_PLY)) {
      const move = board.parseSan(san);
      if (!move) break;
      const key = positionKey(board.fen());
      if (gapKey === null && (!positions.has(key) || !repMoves.has(`${key}\t${move}`))) {
        const moveSan = board.san(move);
        gapKey = `${color}\n${sans.join(' ')}\n${moveSan}`;
        if (!gaps.has(gapKey)) {
          gaps.set(gapKey, new Gap(color, [...sans], moveSan, board.turn !== myTurn, positions.has(key)));
        }
        gaps.get(gapKey)!.record.add(g.result);
        gaps.get(gapKey)!.game_ids.push(g.id);
        counter(gapOpenings, gapKey).add(name);
      }
      sans.push(board.san(move));
      board.push(move);
      if (gapKey !== null && !gapAfterKeys.has(gapKey) && board.turn === myTurn) {
        // position you had to answer right after the gap
        gapAfterKeys.set(gapKey, positionKey(board.fen()));
      }
      if (gapKey !== null && sans.length === gaps.get(gapKey)!.prefix.length + 2) {
        // your reply to the opponent's out-of-book move
        counter(myReplies, gapAfterKeys.get(gapKey) ?? '').add(move);
      }
      if (gapKey !== null && sans.length >= Math.max(COMMON_PLIES, gaps.get(gapKey)!.prefix.length + 2)) {
        break;   // past the gap and your reply to it; nothing more to learn
      }
    }

    if (sans.length) report.first_moves.set(sans[0], (report.first_moves.get(sans[0]) ?? 0) + 1);
    if (sans.length >= COMMON_PLIES) {
      const lineSans = sans.slice(0, COMMON_PLIES);
      const ckey = `${color}\n${lineSans.join(' ')}`;
      if (!common.has(ckey)) {
        const replay = Board.fromFen();
        let inRep = true;
        for (const s of lineSans) {
          const mv = replay.parseSan(s)!;
          if (replay.turn === myTurn && !repMoves.has(`${positionKey(replay.fen())}\t${mv}`)) inRep = false;
          replay.push(mv);
        }
        common.set(ckey, new CommonLine(color, lineSans, inRep));
      }
      common.get(ckey)!.record.add(g.result);
      common.get(ckey)!.game_ids.push(g.id);
      counter(commonOpenings, ckey).add(name);
    }
  }

  // engine suggestions: best move Stockfish found in that exact position
  const engineBest = new Map<string, Counter<string>>();
  const wanted = new Set(gapAfterKeys.values());
  for (const r of conn.all('SELECT fen_before, best_move_uci FROM move_evaluations WHERE best_move_uci IS NOT NULL')) {
    const key = positionKey(r.fen_before);
    if (wanted.has(key)) counter(engineBest, key).add(r.best_move_uci);
  }

  for (const [key, gap] of gaps) {
    gap.opening = gapOpenings.get(key)!.mostCommon()!;
    if (!gap.by_opponent) continue;
    const after = gapAfterKeys.get(key);
    if (!after) continue;
    const board = boardAfter([...gap.prefix, gap.move]);
    const source = engineBest.get(after) ?? myReplies.get(after);
    if (source && source.size) {
      const san = sanOrNull(board, source.mostCommon()!);
      if (san !== null) {
        gap.suggestion = san;
        gap.suggestion_source = engineBest.has(after) ? 'engine' : 'your usual';
      }
    }
  }

  for (const [key, line] of common) line.opening = commonOpenings.get(key)!.mostCommon()!;

  report.gaps = [...gaps.values()].filter((g) => g.record.games >= MIN_GAMES).sort((a, b) => b.record.games - a.record.games);
  report.common = [...common.values()].filter((c) => c.record.games >= MIN_GAMES).sort((a, b) => b.record.games - a.record.games);
  return report;
}

type Record2 = { [color: string]: [Set<string>, Set<string>] };

/** A PGN for adding this gap to a repertoire: the opponent's move plus your
 *  suggested reply, or (your own move) the move you actually play. */
export function gapPgn(gap: Gap, lineName: string): string | null {
  let sans: string[];
  if (gap.by_opponent) {
    if (!gap.suggestion) return null;
    sans = [...gap.prefix, gap.move, gap.suggestion];
  } else {
    sans = [...gap.prefix, gap.move];
  }
  return `[Event "${lineName}"]\n\n${formatLine(sans)} *\n`;
}

// ---------- popular moves your repertoire doesn't answer (Lichess data) ----------

export const MIN_POPULAR_SHARE = 0.08;   // a reply played in at least 8% of games at that position
export const MIN_POPULAR_GAMES = 30;     // ...with enough games behind it to mean something
export const MIN_REPLY_SHARE = 0.10;     // suggested answers come from replies at least this common

export type StatsFor = (fen: string) => PositionStats | null;

export class PopularGap {
  suggestion: string | null = null;
  suggestion_source = '';                // "engine" / "lichess"
  inside = true;                         // false: before your opening starts (see markInside)

  constructor(
    readonly color: string,              // your color
    readonly prefix: string[],           // SAN moves to the position (through your repertoire)
    readonly move: string,               // the popular opponent move you have no answer to
    readonly share: number,              // how often it's played in that position
    readonly reach: number,              // chance a game gets to that position at all
    readonly games: number,
    readonly opponent_score: number,     // how players who choose it score
  ) {}

  get line(): string {
    return formatLine([...this.prefix, this.move]);
  }

  /** Rough share of your games (in this repertoire) that would see this move. */
  get frequency(): number {
    return this.reach * this.share;
  }

  /** For gapPgn / Add to repertoire. */
  asGap(): Gap {
    const gap = new Gap(this.color, [...this.prefix], this.move, true);
    gap.suggestion = this.suggestion;
    gap.suggestion_source = this.suggestion_source;
    return gap;
  }
}

/** statsFor(fen) -> explorer PositionStats or null (cache only — no network
 *  here). Walks each enabled repertoire tree; at every position where the
 *  opponent is to move and your prep continues, any popular reply that no line
 *  covers is a gap. Sorted by how often you'd actually face it. */
export function popularGaps(conn: Db, statsFor: StatsFor): PopularGap[] {
  const found = new Map<string, PopularGap>();

  for (const color of ['white', 'black']) {
    const mine = turnOf(color);
    const [, repMoves] = repertoire(conn, color);
    // position -> repertoire moves from it, merged across every line
    const movesAt = new Map<string, string[]>();
    for (const entry of [...repMoves].sort(compareTuple)) {
      const [key, uci] = entry.split('\t');
      if (!movesAt.has(key)) movesAt.set(key, []);
      movesAt.get(key)!.push(uci);
    }
    const seen = new Map<string, number>();   // position -> best reach already explored

    const visit = (board: Board, sans: string[], reach: number): void => {
      const key = positionKey(board.fen());
      if ((seen.get(key) ?? -1.0) >= reach) return;
      seen.set(key, reach);
      const nodes = movesAt.get(key) ?? [];
      // only where your prep continues with an opponent move — a line that ends
      // here is a deliberate stopping point, not a hole
      const stats = board.turn !== mine && nodes.length ? statsFor(board.fen()) : null;
      if (stats && stats.games) {
        for (const m of stats.moves) {
          const share = m.games / stats.games;
          if (share < MIN_POPULAR_SHARE || m.games < MIN_POPULAR_GAMES) continue;
          if (repMoves.has(`${key}\t${m.uci}`)) continue;
          const san = sanOrNull(board, m.uci);
          if (san === null) continue;
          const gkey = `${color}\n${key}\n${m.uci}`;
          if (!found.has(gkey) || found.get(gkey)!.reach < reach) {
            found.set(gkey, new PopularGap(color, [...sans], san, share, reach, m.games, m.scoreFor(board.turn)));
          }
        }
      }
      for (const uci of nodes) {
        if (!board.isLegal(uci)) continue;
        let step = 1.0;
        if (board.turn !== mine && stats && stats.games) step = stats.share(uci);
        const san = board.san(uci);
        board.push(uci);
        visit(board, [...sans, san], reach * step);
        board.pop();
      }
    };

    if (movesAt.size) visit(Board.fromFen(), [], 1.0);
  }

  const gaps = [...found.values()];
  suggestReplies(conn, gaps, statsFor);
  return gaps.sort((a, b) => b.frequency - a.frequency);
}

/** Python's sorted() on (position, uci) tuples: by position, then move. */
function compareTuple(a: string, b: string): number {
  const [ka, ua] = a.split('\t');
  const [kb, ub] = b.split('\t');
  if (ka !== kb) return ka < kb ? -1 : 1;
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/** Your answer to each gap: Stockfish's best move there if any analyzed game
 *  reached it, else the best-scoring common reply on Lichess. */
function suggestReplies(conn: Db, gaps: PopularGap[], statsFor: StatsFor): void {
  const after = new Map<string, [PopularGap, Board]>();
  for (const g of gaps) {
    const board = boardAfter([...g.prefix, g.move]);
    after.set(positionKey(board.fen()), [g, board]);
  }
  const engineBest = new Map<string, Counter<string>>();
  for (const r of conn.all('SELECT fen_before, best_move_uci FROM move_evaluations WHERE best_move_uci IS NOT NULL')) {
    const key = positionKey(r.fen_before);
    if (after.has(key)) {
      if (!engineBest.has(key)) engineBest.set(key, new Counter());
      engineBest.get(key)!.add(r.best_move_uci);
    }
  }
  for (const [key, [g, board]] of after) {
    if (engineBest.has(key)) {
      const san = sanOrNull(board, engineBest.get(key)!.mostCommon()!);
      if (san !== null) {
        g.suggestion = san;
        g.suggestion_source = 'engine';
      }
      continue;
    }
    const stats = statsFor(board.fen());
    if (!stats || !stats.games) continue;
    let candidates = stats.moves.filter((m) => m.games / stats.games >= MIN_REPLY_SHARE);
    if (!candidates.length) candidates = stats.moves.slice(0, 1);
    if (!candidates.length) continue;
    // max() by (score, games): the first of equal maxima wins, like Python
    let best = candidates[0];
    for (const m of candidates.slice(1)) {
      const [s, bs] = [m.scoreFor(board.turn), best.scoreFor(board.turn)];
      if (s > bs || (s === bs && m.games > best.games)) best = m;
    }
    const san = sanOrNull(board, best.uci);
    if (san !== null) {
      g.suggestion = san;
      g.suggestion_source = 'lichess';
    }
  }
}

/** Positions right after each gap move (where you'd answer) — worth
 *  downloading so suggestReplies can use Lichess data. */
export function gapReplyPositions(gaps: PopularGap[]): string[] {
  return gaps.map((g) => boardAfter([...g.prefix, g.move]).fen());
}

/** starts: color -> each repertoire's start position as UCI moves
 *  (openingTree.startPath). A gap is inside when one of them is a prefix of
 *  the moves leading to it; else it's before your openings begin. */
export function markInside(gaps: PopularGap[], starts: { [color: string]: string[][] }): void {
  for (const g of gaps) {
    const board = Board.fromFen();
    const ucis: string[] = [];
    for (const san of g.prefix) ucis.push(board.pushSan(san));
    g.inside = (starts[g.color] ?? []).some((s) => s.length <= ucis.length && s.every((u, i) => ucis[i] === u));
  }
}
