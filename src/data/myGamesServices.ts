/**
 * Opening Drill → My games (my_games_view.py's database work), in the
 * database worker: the report of your openings and where you (and your
 * opponents) leave your prep, plus the saved Stockfish commentary and
 * "works best at your level" results. Plain data only.
 */
import * as explorer from '../core/explorer';
import * as myOpenings from '../core/myOpenings';
import * as openingCommentary from '../core/openingCommentary';
import * as practical from '../core/practical';
import type { Db } from '../core/sqlite';
import type { Record as GameRecord } from '../core/stats';

export const REFRESH_SECONDS = 300;    // the report is recomputed at most this often (or after new games)

export interface RecordView { games: number; wins: number; draws: number; losses: number; score: number }

export interface OpeningUseView {
  name: string;
  color: string;
  games: number;
  score: number;
  left: number;
  followed: number;
  deviationKeys: string[];
}

export interface MyDeviationView {
  key: string;
  color: string;
  prefix: string[];
  fen: string;
  playedUci: string;
  playedSan: string;
  prepUcis: string[];
  prepSans: string[];
  repertoires: string[];
  games: number;
  line: string;
  moveNumber: number;
  record: RecordView;
  prepRecord: RecordView;
  gameIds: string[];
}

export interface OpponentDeviationView {
  key: string;
  color: string;
  fen: string;
  playedUci: string;
  playedSan: string;
  prepSans: string[];
  games: number;
  record: RecordView;
  usualReply: string | null;
}

export interface MyGamesReport {
  games: number;
  openings: OpeningUseView[];
  deviations: MyDeviationView[];
  opponentDeviations: OpponentDeviationView[];
  costs: Record<string, number>;          // deviation key -> centipawns it costs (saved commentary)
}

const rec = (r: GameRecord): RecordView => ({ games: r.games, wins: r.wins, draws: r.draws, losses: r.losses, score: r.score });

let cache: { at: number; games: number; report: MyGamesReport } | null = null;

/** The report: recomputed after new games or every few minutes. */
export function myGamesReport(conn: Db, force = false): MyGamesReport {
  const games = conn.get('SELECT COUNT(*) AS n FROM games')!.n as number;
  if (!force && cache && cache.games === games && Date.now() - cache.at < REFRESH_SECONDS * 1000) {
    return { ...cache.report, costs: costs(conn, cache.report.deviations) };
  }
  const r = myOpenings.compute(conn);
  const deviations = r.deviations.map((d): MyDeviationView => ({
    key: d.key, color: d.color, prefix: d.prefix, fen: d.fen, playedUci: d.played_uci, playedSan: d.played_san,
    prepUcis: d.prep_ucis, prepSans: d.prep_sans, repertoires: d.repertoires, games: d.games, line: d.line,
    moveNumber: d.move_number, record: rec(d.record), prepRecord: rec(d.prep_record), gameIds: d.game_ids,
  }));
  const report: MyGamesReport = {
    games: r.games,
    openings: r.openings.map((o) => ({ name: o.name, color: o.color, games: o.games, score: o.record.score, left: o.left,
      followed: o.followed, deviationKeys: [...o.deviation_keys.keys()] })),
    deviations,
    opponentDeviations: r.opponent_deviations.map((o) => ({
      key: `${o.fen}|${o.played_uci}`, color: o.color, fen: o.fen, playedUci: o.played_uci, playedSan: o.played_san,
      prepSans: o.prep_sans, games: o.games, record: rec(o.record), usualReply: o.usual_reply,
    })),
    costs: {},
  };
  cache = { at: Date.now(), games, report };
  return { ...report, costs: costs(conn, deviations) };
}

function costs(conn: Db, deviations: MyDeviationView[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of deviations) {
    const n = openingCommentary.cached(conn, d.fen, d.playedUci, d.prepUcis);
    if (n) out[d.key] = openingCommentary.cost(n);
  }
  return out;
}

export function commentaryCached(conn: Db, fen: string, mine: string, prep: string[]): openingCommentary.Notes | null {
  return openingCommentary.cached(conn, fen, mine, prep);
}

export function commentarySave(conn: Db, fen: string, mine: string, prep: string[], notes: openingCommentary.Notes): void {
  openingCommentary.save(conn, fen, mine, prep, notes);
}

export function practicalCached(conn: Db, bands: string, fen: string, mine: string): practical.Choice[] | null {
  return practical.cached(conn, bands, fen, mine);
}

export function practicalSave(conn: Db, bands: string, fen: string, mine: string, choices: practical.Choice[]): void {
  practical.save(conn, bands, fen, mine, choices);
}

export function lichessToken(conn: Db): string | null {
  return explorer.getToken(conn);
}

/** Games for the "Review games…" list, newest first. */
export function gamesList(conn: Db, ids: string[]): { id: string; played: string; opponent: string; result: string; timeControl: string; url: string }[] {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  return conn.all(`SELECT id, played_at, opponent_username, result, time_control, chess_com_url FROM games WHERE id IN (${marks})
    ORDER BY played_at DESC`, ids).map((r) => ({ id: r.id, played: String(r.played_at).slice(0, 10), opponent: r.opponent_username,
    result: r.result, timeControl: r.time_control, url: r.chess_com_url }));
}

export const myGamesServices = {
  myGamesReport, commentaryCached, commentarySave, practicalCached, practicalSave, lichessToken, gamesList,
};
