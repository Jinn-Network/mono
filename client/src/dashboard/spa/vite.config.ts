import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
