/**
 * Starting Stockfish in the browser: single-threaded builds served from
 * /engine/ (copied there from the stockfish npm package by
 * tools/copy-engine.mjs), one Web Worker per engine.
 *
 * Two strengths: "standard" (the 1.8 MB lite network: starts in a second) and
 * "strong" (the 95 MB full network: about 20 s to download the first time,
 * then cached by the browser; it picked the desktop's move more often in the
 * spikes/bench.html test, 65% against 62%). The choice is per device (it's a
 * download), kept in localStorage, and applies to the interactive engine and
 * Play it out; bulk analysis always uses the standard one, several at once.
 */
import { SharedEngine } from '../core/engineService';
import { UciEngine } from './uci';

export type Strength = 'standard' | 'strong';
const FLAVOR: Record<Strength, string> = { standard: 'stockfish-19-lite-single', strong: 'stockfish-19-single' };
const KEY = 'pawnpromoter.engineStrength';

export const engineUrl = (strength: Strength) => `${import.meta.env.BASE_URL}engine/${FLAVOR[strength]}.js`;
export const ENGINE_URL = engineUrl('standard');

/** The strength chosen on this device (standard if none, or storage is blocked). */
export function engineStrength(): Strength {
  try {
    return localStorage.getItem(KEY) === 'strong' ? 'strong' : 'standard';
  } catch {
    return 'standard';
  }
}

/** Changes the strength: the interactive engine restarts with it on its next search. */
export function setEngineStrength(strength: Strength): void {
  try {
    localStorage.setItem(KEY, strength);
  } catch { /* blocked storage: this session only */ }
  override = strength;
  shared?.restart();
}
let override: Strength | null = null;
const chosen = () => override ?? engineStrength();

/** A new Stockfish (its own Web Worker). Hash in MB, as on desktop's default. */
export async function startStockfish(hashMb = 16, strength: Strength = 'standard'): Promise<UciEngine> {
  const engine = new UciEngine(new Worker(engineUrl(strength)) as unknown as ConstructorParameters<typeof UciEngine>[0], { Hash: hashMb });
  await engine.whenReady();
  return engine;
}

/** Stockfish at the chosen strength; if the strong one won't load (memory,
 *  network), the standard one instead. */
export async function startChosenStockfish(hashMb = 16): Promise<UciEngine> {
  if (chosen() === 'standard') return startStockfish(hashMb);
  try {
    return await startStockfish(hashMb, 'strong');
  } catch (e) {
    console.warn('The strong engine did not start; using the standard one.', e);
    return startStockfish(hashMb);
  }
}

let shared: SharedEngine | null = null;

/** The app's one Stockfish for interactive work (analysis boards, explanations,
 *  Tactics & Threats) — engine_service.py's role. Started on first use. */
export function sharedEngine(): SharedEngine {
  shared ??= new SharedEngine(() => startChosenStockfish());
  return shared;
}
