// Copies the Stockfish builds the app uses from the stockfish npm package into
// public/engine/, where the app loads them as Web Workers:
// - lite, single-threaded (1.8 MB): the default, and always used for bulk analysis;
// - full, single-threaded (95 MB, the full-strength network): "Strong" in
//   Your data → Engine, for the interactive screens and Play it out.
// Neither needs special server headers (no threads).
import { copyFileSync, mkdirSync } from 'node:fs';

const from = new URL('../node_modules/stockfish/bin/', import.meta.url);
const to = new URL('../public/engine/', import.meta.url);
mkdirSync(to, { recursive: true });
for (const flavor of ['stockfish-19-lite-single', 'stockfish-19-single']) {
  for (const ext of ['.js', '.wasm']) copyFileSync(new URL(flavor + ext, from), new URL(flavor + ext, to));
}
console.log('Stockfish 19 (lite and full) copied to public/engine/');
