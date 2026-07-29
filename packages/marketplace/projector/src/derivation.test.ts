import { describe, expect, test } from "vitest";
import { createDerivationAnnotation } from "./derivation.js";

describe("createDerivationAnnotation", () => {
  test("carries the exact six EVM fields and all three ratified additions", () => {
    expect(
      createDerivationAnnotation(
        {
          chainId: 84532,
          address: "0x1111111111111111111111111111111111111111",
          blockNumber: 12_345_678n,
          blockHash: `0x${"2".repeat(64)}`,
          transactionHash: `0x${"3".repeat(64)}`,
          logIndex: 7,
          finalityTier: "safe",
        },
        "TaskAttemptCreated",
        "today",
      ),
    ).toEqual({
      chainId: 84532,
      contract: "0x1111111111111111111111111111111111111111",
      event: "TaskAttemptCreated",
      blockNumber: 12_345_678n,
      blockHash: `0x${"2".repeat(64)}`,
      txHash: `0x${"3".repeat(64)}`,
      logIndex: 7,
      finalityTier: "safe",
      contractGeneration: "today",
    });
  });
});
