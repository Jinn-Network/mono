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
