// Copies the Stockfish build the app uses (lite, single-threaded: 1.8 MB, no
// special server headers needed) from the stockfish npm package into
// public/engine/, where the app loads it as a Web Worker. The 95 MB full
// builds in the package are never shipped.
import { copyFileSync, mkdirSync } from 'node:fs';

const from = new URL('../node_modules/stockfish/bin/', import.meta.url);
const to = new URL('../public/engine/', import.meta.url);
mkdirSync(to, { recursive: true });
for (const file of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) copyFileSync(new URL(file, from), new URL(file, to));
console.log('Stockfish 19 lite copied to public/engine/');
