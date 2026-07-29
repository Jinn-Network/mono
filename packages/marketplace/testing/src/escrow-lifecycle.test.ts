import { describe, expect, test } from "vitest";
import { assessTodayEscrowLifecycle } from "./escrow-lifecycle.js";

describe("today-generation escrow lifecycle fixture (§13)", () => {
  test("records the honest claim-time-spend residual and preserves race-loss as non-failure", () => {
    expect(assessTodayEscrowLifecycle({ posted: true, claimed: true, delivered: false, settled: false, refunded: true, raceLost: true })).toEqual({
      generation: "today", claimTimeSpendResidual: true, terminalState: "rejected", refundedUnusedBudget: true,
    });
  });

  test("records a first valid delivery as settled before refund of unused capacity", () => {
    expect(assessTodayEscrowLifecycle({ posted: true, claimed: true, delivered: true, settled: true, refunded: true, raceLost: false })).toMatchObject({ terminalState: "delivered", claimTimeSpendResidual: false });
  });
});
