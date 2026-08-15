// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type {
  DeliveryWaitPort,
  DeliveryWaitResult,
  FinalityAwaitResult,
  FinalityPort,
  ReleaseAttemptPort,
} from "./index.js";

describe("pipeline-declared ports re-home on the binding's port surface (design §6.1 port-type home)", () => {
  test("a FinalityPort implementation satisfies the re-homed declaration", async () => {
    const port: FinalityPort = {
      async awaitFinalized(input) {
        expect(input.taskId).toBe(7n);
        expect(input.attemptIndex).toBe(0);
        expect(input.claimTxHash).toBe(`0x${"a".repeat(64)}`);
        const result: FinalityAwaitResult = { ok: false, kind: "reorged" };
        return result;
      },
    };
    await expect(
      port.awaitFinalized({ taskId: 7n, attemptIndex: 0, claimTxHash: `0x${"a".repeat(64)}` }),
    ).resolves.toEqual({ ok: false, kind: "reorged" });
  });

  test("a DeliveryWaitPort implementation satisfies the re-homed declaration", async () => {
    const bytes = new TextEncoder().encode("{}");
    const port: DeliveryWaitPort = {
      async waitForDelivery() {
        const result: DeliveryWaitResult = { ok: true, deliveryBytes: bytes };
        return result;
      },
    };
    const waited = await port.waitForDelivery({
      attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000000",
      backend: undefined as never,
    });
    expect(waited).toEqual({ ok: true, deliveryBytes: bytes });
  });

  test("a ReleaseAttemptPort implementation reports today-mode unsupported release", async () => {
    const port: ReleaseAttemptPort = {
      async releaseAttempt() {
        return { ok: false, kind: "unsupported" };
      },
    };
    await expect(port.releaseAttempt({ taskId: 1n, attemptIndex: 0 })).resolves.toEqual({
      ok: false,
      kind: "unsupported",
    });
  });
});
