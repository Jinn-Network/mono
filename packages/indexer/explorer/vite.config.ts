import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// JINN_INDEXER_URL lets reviewers point dev at the hosted indexer (e.g. the
// Railway-deployed Ponder at DEFAULT_TESTNET_DISCOVERY_URL) instead of running
// one locally on :42069. Falls back to the local default.
const proxyTarget = process.env.JINN_INDEXER_URL || 'http://127.0.0.1:42069';

export default defineConfig({
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    proxy: {
      '/explorer': { target: proxyTarget, changeOrigin: true },
      '/graphql': { target: proxyTarget, changeOrigin: true },
      '/health': { target: proxyTarget, changeOrigin: true },
      '/ready': { target: proxyTarget, changeOrigin: true },
      '/status': { target: proxyTarget, changeOrigin: true },
    },
  },
});
