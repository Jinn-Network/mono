import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['../../../test-support/tmp-isolation/isolate-tmp.ts', './src/test-setup.ts'],
    // Per-run registry in the main process: each test file records its managed root there, and the
    // teardown removes every recorded root once every worker is gone. That is what covers a
    // fully-skipped file (which fires no `afterAll`), a hard-killed worker, and Ctrl-C.
    globalSetup: ['../../../test-support/tmp-isolation/global-tmp-root.ts'],
    // Playwright e2e specs live under test/e2e and run via `yarn e2e`.
    // Exclude them from vitest so they don't get picked up as unit tests.
    exclude: ['node_modules', 'dist', 'test/e2e/**'],
  },
});
