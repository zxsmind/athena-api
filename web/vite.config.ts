import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The SPA is built straight into the server's static directory, which
 * `server/src/index.ts` serves from `public/` when that directory exists. No
 * server route changes are needed: HashRouter keeps every view on one URL the
 * static handler can resolve.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  /* Dev server: the API is the same origin in production, so /v1 is proxied
     to the running Athena instead of being fetched cross-origin. */
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:39921',
    },
  },
  build: {
    outDir: '../server/src/public',
    emptyOutDir: true,
  },
});
