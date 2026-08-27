import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The shared seam's own behavioural coverage runs here — this is the suite that measured the
    // leak it exists to stop, and no package's tsconfig reaches outside its own `src`, so this is
    // where those cases get executed. Every other suite's wiring is held by
    // `.github/scripts/vitest-tmp-isolation.test.mjs`.
    include: ["src/**/*.test.ts", "../../../test-support/tmp-isolation/*.test.ts"],
    // Point `$TMPDIR` at a managed root before any test module loads, so the workspace roots this
    // suite creates with `mkdtemp(join(tmpdir(), …))` are swept on teardown instead of
    // accumulating in the user temp directory. See ../../../test-support/tmp-isolation/README.md.
    setupFiles: ["../../../test-support/tmp-isolation/isolate-tmp.ts"],
    // Create one per-run registry in the main process: each test file records its root there, and
    // the teardown removes every recorded root once every worker is gone. A fully-skipped test file
    // runs no suite, so the per-file `afterAll` sweep above never fires for it; this is what keeps
    // those files — and a hard-killed worker, and Ctrl-C — from leaving empty roots behind. See
    // ../../../test-support/tmp-isolation/README.md.
    globalSetup: ["../../../test-support/tmp-isolation/global-tmp-root.ts"],
    // The 62-file suite performs crypto/key generation and temporary-workspace I/O. Two workers
    // retain file-level parallel coverage while bounding that shared-resource pressure; four
    // workers still starved unrelated sub-second cases past Vitest's fail-loud 5s default on the
    // shared local/CI-class runner. Keep the default timeout so a real deadlock still fails fast.
    maxWorkers: 2,
  },
});
