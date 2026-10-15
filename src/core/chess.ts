/**
 * A python-chess-shaped Board on top of chessops, so the core modules port
 * line-for-line from the Python prototype (~/Chess) and stay easy to diff.
 *
 * Two things deliberately match python-chess exactly, because their output is
 * stored in (and compared against) databases imported from the desktop app:
 *  - moves are standard UCI, castling as the king's two-square step (e1g1),
 *    never chessops' internal king-takes-rook (e1h1) — except in Chess960,
 *    where python-chess writes castling as king-takes-rook too;
 *  - fen() only writes an en passant square when an en passant capture is
 *    actually legal (python-chess's default en_passant="legal").
 */
import { attacks as pieceAttacks } from 'chessops/attacks';
import { Chess, castlingSide, normalizeMove } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import { SquareSet } from 'chessops/squareSet';
import type { Color, Move, NormalMove, Piece, Role, Square } from 'chessops/types';
import { makeSquare, makeUci, opposite, parseSquare, parseUci, squareFile, squareRank } from 'chessops/util';

export type { Color, Piece, Role, Square };
export { makeSquare as squareName, opposite, parseSquare, squareFile, squareRank };

export const WHITE: Color = 'white';
export const BLACK: Color = 'black';
export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const SQUARES: Square[] = Array.from({ length: 64 }, (_, i) => i);
export const ROLES: Role[] = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

/** python-chess's chess.square_distance (king steps between two squares). */
export function squareDistance(a: Square, b: Square): number {
  return Math.max(Math.abs(squareFile(a) - squareFile(b)), Math.abs(squareRank(a) - squareRank(b)));
}

function toSquares(set: SquareSet): Square[] {
  return [...set];
}

export class Board {
  private pos: Chess;
  private stack: { pos: Chess; uci: string }[] = [];
  /** chess.Board(fen, chess960=True): castling written as king-takes-rook. */
  readonly chess960: boolean;

  private constructor(pos: Chess, chess960: boolean) {
    this.pos = pos;
    this.chess960 = chess960;
  }

  /** Like chess.Board(fen); throws on an invalid FEN. */
  static fromFen(fen: string = STARTING_FEN, chess960 = false): Board {
    const setup = parseFen(fen).unwrap();
    return new Board(Chess.fromSetup(setup).unwrap(), chess960);
  }

  /** copy(stack=False): same position, no move history. */
  copy(): Board {
    return new Board(this.pos.clone(), this.chess960);
  }

  get turn(): Color {
    return this.pos.turn;
  }

  set turn(color: Color) {
    // python-chess lets you flip the side to move (explain._mobility does)
    this.pos.turn = color;
  }

  get fullmoveNumber(): number {
    return this.pos.fullmoves;
  }

  /** UCI strings of every move pushed since this Board was made (move_stack). */
  get moveStack(): string[] {
    return this.stack.map((s) => s.uci);
  }

  fen(): string {
    return makeFen(this.pos.toSetup());
  }

  boardFen(): string {
    return this.fen().split(' ')[0];
  }

  // ---------- moves ----------

  /** Parse UCI into chessops' internal form (castling as king-takes-rook). */
  private internal(uci: string): NormalMove {
    const move = parseUci(uci);
    if (!move || !('from' in move)) throw new Error(`bad UCI move: ${uci}`);
    return normalizeMove(this.pos, move) as NormalMove;
  }

  /** chessops move -> standard UCI (castling as the king's two-square step). */
  private standard(move: Move): string {
    const m = move as NormalMove;
    const side = this.chess960 ? undefined : castlingSide(this.pos, m);
    if (side && this.pos.board.getRole(m.from) === 'king') {
      const to = (side === 'a' ? 2 : 6) + 8 * squareRank(m.from);
      return makeSquare(m.from) + makeSquare(to);
    }
    return makeUci(m);
  }

  legalMoves(): string[] {
    const out = new Set<string>();
    for (const [from, dests] of this.pos.allDests()) {
      for (const to of dests) {
        const role = this.pos.board.getRole(from);
        const lastRank = (this.pos.turn === 'white' ? 7 : 0);
        if (role === 'pawn' && squareRank(to) === lastRank) {
          for (const promotion of ['q', 'r', 'b', 'n']) out.add(makeSquare(from) + makeSquare(to) + promotion);
        } else {
          out.add(this.standard({ from, to }));
        }
      }
    }
    return [...out];
  }

  isLegal(uci: string): boolean {
    const move = parseUci(uci);
    if (!move || !('from' in move)) return false;
    return this.pos.isLegal(normalizeMove(this.pos, move));
  }

  push(uci: string): void {
    const move = this.internal(uci);
    this.stack.push({ pos: this.pos.clone(), uci });
    this.pos.play(move);
  }

  /** push_san; returns the move's UCI. */
  pushSan(san: string): string {
    const move = parseSan(this.pos, san);
    if (!move) throw new Error(`illegal SAN ${san} in ${this.fen()}`);
    const uci = this.standard(move);
    this.push(uci);
    return uci;
  }

  /** Board.push(chess.Move.null()): pass the turn. */
  pushNull(): void {
    this.stack.push({ pos: this.pos.clone(), uci: '0000' });
    this.pos.turn = opposite(this.pos.turn);
    this.pos.epSquare = undefined;
  }

  pop(): string {
    const last = this.stack.pop();
    if (!last) throw new Error('pop from empty move stack');
    this.pos = last.pos;
    return last.uci;
  }

  san(uci: string): string {
    return makeSan(this.pos, this.internal(uci));
  }

  /** parse_san, returning standard UCI (or undefined if illegal). */
  parseSan(san: string): string | undefined {
    const move = parseSan(this.pos, san);
    return move ? this.standard(move) : undefined;
  }

  // ---------- move properties ----------

  isEnPassant(uci: string): boolean {
    const m = this.internal(uci);
    return this.pos.board.getRole(m.from) === 'pawn' && m.to === this.pos.epSquare
      && squareFile(m.from) !== squareFile(m.to) && !this.pos.board.has(m.to);
  }

  isCapture(uci: string): boolean {
    const m = this.internal(uci);
    if (this.isCastling(uci)) return false;
    return this.pos.board[opposite(this.pos.turn)].has(m.to) || this.isEnPassant(uci);
  }

  isCastling(uci: string): boolean {
    const m = this.internal(uci);
    return this.pos.board.getRole(m.from) === 'king' && castlingSide(this.pos, m) !== undefined;
  }

  givesCheck(uci: string): boolean {
    const after = this.copy();
    after.push(uci);
    return after.isCheck();
  }

  // ---------- board queries ----------

  pieceAt(square: Square): Piece | undefined {
    return this.pos.board.get(square);
  }

  /** Square -> piece, in python-chess's order (h8 down to a1): explanations
   *  name the first piece that qualifies, so the order is visible in text. */
  pieceMap(): Map<Square, Piece> {
    return new Map([...this.pos.board].reverse());
  }

  /** Squares of `color`'s pieces of one type (board.pieces). */
  pieces(role: Role, color: Color): Square[] {
    return toSquares(this.pos.board.pieces(color, role));
  }

  king(color: Color): Square | undefined {
    return this.pos.board.kingOf(color);
  }

  /** Squares of `color`'s pieces attacking `square` (pins ignored, like python-chess). */
  attackers(color: Color, square: Square): Square[] {
    return toSquares(this.pos.kingAttackers(square, color, this.pos.board.occupied));
  }

  isAttackedBy(color: Color, square: Square): boolean {
    return this.pos.kingAttackers(square, color, this.pos.board.occupied).nonEmpty();
  }

  /** Squares the piece on `square` attacks (empty if no piece). */
  attacks(square: Square): Square[] {
    const piece = this.pos.board.get(square);
    return piece ? toSquares(pieceAttacks(piece, square, this.pos.board.occupied)) : [];
  }

  /** Pseudo-legal moves of the piece on `square` for a bishop, rook or queen
   *  (python-chess counts these for scope; side to move is not checked). */
  sliderMobility(square: Square): number {
    const piece = this.pos.board.get(square);
    if (!piece) return 0;
    return pieceAttacks(piece, square, this.pos.board.occupied).diff(this.pos.board[piece.color]).size();
  }

  isCheck(): boolean {
    return this.pos.isCheck();
  }

  isCheckmate(): boolean {
    return this.pos.isCheckmate();
  }

  isStalemate(): boolean {
    return this.pos.isStalemate();
  }

  isInsufficientMaterial(): boolean {
    return this.pos.isInsufficientMaterial();
  }

  /** is_game_over() without claims: mate, stalemate, insufficient material,
   *  and python-chess's automatic 75-move rule (fivefold repetition needs a
   *  game history and isn't tracked here). */
  isGameOver(): boolean {
    return this.pos.isEnd() || this.pos.halfmoves >= 150;
  }
}

/** Legal-move check that never throws on malformed UCI ("move in board.legal_moves"). */
export function isLegalUci(board: Board, uci: string | null | undefined): uci is string {
  return !!uci && board.isLegal(uci);
}
