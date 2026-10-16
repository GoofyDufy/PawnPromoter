/**
 * Thematic explainers for opening families, shown in the Opening Drill tab's
 * Plans view — port of opening_notes.py: the core idea, each side's plans, the
 * pawn structure, and what to watch out for. The text itself is generated from
 * the prototype (data/openingNotes.ts).
 *
 * notesFor(name) matches a line or repertoire name (e.g. "Queens Gambit -
 * Semi-Slav Defense", "Catalan - Closed") against MATCHERS in order, so more
 * specific families come first.
 */
import { MATCHERS, NOTES } from './data/openingNotes';

export interface OpeningNotes {
  title: string;
  idea: string;
  white: string[];
  black: string[];
  structure: string;
  watch_out: string[];
}

export { MATCHERS, NOTES };

function normalize(name: string): string {
  const n = name.toLowerCase().replaceAll("'", '').replaceAll('’', '').replaceAll('ü', 'u');
  return n.replace(/[^a-z0-9]+/g, ' ').trim();
}

/** First match across the given names (e.g. line name, then repertoire name). */
export function notesFor(...names: (string | null | undefined)[]): OpeningNotes | null {
  for (const name of names) {
    if (!name) continue;
    const text = normalize(name);
    for (const [keywords, key] of MATCHERS) {
      if (keywords.every((k) => text.includes(k))) return NOTES[key];
    }
  }
  return null;
}
