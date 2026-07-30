import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Real Linux custody shims are process-heavy; parallel files amplify GHA flake
    // (fingerprint races, sub-2s shutdown bounds, 5s default timeouts).
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
