/**
 * Stats' database work (stats_tab.py), in the database worker: the Overview,
 * Playing style and Repertoire tables as plain rows, and the actions behind
 * them (show the games behind a line, add a line to your repertoire). The
 * Repertoire report is kept here between calls, so a row can be acted on.
 */
import { Board } from '../core/chess';
import * as db from '../core/db';
import * as explorer from '../core/explorer';
import { pyFixed } from '../core/format';
import { type PlayerColor, TIME_FILTERS, timeClass } from '../core/models';
import * as openingImporter from '../core/openingImporter';
import * as catalog from '../core/openingsCatalog';
import * as openingTree from '../core/openingTree';
import * as gaps from '../core/repertoireGaps';
import * as improvement from '../core/improvement';
import * as scouting from '../core/scouting';
import type { Game } from '../core/models';
import type { Db } from '../core/sqlite';
import * as stats from '../core/stats';
import * as style from '../core/style';

export const MIN_OPENING_GAMES = 3;
export const REPERTOIRE_FROM_GAMES = 'From my games';
export const SUGGESTIONS_REPERTOIRE = 'Style suggestions';
const BAR_WIDTH = 12;

export interface TableRow { id?: string; cells: string[]; tone?: 'weak' | 'before' }
export interface Table { columns: string[]; rows: TableRow[] }

const bar = (f: number) => {
  const filled = Math.round(Math.max(0, Math.min(1, f)) * BAR_WIDTH);
  return '▰'.repeat(filled) + '▱'.repeat(BAR_WIDTH - filled);
};
const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const classes = (filter: string) => TIME_FILTERS[filter] ?? null;

// ---------- Overview ----------

export function statsOverview(conn: Db, filter: string): { summary: string; openings: Table; losses: Table; phases: Table; clock: Table } {
  db.setSetting(conn, 'stats_filter', filter);
  const s = stats.compute(conn, classes(filter));
  // openings: most-played first; weak (<40% score) highlighted
  const openings = [...s.openings].filter(([, r]) => r.games >= MIN_OPENING_GAMES).sort((a, b) => b[1].games - a[1].games)
    .map(([key, r]): TableRow => {
      const [name, color] = stats.splitOpeningKey(key);
      return { cells: [name, cap(color), String(r.games), `${r.wins} / ${r.draws} / ${r.losses}`, `${Math.round(100 * r.score)}%`, bar(r.score)],
        tone: r.score < 0.4 ? 'weak' : undefined };
    });
  const order = ['Bullet', 'Blitz', 'Rapid', 'Daily', 'Other'];
  const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : 99);
  const losses = [...s.loss_reasons.keys()].sort((a, b) => rank(a) - rank(b)).map((tc): TableRow => {
    const r = s.loss_reasons.get(tc)!;
    const n = (k: string) => r.get(k) ?? 0;
    const lost = [...r.values()].reduce((a, b) => a + b, 0);
    return { cells: [tc, String(lost), pct(n('Resigned'), lost), pct(n('Checkmated'), lost), pct(n('Timeout'), lost), pct(n('Other') + n('Abandoned'), lost)] };
  });
  const worstAvg = Math.max(0, ...[...s.phases.values()].map((p) => p.avg_loss)) || 1;
  const phases = [...s.phases].map(([name, p]): TableRow => ({
    cells: [name, String(p.moves), p.moves ? pyFixed(p.avg_loss / 100, 2) : '–', String(p.blunders), p.moves ? bar(p.avg_loss / worstAvg) : ''] }));
  const worstRate = Math.max(0, ...[...s.clock.values()].map((c) => c.blunder_rate)) || 1;
  const clock = [...s.clock].map(([label, c]): TableRow => ({
    cells: [label, String(c.moves), c.moves ? `${pyFixed(100 * c.blunder_rate, 1)}%` : '–', c.moves ? bar(c.blunder_rate / worstRate) : ''] }));
  return {
    summary: `${s.total_games} games · ${s.engine_games} with Stockfish data`,
    openings: { columns: ['Opening', 'As', 'Games', 'W / D / L', 'Score', ''], rows: openings },
    losses: { columns: ['Time control', 'Losses', 'Resigned', 'Mated', 'Timeout', 'Other'], rows: losses },
    phases: { columns: ['Phase', 'Moves', 'Avg loss', 'Blunders', ''], rows: phases },
    clock: { columns: ['Time left', 'Moves', 'Blunder rate', ''], rows: clock },
  };
}

// ---------- Playing style ----------

export function statsStyle(conn: Db, filter: string): { verdict: string; note: string; indicators: Table; gameTypes: Table; character: Table; recommend: Table } {
  const r = style.computeStyle(conn, classes(filter));
  let note = `Based on ${r.games} Stockfish-analyzed games in this filter.`;
  if (r.multipv_games < r.games) {
    note += ` ${r.games - r.multipv_games} were analyzed before top-3 engine moves were recorded — `
      + 'Analyze new games re-analyzes them for more accurate labels.';
  }
  const indicators: TableRow[] = [];
  for (const [name, p] of r.accuracy) {
    indicators.push({ cells: [`Avg pawns lost, ${name.toLowerCase()}`, p.moves ? pyFixed(p.avg_loss / 100, 2) : '–', `${p.moves} moves`] });
    indicators.push({ cells: [`Blunder rate, ${name.toLowerCase()}`, p.moves ? `${pyFixed(100 * p.blunder_rate, 1)}%` : '–', `${p.moves} moves`] });
  }
  indicators.push({ cells: ['Only-move positions solved', pct(r.only_moves_found, r.only_moves), `${r.only_moves} positions`] });
  indicators.push({ cells: ['Opponent blunders punished', pct(r.punished, r.punish_chances), `${r.punish_chances} chances`] });
  const gameTypes = [...r.game_types].map(([name, rec]): TableRow => ({
    cells: [name, String(rec.games), `${rec.wins} / ${rec.draws} / ${rec.losses}`, rec.games ? `${Math.round(100 * rec.score)}%` : '–', rec.games ? bar(rec.score) : ''] }));
  const character = [...r.openings].filter(([, [rec]]) => rec.games >= MIN_OPENING_GAMES).sort((a, b) => b[1][0].games - a[1][0].games)
    .map(([key, [rec, sharpness]]): TableRow => {
      const [name, color] = stats.splitOpeningKey(key);
      return { cells: [name, cap(color), String(rec.games), `${Math.round(100 * rec.score)}%`, r.character(sharpness)] };
    });
  const records = stats.compute(conn, classes(filter)).openings;
  const entries = catalog.CATALOG.map((o, i) => [i, o] as const)
    .sort(([, a], [, b]) => (catalog.FIT_RANK[catalog.fit(r.style, a)] - catalog.FIT_RANK[catalog.fit(r.style, b)])
      || (Number(a.color !== 'white') - Number(b.color !== 'white')) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const recommend = entries.map(([i, o]): TableRow => {
    const rec = catalog.yourRecord(o, records);
    return { id: String(i), cells: [o.name, cap(o.color), o.character, catalog.fit(r.style, o), rec ? `${Math.round(100 * rec.score)}% (${rec.games})` : 'new'] };
  });
  return {
    verdict: r.verdict, note,
    indicators: { columns: ['Measure', 'Value', 'Based on'], rows: indicators },
    gameTypes: { columns: ['Game type', 'Games', 'W / D / L', 'Score', ''], rows: gameTypes },
    character: { columns: ['Opening', 'As', 'Games', 'Score', 'Character'], rows: character },
    recommend: { columns: ['Opening', 'As', 'Style', 'Fit', 'You'], rows: recommend },
  };
}

/** A catalog opening into "Style suggestions" (once; switched back on if it was off), for drilling. */
export function drillSuggestion(conn: Db, index: number): { repertoire: string; color: PlayerColor; lineName: string } {
  const o = catalog.CATALOG[index];
  const root = db.allRootLines(conn, SUGGESTIONS_REPERTOIRE, o.color).find((r) => r.line_name === o.name);
  if (!root) openingImporter.importPgnText(`[Event "${o.name}"]\n\n${o.moves} *\n`, SUGGESTIONS_REPERTOIRE, o.color, conn);
  else if (!root.is_enabled) db.setLineEnabled(conn, root.id, true);
  return { repertoire: SUGGESTIONS_REPERTOIRE, color: o.color, lineName: o.name };
}

// ---------- Repertoire ----------

let report: gaps.GapReport | null = null;
let popular: gaps.PopularGap[] = [];

/** Where your games leave your repertoire, and the lines you face most. */
export function statsRepertoire(conn: Db, filter: string, firstMove: string | null): {
  note: string; firstMoves: [string, number][]; gaps: Table; common: Table;
} {
  report = gaps.compute(conn, classes(filter));
  return repertoireView(firstMove);
}

const startsWith = (first: string | null, sans: string[]) => first === null || (sans.length > 0 && sans[0] === first);

/** The same report, filtered to another first move (no recomputing). */
export function statsRepertoireRender(_conn: Db, firstMove: string | null) {
  return report ? repertoireView(firstMove) : null;
}

function repertoireView(first: string | null) {
  const r = report!;
  const missing = Object.entries(r.has_repertoire).filter(([, has]) => !has).map(([c]) => cap(c));
  let note = `From the first ${gaps.MAX_PLY / 2} moves of ${r.games} games.`;
  if (missing.length) {
    note += ` You have no ${missing.join(' or ')} repertoire yet, so those games only appear under Lines you face most — add the most common ones from there.`;
  }
  const gapRows = r.gaps.map((g, i) => [g, i] as const).filter(([g]) => r.has_repertoire[g.color] && startsWith(first, [...g.prefix, g.move]))
    .map(([g, i]): TableRow => ({ id: `gap${i}`, cells: [g.line, cap(g.color), g.who, String(g.record.games), `${Math.round(100 * g.record.score)}%`,
      g.suggestion ? `${g.suggestion} (${g.suggestion_source})` : g.by_opponent ? '–' : `${g.move} (what you play)`] }));
  const commonRows = r.common.map((c, i) => [c, i] as const).filter(([c]) => startsWith(first, c.sans)).slice(0, 60)
    .map(([c, i]): TableRow => ({ id: `common${i}`, cells: [gaps.formatLine(c.sans), c.opening, cap(c.color), String(c.record.games),
      `${Math.round(100 * c.record.score)}%`, c.in_repertoire ? '✓' : ''] }));
  return {
    note,
    firstMoves: [...r.first_moves].sort((a, b) => b[1] - a[1]),
    gaps: { columns: ['Line (first uncovered move last)', 'As', 'Who left', 'Games', 'Score', 'Suggested reply'], rows: gapRows },
    common: { columns: ['Line', 'Opening', 'As', 'Games', 'Score', 'In rep'], rows: commonRows },
  };
}

/** Popular Lichess moves your prep doesn't answer (cached data only), inside your openings first. */
export function statsPopular(conn: Db, firstMove: string | null): { status: string | null; table: Table; opponentFens: string[]; replyFens: string[] } {
  const empty = { columns: ['Line (unanswered move last)', 'As', 'Where', "You'd face it", 'Played here', 'They score', 'Suggested reply'], rows: [] };
  if (!explorer.getToken(conn)) {
    return { status: 'Connect Lichess (Opening Drill → Add lines → Connect Lichess…) to see which popular moves your repertoire doesn\'t answer.',
      table: empty, opponentFens: [], replyFens: [] };
  }
  const opponentFens = explorer.opponentPositions(conn);
  if (!opponentFens.length) {
    return { status: 'Add some lines in Opening Drill first: this checks every position in your repertoire against what Lichess players actually play.',
      table: empty, opponentFens: [], replyFens: [] };
  }
  const bands = explorer.ratingBands(conn);
  popular = gaps.popularGaps(conn, (fen) => explorer.cached(conn, fen, bands));
  const starts: { [color: string]: string[][] } = {};
  for (const [rep, color] of db.listRepertoires(conn)) (starts[color] ??= []).push(openingTree.startPath(conn, rep, color as PlayerColor));
  gaps.markInside(popular, starts);
  popular.sort((a, b) => Number(!a.inside) - Number(!b.inside) || b.frequency - a.frequency);
  const inside = popular.filter((g) => g.inside).length;
  const status = `${inside} popular move(s) inside your openings without an answer, ${popular.length - inside} before your openings start `
    + `(other openings, greyed) — Lichess blitz/rapid, players ${explorer.describeBands(bands)}. Change where an opening starts by `
    + 'right-clicking it in Opening Drill → Tree.';
  const rows = popular.map((g, i) => [g, i] as const).filter(([g]) => startsWith(firstMove, [...g.prefix, g.move]))
    .map(([g, i]): TableRow => ({ id: `popular${i}`, tone: g.inside ? undefined : 'before', cells: [g.line, cap(g.color), g.inside ? 'in opening' : 'before it',
      `${pyFixed(100 * g.frequency, 1)}%`, `${Math.round(100 * g.share)}%`, `${Math.round(100 * g.opponent_score)}%`,
      g.suggestion ? `${g.suggestion} (${g.suggestion_source})` : '–'] }));
  return { status, table: { ...empty, rows }, opponentFens, replyFens: gaps.gapReplyPositions(popular) };
}

/** The games behind a row, newest first, and the position to review them at. */
export function statsGames(conn: Db, id: string): { title: string; fen: string; games: { id: string; label: string; result: string }[] } | { message: string } {
  if (id.startsWith('popular')) return { message: 'This move comes from Lichess players, not from your own games, so there are no games of yours to show.' };
  const item = id.startsWith('gap') ? report?.gaps[Number(id.slice(3))] : report?.common[Number(id.slice(6))];
  if (!item) return { message: 'Select a line in the table first.' };
  let title: string;
  let fen: string;
  if (item instanceof gaps.Gap) {
    title = item.line;
    fen = item.review_fen;
  } else {
    title = gaps.formatLine(item.sans);
    const b = Board.fromFen();
    for (const san of item.sans) b.push(b.parseSan(san)!);
    fen = b.fen();
  }
  const marks = item.game_ids.map(() => '?').join(',');
  const rows = item.game_ids.length ? conn.all(`SELECT id, played_at, opponent_username, result, time_control, evaluated_at FROM games
    WHERE id IN (${marks}) ORDER BY played_at DESC`, item.game_ids) : [];
  return { title, fen, games: rows.map((g) => ({ id: g.id, result: g.result,
    label: `${String(g.played_at).slice(0, 10)}   ${String(g.result).toUpperCase().padEnd(5)} vs ${g.opponent_username}  · ${timeClass(g.time_control)}${g.evaluated_at ? '' : '  (not analyzed yet)'}` })) };
}

/** A row into your "From my games" repertoire: the gap with its suggested reply, or the common line. */
export function statsAdd(conn: Db, id: string): { ok: boolean; text: string } {
  let item: gaps.Gap | gaps.CommonLine | undefined;
  if (id.startsWith('popular')) {
    const p = popular[Number(id.slice(7))];
    if (p) {
      item = p.asGap();
      item.opening = 'Lichess';
    }
  } else item = id.startsWith('gap') ? report?.gaps[Number(id.slice(3))] : report?.common[Number(id.slice(6))];
  if (!item) return { ok: false, text: 'Select a line in the table first.' };
  const color = item.color as PlayerColor;
  let pgn: string | null;
  if (item instanceof gaps.Gap) {
    const name = `${item.opening} — ${item.line}`;
    pgn = gaps.gapPgn(item, name.slice(0, 90));
    if (pgn === null) {
      return { ok: false, text: "There's no suggested reply for this position yet. Analyze more games, or add the line by hand with Paste / type a line." };
    }
  } else {
    const name = `${item.opening} — ${gaps.formatLine(item.sans)}`;
    pgn = `[Event "${name.slice(0, 90)}"]\n\n${gaps.formatLine(item.sans)} *\n`;
  }
  const added = openingImporter.importPgnText(pgn, REPERTOIRE_FROM_GAMES, color, conn);
  return added ? { ok: true, text: `Added to '${REPERTOIRE_FROM_GAMES}' (${color}). Drill it in Opening Drill, and extend it with Paste / type a line.` }
    : { ok: true, text: `That line is already in '${REPERTOIRE_FROM_GAMES}'.` };
}

/** Lichess positions still to download (to fill the popular-gap list). */
export function explorerMissing(conn: Db, fens: string[]): { token: string | null; bands: string; fens: string[] } {
  const token = explorer.getToken(conn);
  const bands = explorer.ratingBands(conn);
  return { token, bands, fens: token ? explorer.missing(conn, fens, bands) : [] };
}

/** Opponent Prep: their lines as White and as Black (their games stay in memory, never saved). */
export function scoutLines(conn: Db, games: Game[], filter: string): scouting.ScoutReport {
  return scouting.scoutLines(conn, games, classes(filter));
}

/** Stats → Improvement: how you're doing over time, by area, with commentary. */
export function statsImprovement(conn: Db, filter: string): improvement.Improvement {
  return improvement.compute(conn, classes(filter));
}

export const statsServices = {
  scoutLines, statsImprovement,
  statsOverview, statsStyle, drillSuggestion, statsRepertoire, statsRepertoireRender, statsPopular, statsGames, statsAdd,
  explorerMissing,
};
