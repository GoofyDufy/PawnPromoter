/**
 * What works in practice at a position, against players around your level —
 * port of practical.py (Opening Drill → My games, under a deviation's "why").
 *
 * For each move worth considering — the ones Lichess players at your rating
 * play most, plus your prep move and your own — three things:
 *  - is it sound? Stockfish's evaluation after it (your point of view);
 *  - how often players at your level choose it, and how they score with it;
 *  - does it get you somewhere? What your opponents at your level usually reply
 *    (their share), and how often those replies leave you +0.5 or better by
 *    Stockfish ("advantage rate").
 * Moves are ranked by advantage rate, then the average evaluation after their
 * usual replies, then score; unsound ones go last.
 *
 * Explorer data comes from the cache or is downloaded first by the caller
 * (explorer.fetchStats, never from here). Results are saved in practical_moves.
 */
import { MATE_CP, scoreToCp } from './analyzer';
import type { Board } from './chess';
import type { Engine } from './engine';
import type { PositionStats } from './explorer';
import { pyFixed, pyPercent, pySigned } from './format';
import type { Db } from './sqlite';
import { nowIso } from './time';

export const ADVANTAGE_CP = 50;        // "an advantage": half a pawn or more
export const UNSOUND_CP = -30;         // worse than this after the move: not recommended
export const MIN_GAMES = 30;           // a popular move needs this many games at your level
export const MAX_POPULAR = 5;          // popular moves considered (plus your prep and your move)
export const REPLY_SHARE = 0.05;       // opponent replies under this share are ignored
export const MAX_REPLIES = 6;
export const DEPTH = 16;               // replies within a few tenths: depth 14 swings too much
export const VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS practical_moves (
    key TEXT PRIMARY KEY,          -- rating bands | position | your move
    version INTEGER,
    data TEXT,                     -- [Choice] as JSON
    created_at TEXT
);
`;

export function ensureSchema(conn: Db): void {
  conn.exec(SCHEMA);
}

/** Field order matches the Python dataclasses: saved as JSON in practical_moves. */
export interface Reply {
  san: string;
  share: number;             // of their games at your level after your move
  cp: number;                // Stockfish after it, your point of view
}

export interface Choice {
  uci: string;
  san: string;
  eval_cp: number;                   // after your move (their best reply), your point of view
  share: number | null;              // how often players at your level choose it (null: no data)
  games: number;
  score: number | null;              // how they score with it (your colour)
  advantage_rate: number | null;     // share of their usual replies leaving you +0.5 or better
  avg_cp: number | null;             // average evaluation after their usual replies
  replies: Reply[];
  tags: string[];                    // "your prep", "you played", "Stockfish's best of these"
}

export const sound = (c: Choice) => c.eval_cp >= UNSOUND_CP;

/** ucis to look at: the popular moves at your level, your prep, your move. */
export function candidates(board: Board, stats: PositionStats | null, prep: string[], mine: string): string[] {
  const out: string[] = [];
  if (stats) {
    for (const m of [...stats.moves].sort((a, b) => b.games - a.games)) {
      if (m.games >= MIN_GAMES && out.length < MAX_POPULAR) out.push(m.uci);
    }
  }
  for (const uci of [...prep, mine]) if (!out.includes(uci)) out.push(uci);
  return out.filter((u) => board.isLegal(u));
}

/** Engine work. afterStats: uci -> explorer stats after that move. */
export async function evaluate(engine: Engine, board: Board, ucis: string[], stats: PositionStats | null,
  afterStats: Map<string, PositionStats | null>, prep: string[], mine: string): Promise<Choice[]> {
  const me = board.turn;
  const byUci = new Map(stats ? stats.moves.map((m) => [m.uci, m]) : []);
  const total = stats ? stats.games : 0;
  const choices: Choice[] = [];
  for (const uci of ucis) {
    const after = board.copy();
    after.push(uci);
    if (after.isGameOver()) continue;
    const [best] = await engine.analyse(after, { depth: DEPTH });
    const evalCp = scoreToCp(best.score, me);
    const m = byUci.get(uci);
    const aStats = afterStats.get(uci);
    const replies: Reply[] = [];
    if (aStats && aStats.games) {
      const usual = [...aStats.moves].sort((a, b) => b.games - a.games)
        .filter((r) => r.games / aStats.games >= REPLY_SHARE).slice(0, MAX_REPLIES);
      const roots = usual.map((r) => r.uci).filter((u) => after.isLegal(u));
      if (roots.length) {
        const infos = await engine.analyse(after, { depth: DEPTH }, roots.length, roots);
        const cpOf = new Map(infos.filter((i) => i.pv.length).map((i) => [i.pv[0], scoreToCp(i.score, me)]));
        for (const r of usual) {
          if (cpOf.has(r.uci)) replies.push({ san: after.san(r.uci), share: r.games / aStats.games, cp: cpOf.get(r.uci)! });
        }
      }
    }
    const weight = replies.reduce((s, r) => s + r.share, 0);
    const adv = weight ? replies.filter((r) => r.cp >= ADVANTAGE_CP).reduce((s, r) => s + r.share, 0) / weight : null;
    const cap = Math.floor(MATE_CP / 10);
    const avg = weight ? Math.trunc(replies.reduce((s, r) => s + r.share * Math.max(-cap, Math.min(cap, r.cp)), 0) / weight) : null;
    const tags = [...(prep.includes(uci) ? ['your prep'] : []), ...(uci === mine ? ['you played'] : [])];
    choices.push({ uci, san: board.san(uci), eval_cp: evalCp, share: m && total ? m.games / total : null,
      games: m ? m.games : 0, score: m ? m.scoreFor(me) : null, advantage_rate: adv, avg_cp: avg, replies, tags });
  }
  if (choices.length) {
    let top = choices[0];
    for (const c of choices) if (c.eval_cp > top.eval_cp) top = c;     // max(): the first of equals
    top.tags.push("Stockfish's best of these");
  }
  return rank(choices);
}

/** Sound moves first, by how often they lead to +0.5, then by score. */
export function rank(choices: Choice[]): Choice[] {
  const keyOf = (c: Choice) => [sound(c) ? 0 : 1, -(c.advantage_rate ?? -1), -(c.avg_cp ?? -MATE_CP), -(c.score ?? 0), -c.eval_cp];
  return [...choices].sort((a, b) => {
    const [ka, kb] = [keyOf(a), keyOf(b)];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

export function describe(choices: Choice[], band: string): string {
  if (!choices.length) return '';
  const lines = [`What works against players ${band} here (ranked by how often their usual replies `
    + `leave you +${pyFixed(ADVANTAGE_CP / 100, 1)} or better):`];
  for (const [j, c] of choices.entries()) {
    const i = j + 1;
    const bits = [`Stockfish ${pySigned(c.eval_cp / 100, 2)}`.replaceAll('-', '−')];
    if (c.share !== null) bits.push(`played ${pyPercent(c.share)}, scores ${pyPercent(c.score!)}`);
    if (c.advantage_rate !== null) {
      bits.push(`+0.5 or better after ${pyPercent(c.advantage_rate)} of their replies (average ${pySigned(c.avg_cp! / 100, 2)})`
        .replaceAll('-', '−'));
    }
    const tags = c.tags.length ? ` (${c.tags.join(', ')})` : '';
    const mark = sound(c) ? '' : '  — not sound';
    lines.push(`${i}. ${c.san}${tags}: ${bits.join(' · ')}${mark}`);
    if (c.replies.length && i <= 3) {
      const usual = c.replies.slice(0, 4).map((r) => `${r.san} ${pyPercent(r.share)} → ${pySigned(r.cp / 100, 1)}`.replaceAll('-', '−'))
        .join(', ');
      lines.push(`    their usual replies: ${usual}`);
    }
  }
  const best = choices.find((c) => sound(c) && c.advantage_rate !== null);
  if (best && best.advantage_rate === 0) {
    lines.push("None of these usually gets you a half-pawn edge yet — the position is still balanced; "
      + 'the ranking shows which keeps the most pressure.');
  } else if (best && !best.tags.includes('your prep')) {
    lines.push(`In practice ${best.san} gets you an edge most often here.`);
  } else if (best) {
    lines.push(`Your prep move ${best.san} is also the one that works best in practice here.`);
  }
  return lines.join('\n');
}

// ---------- cache ----------

function key(bands: string, fen: string, mine: string): string {
  return `${bands}|${fen.split(/\s+/).slice(0, 4).join(' ')}|${mine}`;
}

export function cached(conn: Db, bands: string, fen: string, mine: string): Choice[] | null {
  const row = conn.get('SELECT data FROM practical_moves WHERE key = ? AND version = ?', [key(bands, fen, mine), VERSION]);
  return row ? (JSON.parse(row.data) as Choice[]) : null;
}

export function save(conn: Db, bands: string, fen: string, mine: string, choices: Choice[]): void {
  conn.run('INSERT OR REPLACE INTO practical_moves (key, version, data, created_at) VALUES (?, ?, ?, ?)',
    [key(bands, fen, mine), VERSION, JSON.stringify(choices), nowIso()]);
}
