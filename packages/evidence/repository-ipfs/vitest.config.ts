// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

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
});
