import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The sweep seam below lives three levels above this package, and this is the repository's one
  // Vitest suite that runs in a browser-shaped environment (`jsdom`, further down). That
  // combination is what needs this block: a jsdom suite loads its setup files through Vite's web
  // transform pipeline, which serves anything outside the Vite root under a `/@fs/` URL and refuses
  // the ones `server.fs.allow` does not cover. Explorer carries its own `yarn.lock` with no
  // workspace above it, so the root Vite infers is this directory and the seam is outside it.
  // Without the allowance every test file fails to load with
  // `Cannot find module '/@fs/…/test-support/tmp-isolation/isolate-tmp.ts'` — 34 files, no tests
  // run, and the suite reports as failed rather than as leaking. The Node-environment suites that
  // wire the same seam never take this path, which is why this is the only config that needs it.
  server: {
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../../../', import.meta.url))],
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // `$TMPDIR` is redirected at a managed root before any test module loads and swept on
    // teardown, so nothing this suite creates with `mkdtemp(join(tmpdir(), …))` outlives the run —
    // including what a failing file leaves behind. See ../../../test-support/tmp-isolation/README.md.
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
