import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The conformance kit reads `describe`/`it`/`expect` off `globalThis` at call
    // time so the module stays importable outside a test run (see src/testing.ts).
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
