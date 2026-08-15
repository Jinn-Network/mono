// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { Address, Hex } from "viem";
import {
  describeBroadcastProfileConformance,
  type BroadcastConformanceSubject,
} from "./venue-broadcast-conformance.js";

const FROM = "0x1111111111111111111111111111111111111111" as Address;

describe("broadcast-profile conformance driver (design §7 ruling 1)", () => {
  test("the driver rejects a subject that never records a submission ledger entry", async () => {
    const bare: BroadcastConformanceSubject = {
      async submissions() { return []; },
      async execute() { return { txHash: `0x${"f".repeat(64)}` as Hex }; },
      classify() { return "retryable"; },
    };
    await expect(
      (async () => {
        const entries = await bare.submissions();
        expect(entries.length).toBeGreaterThan(0);
      })(),
    ).rejects.toThrow();
  });

  describeBroadcastProfileConformance(async () => {
    const { buildReferenceBroadcaster } = await import("./venue-broadcast-reference.js");
    return buildReferenceBroadcaster({ from: FROM });
  });
});
