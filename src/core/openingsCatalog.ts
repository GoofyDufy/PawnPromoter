/**
 * Hand-curated openings tagged by character, used to recommend openings that
 * fit your playing style (style.ts) — port of openings_catalog.py. Each has
 * one representative main line that "Drill this" imports.
 *
 * `match` is a lowercase fragment of chess.com's opening name (as produced by
 * stats.openingName) used to find your own record with that opening.
 * The entries themselves are generated from the prototype: data/catalog.ts.
 */
import type { PlayerColor } from './models';
import { Record, splitOpeningKey } from './stats';

export const SHARP = 'Sharp';
export const BALANCED = 'Balanced';
export const POSITIONAL = 'Positional';

export interface CatalogOpening {
  name: string;
  color: PlayerColor;
  character: string;
  match: string;
  moves: string;
  note: string;
}

export { CATALOG } from './data/catalog';

/** style -> character -> fit label (lower rank sorts first) */
const FIT: { [style: string]: { [character: string]: string } } = {
  sharp: { [SHARP]: 'Great fit', [BALANCED]: 'Good fit', [POSITIONAL]: 'Less natural' },
  quiet: { [POSITIONAL]: 'Great fit', [BALANCED]: 'Good fit', [SHARP]: 'Less natural' },
  balanced: { [BALANCED]: 'Great fit', [SHARP]: 'Good fit', [POSITIONAL]: 'Good fit' },
};
export const FIT_RANK: { [label: string]: number } = { 'Great fit': 0, 'Good fit': 1, 'Less natural': 2, '–': 3 };

export function fit(style: string | null, opening: CatalogOpening): string {
  return (style && FIT[style]?.[opening.character]) || '–';
}

/** Merges your records for every chess.com opening family whose name contains
 *  this entry's match fragment (same color). null if you've never played it.
 *  records: stats.openingKey(name, color) -> record (Stats.openings). */
export function yourRecord(opening: CatalogOpening, records: Map<string, Record>): Record | null {
  const merged = new Record();
  for (const [key, rec] of records) {
    const [name, color] = splitOpeningKey(key);
    if (color === opening.color && name.toLowerCase().includes(opening.match)) {
      merged.wins += rec.wins;
      merged.draws += rec.draws;
      merged.losses += rec.losses;
    }
  }
  return merged.games ? merged : null;
}
