import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `$TMPDIR` is redirected at a managed root before any test module loads and swept on
    // teardown, so nothing this suite creates with `mkdtemp(join(tmpdir(), …))` outlives the run —
    // including what a failing file leaves behind. See ../../../test-support/tmp-isolation/README.md.
    setupFiles: ["../../../test-support/tmp-isolation/isolate-tmp.ts"],
    // Per-run registry in the main process: each test file records its managed root there, and the
    // teardown removes every recorded root once every worker is gone. That is what covers a
    // fully-skipped file (which fires no `afterAll`), a hard-killed worker, and Ctrl-C.
    globalSetup: ["../../../test-support/tmp-isolation/global-tmp-root.ts"],
    // Both M2.5 and M3.5 own ephemeral Anvil forks backed by the same public Base-Sepolia
    // endpoint. Serializing the files keeps fork setup and transaction latency inside the
    // conformance vectors' five-second budgets instead of making unrelated vectors contend.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
