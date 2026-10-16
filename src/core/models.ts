/**
 * Core data models — port of models.py. Field names stay snake_case so rows,
 * the SQL and the Python prototype all line up one-to-one.
 */
import { addDays, isoformat, nowIso } from './time';

export type PlayerColor = 'white' | 'black';
export type GameResult = 'win' | 'loss' | 'draw';
export type PuzzleSource = 'own_game_mistake' | 'opening_prep' | 'lichess';   // lichess: lichessPuzzles.ts

export function newId(): string {
  return crypto.randomUUID();
}

/** chess.com's buckets from a time-control string like '180+2' or '1/86400'. */
export function timeClass(timeControl: string | null | undefined): string {
  if (!timeControl || timeControl.includes('/')) return 'Daily';
  const [base, inc = ''] = timeControl.split(/\+(.*)/s);
  if (!/^\s*[-+]?\d+\s*$/.test(base) || (inc !== '' && !/^\s*[-+]?\d+\s*$/.test(inc))) return 'Other';
  const estimate = parseInt(base, 10) + 40 * parseInt(inc || '0', 10);
  if (estimate < 180) return 'Bullet';
  if (estimate < 600) return 'Blitz';
  return 'Rapid';
}

/** dropdown label -> time classes included (null = every game); shared by
 *  the Stats tab and Puzzle Review's focus filter */
export const TIME_FILTERS: Record<string, Set<string> | null> = {
  'All games': null,
  'All except Bullet': new Set(['Blitz', 'Rapid', 'Daily', 'Other']),
  Rapid: new Set(['Rapid']),
  Blitz: new Set(['Blitz']),
  Bullet: new Set(['Bullet']),
  Daily: new Set(['Daily']),
};

export function inTimeFilter(timeControl: string | null | undefined, timeClasses: Set<string> | null | undefined): boolean {
  return !timeClasses || timeClasses.has(timeClass(timeControl));
}

/** Dates are kept as Python-style ISO strings (see time.ts), exactly as stored. */
export interface Game {
  id: string;
  chess_com_url: string;
  pgn: string;
  played_at: string;
  time_control: string;
  my_color: PlayerColor;
  opponent_username: string;
  result: GameResult;
  is_analyzed: boolean;
  analyzed_at: string | null;
  // chess.com's accuracy (%), for games reviewed there (null otherwise)
  my_accuracy: number | null;
  opp_accuracy: number | null;
}

export function makeGame(
  g: Omit<Game, 'id' | 'is_analyzed' | 'analyzed_at' | 'my_accuracy' | 'opp_accuracy'> & Partial<Game>,
): Game {
  return { id: newId(), is_analyzed: false, analyzed_at: null, my_accuracy: null, opp_accuracy: null, ...g };
}

export interface Puzzle {
  id: string;
  fen: string;                          // position BEFORE the move to be tested
  correct_move_san: string;
  correct_move_uci: string;
  source: PuzzleSource;
  played_move_san: string | null;       // set if source == own_game_mistake
  eval_swing_cp: number | null;         // magnitude of the mistake
  eval_before_cp: number | null;        // eval if the best move is played
  eval_after_cp: number | null;         // eval after the played (mistake) move
  puzzle_type: string | null;           // heuristic tag, e.g. "Left Hanging"
  source_game_id: string | null;
  opening_line_id: string | null;
  created_at: string;
  // from puzzleKind.ts (null until classified): the solution to play, how many
  // of your moves it is, and Attacking / Defensive / Positional
  solution_ucis: string | null;
  solution_moves: number | null;
  kind: string | null;
  // Lichess puzzles only: their rating, themes, game, opening, and the
  // opponent's move that sets the puzzle up (shown on the board first)
  rating: number | null;
  themes: string | null;
  game_url: string | null;
  opening: string | null;
  setup_fen: string | null;
  setup_uci: string | null;
}

export function makePuzzle(
  p: Pick<Puzzle, 'fen' | 'correct_move_san' | 'correct_move_uci' | 'source'> & Partial<Puzzle>,
): Puzzle {
  return {
    id: newId(), played_move_san: null, eval_swing_cp: null, eval_before_cp: null, eval_after_cp: null,
    puzzle_type: null, source_game_id: null, opening_line_id: null, created_at: nowIso(),
    solution_ucis: null, solution_moves: null, kind: null,
    rating: null, themes: null, game_url: null, opening: null, setup_fen: null, setup_uci: null, ...p,
  };
}

/** Raw Stockfish output for one of YOUR moves in a game, cached permanently
 *  so a game never has to go through the engine twice. No blunder threshold
 *  is applied here — puzzles are derived from these later. */
export interface MoveEvaluation {
  game_id: string;
  ply: number;                          // 0-based half-move index within the game
  fen_before: string;                   // position you moved from
  move_uci: string;                     // what you played
  best_move_uci: string | null;         // engine's top choice (null if it gave no PV)
  cp_before: number;                    // eval before your move, from your POV
  cp_after: number | null;              // eval after your move; null when already decisive
  depth: number;
  // engine's 2nd/3rd choices (MultiPV) from the same position, your POV.
  second_move_uci: string | null;
  cp_second: number | null;
  third_move_uci: string | null;
  cp_third: number | null;
}

/** One ply in a repertoire tree. Root nodes have parent_id = null. */
export interface OpeningLine {
  id: string;
  move_san: string;
  move_uci: string;
  fen_after_move: string;
  repertoire_name: string;
  my_color: PlayerColor;
  move_number: number;
  parent_id: string | null;
  is_line_end: boolean;
  line_name: string | null;             // e.g. "Orthodox Defense" — from the PGN's [Event] tag
  is_enabled: boolean;                  // toggled off to exclude from drilling without deleting
  fen_before_move: string | null;       // position this move was played from (matches across imports)
  notes: string | null;
}

export function makeOpeningLine(
  l: Pick<OpeningLine, 'move_san' | 'move_uci' | 'fen_after_move' | 'repertoire_name' | 'my_color' | 'move_number'>
    & Partial<OpeningLine>,
): OpeningLine {
  return {
    id: newId(), parent_id: null, is_line_end: false, line_name: null, is_enabled: true,
    fen_before_move: null, notes: null, ...l,
  };
}

/** SM-2 style spaced repetition state, one per puzzle. */
export class ReviewState {
  ease_factor = 2.5;
  interval_days = 0;
  repetitions = 0;
  due_date: string = nowIso();
  last_reviewed_at: string | null = null;
  consecutive_correct = 0;
  consecutive_wrong = 0;

  constructor(public puzzle_id: string, init: Partial<Omit<ReviewState, 'record_attempt'>> = {}) {
    Object.assign(this, init);
  }

  /** quality: 0-5 (SM-2 scale). 5 = instant correct, 3 = correct but
   *  hesitant, 0 = wrong. */
  record_attempt(quality: number, now: Date = new Date()): void {
    this.last_reviewed_at = isoformat(now);

    if (quality >= 3) {
      this.consecutive_correct += 1;
      this.consecutive_wrong = 0;
      if (this.repetitions === 0) this.interval_days = 1;
      else if (this.repetitions === 1) this.interval_days = 6;
      else this.interval_days = pyRound(this.interval_days * this.ease_factor);
      this.repetitions += 1;
    } else {
      this.consecutive_wrong += 1;
      this.consecutive_correct = 0;
      this.repetitions = 0;
      this.interval_days = 1;
    }

    const q = quality;
    this.ease_factor = Math.max(1.3, this.ease_factor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    this.due_date = isoformat(addDays(now, this.interval_days));
  }
}

/** Python's round(): halves go to the even neighbour (round(2.5) == 2). */
export function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
