/**
 * Opponent scouting as plain data — port of scouting.py: a player's most
 * common opening lines as White and as Black, their score, and whether YOUR
 * repertoire (for the other color) covers each line.
 */
import { Board, type Color } from './chess';
import { type Game, inTimeFilter } from './models';
import { formatLine, openingMoves, positionKey, repertoire } from './repertoireGaps';
import type { Db } from './sqlite';
import { Record } from './stats';

export const SCOUT_PLIES = 6;
export const MIN_GAMES = 2;

export interface ScoutLine {
  line: string;
  sans: string[];
  games: number;
  wins: number;
  draws: number;
  losses: number;
  score: number;
  covered_by_your_repertoire: boolean;
}

export interface ScoutReport {
  games: number;
  white: ScoutLine[];
  black: ScoutLine[];
}

/** games were fetched under the SCOUTED player's name, so my_color and result
 *  are from their point of view. */
export function scoutLines(conn: Db, games: Iterable<Game>, timeClasses: Set<string> | null = null, limit = 40): ScoutReport {
  const lines = new Map<string, Record>();   // "color\nsan san ..." -> record
  let count = 0;
  for (const g of games) {
    if (!inTimeFilter(g.time_control, timeClasses)) continue;
    count += 1;
    const board = Board.fromFen();
    const clean: string[] = [];
    for (const san of openingMoves(g.pgn, SCOUT_PLIES)) {
      const move = board.parseSan(san);
      if (!move) break;
      clean.push(board.san(move));
      board.push(move);
    }
    if (clean.length >= SCOUT_PLIES) {
      const key = `${g.my_color}\n${clean.join(' ')}`;
      if (!lines.has(key)) lines.set(key, new Record());
      lines.get(key)!.add(g.result);
    }
  }

  const reps = { white: repertoire(conn, 'white')[1], black: repertoire(conn, 'black')[1] };
  const out: ScoutReport = { games: count, white: [], black: [] };
  for (const theirColor of ['white', 'black'] as const) {
    const myColor = theirColor === 'white' ? 'black' : 'white';
    const myTurn: Color = myColor;
    const rows = [...lines].filter(([k, r]) => k.split('\n')[0] === theirColor && r.games >= MIN_GAMES)
      .map(([k, r]) => [k.split('\n')[1].split(' '), r] as [string[], Record])
      .sort((a, b) => b[1].games - a[1].games)
      .slice(0, limit);
    out[theirColor] = rows.map(([sans, rec]) => {
      let covered = true;
      const board = Board.fromFen();
      for (const san of sans) {
        const move = board.parseSan(san)!;
        if (board.turn === myTurn && !reps[myColor].has(`${positionKey(board.fen())}\t${move}`)) covered = false;
        board.push(move);
      }
      return {
        line: formatLine(sans), sans, games: rec.games, wins: rec.wins, draws: rec.draws, losses: rec.losses,
        score: rec.score, covered_by_your_repertoire: covered,
      };
    });
  }
  return out;
}
