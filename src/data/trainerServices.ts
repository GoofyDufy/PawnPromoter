/**
 * Tactics & Threats' database work (spot_tab.py, threat_tab.py, sac_tab.py),
 * in the database worker: positions from your games, what you've seen, the
 * results, and — for Sacrifice!! — your amazing and missed sacrifices and what
 * you actually played after them. Engine work stays on the page.
 */
import * as amazing from '../core/amazing';
import { winChances } from '../core/analyzer';
import { Board, WHITE } from '../core/chess';
import * as db from '../core/db';
import { pySigned } from '../core/format';
import { readGame } from '../core/pgn';
import * as sac from '../core/sac';
import * as spot from '../core/spot';
import type { Db } from '../core/sqlite';
import * as threat from '../core/threat';
import { level, type LevelView } from './level';
import { shortDate } from './dates';

/** "From your game vs X · Oct 05, 2026 · move 24" */
export function gameSource(conn: Db, gameId: string, ply: number): string {
  const g = db.getGame(conn, gameId);
  return g ? `From your game vs ${g.opponent_username} · ${shortDate(g.played_at)} · move ${Math.floor(ply / 2) + 1}` : '';
}

/** The opponent's move into this position (UCI and SAN), and the value of the piece of yours it took. */
export function lastMoveOf(conn: Db, gameId: string, ply: number): { uci: string | null; san: string | null; captured: number } {
  const [uci, captured] = spot.lastMove(conn, { game_id: gameId, ply, fen: '', played_uci: '' });
  let san: string | null = null;
  const row = conn.get('SELECT pgn FROM games WHERE id = ?', [gameId]);
  const game = row ? readGame(row.pgn) : null;
  if (game && uci) {
    const board = Board.fromFen(game.startFen, game.chess960);
    for (const [i, m] of game.mainline.entries()) {
      if (i === ply - 1) {
        san = board.san(m);
        break;
      }
      board.push(m);
    }
  }
  return { uci, san, captured };
}

// ---------- Is there a tactic? ----------

export function spotSeen(conn: Db): string[] {
  return [...spot.seenFens(conn)];
}

export function spotCandidates(conn: Db, quiet: boolean, exclude: string[]): spot.Candidate[] {
  return spot.candidates(conn, quiet, new Set(exclude));
}

export function spotRecord(conn: Db, fen: string, isTactic: boolean, reason: string, saidTactic: boolean, moveOk: boolean): LevelView {
  spot.record(conn, fen, new spot.Verdict(isTactic, reason, '', 0, null), saidTactic, moveOk);
  return level(conn);
}

export function spotSummary(conn: Db): spot.Summary {
  return { ...spot.summary(conn) };
}

// ---------- What's the threat? ----------

export function threatSeen(conn: Db): string[] {
  return [...threat.seenFens(conn)];
}

export function threatCandidates(conn: Db, want: boolean, exclude: string[]): threat.Candidate[] {
  return threat.candidates(conn, want, new Set(exclude));
}

export function threatRecord(conn: Db, fen: string, hadThreat: boolean, found: boolean, moveOk: boolean): LevelView {
  threat.record(conn, fen, hadThreat, found, moveOk);
  return level(conn);
}

export function threatSummary(conn: Db): threat.Summary {
  return { ...threat.summary(conn) };
}

// ---------- Sacrifice!! ----------

export interface SacCandidateView {
  fen: string;
  sacUci: string;
  source: string;            // game / missed / lichess
  gameId: string | null;
  ply: number | null;
  label: string;
  key: string;
}

const view = (c: sac.Candidate, label = c.label): SacCandidateView =>
  ({ fen: c.fen, sacUci: c.sac_uci, source: c.source, gameId: c.game_id, ply: c.ply, label, key: c.key });

/** Your amazing sacrifices, the ones you missed, and Lichess sacrifice puzzles — not done yet first, shuffled. */
export function sacPool(conn: Db): { pool: SacCandidateView[]; own: number; missed: number; lichess: number } {
  let found: amazing.Amazing[] = [];
  let missedFound: amazing.Missed[] = [];
  try {
    found = amazing.findAll(conn);
    missedFound = amazing.findMissed(conn);
  } catch {
    /* no analysis yet */
  }
  const own = sac.ownCandidates(found);
  const missed = sac.missedCandidates(missedFound);
  const theirs = sac.lichessCandidates(conn);
  const names = new Map(conn.all('SELECT id, opponent_username, played_at FROM games').map((r) => [r.id, r]));
  const labelled = [...own, ...missed].map((c) => {
    const g = names.get(c.game_id);
    return view(c, g ? `From your game vs ${g.opponent_username} · ${String(g.played_at).slice(0, 10)}${c.source === 'missed' ? ' · one you missed' : ''}` : c.label);
  });
  const all = [...labelled, ...theirs.map((c) => view(c))];
  const keyed = new Map(all.map((v) => [v.key, v]));
  const picked = sac.pick([...own, ...missed, ...theirs], sac.seen(conn)).map((c) => keyed.get(c.key)!);
  return { pool: picked, own: own.length, missed: missed.length, lichess: theirs.length };
}

export function sacLichess(conn: Db): SacCandidateView[] {
  return sac.lichessCandidates(conn).map((c) => view(c));
}

const toCand = (v: SacCandidateView) => new sac.Candidate(v.fen, v.sacUci, v.source, v.gameId, v.ply, v.label);

export function sacRecord(conn: Db, cand: SacCandidateView, moves: number, misses: number): LevelView {
  sac.record(conn, toCand(cand), moves, misses);
  return level(conn);
}

export function sacSummary(conn: Db): [number, number] {
  return sac.summary(conn);
}

const number = (b: Board) => (b.turn === WHITE ? `${b.fullmoveNumber}.` : `${b.fullmoveNumber}...`);
const signed = (cp: number) => pySigned(cp / 100, 1);

/** What you played in the game from the sacrifice on (sac_tab._game_comparison): your game's moves
 *  and a summary — judged like the round, from the saved analysis, while the position was still sharp. */
export function sacGameComparison(conn: Db, cand: SacCandidateView, line: string[]): { moves: string[]; text: string } {
  if (cand.gameId === null || cand.ply === null) return { moves: [], text: '' };
  const row = conn.get('SELECT pgn, result FROM games WHERE id = ?', [cand.gameId]);
  const game = row ? readGame(row.pgn) : null;
  if (!game) return { moves: [], text: '' };
  const moves = game.mainline.slice(cand.ply, cand.ply + line.length + 2);
  const start = Board.fromFen(cand.fen);
  if (cand.source === 'missed') return { moves, text: missedText(conn, cand, start, moves, row!.result) };
  const evals = new Map(conn.all(`SELECT ply, move_uci, best_move_uci, cp_before, cp_after, cp_second, fen_before FROM move_evaluations
    WHERE game_id = ? AND ply BETWEEN ? AND ?`, [cand.gameId, cand.ply, cand.ply + moves.length]).map((r) => [r.ply, r]));
  const board = start.copy();
  let found = 0;
  let tried = 0;
  let slip = '';
  let stopped = '';
  const played: [Board, string, string][] = [];
  for (const [i, move] of moves.entries()) {
    if (!board.isLegal(move)) break;
    const san = board.san(move);
    let mark = '';
    if (i > 0 && i % 2 === 0 && !stopped) {           // one of your follow-ups, while it still mattered
      const ev = evals.get(cand.ply + i);
      if (ev && ev.cp_after !== null) {
        if (ev.cp_before >= sac.CLEAR_WIN_CP) {
          stopped = ` From move ${board.fullmoveNumber} you were clearly winning (${signed(ev.cp_before)}).`;
        } else if (ev.cp_second !== null && winChances(ev.cp_before) - winChances(ev.cp_second) < sac.CALM_GAP) {
          stopped = ` From move ${board.fullmoveNumber} the position had calmed down.`;
        } else {
          tried += 1;
          const ok = ev.move_uci === ev.best_move_uci || winChances(ev.cp_before) - winChances(ev.cp_after) <= sac.OK_WC;
          found += ok ? 1 : 0;
          mark = ok ? '✓' : '?';
          if (!ok && !slip) {
            const best = Board.fromFen(ev.fen_before).san(ev.best_move_uci);
            slip = ` ${number(board)}${san} let it slip (${signed(ev.cp_before)} → ${signed(ev.cp_after)}; better was ${best}).`;
          }
        }
      }
    } else if (i === 1 && line.length > 1 && move !== line[1]) {
      mark = ` (Stockfish defends ${board.san(line[1])})`;
    }
    played.push([board.copy(), san, mark]);
    board.push(move);
  }
  if (!played.length) return { moves: [], text: '' };
  const parts = played.map(([b, san, mark], j) => {
    const n = b.turn === WHITE ? `${b.fullmoveNumber}.` : j === 0 ? `${b.fullmoveNumber}...` : '';
    return `${n}${san}${mark}`;
  });
  const result = ({ win: 'you won', loss: 'you lost', draw: 'it was drawn' } as Record<string, string>)[row!.result] ?? '';
  const verdict = tried ? `You found ${found} of ${tried} follow-up${tried !== 1 ? 's' : ''}${found === tried ? ' — the right line.' : '.'}`
    : stopped ? 'The sacrifice paid off straight away.' : 'No saved analysis of these moves.';
  return { moves, text: `In your game: ${parts.join(' ')}\n${verdict}${slip}${stopped}${result ? ` In the end ${result}.` : ''}` };
}

/** A sacrifice you missed: what you played instead, what it cost, how the game went on. */
function missedText(conn: Db, cand: SacCandidateView, start: Board, moves: string[], result: string): string {
  const ev = conn.get('SELECT move_uci, cp_before, cp_after FROM move_evaluations WHERE game_id = ? AND ply = ?', [cand.gameId, cand.ply]);
  if (!ev || !moves.length) return '';
  const board = start.copy();
  const played = board.san(ev.move_uci);
  const parts: string[] = [];
  for (const [i, move] of moves.slice(0, 4).entries()) {
    if (!board.isLegal(move)) break;
    const n = board.turn === WHITE ? `${board.fullmoveNumber}.` : i === 0 ? `${board.fullmoveNumber}...` : '';
    parts.push(`${n}${board.san(move)}`);
    board.push(move);
  }
  const outcome = ({ win: 'you won', loss: 'you lost', draw: 'it was drawn' } as Record<string, string>)[result] ?? '';
  return `You missed it in your game: ${number(start)}${played} instead (${signed(ev.cp_before)} → ${signed(ev.cp_after)}); `
    + `then ${parts.slice(1).join(' ')}${outcome ? ` … ${outcome}.` : ' …'}`;
}

export const trainerServices = {
  gameSource, lastMoveOf, spotSeen, spotCandidates, spotRecord, spotSummary, threatSeen, threatCandidates, threatRecord,
  threatSummary, sacPool, sacLichess, sacRecord, sacSummary, sacGameComparison,
};

