// The deep coach: Stockfish's good lines read further (16 half-moves), and the plan they share said once —
// the piece that comes alive, the pawns pushed, the break — on the real lines Stockfish gave for these positions.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as coach from '../src/core/coach';
import { type Engine, type InfoLine, PovScore, Score } from '../src/core/engine';
import { SharedEngine } from '../src/core/engineService';
import type { DbClient } from '../src/data/client';
import { CoachIdeas, deepCoach, setDeepCoach } from '../src/ui/coachIdeas';

// a knight ending: every good line brings the knight round from h4 (Stockfish 19, depth 18)
const KNIGHT = {
  fen: '8/8/rp2p3/3pkp2/4n1pN/6P1/P1R3K1/8 w - - 4 37',
  lines: [
    { line: ['h4g6', 'e5d4', 'c2b2', 'b6b5', 'g2g1', 'e4g5', 'g6e7', 'd4c4', 'e7c6', 'g5f3', 'g1f2', 'a6a4', 'f2f1', 'f3d4', 'a2a3'], cp: -569 },
    { line: ['g2g1', 'b6b5', 'h4g6', 'e5d4', 'c2b2', 'e4c3', 'g1f1', 'd4e4', 'g6f4', 'd5d4', 'b2b3', 'a6a2', 'f4e6', 'e4d3'], cp: -581 },
    { line: ['g2f1', 'b6b5', 'h4g6', 'e5d6', 'g6h8', 'a6a7', 'f1g1', 'd5d4', 'h8f7', 'd6d5', 'f7e5'], cp: -591 },
  ],
};
// a Stonewall-ish middlegame: the bishop comes out and c2–c4 hits d5
const STONEWALL = {
  fen: 'rn1q1rk1/pp1b2pp/2pbpn2/3p1p2/1P6/P2PPN2/1BP1BPPP/RN1Q1RK1 w - - 1 9',
  lines: [
    { line: ['b1d2', 'd8e7', 'e3e4', 'f5e4', 'd3e4', 'e6e5', 'f1e1', 'a7a5', 'b4a5', 'a8a5', 'e2d3', 'd7g4', 'e4d5', 'c6d5', 'c2c4', 'e5e4'], cp: 61 },
    { line: ['c2c4', 'a7a5', 'c4c5', 'd6c7', 'b1d2', 'd7e8', 'b2e5', 'c7e5', 'f3e5', 'b8d7', 'f2f4', 'd7e5', 'f4e5', 'f6d7', 'd3d4', 'd8g5'], cp: 55 },
    { line: ['b2e5', 'd7e8', 'b1d2', 'e8h5', 'c2c4', 'd6e5', 'f3e5', 'h5e2', 'd1e2', 'b8d7', 'd2f3', 'd7e5', 'f3e5', 'f6d7', 'e5f3', 'd8e7'], cp: 25 },
  ],
};

describe('the plan Stockfish\'s good lines share', () => {
  it('the themes, not the moves: a knight rerouted, a file taken, a weakness left behind', () => {
    expect(coach.deepPlan(KNIGHT.fen, KNIGHT.lines, 'white'))
      .toBe("The idea here: reroute your knight to c6 via e7, take the b-file with a rook and leave them with an isolated pawn on b5 — most of Stockfish's good lines do this.");
  });

  it('a piece and a pawn break, in the order they come', () => {
    const plan = coach.deepPlan(STONEWALL.fen, STONEWALL.lines, 'white')!;
    expect(plan).toMatch(/^The idea here: bring your light-squared bishop to life, strike with c4 and trade off the dark-squared bishops/);
    expect(plan).toMatch(/most of Stockfish's good lines do this\.$/);
  });

  it('from the other side, it\'s their idea', () => {
    const theirs = coach.deepPlan(KNIGHT.fen, KNIGHT.lines.map((l) => ({ ...l, cp: -l.cp })), 'black')!;
    expect(theirs).toMatch(/^Their idea: reroute their knight to c6 via e7/);
    expect(theirs).toMatch(/leave you with an isolated pawn on b5/);
  });

  it('a line that wins material is a tactic, not a plan', () => {
    const fork = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 30';
    expect(coach.deepPlan(fork, [{ line: ['b5c7', 'e8d8', 'c7a8', 'd8c8', 'e1d2', 'c8b7', 'd2d3', 'b7a8'], cp: 500 }], 'white')).toBe(null);
  });

  it('a line Stockfish rates much worse than the best doesn\'t count', () => {
    const [best, second] = STONEWALL.lines;
    // only the best line is good: its own changes, labelled as one line
    expect(coach.deepPlan(STONEWALL.fen, [best, { ...second, cp: best.cp - 200 }], 'white')).toMatch(/\(Stockfish's line\)/);
  });
});

describe('a search that can be called off', () => {
  const slow = (): Engine & { stop: () => void } => {
    let release: (() => void) | null = null;
    return {
      analyse: (b: Board) => new Promise<InfoLine[]>((resolve) => {
        release = () => resolve([{ pv: b.legalMoves().slice(0, 1), score: new PovScore(Score.cp(0), b.turn), depth: 9 }]);
      }),
      stop: () => release?.(),
    };
  };

  it('stopped while running: ends with what it found; stopped while waiting: never runs', async () => {
    const shared = new SharedEngine(async () => slow());
    const first = shared.stoppable(Board.fromFen(), { depth: 18 }, 3);
    const second = shared.stoppable(Board.fromFen(), { depth: 18 }, 3);
    await new Promise((r) => setTimeout(r, 0));
    second.stop();                              // still waiting its turn
    first.stop();                               // the one running
    expect((await first.result)[0].depth).toBe(9);
    expect(await second.result).toEqual([]);
  });
});

describe('Deep coach in the Ideas', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v),
    };
  });
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  const client = { service: async (name: string) => (name === 'getSettings' ? { analysis_ideas: '1' } : undefined) } as unknown as DbClient;
  const quick = (b: Board): InfoLine[] => [{ pv: b.legalMoves().slice(0, 2), score: new PovScore(Score.cp(-570), b.turn), depth: 12 }];
  const deepLines = (): InfoLine[] => KNIGHT.lines.map((l) => ({ pv: l.line, score: new PovScore(Score.cp(l.cp), 'white'), depth: 18 }));

  it('off by default; on: the quick ideas first, then the shared plan as a key idea', async () => {
    expect(deepCoach()).toBe(false);
    let deepAsked = 0;
    const fake = { analyse: async (b: Board) => quick(b), stoppable: () => { deepAsked += 1; return { result: Promise.resolve(deepLines()), stop: () => {} }; } };
    const pending: boolean[] = [];
    const c: CoachIdeas = new CoachIdeas(client, 'analysis_ideas', fake as unknown as Engine, () => pending.push(c.deepPending));
    await c.load();
    await c.explain({ fen: KNIGHT.fen, me: 'white' });
    expect(deepAsked).toBe(0);                          // off: no deep search
    setDeepCoach(true);
    await new Promise((r) => setTimeout(r, 0));
    await c.explain({ fen: KNIGHT.fen, me: 'white' });
    expect(deepAsked).toBeGreaterThan(0);
    expect(pending).toContain(true);                    // "Deep coach is reading Stockfish's lines…" was shown
    expect(c.deepPending).toBe(false);
    expect(c.ideas?.key.join(' ')).toMatch(/reroute your knight to c6 via e7/);
    // "see where it leads": the deep line, for the preview board, and whose side you are
    expect(c.ideas?.deepLine).toEqual(KNIGHT.lines[0].line.slice(0, coach.DEEP_PLIES));
    expect(c.ideas?.me).toBe('white');
  });
});

describe('Deep coach checks the advice again, against its deeper lines', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  });
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  // White has a rook and open files: "a rook there would be well placed" — or not, depending on the search
  const FEN = '4k3/p7/8/8/8/8/P7/R3K3 w - - 0 30';
  const line = (pv: string[], cp: number): InfoLine => ({ pv, score: new PovScore(Score.cp(cp), 'white'), depth: 18 });
  const client = { service: async (n: string) => (n === 'getSettings' ? { analysis_ideas: '1' } : undefined) } as unknown as DbClient;

  it('a verdict the deeper lines overturn: left out at first, then confirmed', async () => {
    const fake = {
      // the quick pass: king moves on top, and every rook move to the file clearly worse
      analyse: async (b: Board, _l: unknown, multipv?: number, rootMoves?: string[]) => {
        if (rootMoves?.length) return [line([rootMoves[0]], -250)];
        if (b.turn !== 'white') return [{ pv: b.legalMoves().slice(0, 1), score: new PovScore(Score.cp(0), b.turn) }];
        return [line(['e1d2', 'e8d7'], 30), line(['e1e2', 'e8d7'], 25), line(['e1f2', 'e8d7'], 20)].slice(0, multipv ?? 1);
      },
      // the deep pass: a rook move to the open file is Stockfish's best
      stoppable: () => ({ result: Promise.resolve([line(['a1b1', 'e8d7', 'b1b7', 'd7c6', 'b7a7', 'c6b6', 'a7a3', 'b6b5'], 60),
        line(['e1d2', 'e8d7', 'd2c3', 'd7c6', 'c3b4', 'c6b6', 'a1f1', 'b6c6'], 30)]), stop: () => {} }),
    };
    const shown: (string | undefined)[] = [];
    const c: CoachIdeas = new CoachIdeas(client, 'analysis_ideas', fake as unknown as Engine,
      () => shown.push(c.ideas?.points.find((p) => p.rule === 'open-file')?.text));
    await c.load();
    setDeepCoach(true);
    await new Promise((r) => setTimeout(r, 0));
    await c.explain({ fen: FEN, me: 'white' });
    expect(shown).toContain(undefined);                                 // the quick check left it out
    expect(c.ideas?.points.find((p) => p.rule === 'open-file')?.text).toMatch(/(is|are) open: a rook there would be well placed\./);   // confirmed by the deep lines
  });
});
