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
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
