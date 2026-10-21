/** The Lichess masters database lookup (Stats → Lines you face most → Show lines in master database). */
import { describe, expect, it } from 'vitest';
import { BadToken, ExplorerError, fetchMasters, MASTERS_URL, parseMasters } from '../src/core/explorer';

const SAMPLE = {
  white: 300, draws: 500, black: 200,
  opening: { eco: 'B90', name: 'Sicilian Defense: Najdorf Variation' },
  moves: [
    { uci: 'c1g5', san: 'Bg5', white: 120, draws: 150, black: 80, averageRating: 2512 },
    { uci: 'f1e2', san: 'Be2', white: 60, draws: 90, black: 50, averageRating: 2480 },
  ],
  topGames: [
    { id: 'abcd1234', winner: 'black', white: { name: 'Fischer, Robert James', rating: 2785 }, black: { name: 'Spassky, Boris', rating: 2660 }, year: 1972 },
    { id: 'efgh5678', winner: null, white: { name: 'Kasparov, Garry', rating: 2851 }, black: { name: 'Anand, Viswanathan', rating: 2725 }, year: 1995 },
  ],
};

const respond = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status });

describe('the masters database', () => {
  it('reads a position: totals, moves with their scores, and games', () => {
    const p = parseMasters(SAMPLE);
    expect(p.games).toBe(1000);
    expect(p.opening).toBe('B90 Sicilian Defense: Najdorf Variation');
    expect(p.moves[0]).toEqual({ uci: 'c1g5', san: 'Bg5', games: 350, white: 120, draws: 150, black: 80, rating: 2512 });
    expect(p.topGames.map((g) => g.result)).toEqual(['0-1', '½-½']);
    expect(p.topGames[0]).toMatchObject({ id: 'abcd1234', white: 'Fischer, Robert James', whiteRating: 2785, year: 1972 });
  });

  it('copes with a position no master reached', () => {
    expect(parseMasters({ white: 0, draws: 0, black: 0, moves: [], topGames: [] })).toEqual({ games: 0, white: 0, draws: 0, black: 0, opening: null, moves: [], topGames: [] });
  });

  it('asks Lichess for the position, with the token when there is one', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as unknown as typeof fetch;
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect((await fetchMasters('tok', fen, fake)).games).toBe(1000);
    expect(seen[0].url.startsWith(`${MASTERS_URL}?`)).toBe(true);
    expect(new URL(seen[0].url).searchParams.get('fen')).toBe(fen);
    expect(Object.values(seen[0].headers).join(' ')).toContain('tok');
    await fetchMasters(null, fen, fake);
    expect(seen[1].headers).toEqual({});
  });

  it('explains what went wrong', async () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    await expect(fetchMasters(null, fen, respond(401) as unknown as typeof fetch)).rejects.toThrow(/Connect Lichess/);
    await expect(fetchMasters('tok', fen, respond(401) as unknown as typeof fetch)).rejects.toBeInstanceOf(BadToken);
    await expect(fetchMasters('tok', fen, respond(429) as unknown as typeof fetch)).rejects.toThrow(/slow down/);
    await expect(fetchMasters('tok', fen, respond(500) as unknown as typeof fetch)).rejects.toBeInstanceOf(ExplorerError);
  });
});
