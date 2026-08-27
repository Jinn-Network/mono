import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The conformance suite gates whichever implementation `src/conformance.ts` binds — the shipped
// package by default. Setting JINN_POLICY_CONFORMANCE=reference re-points that swap point at the
// kit's naive reference deriver, so the identical assertions run against two structurally
// different code paths (substrate §8's two-implementation requirement, kept live rather than
// historical). Nothing else in the suite changes.
const referenceConformance = process.env["JINN_POLICY_CONFORMANCE"] === "reference";

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
    include: ["src/**/*.test.ts"],
    alias: referenceConformance
      ? {
          "./conformance.js": fileURLToPath(
            new URL("./fixtures/reference/conformance.ts", import.meta.url),
          ),
        }
      : {},
  },
});
