/**
 * Book positions and opening names for the weakness stats (SPEC §4) — port of
 * ~/WeaknessStats/weakstats/eco.py and tools/build_eco.py. Built from the
 * opening_library table (Lichess's chess-openings, CC0) every database
 * already has: every position along every named line. Empty library → no
 * book (no book exclusions) and openings from the PGN headers
 * (source "headers_fallback").
 */
import { Board } from '../chess';
import type { Db } from '../sqlite';

/** FEN without the halfmove / fullmove counters. */
export const epd = (fen: string): string => fen.split(' ').slice(0, 4).join(' ');

export interface Opening { eco: string; name: string; source: 'eco_table' | 'headers_fallback' }

interface Row { eco: string; name: string; ply: number; endsHere: boolean; lineLength: number }

export class Book {
  private rows = new Map<string, Row>();
  readonly source: Opening['source'];

  constructor(lines: { eco: string; name: string; ucis: string }[]) {
    for (const line of lines) {
      const moves = line.ucis.split(/\s+/).filter(Boolean);
      const board = Board.fromFen();
      moves.forEach((u, i) => {
        board.push(u);
        const key = epd(board.fen());
        const cand: Row = { eco: line.eco, name: line.name, ply: i + 1, endsHere: i === moves.length - 1, lineLength: moves.length };
        const old = this.rows.get(key);
        // a line ending exactly here names the position; otherwise the
        // shortest (most general) line passing through it does
        if (!old || (cand.endsHere && !old.endsHere) || (cand.endsHere === old.endsHere && cand.lineLength < old.lineLength)) this.rows.set(key, cand);
      });
    }
    this.source = this.rows.size ? 'eco_table' : 'headers_fallback';
  }

  static fromDb(conn: Db): Book {
    let lines: { eco: string; name: string; ucis: string }[] = [];
    try {
      lines = conn.all('SELECT eco, name, ucis FROM opening_library WHERE ucis IS NOT NULL ORDER BY eco, name');
    } catch {
      lines = [];
    }
    return new Book(lines);
  }

  get size(): number {
    return this.rows.size;
  }

  isBook(key: string): boolean {
    return this.rows.has(key);
  }

  /** The row with the greatest line ply matching any game position. */
  opening(keys: Iterable<string>, headerEco = '', headerName = ''): Opening {
    let best: Row | undefined;
    for (const k of keys) {
      const r = this.rows.get(k);
      if (r && (!best || r.ply > best.ply)) best = r;
    }
    if (!best) return { eco: headerEco || '?', name: headerName || 'Unknown', source: 'headers_fallback' };
    return { eco: best.eco, name: best.name, source: this.source };
  }
}

/** "Sicilian Defense: Najdorf Variation" → "Sicilian Defense" (the openings table groups by family). */
export const family = (name: string): string => name.split(':')[0].trim();
