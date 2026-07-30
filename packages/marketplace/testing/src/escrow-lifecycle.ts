// SPDX-License-Identifier: MIT

import type { MarketplaceChainConfig } from "@jinn-network/marketplace-binding";
import type { ContractGeneration } from "@jinn-network/marketplace-binding";

/**
 * Transaction adapter for an ephemeral Anvil fork. Every method sends or reads the deployed
 * today-generation contract; the suite owns ordering and assertions, while setup (funding and
 * impersonation) remains local to the fork implementation.
 */
export interface ForkEscrowContext {
  post(): Promise<{ taskId: bigint; creatorBalanceBefore: bigint; creatorBalanceAfterPost: bigint }>;
  claim(input: { taskId: bigint }): Promise<{ requestId: `0x${string}`; solutionBudgetBefore: bigint; solutionBudgetAfter: bigint }>;
  deliver(input: { requestId: `0x${string}` }): Promise<void>;
  settle(input: { requestId: `0x${string}` }): Promise<{ raceLost: boolean }>;
  verdict(input: { taskId: bigint }): Promise<void>;
  refund(input: { taskId: bigint }): Promise<{ refunded: bigint }>;
}

/**
 * The §13 today-generation escrow lifecycle. The context is deliberately transaction-shaped so
 * a real Anvil fork cannot replace post/claim/deliver/settle/verdict/refund with a state oracle.
 */
export async function describeEscrowLifecycle(
  config: MarketplaceChainConfig,
  forkCtx: ForkEscrowContext,
  generation: ContractGeneration,
): Promise<void> {
  if (generation !== "today" || config.generation !== "today") {
    throw new Error("M3 escrow fixtures cover the deployed today generation only");
  }
  const posted = await forkCtx.post();
  const claimed = await forkCtx.claim({ taskId: posted.taskId });
  if (claimed.solutionBudgetAfter >= claimed.solutionBudgetBefore) {
    throw new Error("today claim must spend the solution budget at claim time (§5.2 residual)");
  }
  await forkCtx.deliver({ requestId: claimed.requestId });
  const settlement = await forkCtx.settle({ requestId: claimed.requestId });
  if (settlement.raceLost) {
    // A competitor's atomic first claim is not execution failure; callers map it to rejected or
    // delivered-but-unsettled, never failed (M3.3).
    return;
  }
  await forkCtx.verdict({ taskId: posted.taskId });
  const refund = await forkCtx.refund({ taskId: posted.taskId });
  if (refund.refunded <= 0n) throw new Error("today lifecycle fixture expected unused task budget refund");
}
