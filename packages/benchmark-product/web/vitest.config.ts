import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The product graph is intentionally installed through Yarn portals. Keep those consumer
    // paths intact so Vitest resolves each portal's transitive packages from this web install,
    // matching Node's --preserve-symlinks runtime contract instead of requiring sibling
    // node_modules trees beside the real source paths.
    preserveSymlinks: true,
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
