/** Deep coach's 📖 story: Stockfish's line told as a scene, the blow, and how it ends. */
import { describe, expect, it } from 'vitest';
import { MATE_CP } from '../src/core/analyzer';
import { deepStory, lineStory } from '../src/core/story';

describe("Deep coach's story", () => {
  it('tells a sacrifice that ends in mate', () => {
    const story = lineStory('r5k1/5ppp/8/8/8/8/4QPPP/4R1K1 w - - 0 1', ['e2e8', 'a8e8', 'e1e8'], 'white', MATE_CP)!;
    expect(story).toMatch(/king/);
    expect(story).toMatch(/give something first|invest material/);
    expect(story).toMatch(/mate/);
    expect(story).toContain('(1.Qe8+ Rxe8)');                 // the moves stay, numbered, for the board's arrows
  });

  it('tells a fork from the scene to the material it wins', () => {
    const story = lineStory('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', ['d5c7', 'e8d7', 'c7a8', 'd7c8'], 'white', 900)!;
    expect(story).toMatch(/^Your opponent is two pawns up, but their rook on a8/);
    expect(story).toMatch(/hitting the king and the rook on a8 at once/);
    expect(story).toMatch(/you are a piece up and winning/);
    expect(story).not.toMatch(/tries to hold on/);
  });

  it('tells it from the other side: their idea against you', () => {
    const story = lineStory('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', ['d5c7', 'e8d7', 'c7a8', 'd7c8'], 'black', -900)!;
    expect(story).toMatch(/^You are two pawns up, but your rook on a8/);
    expect(story).toMatch(/their knight/);
    expect(story).toMatch(/your opponent is a piece up and winning/);
  });

  it('tells a quiet line as a plan', () => {
    const story = lineStory('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'f8c5', 'e1g1', 'e8g8'], 'white', 30)!;
    expect(story).toMatch(/tactic|slow story|where the pieces belong/);
    expect(story).toMatch(/about level/);
  });

  it("tells the line with the tactic in it, even when Stockfish's first choice is a quiet move", () => {
    const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1';
    const story = deepStory(fen, [{ line: ['e1d2', 'a8a7', 'd2d3', 'a7a8'], cp: 900 }, { line: ['d5c7', 'e8d7', 'c7a8', 'd7c8'], cp: 880 }], 'white')!;
    expect(story).toMatch(/hitting the king and the rook on a8 at once/);
    expect(story).toMatch(/Stockfish's first choice, 1\.Kd2, is about as good/);
  });

  it('tells an only move as a critical moment, not a plan', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'f8c5'];
    expect(deepStory(fen, [{ line, cp: 200 }, { line: ['a2a3', 'e7e5'], cp: 0 }], 'white')).toMatch(/only one move keeps your edge/);
    expect(deepStory(fen, [{ line, cp: 200 }, { line: ['a2a3', 'e7e5'], cp: 180 }], 'white')).not.toMatch(/Only one move/);
  });

  it('has nothing to tell without a line', () => {
    expect(lineStory('4k3/8/8/8/8/8/8/4K3 w - - 0 1', ['e1e2'], 'white', 0)).toBeNull();
  });
});

describe('the story names pieces where they stand', () => {
  it('a piece taken after it moves is named on its square now, then where it is taken', () => {
    // their rook is on d8; it steps to e8 during the line and is taken there
    const s = lineStory('3r2k1/5ppp/8/1B6/8/8/P4PPP/6K1 w - - 0 1', ['a2a3', 'd8e8', 'b5e8', 'g8f8', 'e8b5', 'f8e7'], 'white', 500)!;
    expect(s).toMatch(/their rook on d8 is/);
    expect(s).not.toMatch(/rook on e8 is/);
    expect(s).toMatch(/grabs the rook on e8/);
  });
});
