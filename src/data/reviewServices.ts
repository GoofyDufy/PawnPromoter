/**
 * Game Review's database work (game_review_tab.py), in the database worker:
 * your analyzed games, one game with its saved analysis (one evaluation per
 * move of yours), where it left your prep, its named line, its amazing moves
 * and accuracy — plus every amazing move of yours, for the list.
 */
import * as amazing from '../core/amazing';
import { Board } from '../core/chess';
import * as db from '../core/db';
import { pyFixed } from '../core/format';
import * as gameNotes from '../core/gameNotes';
import { inTimeFilter, makePuzzle, PICK_PREFIX, SELF_MADE, TIME_FILTERS, timeClass } from '../core/models';
import * as puzzleTags from '../core/puzzleTags';
import * as myLines from '../core/myLines';
import * as myOpenings from '../core/myOpenings';
import * as openingLibrary from '../core/openingLibrary';
import { readGame } from '../core/pgn';
import type { Db } from '../core/sqlite';

export interface ReviewGameRow { id: string; label: string }

export const RESULTS: Record<string, string | null> = { 'All results': null, Wins: 'win', Losses: 'loss', Draws: 'draw' };

/** The games list: analyzed games, newest first, with their blunders (_refresh_games);
 *  result: All results / Wins / Losses / Draws. */
export function reviewGames(conn: Db, filter: string, result = 'All results'): ReviewGameRow[] {
  const want = RESULTS[result] ?? null;
  const blunders = new Map(conn.all(`SELECT game_id, SUM(cp_after IS NOT NULL AND cp_before - cp_after >= 300) AS n
    FROM move_evaluations GROUP BY game_id`).map((r) => [r.game_id, r.n as number]));
  const classes = TIME_FILTERS[filter] ?? null;
  return conn.all('SELECT * FROM games WHERE evaluated_at IS NOT NULL ORDER BY played_at DESC LIMIT 1500')
    .filter((g) => inTimeFilter(g.time_control, classes) && (want === null || g.result === want))
    .map((g) => {
      const n = blunders.get(g.id) ?? 0;
      const tag = n ? ` · ${n} blunder${n !== 1 ? 's' : ''}` : '';
      return { id: g.id, label: `${String(g.played_at).slice(0, 10)}  ${String(g.result).toUpperCase().padEnd(4)} vs ${g.opponent_username} · ${timeClass(g.time_control)}${tag}` };
    });
}

export interface EvalRow {
  ply: number;
  fen_before: string;
  move_uci: string;
  best_move_uci: string | null;
  cp_before: number;
  cp_after: number | null;
  second_move_uci: string | null;
  cp_second: number | null;
}

export interface PrepView {
  inPrep: number;
  reason: string;            // you / opponent / ended / none / still
  prepSans: string[];
  prepUcis: string[];
  departure: number | null;
}

export interface ReviewGame {
  id: string;
  title: string;
  accuracy: string;          // "\nAccuracy — chess.com: you 81.2% … · Pawn Promoter: you 79.0%"
  opening: string;           // its named line · where it left your prep
  ucis: string[];
  sans: string[];
  evals: Record<number, EvalRow>;
  myColor: 'white' | 'black';
  prep: PrepView | null;
  amazing: Record<number, number>;    // ply -> pawns' worth sacrificed
  /** ply of your move -> the puzzle made from the position before it (pick: one you made yourself) */
  puzzles: Record<number, { id: string; pick: boolean; type: string | null }>;
  /** ply (moves played before the position) -> your note on it */
  notes: Record<number, string>;
  url: string;
}

const number = (ply: number) => `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '...'}`;

let libraryPositions: Map<string, [number, number]> | null = null;

export function reviewGame(conn: Db, gameId: string): ReviewGame | null {
  const g = conn.get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!g) return null;
  const parsed = readGame(g.pgn);
  const ucis: string[] = [];
  const sans: string[] = [];
  if (parsed) {
    const board = Board.fromFen(parsed.startFen, parsed.chess960);
    for (const m of parsed.mainline) {
      if (!board.isLegal(m)) break;              // a damaged PGN: keep the moves up to there
      sans.push(board.san(m));
      board.push(m);
      ucis.push(m);
    }
  }
  const evals: Record<number, EvalRow> = {};
  for (const r of conn.all('SELECT * FROM move_evaluations WHERE game_id = ?', [gameId])) {
    evals[r.ply] = { ply: r.ply, fen_before: r.fen_before, move_uci: r.move_uci, best_move_uci: r.best_move_uci,
      cp_before: r.cp_before, cp_after: r.cp_after, second_move_uci: r.second_move_uci, cp_second: r.cp_second };
  }
  const myColor = g.my_color as 'white' | 'black';
  const p = myOpenings.prepPath(myOpenings.repertoireFor(conn, myColor), ucis, myColor);
  const prep: PrepView = { inPrep: p.in_prep, reason: p.reason, prepSans: p.prep_sans, prepUcis: p.prep_ucis, departure: p.departure_ply };
  const amazingMoves: Record<number, number> = {};
  for (const ev of Object.values(evals)) {
    const size = amazing.isAmazing(ev.fen_before, ev.move_uci, ev.cp_before, ev.cp_after);
    if (size) amazingMoves[ev.ply] = size;
  }
  const me = db.getSetting(conn, 'chess_com_username') || 'You';
  const [white, black] = myColor === 'white' ? [me, g.opponent_username] : [g.opponent_username, me];
  const noData = Object.keys(evals).length ? '' : ' · no saved analysis yet (re-analyze to see mistakes)';
  const title = `${white} (White) vs ${black} (Black) — ${String(g.played_at).slice(0, 10)} — ${g.result} · ${timeClass(g.time_control)}${noData}`;
  const parts: string[] = [];
  if (g.my_accuracy !== null && g.my_accuracy !== undefined) {
    parts.push(`chess.com: you ${pyFixed(g.my_accuracy, 1)}%${g.opp_accuracy !== null && g.opp_accuracy !== undefined ? `, them ${pyFixed(g.opp_accuracy, 1)}%` : ''}`);
  }
  const ours = amazing.gameAccuracy(Object.values(evals));
  if (ours !== null) parts.push(`Pawn Promoter: you ${pyFixed(ours, 1)}%`);
  return {
    id: g.id, title, accuracy: parts.length ? `Accuracy — ${parts.join(' · ')}` : '', opening: openingText(conn, { id: g.id, pgn: g.pgn }, prep, sans, myColor),
    ucis, sans, evals, myColor, prep, amazing: amazingMoves, puzzles: gamePuzzles(conn, gameId, evals),
    notes: gameNotes.forGame(conn, gameId), url: g.chess_com_url,
  };
}

/** The deepest named line this game reached · where it left your prep (and who left it). */
function openingText(conn: Db, g: { id: string; pgn: string }, p: PrepView, sans: string[], myColor: string): string {
  const row = conn.get('SELECT library_id FROM game_lines WHERE game_id = ?', [g.id]);
  let lid: number | null = row ? row.library_id : null;
  if (!row && openingLibrary.count(conn)) {
    libraryPositions ??= myLines.libraryPositions(conn);
    [lid] = myLines.matchGame(g.pgn, libraryPositions);
  }
  const name = lid !== null ? openingLibrary.get(conn, [lid])[0]?.name ?? '' : '';
  const n = p.inPrep;
  const moveName = (ply: number) => (ply >= 0 && ply < sans.length ? number(ply) + sans[ply] : '?');
  const prep = number(n) + p.prepSans.join('/');
  const where = p.reason === 'you' ? `⚑ You left your prep with ${moveName(n)} (your prep: ${prep})`
    : p.reason === 'opponent' ? `⚑ They left your prep with ${moveName(n)} (your prep expects ${prep})`
      : p.reason === 'ended' ? `Your prep ran out after ${moveName(n - 1)} — both sides stayed in it`
        : p.reason === 'still' ? 'The whole opening stayed inside your prep'
          : `No prep for this opening as ${myColor === 'white' ? 'White' : 'Black'}`;
  return (name ? `${name} · ` : '') + where;
}

/** Which of your moves' positions are puzzles (matched by position). */
function gamePuzzles(conn: Db, gameId: string, evals: Record<number, EvalRow>): ReviewGame['puzzles'] {
  const byFen = new Map(conn.all('SELECT id, fen, puzzle_type FROM puzzles WHERE source_game_id = ?', [gameId])
    .map((r) => [r.fen, r]));
  const out: ReviewGame['puzzles'] = {};
  for (const ev of Object.values(evals)) {
    const p = byFen.get(ev.fen_before);
    if (p) out[ev.ply] = { id: p.id, pick: String(p.id).startsWith(PICK_PREFIX), type: p.puzzle_type };
  }
  return out;
}

/** Make the position before your move at this ply a puzzle (the engine's best move from the
 *  saved analysis is the answer). Kept when puzzles are rebuilt. Returns its id. */
export function makePick(conn: Db, gameId: string, ply: number, tags: string[] = []): { id: string; puzzles: ReviewGame['puzzles'] } {
  const r = conn.get('SELECT * FROM move_evaluations WHERE game_id = ? AND ply = ?', [gameId, ply]);
  if (!r || !r.best_move_uci) throw new Error('This move has no saved analysis.');
  const existing = conn.get('SELECT id FROM puzzles WHERE source_game_id = ? AND fen = ?', [gameId, r.fen_before]);
  let id: string = existing?.id;
  if (!existing) {
    const board = Board.fromFen(r.fen_before);
    const swing = r.cp_after === null ? null : Math.max(0, r.cp_before - r.cp_after);
    const p = makePuzzle({
      fen: r.fen_before, correct_move_san: board.san(r.best_move_uci), correct_move_uci: r.best_move_uci, source: 'own_game_mistake',
      played_move_san: board.san(r.move_uci), eval_swing_cp: swing, eval_before_cp: r.cp_before, eval_after_cp: r.cp_after,
      puzzle_type: SELF_MADE, source_game_id: gameId,
    });
    p.id = PICK_PREFIX + p.id;
    db.insertPuzzle(conn, p);
    id = p.id;
  }
  const puzzle = conn.get('SELECT * FROM puzzles WHERE id = ?', [id]);
  if (puzzle) for (const tag of tags) puzzleTags.add(conn, db.rowToPuzzle(puzzle), tag);
  const evals: Record<number, EvalRow> = {};
  for (const e of conn.all('SELECT * FROM move_evaluations WHERE game_id = ?', [gameId])) evals[e.ply] = e as EvalRow;
  return { id, puzzles: gamePuzzles(conn, gameId, evals) };
}

/** Remove a puzzle you made yourself (not the ones made from your mistakes). */
export function removePick(conn: Db, id: string): void {
  if (!id.startsWith(PICK_PREFIX)) return;
  conn.transaction(() => {
    conn.run('DELETE FROM review_state WHERE puzzle_id = ?', [id]);
    conn.run('DELETE FROM puzzles WHERE id = ?', [id]);
  });
}

/** Tags offered when you make a puzzle: the common ones, then every tag you've used. */
export const PICK_TAGS = ['Opening', 'Middlegame', 'Endgame', 'Attacking', 'Defensive', 'Positional', 'Tactic', 'Sacrifice',
  'Calculation', 'Time trouble', 'Missed win', 'Good move'];

export function pickTagOptions(conn: Db): string[] {
  const have = new Set(PICK_TAGS.map((t) => t.toLowerCase()));
  const yours = [...puzzleTags.allUserTags(conn).keys()].filter((t) => !have.has(t.toLowerCase()))
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return [...PICK_TAGS, ...yours];
}

/** Your note on a position (empty: removed). Returns the game's notes. */
export function saveNote(conn: Db, gameId: string, ply: number, fen: string, text: string): Record<number, string> {
  gameNotes.save(conn, gameId, ply, fen, text);
  return gameNotes.forGame(conn, gameId);
}

export interface NoteView { gameId: string; ply: number; fen: string; text: string; label: string; updated: string }

/** Every note you've written, newest first. */
export function allNotes(conn: Db): NoteView[] {
  const marks: Record<string, string> = { win: 'W', loss: 'L', draw: 'D' };
  /** 'after 12...Nf6': the move that led to the noted position. */
  const after = (gameId: string, ply: number): string => {
    if (!ply) return 'the start';
    const game = readGame(conn.get('SELECT pgn FROM games WHERE id = ?', [gameId])?.pgn ?? '');
    if (!game || ply > game.mainline.length) return `move ${Math.ceil(ply / 2)}`;
    const b = Board.fromFen(game.startFen, game.chess960);
    for (const m of game.mainline.slice(0, ply - 1)) b.push(m);
    return `after ${b.fullmoveNumber}${b.turn === 'white' ? '.' : '...'}${b.san(game.mainline[ply - 1])}`;
  };
  return gameNotes.all(conn).map((n) => ({
    gameId: n.gameId, ply: n.ply, fen: n.fen, text: n.text, updated: n.updatedAt.slice(0, 10),
    label: `${n.playedAt.slice(0, 10)}  ${marks[n.result] ?? '?'}  vs ${n.opponent} · ${after(n.gameId, n.ply)}`,
  }));
}

export interface AmazingView { gameId: string; ply: number; label: string }

/** Every amazing move of yours, for the list (worked out once and saved by amazing.ts). */
export function amazingMoves(conn: Db): AmazingView[] {
  const games = new Map(conn.all('SELECT id, played_at, opponent_username, result FROM games').map((r) => [r.id, r]));
  const marks: Record<string, string> = { win: 'W', loss: 'L', draw: 'D' };
  return amazing.findAll(conn).filter((m) => games.has(m.game_id)).map((m) => {
    const g = games.get(m.game_id)!;
    return { gameId: m.game_id, ply: m.ply,
      label: `${String(g.played_at).slice(0, 10)}  ${marks[g.result] ?? '?'}  ${number(m.ply)}${m.san}!!  offered ${m.offered} · vs ${g.opponent_username}` };
  });
}

export const reviewServices = { reviewGames, reviewGame, amazingMoves, makePick, removePick, pickTagOptions, saveNote, allNotes };
