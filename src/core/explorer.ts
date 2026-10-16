/**
 * Lichess Opening Explorer — port of explorer.py: how often players near your
 * rating play each move in a position, and how they score with it.
 *
 * The explorer needs a (free) Lichess personal access token with no
 * permissions — it's kept in this player's database (settings
 * 'lichess_token'). Answers are cached in the explorer_cache table, so each
 * position is downloaded once and drills keep working offline.
 *
 * The UI only reads the cache (cached()); downloads run in warm(), one request
 * at a time, waiting a minute after a 429 (rate limited) as Lichess asks.
 * `fetchImpl` and `sleep` are injectable for tests.
 */
import { Board, type Color, WHITE } from './chess';
import * as db from './db';
import { positionKey } from './repertoireGaps';
import type { Db } from './sqlite';
import { addDays, isoformat, nowIso } from './time';

export const EXPLORER_URL = 'https://explorer.lichess.ovh/lichess';
export const ACCOUNT_URL = 'https://lichess.org/api/account';
export const TOKEN_PAGE = 'https://lichess.org/account/oauth/token';
export const TOKEN_SETTING = 'lichess_token';

export const SPEEDS = 'blitz,rapid';
export const RATING_BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
/** chess.com ratings run roughly this much below Lichess for the same strength
 *  (rough rule of thumb — only used to pick which rating bands to ask for) */
export const CHESS_COM_TO_LICHESS = 200;
export const RATING_WINDOW = 200;      // bands within ± this of your estimated Lichess rating
export const CACHE_DAYS = 60;
export const RATE_LIMIT_WAIT_S = 61;
export const REQUEST_GAP_S = 0.3;      // pause between requests while warming the cache

const ELO_RE: { [color: string]: RegExp } = { white: /\[WhiteElo "(\d+)"\]/, black: /\[BlackElo "(\d+)"\]/ };

type Fetch = typeof fetch;

export class ExplorerError extends Error {}
export class BadToken extends ExplorerError {}

export class MoveStat {
  constructor(
    public uci: string,
    readonly san: string,
    readonly games: number,
    readonly white: number,
    readonly draws: number,
    readonly black: number,
  ) {}

  /** Points per game (win 1, draw ½) for `color` after this move. */
  scoreFor(color: Color): number {
    if (!this.games) return 0.5;
    const wins = color === WHITE ? this.white : this.black;
    return (wins + 0.5 * this.draws) / this.games;
  }
}

export class PositionStats {
  constructor(readonly games: number, readonly moves: MoveStat[]) {}

  /** Fraction of games in this position where `uci` was played. */
  share(uci: string): number {
    if (!this.games) return 0.0;
    return (this.moves.find((m) => m.uci === uci)?.games ?? 0) / this.games;
  }
}

/** PositionStats as plain data (to cross to another thread) and back. */
export interface PlainStats {
  games: number;
  moves: { uci: string; san: string; games: number; white: number; draws: number; black: number }[];
}

export function toPlain(stats: PositionStats): PlainStats {
  return { games: stats.games, moves: stats.moves.map((m) => ({ uci: m.uci, san: m.san, games: m.games, white: m.white, draws: m.draws, black: m.black })) };
}

export function fromPlain(p: PlainStats): PositionStats {
  return new PositionStats(p.games, p.moves.map((m) => new MoveStat(m.uci, m.san, m.games, m.white, m.draws, m.black)));
}

// ---------- token ----------

export function getToken(conn: Db): string | null {
  return db.getSetting(conn, TOKEN_SETTING) || null;
}

export function setToken(conn: Db, token: string | null): void {
  if (token) db.setSetting(conn, TOKEN_SETTING, token);
  else conn.run('DELETE FROM settings WHERE key = ?', [TOKEN_SETTING]);
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The Lichess username the token belongs to; throws BadToken / ExplorerError. */
export async function checkToken(token: string, fetchImpl: Fetch = fetch): Promise<string> {
  let resp: Response;
  try {
    resp = await fetchImpl(ACCOUNT_URL, { headers: auth(token), signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new ExplorerError(`Couldn't reach Lichess: ${e}`);
  }
  if (resp.status === 401) throw new BadToken("Lichess didn't accept that token.");
  if (resp.status !== 200) throw new ExplorerError(`Lichess answered with an error (${resp.status}).`);
  return (await resp.json()).username ?? '?';
}

// ---------- which players to compare with ----------

/** Median of your chess.com rating over your most recent games. */
export function myRecentRating(conn: Db, games = 50): number | null {
  const ratings: number[] = [];
  for (const r of conn.all('SELECT pgn, my_color FROM games ORDER BY played_at DESC LIMIT ?', [games])) {
    const m = ELO_RE[r.my_color]?.exec(r.pgn);
    if (m) ratings.push(parseInt(m[1], 10));
  }
  if (!ratings.length) return null;
  ratings.sort((a, b) => a - b);
  const mid = Math.floor(ratings.length / 2);
  // int(statistics.median(...)): the middle value, or the mean of the two middle ones, truncated
  return ratings.length % 2 ? ratings[mid] : Math.trunc((ratings[mid - 1] + ratings[mid]) / 2);
}

/** Lichess rating bands around your level, e.g. '1600,1800'. */
export function ratingBands(conn: Db): string {
  const rating = myRecentRating(conn);
  if (rating === null) return '1400,1600,1800';
  const est = rating + CHESS_COM_TO_LICHESS;
  const bands: string[] = [];
  for (const [i, low] of RATING_BUCKETS.entries()) {
    const high = i + 1 < RATING_BUCKETS.length ? RATING_BUCKETS[i + 1] : 10_000;
    if (low < est + RATING_WINDOW && high > est - RATING_WINDOW) bands.push(String(low));
  }
  return bands.join(',');
}

/** '1600,1800' -> 'rated 1600–2000' (Lichess ratings). */
export function describeBands(bands: string): string {
  const lows = bands.split(',').map((b) => parseInt(b, 10)).sort((a, b) => a - b);
  const next = RATING_BUCKETS.filter((b) => b > lows[lows.length - 1]);
  return next.length ? `rated ${lows[0]}–${next[0]}` : `rated ${lows[0]}+`;
}

// ---------- cache ----------

function cacheKey(bands: string, fen: string): string {
  return `${bands}|${SPEEDS}|${positionKey(fen)}`;
}

/** Cached stats for this position (no network), or null. */
export function cached(conn: Db, fen: string, bands: string | null = null): PositionStats | null {
  const row = conn.get('SELECT data FROM explorer_cache WHERE key = ?', [cacheKey(bands || ratingBands(conn), fen)]);
  return row ? parse(JSON.parse(row.data), fen) : null;
}

export function save(conn: Db, fen: string, bands: string, data: unknown): void {
  conn.run('INSERT OR REPLACE INTO explorer_cache (key, data, fetched_at) VALUES (?, ?, ?)',
    [cacheKey(bands, fen), JSON.stringify(data), nowIso()]);
}

/** Positions with no fresh cache entry (one per distinct position). */
export function missing(conn: Db, fens: Iterable<string>, bands: string, now: Date = new Date()): string[] {
  const cutoff = isoformat(addDays(now, -CACHE_DAYS));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const fen of fens) {
    const key = cacheKey(bands, fen);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = conn.get('SELECT fetched_at FROM explorer_cache WHERE key = ?', [key]);
    if (!row || row.fetched_at < cutoff) out.push(fen);
  }
  return out;
}

export function parse(data: any, fen: string): PositionStats {
  const moves: MoveStat[] = (data.moves ?? []).map((m: any) => {
    const games = (m.white ?? 0) + (m.draws ?? 0) + (m.black ?? 0);
    return new MoveStat(m.uci, m.san ?? m.uci, games, m.white ?? 0, m.draws ?? 0, m.black ?? 0);
  });
  const total = (data.white ?? 0) + (data.draws ?? 0) + (data.black ?? 0);
  // castling comes back as king-takes-rook (e1h1) for some positions; use the
  // standard form (e1g1) so it matches repertoire moves
  const board = Board.fromFen(fen);
  for (const m of moves) {
    try {
      m.uci = board.normalizeUci(m.uci) ?? m.uci;
    } catch {
      /* malformed UCI: keep it as it came */
    }
  }
  return new PositionStats(total, moves);
}

// ---------- network ----------

/** Raw explorer answer for one position. Throws BadToken, or
 *  ExplorerError('rate limited') on 429. */
export async function fetchStats(token: string, fen: string, bands: string, fetchImpl: Fetch = fetch): Promise<any> {
  const params = new URLSearchParams({
    variant: 'standard', fen, speeds: SPEEDS, ratings: bands, moves: '12', topGames: '0', recentGames: '0',
  });
  let resp: Response;
  try {
    resp = await fetchImpl(`${EXPLORER_URL}?${params}`, { headers: auth(token), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ExplorerError(`Couldn't reach Lichess: ${e}`);
  }
  if (resp.status === 401) throw new BadToken("Lichess didn't accept the saved token.");
  if (resp.status === 429) throw new ExplorerError('rate limited');
  if (resp.status !== 200) throw new ExplorerError(`Lichess answered with an error (${resp.status}).`);
  return resp.json();
}

const realSleep = (s: number) => new Promise<void>((resolve) => setTimeout(resolve, s * 1000));

/** Downloads stats for `fens` one at a time. onResult(fen, data) per position
 *  (save it with save()), and resolves to [fetched, error or null]. Stops early
 *  when `stop()` returns true. */
export async function warm(
  token: string, fens: string[], bands: string,
  onResult: (fen: string, data: any) => void,
  stop: () => boolean = () => false,
  opts: { fetchImpl?: Fetch; sleep?: (seconds: number) => Promise<void> } = {},
): Promise<[number, string | null]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  let fetched = 0;
  let error: string | null = null;
  for (const fen of fens) {
    if (stop()) break;
    let data: any;
    try {
      data = await fetchStats(token, fen, bands, fetchImpl);
    } catch (e) {
      if (!(e instanceof ExplorerError) || e.message !== 'rate limited') {
        error = e instanceof Error ? e.message : String(e);
        break;
      }
      await sleep(RATE_LIMIT_WAIT_S);
      try {
        data = await fetchStats(token, fen, bands, fetchImpl);
      } catch (e2) {
        error = e2 instanceof Error ? e2.message : String(e2);
        break;
      }
    }
    onResult(fen, data);
    fetched += 1;
    await sleep(REQUEST_GAP_S);
  }
  return [fetched, error];
}

// ---------- what to download for a repertoire ----------

/** Every position in your (enabled) repertoire where the OPPONENT moves next
 *  and your prep has an answer for them. All repertoires when repertoireName is null. */
export function opponentPositions(conn: Db, repertoireName: string | null = null): string[] {
  let sql = 'SELECT fen_before_move, my_color FROM opening_lines WHERE is_enabled = 1';
  const args: string[] = [];
  if (repertoireName !== null) {
    sql += ' AND repertoire_name = ?';
    args.push(repertoireName);
  }
  const fens: string[] = [];
  for (const r of conn.all(sql, args)) {
    const fen = r.fen_before_move;
    if (fen && Board.fromFen(fen).turn !== r.my_color) fens.push(fen);
  }
  return [...new Set(fens)];
}
