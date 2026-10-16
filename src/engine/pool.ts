/**
 * Several Stockfish engines side by side, for bulk work — the web version of
 * analyzer.evaluate_games_parallel and puzzle_kind.classify_all: each engine
 * takes the next job from the list (newest first stays roughly in order).
 * Phase 0: two single-threaded engines give ~2x the throughput of one, and
 * beat one multi-threaded engine at depth 14.
 */
import type { Engine } from '../core/engine';

export async function runPool<T, R>(
  engines: Engine[], jobs: T[], work: (engine: Engine, job: T) => Promise<R>,
  onDone?: (job: T, result: R) => void | Promise<void>, shouldStop?: () => boolean,
): Promise<number> {
  let next = 0;
  let finished = 0;
  let failure: unknown = null;
  const lane = async (engine: Engine) => {
    while (failure === null && next < jobs.length && !shouldStop?.()) {
      const job = jobs[next++];
      try {
        const result = await work(engine, job);
        await onDone?.(job, result);   // saved before this engine takes its next job
        finished += 1;
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(engines.slice(0, Math.max(1, Math.min(engines.length, jobs.length))).map(lane));
  if (failure !== null) throw failure;
  return finished;
}

/** Engines to run side by side: one per physical core, at most 2 (as on desktop). */
export function parallelEngines(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(2, Math.floor(cores / 2)));
}
