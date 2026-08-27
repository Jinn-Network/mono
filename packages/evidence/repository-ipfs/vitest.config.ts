// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

const ORDINARY_TEST_TIMEOUT_MS = 15_000;
const REAL_KUBO_TEST_TIMEOUT_MS = 120_000;

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
  },
  ssr: {
    noExternal: [
      "@jinn-network/evidence-protocol",
      "@jinn-network/evidence-repository",
    ],
  },
  test: {
    // `$TMPDIR` is redirected at a managed root before any test module loads and swept on
    // teardown, so nothing this suite creates with `mkdtemp(join(tmpdir(), …))` outlives the run —
    // including what a failing file leaves behind. See ../../../test-support/tmp-isolation/README.md.
    setupFiles: ["../../../test-support/tmp-isolation/isolate-tmp.ts"],
    // Per-run registry in the main process: each test file records its managed root there, and the
    // teardown removes every recorded root once every worker is gone. That is what covers a
    // fully-skipped file (which fires no `afterAll`), a hard-killed worker, and Ctrl-C.
    globalSetup: ["../../../test-support/tmp-isolation/global-tmp-root.ts"],
    testTimeout:
      process.env.JINN_KUBO_API_URL === undefined
        ? ORDINARY_TEST_TIMEOUT_MS
        : REAL_KUBO_TEST_TIMEOUT_MS,
  },
});
