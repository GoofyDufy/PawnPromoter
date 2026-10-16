/**
 * Imports a PGN repertoire into the OpeningLine tree — port of
 * opening_importer.py.
 *
 * Supports branching lines: variations (sidelines in parentheses, as exported
 * by lichess studies / most opening-trainer tools) each become a branch in the
 * tree. Several separate single-line PGNs in one file each become their own
 * root-to-leaf chain.
 */
import { Board } from './chess';
import * as db from './db';
import { makeOpeningLine, type PlayerColor } from './models';
import { type Node, type PgnNodeData, readGames } from './pgn';
import type { Db } from './sqlite';
import { startingPosition } from 'chessops/pgn';
import { makeFen } from 'chessops/fen';

/** python-chess 1.11's GameNode.comment: each {…} with one surrounding space
 *  trimmed, joined with spaces. */
function pythonComment(comments: string[] | undefined): string {
  return (comments ?? []).map((c) => c.replace(/^\s/, '').replace(/\s$/, '')).join(' ');
}

function walk(node: Node<PgnNodeData>, board: Board, parentId: string | null, repertoireName: string,
  myColor: PlayerColor, lineName: string, conn: Db): void {
  for (const variation of node.children) {
    const uci = board.parseSan(variation.data.san);
    if (!uci) continue;                           // python-chess drops the rest of a line at an illegal move
    const comment = pythonComment(variation.data.comments).trim() || null;   // PGN {…} after the move = its explanation

    // re-importing a line that's already there (same line, same moves)
    // updates its notes instead of creating a duplicate tree
    const existing = db.findLineNode(conn, repertoireName, myColor, lineName, parentId, uci);
    const after = board.copy();
    after.push(uci);
    if (existing) {
      if (comment && comment !== existing.notes) db.setLineNotes(conn, existing.id, comment);
      walk(variation, after, existing.id, repertoireName, myColor, lineName, conn);
      continue;
    }

    const moveNumber = board.fullmoveNumber * 2 - (board.turn === 'white' ? 2 : 1);
    const line = makeOpeningLine({
      move_san: board.san(uci),
      move_uci: uci,
      fen_after_move: after.fen(),
      repertoire_name: repertoireName,
      my_color: myColor,
      move_number: moveNumber,
      parent_id: parentId,
      // python-chess never adds an illegal move to the tree, so only legal continuations count
      is_line_end: !variation.children.some((child) => after.parseSan(child.data.san) !== undefined),
      line_name: lineName,
      fen_before_move: board.fen(),
      notes: comment,
    });
    db.saveOpeningLine(conn, line);

    // recurse into this variation's own continuations/sidelines
    walk(variation, after, line.id, repertoireName, myColor, lineName, conn);
  }
}

const countLines = (conn: Db, name: string, color: string) =>
  conn.get('SELECT COUNT(*) AS n FROM opening_lines WHERE repertoire_name = ? AND my_color = ?', [name, color])!.n as number;

/** Parses every game in pgnText and inserts them as trees. Returns the number
 *  of NEW positions imported (lines already present only get their move
 *  comments refreshed, so re-importing an annotated file is safe and returns
 *  0). Each game's [Event] header (if present) is stored as that line's
 *  display name, falling back to the repertoire name. */
export function importPgnText(pgnText: string, repertoireName: string, myColor: PlayerColor, conn: Db): number {
  const before = countLines(conn, repertoireName, myColor);
  conn.transaction(() => {
    for (const game of readGames(pgnText)) {
      let lineName = game.headers.get('Event') ?? repertoireName;
      if (lineName === '?') lineName = repertoireName;   // the default when no header is set
      const start = startingPosition(game.headers);
      if (start.isErr) continue;
      walk(game.moves, Board.fromFen(makeFen(start.value.toSetup())), null, repertoireName, myColor, lineName, conn);
    }
  });
  return countLines(conn, repertoireName, myColor) - before;
}
