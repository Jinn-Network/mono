import { describe, expect, test, vi } from "vitest";
import { settleDelivery, mapRaceLoss } from "./settlement.js";

describe("settleDelivery", () => {
  test("settles a first valid delivery with the exact requestId and keccak digest", async () => {
    const claim = vi.fn(async () => ({ status: "settled" as const }));
    await expect(settleDelivery({ requestId: `0x${"a".repeat(64)}` }, new TextEncoder().encode("sealed"), { pin: async () => undefined, claimSolutionDelivery: claim }))
      .resolves.toEqual({ settled: true, state: "delivered" });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ requestId: `0x${"a".repeat(64)}` }));
  });

  test("maps a race loss to the observed non-failure state and is idempotent", async () => {
    expect(mapRaceLoss("rejected")).toBe("rejected");
    expect(mapRaceLoss("delivered-unsettled")).toBe("delivered");
    const claim = vi.fn(async () => ({ status: "already-settled" as const }));
    await expect(settleDelivery({ requestId: `0x${"a".repeat(64)}` }, new TextEncoder().encode("sealed"), { pin: async () => undefined, claimSolutionDelivery: claim }))
      .resolves.toEqual({ settled: true, state: "delivered" });
  });
});
