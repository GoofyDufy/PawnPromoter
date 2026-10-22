// The advice check: a piece of the Coach's advice ("put a rook on the open file") is tested against Stockfish —
// kept when a good move follows it, left out when every move that follows it is clearly worse than Stockfish's best.
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as coach from '../src/core/coach';
import { type Engine, type InfoLine, PovScore, Score } from '../src/core/engine';
import type { DbClient } from '../src/data/client';
import { CoachIdeas, checkAdvice, checkTactics } from '../src/ui/coachIdeas';

// White: a rook and open files on the board — the Coach says "put a rook there first"
const FEN = '4k3/p7/8/8/8/8/P7/R3K3 w - - 0 30';
const line = (pv: string[], cp: number): InfoLine => ({ pv, score: new PovScore(Score.cp(cp), 'white'), depth: 12 });

/** Stockfish's top moves are king moves (+0.3); restricted to the moves that follow the advice, it scores `rookCp`. */
const engine = (rookCp: number, asked: string[][] = []): Engine => ({
  analyse: async (b: Board, _limit, multipv, rootMoves) => {
    if (rootMoves?.length) { asked.push(rootMoves); return [line([rootMoves[0]], rookCp)]; }
    if (b.turn !== 'white') return [{ pv: b.legalMoves().slice(0, 1), score: new PovScore(Score.cp(0), b.turn) }];
    return [line(['e1d2', 'e8d7'], 30), line(['e1e2', 'e8d7'], 25), line(['e1f2', 'e8d7'], 20)].slice(0, multipv ?? 1);
  },
});
const alternatives = [{ move: 'e1d2', cp: 30 }, { move: 'e1e2', cp: 25 }, { move: 'e1f2', cp: 20 }];

describe('checking advice against Stockfish', () => {
  const ideas = coach.positionIdeas({ fen: FEN, me: 'white', cp: 30, bestLine: ['e1d2'], alternatives });

  it('the advice says which moves follow it', () => {
    const p = ideas.points.find((x) => x.rule === 'open-file')!;
    expect(p.text).toMatch(/(is|are) open: put a rook there first/);
    expect(p.advice!('a1b1')).toBe(true);
    expect(p.advice!('e1d2')).toBe(false);
  });

  it('contradicted: every rook move to the file is clearly worse (only those moves are searched)', async () => {
    const asked: string[][] = [];
    const v = await checkAdvice(engine(-250, asked), Board.fromFen(FEN), ideas, 'white', alternatives);
    expect(v.find((x) => x.rule === 'open-file')).toMatchObject({ verdict: 'contradicted', gap: 280 });
    expect(asked[0].every((m) => m.startsWith('a1'))).toBe(true);
  });

  it('agrees: a rook move is about as good', async () => {
    const v = await checkAdvice(engine(10), Board.fromFen(FEN), ideas, 'white', alternatives);
    expect(v.find((x) => x.rule === 'open-file')?.verdict).toBe('agrees');
  });

  it("agrees without a search when one of Stockfish's top moves follows it", async () => {
    const asked: string[][] = [];
    const v = await checkAdvice(engine(-250, asked), Board.fromFen(FEN), ideas, 'white', [{ move: 'a1b1', cp: 30 }, ...alternatives]);
    expect(v.find((x) => x.rule === 'open-file')?.verdict).toBe('agrees');
    expect(asked.length).toBe(0);
  });

  it('only on your move: no claims about the other side\'s moves', async () => {
    expect(await checkAdvice(engine(-250), Board.fromFen(FEN), ideas, 'black', alternatives)).toEqual([]);
  });

  it('in the Ideas: contradicted advice is left out, the rest kept', async () => {
    const client = { service: async (n: string) => (n === 'getSettings' ? { analysis_ideas: '1' } : undefined) } as unknown as DbClient;
    const shown = async (rookCp: number) => {
      const c = new CoachIdeas(client, 'analysis_ideas', engine(rookCp), () => {});
      await c.load();
      await c.explain({ fen: FEN, me: 'white' });
      return c.ideas!.points.map((p) => p.rule);
    };
    expect(await shown(-250)).not.toContain('open-file');
    expect(await shown(10)).toContain('open-file');
  });
});

describe("checking their tactics against Stockfish", () => {
  // their knight on d7 forks your rooks on b8 and f8 (Black to move) — from your puzzles
  const FORK = '1r3rk1/2bN1ppp/4p3/p2p2Pn/3P1P2/2P4b/PP3R2/R1B3K1 b - - 1 21';
  const ideas = coach.positionIdeas({ fen: FORK, me: 'black', cp: 0 });
  const fake = (theirCp: number, asked: string[][] = []): Engine => ({
    analyse: async (b: Board, _l, _m, rootMoves) => {
      if (rootMoves?.length) asked.push(rootMoves);
      const pv = rootMoves?.length ? [rootMoves[0], 'f8b8'] : b.legalMoves().slice(0, 1);
      return [{ pv, score: new PovScore(Score.cp(theirCp), b.turn), depth: 10 }];
    },
  });

  it('the fork knows the moves that cash it in', () => {
    expect(ideas.points.find((p) => p.rule === 'forked')?.cash).toEqual(['d7b8', 'd7f8']);
  });

  it('it works when cashing it in gains them a pawn or more', async () => {
    const asked: string[][] = [];
    const v = await checkTactics(fake(200, asked), Board.fromFen(FORK), ideas, 'black', 0);
    expect(v).toEqual([expect.objectContaining({ rule: 'forked', verdict: 'works' })]);
    expect(asked[0]).toEqual(['d7b8', 'd7f8']);                // only the knight's captures were searched
  });

  it('it fails when you are still better after it, and says so', async () => {
    const v = await checkTactics(fake(-300), Board.fromFen(FORK), ideas, 'black', 0);
    expect(v[0]).toMatchObject({ verdict: 'fails', why: "it isn't a real threat: even after Nxb8 Rxb8 you're still better" });
    const shown = coach.positionIdeas({ fen: FORK, me: 'black', cp: 0, revised: { [v[0].text]: { text: `${v[0].text.replace(/\.$/, '')} — but ${v[0].why}.`, weight: 30 } } });
    const p = shown.points.find((x) => x.rule === 'forked')!;
    expect(p.text).toBe("Their knight on d7 forks your rook on b8 and rook on f8 — but it isn't a real threat: even after Nxb8 Rxb8 you're still better.");
    expect(p.weight).toBe(30);
  });

  it('a pinned attacker can\'t take', async () => {
    // a white bishop on b5 pins the black knight on d7 to the king on e8: the knight "forks" nothing it can take
    const fen = '4k3/3n4/8/1B6/8/8/8/4K3 w - - 0 1';
    const fakeIdeas = { summary: '', key: [], sections: [], points: [{ section: '', rule: 'forked', weight: 98, text: 'x.', cash: ['d7b6'] }] };
    const v = await checkTactics(fake(0), Board.fromFen(fen), fakeIdeas, 'white', 0);
    expect(v[0]).toMatchObject({ verdict: 'fails', why: "the knight on d7 is pinned, so it can't take" });
  });

  it('your best move just takes the piece behind it', () => {
    const t = coach.positionIdeas({ fen: FORK, me: 'black', cp: 300, bestLine: ['f8d8'], alternatives: [{ move: 'f8d8', cp: 300 }] })
      .points.find((p) => p.rule === 'forked')?.text;
    expect(t).toBe('Their knight on d7 forks your rook on b8 and rook on f8.');      // (Rd8 doesn't take it)
    // Bxd7? the bishop on h3 is Black's: check against a real capture of the knight
    const k = coach.positionIdeas({ fen: '1r3rk1/2bN1ppp/2b1p3/p2p2Pn/3P1P2/2P5/PP3R2/R1B3K1 b - - 1 21', me: 'black', cp: 300, bestLine: ['c6d7'] })
      .points.find((p) => p.rule === 'forked')?.text;
    expect(k).toBe('Their knight on d7 forks your rook on b8 and rook on f8 — but you can just take it: Bxd7.');
  });
});
