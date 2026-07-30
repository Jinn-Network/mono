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
    environment: "node",
  },
});
