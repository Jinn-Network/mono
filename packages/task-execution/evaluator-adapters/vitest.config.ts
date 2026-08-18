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
  },
});
