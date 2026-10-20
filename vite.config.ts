import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Renderer (dashboard) build. Loaded by Electron from the app:// scheme, so asset paths are relative.
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome140',
    // The bundle is read from local disk (app://), never downloaded, so one chunk beats
    // code-splitting (no loading flash on navigation); 500 kB is a web-delivery advisory.
    chunkSizeWarningLimit: 1024,
    // 0.7.3: no modulepreload polyfill. Electron's Chromium supports modulepreload natively, the single
    // chunk has no preload links, and the polyfill is Vite's own (MIT) code inlined without its notice.
    modulePreload: { polyfill: false },
  },
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
});
