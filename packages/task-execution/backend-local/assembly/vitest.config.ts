import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Real Linux custody shims are process-heavy; parallel files amplify GHA flake
    // (fingerprint races, sub-2s shutdown bounds, 5s default timeouts).
    fileParallelism: false,
    testTimeout: 20_000,
    // Keep the supervisor package on the real filesystem so native binary discovery
    // via package entry / import.meta.url still finds dist/native/*.
    server: {
      deps: {
        external: [/@jinn-network\/task-execution-supervisor(?:\/|$)/],
      },
    },
  },
});
