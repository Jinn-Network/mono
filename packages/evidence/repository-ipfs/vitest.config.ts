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
    testTimeout:
      process.env.JINN_KUBO_API_URL === undefined
        ? ORDINARY_TEST_TIMEOUT_MS
        : REAL_KUBO_TEST_TIMEOUT_MS,
  },
});
