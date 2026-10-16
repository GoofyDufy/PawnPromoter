/** Your level and XP (level_card.py's numbers), for the sidebar card. */
import * as progression from '../core/progression';
import type { Db } from '../core/sqlite';

export interface LevelView {
  number: number;
  name: string;
  totalXp: number;
  xpIntoLevel: number;
  xpForLevel: number | null;
  progress: number;
}

export function level(conn: Db): LevelView {
  const l = progression.levelFor(progression.totalXp(conn));
  return { number: l.number, name: l.name, totalXp: l.total_xp, xpIntoLevel: l.xp_into_level,
    xpForLevel: l.xp_for_level, progress: l.progress };
}
