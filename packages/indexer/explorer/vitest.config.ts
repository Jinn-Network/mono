import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // Playwright e2e specs live under test/e2e and run via `yarn e2e`.
    // Exclude them from vitest so they don't get picked up as unit tests.
    exclude: ['node_modules', 'dist', 'test/e2e/**'],
  },
});
