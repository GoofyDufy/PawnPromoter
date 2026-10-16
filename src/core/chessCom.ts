/**
 * Thin wrapper around the chess.com PubAPI for pulling your own games — port
 * of chess_com_client.py. The browser can't set a User-Agent header, so none
 * is sent (the API doesn't require it). `fetchImpl` is injectable for tests.
 */
import { type Game, type GameResult, type PlayerColor, makeGame } from './models';
import { isoformat } from './time';

export const BASE_URL = 'https://api.chess.com/pub';

type Fetch = typeof fetch;

async function getJson(url: string, fetchImpl: Fetch): Promise<any> {
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`chess.com answered ${resp.status} for ${url}`);
  return resp.json();
}

export async function getArchiveUrls(username: string, fetchImpl: Fetch = fetch): Promise<string[]> {
  return (await getJson(`${BASE_URL}/player/${username}/games/archives`, fetchImpl)).archives;
}

/** One month's games, from your (`username`'s) point of view. */
export function gamesFromArchive(rawGames: any[], username: string): Game[] {
  const games: Game[] = [];
  for (const g of rawGames) {
    if (!('pgn' in g)) continue;
    const white = String(g.white.username).toLowerCase();
    const myColor: PlayerColor = white === username.toLowerCase() ? 'white' : 'black';
    const opponent = myColor === 'white' ? g.black.username : g.white.username;

    const myResultRaw = myColor === 'white' ? g.white.result : g.black.result;
    let result: GameResult;
    if (myResultRaw === 'win') result = 'win';
    else if (['checkmated', 'resigned', 'timeout', 'abandoned', 'lose'].includes(myResultRaw)) result = 'loss';
    else result = 'draw';

    const acc = g.accuracies || {};               // only for games reviewed on chess.com
    const [mine, theirs] = myColor === 'white' ? ['white', 'black'] : ['black', 'white'];
    games.push(makeGame({
      my_accuracy: acc[mine] ?? null,
      opp_accuracy: acc[theirs] ?? null,
      chess_com_url: g.url,
      pgn: g.pgn,
      played_at: isoformat(new Date((g.end_time ?? 0) * 1000)),   // local time, like datetime.fromtimestamp
      time_control: g.time_control ?? 'unknown',
      my_color: myColor,
      opponent_username: opponent,
      result,
    }));
  }
  return games;
}

export async function getGamesFromArchive(archiveUrl: string, username: string, fetchImpl: Fetch = fetch): Promise<Game[]> {
  return gamesFromArchive((await getJson(archiveUrl, fetchImpl)).games ?? [], username);
}

/** Games from the most recent `monthsBack` monthly archives (0 = your entire
 *  history). onProgress(done, total) is called after each month downloads. */
export async function fetchAllGames(
  username: string, monthsBack = 3,
  onProgress?: (done: number, total: number) => void,
  fetchImpl: Fetch = fetch,
): Promise<Game[]> {
  let archiveUrls = await getArchiveUrls(username, fetchImpl);
  if (monthsBack > 0) archiveUrls = archiveUrls.slice(-monthsBack);
  const all: Game[] = [];
  for (const [i, url] of archiveUrls.entries()) {
    all.push(...(await getGamesFromArchive(url, username, fetchImpl)));
    onProgress?.(i + 1, archiveUrls.length);
  }
  return all;
}
