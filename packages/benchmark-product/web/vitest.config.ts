import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/server-only.ts", import.meta.url)),
      // Sibling dist, not the Yarn portal. Worktrees that share the primary
      // node_modules otherwise import a different checkout's core catalog.
      "@colophon-claims/core": fileURLToPath(new URL("../core/dist/index.js", import.meta.url)),
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
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
