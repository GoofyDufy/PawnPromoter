import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: './',                       // works from any folder (GitHub Pages, Cloudflare, a sub-path)
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },   // it loads its .wasm next to itself
  build: {
    target: 'es2022',
    // `vite build --mode e2e`: also the end-to-end test page, into its own folder (never shipped)
    ...(mode === 'e2e' ? { outDir: 'dist-e2e', rollupOptions: { input: { main: 'index.html', e2e: 'e2e.html' } } } : {}),
  },
}));
