/**
 * Your openings as you actually play them (Opening Drill → My games) — port of
 * my_openings.py: the openings you play most, and every place where YOU leave
 * your own repertoire — the move your prep has there, what you played instead,
 * and how each scores for you. Pure functions, no engine (openingCommentary.ts
 * explains a deviation with Stockfish, on demand).
 *
 * Each game's first MAX_PLY half-moves are replayed against all your enabled
 * lines for the colour you had, matched by position (transpositions count):
 *  - your move at a position your prep covers, and it's a prep move: followed
 *  - your move there, and it isn't: a deviation (only the first in a game)
 *  - the opponent's move at a covered position isn't in your prep: the opponent
 *    left it (an OpponentDeviation — with your reply and how you did)
 *  - your prep ends: out of book, nothing more is counted.
 */
import { Board, type Color } from './chess';
import { inTimeFilter } from './models';
import { Counter, formatLine, openingMoves, positionKey } from './repertoireGaps';
import type { Db } from './sqlite';
import { Record, openingName, pgnHeaders } from './stats';

export const MAX_PLY = 24;           // the first 12 moves
export const MIN_GAMES = 1;

export class OpeningUse {
  record = new Record();
  followed = 0;            // games where you never left your prep
  left = 0;                // games where you left it yourself
  no_prep = 0;             // games your repertoire had nothing for
  deviation_keys = new Counter<string>();

  constructor(readonly name: string, readonly color: string) {}

  get games(): number {
    return this.record.games;
  }
}

export class MyDeviation {
  record = new Record();         // games you played the deviation
  prep_record = new Record();    // games you played your prep move here
  opening = '';
  game_ids: string[] = [];

  constructor(
    readonly color: string,
    readonly prefix: string[],     // SAN moves up to the position
    readonly fen: string,          // the position (your move)
    readonly played_uci: string,
    readonly played_san: string,
    readonly prep_ucis: string[],  // what your repertoire plays here
    readonly prep_sans: string[],
    readonly repertoires: string[] = [],
  ) {}

  get games(): number {
    return this.record.games;
  }

  get line(): string {
    return formatLine([...this.prefix, this.played_san]);
  }

  get move_number(): number {
    return Math.floor(this.prefix.length / 2) + 1;
  }

  get key(): string {
    return `${positionKey(this.fen)}|${this.played_uci}`;
  }
}

export class OpponentDeviation {
  record = new Record();
  replies = new Counter<string>();      // your reply (SAN) -> games
  opening = '';
  game_ids: string[] = [];

  constructor(
    readonly color: string,        // your colour in these games
    readonly prefix: string[],
    readonly fen: string,          // the position (their move)
    readonly played_uci: string,   // their move, outside your prep
    readonly played_san: string,
    readonly prep_ucis: string[],  // what your prep expects here
    readonly prep_sans: string[],
  ) {}

  get games(): number {
    return this.record.games;
  }

  get line(): string {
    return formatLine([...this.prefix, this.played_san]);
  }

  get usual_reply(): string | null {
    return this.replies.size ? this.replies.mostCommon()! : null;
  }
}

export class Report {
  games = 0;
  openings: OpeningUse[] = [];
  deviations: MyDeviation[] = [];
  opponent_deviations: OpponentDeviation[] = [];
}

/** [position -> your moves from it, position -> repertoire names]. */
function repertoire(conn: Db, color: string): [Map<string, Set<string>>, Map<string, Set<string>>] {
  const moves = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  for (const r of conn.all('SELECT fen_before_move, move_uci, repertoire_name FROM opening_lines WHERE my_color = ? AND is_enabled = 1',
    [color])) {
    const key = positionKey(r.fen_before_move);
    if (!moves.has(key)) moves.set(key, new Set());
    moves.get(key)!.add(r.move_uci);
    if (!names.has(key)) names.set(key, new Set());
    names.get(key)!.add(r.repertoire_name);
  }
  return [moves, names];
}

const sortedStrings = (items: Iterable<string>) => [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function compute(conn: Db, timeClasses: Set<string> | null = null): Report {
  const report = new Report();
  const reps = { white: repertoire(conn, 'white'), black: repertoire(conn, 'black') } as { [c: string]: ReturnType<typeof repertoire> };
  const openings = new Map<string, OpeningUse>();
  const devs = new Map<string, MyDeviation>();
  const devOpenings = new Map<string, Counter<string>>();
  const followedAt = new Map<string, Record>();       // position -> games you played prep there
  const opp = new Map<string, OpponentDeviation>();
  const oppOpenings = new Map<string, Counter<string>>();
  const counter = (m: Map<string, Counter<string>>, k: string) => {
    if (!m.has(k)) m.set(k, new Counter());
    return m.get(k)!;
  };

  for (const g of conn.all('SELECT id, pgn, my_color, result, time_control FROM games')) {
    if (!inTimeFilter(g.time_control, timeClasses)) continue;
    report.games += 1;
    const color: string = g.my_color;
    const mine: Color = color === 'white' ? 'white' : 'black';
    const [repMoves, repNames] = reps[color];
    const name = openingName(pgnHeaders(g.pgn));
    const useKey = `${name}\t${color}`;
    if (!openings.has(useKey)) openings.set(useKey, new OpeningUse(name, color));
    const use = openings.get(useKey)!;
    use.record.add(g.result);

    const board = Board.fromFen();
    const sans: string[] = [];
    let outcome = 'followed';
    let touched = false;
    const tokens = openingMoves(g.pgn, MAX_PLY + 1);
    for (const [i, san] of tokens.slice(0, MAX_PLY).entries()) {
      const move = board.parseSan(san);
      if (!move) break;
      const key = positionKey(board.fen());
      const prep = repMoves.get(key);
      if (!prep || !prep.size) break;                 // out of book (prep ended / opponent left)
      touched = true;
      if (board.turn === mine && !prep.has(move)) {
        const dkey = `${key}|${move}`;
        if (!devs.has(dkey)) {
          const prepUcis = sortedStrings(prep);
          devs.set(dkey, new MyDeviation(color, [...sans], board.fen(), move, board.san(move), prepUcis,
            prepUcis.map((u) => board.san(u)), sortedStrings(repNames.get(key) ?? [])));
        }
        devs.get(dkey)!.record.add(g.result);
        devs.get(dkey)!.game_ids.push(g.id);
        counter(devOpenings, dkey).add(name);
        use.deviation_keys.add(dkey);
        outcome = 'left';
        break;
      }
      if (board.turn === mine) {
        if (!followedAt.has(key)) followedAt.set(key, new Record());
        followedAt.get(key)!.add(g.result);
      } else if (!prep.has(move)) {                    // the opponent left your prep
        const okey = `${key}|${move}`;
        if (!opp.has(okey)) {
          const prepUcis = sortedStrings(prep);
          opp.set(okey, new OpponentDeviation(color, [...sans], board.fen(), move, board.san(move), prepUcis,
            prepUcis.map((u) => board.san(u))));
        }
        const o = opp.get(okey)!;
        o.record.add(g.result);
        o.game_ids.push(g.id);
        counter(oppOpenings, okey).add(name);
        if (i + 1 < tokens.length) {                   // your reply
          const after = board.copy();
          after.push(move);
          const reply = after.parseSan(tokens[i + 1]);
          if (reply) o.replies.add(after.san(reply));
        }
        break;
      }
      sans.push(board.san(move));
      board.push(move);
    }
    if (!touched) use.no_prep += 1;
    else if (outcome === 'left') use.left += 1;
    else use.followed += 1;
  }

  for (const [dkey, d] of devs) {
    d.opening = devOpenings.get(dkey)!.mostCommon()!;
    d.prep_record = followedAt.get(positionKey(d.fen)) ?? new Record();
  }
  for (const [okey, o] of opp) o.opening = oppOpenings.get(okey)!.mostCommon()!;
  report.opponent_deviations = [...opp.values()].sort((a, b) => b.games - a.games);
  report.openings = [...openings.values()].sort((a, b) => b.games - a.games);
  report.deviations = [...devs.values()].filter((d) => d.games >= MIN_GAMES)
    .sort((a, b) => b.games - a.games || a.move_number - b.move_number);
  return report;
}

// ---------- one game, move by move (Game Review) ----------

export class PrepPath {
  constructor(
    readonly in_prep: number,        // half-moves played inside your prep
    readonly reason: string,         // "you" / "opponent" left it, "ended" (your prep stops), "none" (no prep), "still"
    readonly played_san = '',        // the move that left it
    readonly prep_sans: string[] = [],
    readonly prep_ucis: string[] = [],
  ) {}

  /** Index of the move that left your prep (you or them), if one did. */
  get departure_ply(): number | null {
    return this.reason === 'you' || this.reason === 'opponent' ? this.in_prep : null;
  }
}

export function repertoireFor(conn: Db, color: string): Map<string, Set<string>> {
  return repertoire(conn, color)[0];
}

/** Where a game leaves your prep (your repertoire for your colour), and who left it. */
export function prepPath(repMoves: Map<string, Set<string>>, moves: string[], mine: Color): PrepPath {
  const board = Board.fromFen();
  for (const [ply, move] of moves.slice(0, MAX_PLY).entries()) {
    const prep = repMoves.get(positionKey(board.fen()));
    if (!prep || !prep.size) return new PrepPath(ply, ply ? 'ended' : 'none');
    if (!prep.has(move)) {
      const ucis = sortedStrings(prep);
      return new PrepPath(ply, board.turn === mine ? 'you' : 'opponent', board.san(move), ucis.map((u) => board.san(u)), ucis);
    }
    board.push(move);
  }
  return new PrepPath(Math.min(moves.length, MAX_PLY), 'still');
}
