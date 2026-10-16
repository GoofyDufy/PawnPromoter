/**
 * Starting Stockfish in the browser: the lite single-threaded build served
 * from /engine/ (copied there from the stockfish npm package by
 * tools/copy-engine.mjs), one Web Worker per engine.
 */
import { SharedEngine } from '../core/engineService';
import { UciEngine } from './uci';

export const ENGINE_URL = `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;

/** A new Stockfish (its own Web Worker). Hash in MB, as on desktop's default. */
export async function startStockfish(hashMb = 16): Promise<UciEngine> {
  const engine = new UciEngine(new Worker(ENGINE_URL) as unknown as ConstructorParameters<typeof UciEngine>[0], { Hash: hashMb });
  await engine.whenReady();
  return engine;
}

let shared: SharedEngine | null = null;

/** The app's one Stockfish for interactive work (analysis boards, explanations,
 *  Tactics & Threats) — engine_service.py's role. Started on first use. */
export function sharedEngine(): SharedEngine {
  shared ??= new SharedEngine(() => startStockfish());
  return shared;
}
