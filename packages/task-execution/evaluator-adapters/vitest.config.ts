import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Point `$TMPDIR` at a managed root before any test module loads, so the workspace roots this
    // suite creates with `mkdtemp(join(tmpdir(), …))` are swept on teardown instead of
    // accumulating in the user temp directory. See src/test-support/isolate-tmp.ts.
    //
    // Deliberately no `include`: `yarn test` relied on Vitest's default glob before this file
    // existed, and narrowing it here would silently drop test files from the run.
    setupFiles: ["./src/test-support/isolate-tmp.ts"],
    // Create one temp root per run, in the main process, and remove it once every worker is gone.
    // A fully-skipped test file runs no suite, so the per-file `afterAll` sweep above never fires
    // for it; this is what keeps those files — and a hard-killed worker, and Ctrl-C — from leaving
    // empty roots behind. See src/test-support/global-tmp-root.ts.
    globalSetup: ["./src/test-support/global-tmp-root.ts"],
  },
});
