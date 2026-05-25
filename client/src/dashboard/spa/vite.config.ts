import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:7331',
      '/artifacts': 'http://127.0.0.1:7331',
      '/auth': 'http://127.0.0.1:7331',
      '/api': 'http://127.0.0.1:7331',
    },
  },
});
