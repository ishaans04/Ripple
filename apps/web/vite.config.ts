import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** During development, the Fastify server owns every non-asset route. */
const apiServer = process.env.RIPPLE_API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['ripple-source'] },
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      '/health': apiServer,
      '/api': apiServer,
    },
  },
});
