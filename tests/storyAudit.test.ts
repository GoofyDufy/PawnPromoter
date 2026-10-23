// Reading Deep coach's 📖 stories on real puzzles (not part of the normal run): with STORY_SAMPLE set to a JSON
// list of puzzles (exported from your database) and STORY_ENGINE to a Stockfish on this computer, tells the
// story of Stockfish's depth-18 line for each and writes them to STORY_OUT, beside the line itself.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreToCp } from '../src/core/analyzer';
import { Board } from '../src/core/chess';
import { DEEP_PLIES, deepPlan, positionIdeas } from '../src/core/coach';
import { type InfoLine, parseInfo } from '../src/core/engine';
import { deepStory } from '../src/core/story';

interface Puzzle { id: string; fen: string; san: string; type: string; kind: string }

const samplePath = process.env.STORY_SAMPLE;
const enginePath = process.env.STORY_ENGINE;

/** Stockfish's best line from a position, at a depth. */
function search(path: string) {
  const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let onLine: ((l: string) => void) | null = null;
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); onLine?.(l); }
  });
  const send = (c: string) => proc.stdin.write(`${c}\n`);
  send('uci');
  return {
    top: (board: Board, depth: number, multipv: number) => new Promise<InfoLine[]>((resolve) => {
      const best = new Map<number, InfoLine>();
      onLine = (l) => {
        if (l.startsWith('info') && l.includes(' pv ')) { const x = parseInfo(l, board.turn); if (x) best.set(x.multipv, x); }
        if (l.startsWith('bestmove')) { onLine = null; resolve([...best].sort((a, b) => a[0] - b[0]).map(([, v]) => v)); }
      };
      send(`setoption name MultiPV value ${multipv}`);
      send(`position fen ${board.fen()}`);
      send(`go depth ${depth}`);
    }),
    quit: () => send('quit'),
  };
}

describe.skipIf(!samplePath || !enginePath)('Story audit', () => {
  it('tells the story of each puzzle', async () => {
    const puzzles: Puzzle[] = JSON.parse(readFileSync(samplePath!, 'utf8'));
    const engine = search(enginePath!);
    const out: string[] = [];
    for (const [k, p] of puzzles.entries()) {
      const board = Board.fromFen(p.fen);
      const lines = (await engine.top(board, 18, 3)).filter((l) => l.pv.length);
      const info = lines[0];
      if (!info) continue;
      const me = board.turn;
      // what Deep coach showed before the story: its plan sentence and the key ideas, from the same three lines
      const deepLines = lines.map((l) => ({ line: l.pv, cp: scoreToCp(l.score, me) }));
      const plan = deepPlan(p.fen, deepLines, me);
      const ideas = positionIdeas({ fen: p.fen, me, cp: deepLines[0].cp, bestLine: info.pv, deep: plan,
        alternatives: deepLines.map((l) => ({ move: l.line[0], cp: l.cp, line: l.line })) });
      const line = info.pv.slice(0, DEEP_PLIES);
      const story = deepStory(p.fen, deepLines.map((l) => ({ line: l.line.slice(0, DEEP_PLIES), cp: l.cp })), me);
      const sans: string[] = [];
      const b = board.copy();
      for (const m of line) { if (!b.isLegal(m)) break; sans.push(b.san(m)); b.push(m); }
      out.push(`## ${k + 1}. ${p.kind} · ${p.type} — you play ${me}, best ${p.san}\n\n${p.fen}\n\nLine: ${sans.join(' ')} (${scoreToCp(info.score, me)} cp)\n\n**Before:** ${ideas.summary}\n${ideas.key.map((k) => `- ${k}`).join('\n')}\n\n**Story:** ${story ?? '(no story)'}\n`);
      expect(story === null || story.length > 20).toBe(true);
    }
    engine.quit();
    if (process.env.STORY_OUT) writeFileSync(process.env.STORY_OUT, out.join('\n'));
  }, 600_000);
});
