import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    proxy: {
      '/explorer': 'http://127.0.0.1:42069',
      '/graphql': 'http://127.0.0.1:42069',
      '/health': 'http://127.0.0.1:42069',
      '/ready': 'http://127.0.0.1:42069',
      '/status': 'http://127.0.0.1:42069',
    },
  },
});
