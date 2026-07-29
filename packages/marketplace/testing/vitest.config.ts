import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Both M2.5 and M3.5 own ephemeral Anvil forks backed by the same public Base-Sepolia
    // endpoint. Serializing the files keeps fork setup and transaction latency inside the
    // conformance vectors' five-second budgets instead of making unrelated vectors contend.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
