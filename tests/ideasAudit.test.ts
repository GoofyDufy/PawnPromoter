// Tuning the Coach's 💡 Ideas on real games (not part of the normal run): with IDEAS_SAMPLE set to a
// JSON list of positions (exported from your database), counts how often each rule fires — overall,
// by phase, and in the key ideas — and writes a readable dump of some positions to IDEAS_OUT.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/chess';
import * as coach from '../src/core/coach';
import { type Engine, type InfoLine, parseInfo } from '../src/core/engine';
import { scoreToCp } from '../src/core/analyzer';
import type { DbClient } from '../src/data/client';
import { CoachIdeas } from '../src/ui/coachIdeas';

interface Sample { game: string; ply: number; fen: string; move: string; best: string; cp: number; prevFen: string | null; prevMove: string | null; alts?: [string, number | null][] }

const samplePath = process.env.IDEAS_SAMPLE;
const enginePath = process.env.IDEAS_ENGINE;              // a Stockfish on this computer: the full pipeline, with its lines

/** A Stockfish binary over UCI, one search at a time (the app's Engine interface). */
function uciEngine(path: string): Engine & { quit(): void } {
  const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let onLine: ((l: string) => void) | null = null;
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); onLine?.(l); }
  });
  let queue: Promise<unknown> = Promise.resolve();
  const send = (c: string) => proc.stdin.write(`${c}\n`);
  send('uci');
  return {
    analyse(board, limit, multipv = 1, rootMoves?: string[]) {
      const run = queue.then(() => new Promise<InfoLine[]>((resolve) => {
        const best = new Map<number, InfoLine>();
        onLine = (l) => {
          if (l.startsWith('info') && l.includes(' pv ')) { const x = parseInfo(l, board.turn); if (x) best.set(x.multipv, x); }
          if (l.startsWith('bestmove')) { onLine = null; resolve([...best].sort((a, b) => a[0] - b[0]).map(([, v]) => v)); }
        };
        send(`setoption name MultiPV value ${multipv}`);
        send(`position fen ${board.fen()}`);
        send(`go depth ${limit.depth ?? 12}${rootMoves?.length ? ` searchmoves ${rootMoves.join(' ')}` : ''}`);
      }));
      queue = run.catch(() => undefined);
      return run;
    },
    quit() { send('quit'); },
  };
}

const settingsClient = { service: async (name: string) => (name === 'getSettings' ? { audit: '1' } : undefined) } as unknown as DbClient;
const sameSpot = (a: string, b: string) => a.split(' ').slice(0, 4).join(' ') === b.split(' ').slice(0, 4).join(' ');

/** The opponent's move between your previous move and this position, when it can be found. */
function theirMove(s: Sample): string | null | undefined {
  if (!s.prevFen || !s.prevMove) return undefined;
  const b = Board.fromFen(s.prevFen);
  if (!b.isLegal(s.prevMove)) return undefined;
  b.push(s.prevMove);
  return b.legalMoves().find((m) => { const c = b.copy(); c.push(m); return sameSpot(c.fen(), s.fen); }) ?? undefined;
}

/** The position just before this one (your previous move played), when known. */
function before(s: Sample): string | undefined {
  if (!s.prevFen || !s.prevMove) return undefined;
  const b = Board.fromFen(s.prevFen);
  if (!b.isLegal(s.prevMove)) return undefined;
  b.push(s.prevMove);
  return theirMove(s) ? b.fen() : undefined;
}

describe.skipIf(!samplePath)('Ideas audit', () => {
  it('rule frequencies', async () => {
    let samples: Sample[] = JSON.parse(readFileSync(samplePath!, 'utf8'));
    const engine = enginePath ? uciEngine(enginePath) : null;
    // the engine takes a while: every 5th position, unless IDEAS_ALL (the big runs)
    if (engine && !process.env.IDEAS_ALL) samples = samples.filter((_, n) => n % 5 === 0);
    // every verdict as a JSON line (IDEAS_JSON), and every RECHECK-th checked one again at depth 16
    const records: string[] = [];
    const recheckEvery = Number(process.env.IDEAS_RECHECK ?? 0);
    let checkedCount = 0;
    const ideasFor = new CoachIdeas(settingsClient, 'audit', engine, () => {});
    await ideasFor.load();
    const phase = (ply: number) => (ply <= 20 ? 'opening' : ply <= 70 ? 'middlegame' : 'endgame');
    const fired = new Map<string, { all: number; key: number; opening: number; middlegame: number; endgame: number }>();
    const perPhase = { opening: 0, middlegame: 0, endgame: 0 };
    let totalPoints = 0;
    let totalKey = 0;
    const dump: string[] = [];
    const verdicts = new Map<string, { agrees: number; contradicted: number; unverifiable: number; examples: string[] }>();
    const tactics = new Map<string, { works: number; fails: number; examples: string[] }>();
    for (const [n, s] of samples.entries()) {
      const b = Board.fromFen(s.fen);
      let ideas: coach.Ideas;
      if (engine) {
        await ideasFor.explain({ fen: s.fen, me: b.turn, cp: s.cp, theirMove: theirMove(s) ?? null, before: before(s) });
        ideas = ideasFor.ideas!;
        const tactical = ideas.points.some((p) => ['threat', 'forked', 'counterattack', 'skewered', 'pinned-win'].includes(p.rule))
          || /only if you find it|they have a (sacrifice|tactic)/.test(ideas.summary) || ideas.points.some((p) => p.rule === 'payoff' && /it's forced/.test(p.text));
        for (const v of ideasFor.adviceVerdicts) {
          if (v.verdict === 'unverifiable') { records.push(JSON.stringify({ kind: 'advice', rule: v.rule, verdict: v.verdict, phase: phase(s.ply), tactical, fen: s.fen, text: v.text })); continue; }
          let deep: number | null = null;
          checkedCount += 1;
          if (recheckEvery && checkedCount % recheckEvery === 0 && v.moves?.length) {
            const bd = Board.fromFen(s.fen);
            const [top] = await engine.analyse(bd, { depth: 16 });
            const [restricted] = await engine.analyse(bd, { depth: 16 }, 1, v.moves);
            if (top && restricted) deep = scoreToCp(top.score, b.turn) - scoreToCp(restricted.score, b.turn);
          }
          records.push(JSON.stringify({ kind: 'advice', rule: v.rule, verdict: v.verdict, gap: v.gap ?? null, deep, phase: phase(s.ply), tactical, fen: s.fen, text: v.text }));
        }
        for (const v of ideasFor.tacticVerdicts) records.push(JSON.stringify({ kind: 'tactic', rule: v.rule, verdict: v.verdict, why: v.why ?? null, phase: phase(s.ply), tactical, fen: s.fen, text: v.text }));
        for (const v of ideasFor.adviceVerdicts) {
          const e = verdicts.get(v.rule) ?? { agrees: 0, contradicted: 0, unverifiable: 0, examples: [] };
          e[v.verdict] += 1;
          if (v.verdict === 'contradicted' && e.examples.length < 2) e.examples.push(`${s.fen}  [${v.gap} worse] ${v.text}`);
          verdicts.set(v.rule, e);
        }
        for (const v of ideasFor.tacticVerdicts) {
          const e = tactics.get(v.rule) ?? { works: 0, fails: 0, examples: [] };
          e[v.verdict] += 1;
          if (v.verdict === 'fails' && e.examples.length < 3) e.examples.push(`${s.fen}  ${v.text} — but ${v.why}`);
          tactics.set(v.rule, e);
        }
      } else {
        ideas = coach.positionIdeas({ fen: s.fen, me: b.turn, cp: s.cp, bestLine: [s.best], theirMove: theirMove(s),
          alternatives: s.alts?.map(([move, cp]) => ({ move, cp })), before: before(s) });
      }
      const ph = phase(s.ply);
      perPhase[ph] += 1;
      const shown = ideas.points.filter((p) => p.section !== 'Who has what');
      totalPoints += shown.length;
      totalKey += ideas.key.length;
      for (const rule of new Set(ideas.points.map((p) => p.rule))) {
        const f = fired.get(rule) ?? { all: 0, key: 0, opening: 0, middlegame: 0, endgame: 0 };
        f.all += 1;
        f[ph] += 1;
        if (ideas.points.some((p) => p.rule === rule && ideas.key.includes(p.text))) f.key += 1;
        fired.set(rule, f);
      }
      if (n % (engine ? 3 : 15) === 0) {
        dump.push(`## ${s.game} ply ${s.ply} (${ph}) — ${b.turn} to move, eval ${s.cp}`, `FEN: ${s.fen}`, '', `**${ideas.summary}**`, '',
          'Key ideas:', ...ideas.key.map((k) => `- ${k}`), '', ...ideas.points.filter((p) => !ideas.key.includes(p.text) && p.section !== 'Who has what')
            .map((p) => `- [${p.rule} ${p.weight}] ${p.text}`), '');
      }
    }
    engine?.quit();
    const pct = (x: number, of: number) => `${Math.round((100 * x) / Math.max(1, of))}%`;
    const rows = [...fired].sort((a, b) => b[1].all - a[1].all)
      .map(([r, f]) => `${r.padEnd(26)} ${pct(f.all, samples.length).padStart(5)}  key ${pct(f.key, f.all).padStart(4)}  op ${pct(f.opening, perPhase.opening).padStart(4)}  mid ${pct(f.middlegame, perPhase.middlegame).padStart(4)}  end ${pct(f.endgame, perPhase.endgame).padStart(4)}`);
    const checked = [...verdicts].sort((a, b) => b[1].contradicted - a[1].contradicted)
      .map(([r, v]) => `${r.padEnd(26)} agrees ${String(v.agrees).padStart(3)}  contradicted ${String(v.contradicted).padStart(3)}  unverifiable ${String(v.unverifiable).padStart(3)}${v.examples.map((x) => `\n    ${x}`).join('')}`);
    const tacticRows = [...tactics].map(([r, v]) => `${r.padEnd(26)} works ${String(v.works).padStart(3)}  fails ${String(v.fails).padStart(3)}${v.examples.map((x) => `\n    ${x}`).join('')}`);
    const report = [...(checked.length ? ['Advice checked against Stockfish:', ...checked, ''] : []),
      ...(tacticRows.length ? ['Their tactics checked against Stockfish:', ...tacticRows, ''] : []), `${samples.length} positions · ${(totalPoints / samples.length).toFixed(1)} points each (besides "who has what") · ${(totalKey / samples.length).toFixed(1)} key ideas`, '', ...rows].join('\n');
    console.log(report);
    if (process.env.IDEAS_OUT) writeFileSync(process.env.IDEAS_OUT, `${report}\n\n${dump.join('\n')}`);
    if (process.env.IDEAS_JSON) writeFileSync(process.env.IDEAS_JSON, records.join('\n'));
    expect(samples.length).toBeGreaterThan(0);
  }, 10_800_000);                 // (the big runs take hours at most)
});
