import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** During development, the Fastify server owns every non-asset route. */
const apiServer = process.env.RIPPLE_API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['ripple-source'] },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The production policy allows fonts only from this origin, so never inline them as data URIs.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
  server: {
    port: 5173,
    proxy: {
      '/health': apiServer,
      '/api': apiServer,
    },
  },
});
