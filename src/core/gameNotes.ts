/**
 * Your notes on positions in your games (a web-app addition: Game Review's
 * notes box). One note per game and move; the position is kept too, so a
 * puzzle made from that position can show it.
 */
import { nowIso } from './time';
import type { Db } from './sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS game_notes (
    game_id TEXT NOT NULL,
    ply INTEGER NOT NULL,          -- moves played before the position (0 = the start)
    fen TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (game_id, ply)
);
CREATE INDEX IF NOT EXISTS game_notes_fen ON game_notes (fen);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

/** ply -> note, for one game. */
export function forGame(conn: Db, gameId: string): Record<number, string> {
  return Object.fromEntries(conn.all('SELECT ply, text FROM game_notes WHERE game_id = ?', [gameId]).map((r) => [r.ply, r.text]));
}

/** Saves (or, empty, deletes) the note on this position. */
export function save(conn: Db, gameId: string, ply: number, fen: string, text: string): void {
  if (!text.trim()) conn.run('DELETE FROM game_notes WHERE game_id = ? AND ply = ?', [gameId, ply]);
  else {
    conn.run('INSERT OR REPLACE INTO game_notes (game_id, ply, fen, text, updated_at) VALUES (?, ?, ?, ?, ?)',
      [gameId, ply, fen, text, nowIso()]);
  }
}

/** The note on this position in this game (for a puzzle made from it), or null. */
export function atPosition(conn: Db, gameId: string, fen: string): string | null {
  return conn.get('SELECT text FROM game_notes WHERE game_id = ? AND fen = ?', [gameId, fen])?.text ?? null;
}

export interface NoteRow {
  gameId: string;
  ply: number;
  fen: string;
  text: string;
  updatedAt: string;
  playedAt: string;
  opponent: string;
  result: string;
  myColor: string;
}

/** Every note, newest first, with its game. */
export function all(conn: Db): NoteRow[] {
  return conn.all(`SELECT n.game_id, n.ply, n.fen, n.text, n.updated_at, g.played_at, g.opponent_username, g.result, g.my_color
    FROM game_notes n JOIN games g ON g.id = n.game_id ORDER BY n.updated_at DESC`).map((r) => ({
    gameId: r.game_id, ply: r.ply, fen: r.fen, text: r.text, updatedAt: r.updated_at, playedAt: r.played_at,
    opponent: r.opponent_username, result: r.result, myColor: r.my_color,
  }));
}
