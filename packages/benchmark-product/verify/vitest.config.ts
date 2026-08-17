// SPDX-License-Identifier: Apache-2.0

// The package's `node --test` suite runs against the built `dist/`; this vitest
// project exists for the conformance kits, which are authored in TypeScript and
// call `describe`/`test` from vitest directly. `tsconfig.build.json` excludes
// `src/**/*.test.ts`, so nothing collected here reaches the published package.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
