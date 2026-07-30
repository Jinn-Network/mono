import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The mandatory concrete-subject suite executes aggregate's current source, not a possibly
    // stale portal dist. CI still builds aggregate first to verify the public package artifact.
    alias: {
      "@jinn-network/benchmarking-aggregate": fileURLToPath(
        new URL("../aggregate/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
