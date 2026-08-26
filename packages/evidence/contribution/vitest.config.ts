// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jinn-network/evidence-derivation/testing": fileURLToPath(
        new URL("../derivation/src/testing.ts", import.meta.url),
      ),
      "@jinn-network/evidence-derivation": fileURLToPath(
        new URL("../derivation/src/index.ts", import.meta.url),
      ),
      "@jinn-network/evidence-publication/testing": fileURLToPath(
        new URL("../publication/src/testing.ts", import.meta.url),
      ),
      "@jinn-network/evidence-publication": fileURLToPath(
        new URL("../publication/src/index.ts", import.meta.url),
      ),
      "@jinn-network/evidence-repository/testing": fileURLToPath(
        new URL("../repository/src/testing.ts", import.meta.url),
      ),
      "@jinn-network/evidence-repository": fileURLToPath(
        new URL("../repository/src/index.ts", import.meta.url),
      ),
      "@jinn-network/evidence-protocol": fileURLToPath(
        new URL("../protocol/src/index.ts", import.meta.url),
      ),
    },
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
    environment: "node",
  },
});
