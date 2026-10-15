/**
 * PGN reading, the parts of python-chess's chess.pgn the core modules use:
 * read_game() → headers, the starting position and the mainline moves.
 * Variations and comments are parsed too (opening_importer needs them).
 */
import { type Game, type Node, type PgnNodeData, parsePgn, startingPosition } from 'chessops/pgn';
import { makeFen } from 'chessops/fen';
import { Board } from './chess';

export type { Game, Node, PgnNodeData };

export interface ParsedGame {
  headers: Map<string, string>;
  /** FEN of the position the game starts from (STARTING_FEN unless [FEN] is set). */
  startFen: string;
  /** Mainline moves as standard UCI (python-chess's mainline_moves()). */
  mainline: string[];
  /** [Variant "Chess960"]: python-chess reads these games with chess960=True. */
  chess960: boolean;
  raw: Game<PgnNodeData>;
}

/** Every game in a PGN text (chessops never returns null; empty text gives []). */
export function readGames(text: string): Game<PgnNodeData>[] {
  return parsePgn(text);
}

/** python-chess read_game(): the first game, or null when there is none. */
export function readGame(text: string): ParsedGame | null {
  const games = parsePgn(text);
  const game = games[0];
  if (!game) return null;
  const start = startingPosition(game.headers);
  if (start.isErr) return null;
  const startFen = makeFen(start.value.toSetup());
  const chess960 = /960|fischerandom/i.test(game.headers.get('Variant') ?? '');
  const board = Board.fromFen(startFen, chess960);
  const mainline: string[] = [];
  for (const data of game.moves.mainline()) {
    const uci = board.parseSan(data.san);
    if (!uci) break;                 // python-chess also stops at the first illegal move
    board.push(uci);
    mainline.push(uci);
  }
  return { headers: game.headers, startFen, mainline, chess960, raw: game };
}

/** chess.pgn.read_headers(): the tag pairs at the top of the first game,
 *  without parsing the moves (stats read thousands of games). */
export function readHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (headers.size) break;
      continue;
    }
    const m = /^\[([A-Za-z0-9_+#=:-]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(trimmed);
    if (!m) break;
    headers.set(m[1], m[2].replace(/\\(["\\])/g, '$1'));
  }
  return headers;
}

/** game.board(): a Board at the game's starting position. */
export function gameBoard(game: ParsedGame): Board {
  return Board.fromFen(game.startFen, game.chess960);
}
