import { describe, expect, test, vi } from "vitest";
import { describeEscrowLifecycle, type ForkEscrowContext } from "./escrow-lifecycle.js";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";

describe("today-generation escrow lifecycle fixture (§13)", () => {
  test("drives real transaction legs through the fork context and asserts claim-time-spend plus race-loss", async () => {
    const context: ForkEscrowContext = {
      post: vi.fn(async () => ({ taskId: 9n, creatorBalanceBefore: 100n, creatorBalanceAfterPost: 70n })),
      claim: vi.fn(async () => ({ requestId: `0x${"a".repeat(64)}` as const, solutionBudgetBefore: 20n, solutionBudgetAfter: 10n })),
      deliver: vi.fn(async () => undefined),
      settle: vi.fn(async () => ({ raceLost: false })),
      verdict: vi.fn(async () => undefined),
      refund: vi.fn(async () => ({ refunded: 10n })),
    };
    await describeEscrowLifecycle(BASE_SEPOLIA_TODAY, context, "today");
    expect(context.post).toHaveBeenCalledOnce();
    expect(context.claim).toHaveBeenCalledWith({ taskId: 9n });
    expect(context.deliver).toHaveBeenCalledOnce();
    expect(context.settle).toHaveBeenCalledOnce();
    expect(context.verdict).toHaveBeenCalledOnce();
    expect(context.refund).toHaveBeenCalledWith({ taskId: 9n });
  });

  test("a settlement race loss is terminally non-failure and does not invent verdict/refund writes", async () => {
    const context: ForkEscrowContext = {
      post: vi.fn(async () => ({ taskId: 3n, creatorBalanceBefore: 20n, creatorBalanceAfterPost: 10n })),
      claim: vi.fn(async () => ({ requestId: `0x${"b".repeat(64)}` as const, solutionBudgetBefore: 10n, solutionBudgetAfter: 5n })),
      deliver: vi.fn(async () => undefined), settle: vi.fn(async () => ({ raceLost: true })),
      verdict: vi.fn(async () => undefined), refund: vi.fn(async () => ({ refunded: 5n })),
    };
    await describeEscrowLifecycle(BASE_SEPOLIA_TODAY, context, "today");
    expect(context.verdict).not.toHaveBeenCalled();
    expect(context.refund).not.toHaveBeenCalled();
  });
});
