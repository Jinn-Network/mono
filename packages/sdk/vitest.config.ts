import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `$TMPDIR` is redirected at a managed root before any test module loads and swept on
    // teardown, so nothing this suite creates with `mkdtemp(join(tmpdir(), …))` outlives the run —
    // including what a failing file leaves behind. See ../../test-support/tmp-isolation/README.md.
    setupFiles: ['../../test-support/tmp-isolation/isolate-tmp.ts'],
    // Per-run registry in the main process: each test file records its managed root there, and the
    // teardown removes every recorded root once every worker is gone. That is what covers a
    // fully-skipped file (which fires no `afterAll`), a hard-killed worker, and Ctrl-C.
    globalSetup: ['../../test-support/tmp-isolation/global-tmp-root.ts'],
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
