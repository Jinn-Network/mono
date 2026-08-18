import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Point `$TMPDIR` at a managed root before any test module loads, so the workspace roots this
    // suite creates with `mkdtemp(join(tmpdir(), …))` are swept on teardown instead of
    // accumulating in the user temp directory. See src/test-support/isolate-tmp.ts.
    setupFiles: ["./src/test-support/isolate-tmp.ts"],
    // The 62-file suite performs crypto/key generation and temporary-workspace I/O. Two workers
    // retain file-level parallel coverage while bounding that shared-resource pressure; four
    // workers still starved unrelated sub-second cases past Vitest's fail-loud 5s default on the
    // shared local/CI-class runner. Keep the default timeout so a real deadlock still fails fast.
    maxWorkers: 2,
  },
});
