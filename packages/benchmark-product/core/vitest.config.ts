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
    // The suite performs crypto/key generation and temporary-workspace I/O, and 18 of its files
    // write fake harness executables and spawn them as real subprocesses. Two workers retain
    // file-level parallel coverage while bounding that shared-resource pressure; four workers
    // still starved unrelated sub-second cases outright on the shared local/CI-class runner.
    maxWorkers: 2,
    // Vitest's per-test bound is wall clock, so a descheduled worker spends it without doing work.
    // That is what this suite hands it: the file count went 68 (ship) → 135 → 185, and
    // `src/operations/judge-rehearsal.test.ts` now holds one of the two workers for most of a run
    // on its own (2,165,911ms of the 2,690s run in CI 33003612122). Every other file queues on the
    // other worker and competes with that one for cores, which is why the timeouts wander: on
    // 2026-08-17 four unrelated files failed across four branches and one passed unchanged on
    // re-run, and 33003612122 failed `src/operations/run-launch.test.ts` at 5000ms on a case whose
    // real cost is milliseconds (issue #2766).
    //
    // 30s is not a guess: 114 tests across 23 files in this suite already carry a hand-applied
    // `}, 30_000)` added one flake at a time since 2026-08-10, so it is the bound the suite has
    // already converged on — this hoists it to cover the tests nobody has been bitten by yet.
    // It matches `operator/vitest.config.ts`, which raised the same 5s default for the same
    // reason. A genuine hang still fails fast relative to a suite that runs for tens of minutes.
    // Hooks take the same bound: the per-test `beforeEach` in these files does workspace
    // `mkdtemp` and writes executables, which is the same starvation surface.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
