import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Dev server only (`npm run dev`, never in a build): GET /__king-coach/chessprep.db
 *  serves your desktop database (read, never written; KING_COACH_DB overrides
 *  the path), so Your data → "Load from King Coach" imports it in one click. */
function kingCoachDb(): Plugin {
  const path = process.env.KING_COACH_DB ?? join(homedir(), 'Chess', 'chessprep.db');
  return {
    name: 'king-coach-db',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__king-coach/chessprep.db', (req, res) => {
        const fail = (code: number, text: string) => { res.statusCode = code; res.setHeader('Content-Type', 'text/plain'); res.end(text); };
        const remote = req.socket.remoteAddress ?? '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return fail(403, 'Only from this computer.');
        if (!existsSync(path)) return fail(404, `No King Coach database at ${path}.`);
        if (existsSync(`${path}-journal`) || existsSync(`${path}-wal`)) return fail(409, 'King Coach is saving right now — close it and try again.');
        res.setHeader('Content-Type', 'application/x-sqlite3');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(path));
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',                       // works from any folder (GitHub Pages, Cloudflare, a sub-path)
  plugins: [react(), kingCoachDb()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },   // it loads its .wasm next to itself
  build: {
    target: 'es2022',
    // `vite build --mode e2e`: also the end-to-end test page, into its own folder (never shipped)
    ...(mode === 'e2e' ? { outDir: 'dist-e2e', rollupOptions: { input: { main: 'index.html', e2e: 'e2e.html' } } } : {}),
  },
}));
