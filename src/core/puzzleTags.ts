/**
 * Tags on a puzzle — port of puzzle_tags.py: the ones it gets automatically
 * (its kind, type, length, sharp / quiet, Lichess's themes) and the ones you
 * add yourself.
 *
 * Your tags are saved by position + best move for your games' puzzles (their
 * ids change whenever puzzles are rebuilt at a new blunder size) and by id for
 * Lichess puzzles, so they're never lost. Names follow Lichess's theme names
 * (lichess.org/training/themes) wherever there is one.
 */
import type { Puzzle } from './models';
import type { Db } from './sqlite';
import { nowIso } from './time';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_tags (
    puzzle_key TEXT,              -- see key()
    tag TEXT,
    added_at TEXT,
    PRIMARY KEY (puzzle_key, tag)
);
`;

/** offered under "+ Tag" (anything else can be typed in) */
export const SUGGESTED = [
  'Attacking', 'Defensive', 'Counterattack', 'Positional',
  'Fork', 'Pin', 'Skewer', 'Discovered attack', 'Double check', 'Hanging piece', 'Trapped piece',
  'Sacrifice', 'Deflection', 'Attraction', 'Interference', 'Clearance', 'Intermezzo', 'X-ray attack',
  'Quiet move', 'Defensive move', 'Zugzwang', 'Promotion', 'Exposed king', 'Back rank mate', 'Mate',
  'Endgame',
];

/** Lichess theme ids that don't read well split at capitals */
const THEME_NAMES: Record<string, string> = {
  mateIn1: 'Mate in 1', mateIn2: 'Mate in 2', mateIn3: 'Mate in 3', mateIn4: 'Mate in 4',
  mateIn5: 'Mate in 5+', xRayAttack: 'X-ray attack', attackingF2F7: 'Attacking f2/f7',
  oneMove: 'One move', short: '2 moves', long: '3 moves', veryLong: '4+ moves',
  master: 'Master game', masterVsMaster: 'Master vs master', superGM: 'Super GM game',
  enPassant: 'En passant',
};
/** shown after the motifs: what it wins, the game phase, length, whose game */
const LATE_THEMES = new Set(['crushing', 'advantage', 'equality', 'opening', 'middlegame', 'endgame', 'oneMove',
  'short', 'long', 'veryLong', 'master', 'masterVsMaster', 'superGM', 'mate']);

/** Lichess theme ids a download can ask for (lichess.org/training/themes) */
export const LICHESS_THEMES = [
  'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'hangingPiece', 'trappedPiece', 'sacrifice',
  'deflection', 'attraction', 'interference', 'clearance', 'intermezzo', 'xRayAttack', 'quietMove',
  'defensiveMove', 'zugzwang', 'promotion', 'advancedPawn', 'exposedKing', 'kingsideAttack',
  'queensideAttack', 'backRankMate', 'smotheredMate', 'mate', 'mateIn1', 'mateIn2', 'mateIn3', 'mateIn4',
  'endgame', 'rookEndgame', 'pawnEndgame', 'bishopEndgame', 'knightEndgame', 'queenEndgame',
  'capturingDefender', 'attackingF2F7', 'opening', 'middlegame',
];
/** our kinds that match a Lichess theme */
const KIND_THEMES: Record<string, string> = { Defensive: 'defensiveMove', Positional: 'quietMove' };

/** The Lichess theme id for a tag ('Hanging piece' -> 'hangingPiece'), or ''. */
export function lichessTheme(tag: string): string {
  if (tag in KIND_THEMES) return KIND_THEMES[tag];
  return LICHESS_THEMES.find((theme) => themeName(theme).toLowerCase() === tag.toLowerCase()) ?? '';
}

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

export function key(p: Puzzle): string {
  if (p.source === 'lichess') return `lichess:${p.id}`;
  return `${p.fen}|${p.correct_move_uci}`;
}

/** Lichess theme id -> name, e.g. 'hangingPiece' -> 'Hanging piece'. */
export function themeName(theme: string): string {
  if (theme in THEME_NAMES) return THEME_NAMES[theme];
  const words = [...theme].map((c) => (c >= 'A' && c <= 'Z' ? ` ${c.toLowerCase()}` : c)).join('');
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}

/** The puzzle's own tags, most telling first, no repeats. */
export function autoTags(p: Puzzle, sharp: boolean, endgame: boolean): string[] {
  const tags: string[] = [];
  if (p.kind) tags.push(p.kind);
  if (p.source === 'lichess') {
    const themes = (p.themes || '').split(/\s+/).filter(Boolean);
    // sorted(key=t in LATE_THEMES): motifs first, stable otherwise
    tags.push(...[...themes].sort((a, b) => Number(LATE_THEMES.has(a)) - Number(LATE_THEMES.has(b))).map(themeName));
  } else {
    if (p.puzzle_type) tags.push(p.puzzle_type);
    const moves = p.solution_moves || 1;
    tags.push(moves === 1 ? 'One move' : `${moves} moves`);
    tags.push(sharp ? 'Sharp' : 'Quiet');
    if (endgame) tags.push('Endgame');
  }
  const seen = new Set<string>();
  return tags.filter((t) => {
    const lower = t.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

// ---------- your tags ----------

export function userTags(conn: Db, p: Puzzle): string[] {
  return conn.all('SELECT tag FROM user_tags WHERE puzzle_key = ? ORDER BY added_at', [key(p)]).map((r) => r.tag);
}

export function add(conn: Db, p: Puzzle, rawTag: string): void {
  const tag = Array.from(rawTag.split(/\s+/).filter(Boolean).join(' ')).slice(0, 40).join('');   // 40 characters, like Python
  if (tag) {
    conn.run('INSERT OR IGNORE INTO user_tags (puzzle_key, tag, added_at) VALUES (?, ?, ?)', [key(p), tag, nowIso()]);
  }
}

export function remove(conn: Db, p: Puzzle, tag: string): void {
  conn.run('DELETE FROM user_tags WHERE puzzle_key = ? AND tag = ?', [key(p), tag]);
}

/** tag -> puzzle keys carrying it (for the queue's tag filter). */
export function allUserTags(conn: Db): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of conn.all('SELECT puzzle_key, tag FROM user_tags')) {
    if (!out.has(r.tag)) out.set(r.tag, new Set());
    out.get(r.tag)!.add(r.puzzle_key);
  }
  return out;
}
