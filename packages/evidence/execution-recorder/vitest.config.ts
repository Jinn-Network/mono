// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

// Every recorder test does real durable file work: file and directory fsync, link and unlink
// publication, and a fresh workspace per case. Most cases take well under a second on a quiet
// disk, but the hosted runner runs the test files in parallel against one shared disk, and a
// stalled fsync there holds an ordinary case for several seconds. Eight cases that run in
// 0.3 to 1.4 seconds locally took 5.0 to 6.6 seconds in one merge-queue run and tripped the
// 5 second default, which ejected an unrelated change from the queue (#4982).
//
// 30 seconds is the limit the two heaviest cases in `finalization.test.ts` already carry, and it
// leaves roughly four times the slowest case observed on the runner. It is still a bound: a case
// that waits on something that never resolves fails at 30 seconds, well inside the job timeout.
const TEST_TIMEOUT_MS = 30_000;

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
    testTimeout: TEST_TIMEOUT_MS,
  },
});
