// SPDX-License-Identifier: MIT

import type { AttemptState } from "@jinn-network/task-execution-protocol";

/** Fixture oracle for the deployed generation; the live transaction leg is run by the Anvil suite. */
export function assessTodayEscrowLifecycle(input: { posted: boolean; claimed: boolean; delivered: boolean; settled: boolean; refunded: boolean; raceLost: boolean }): { generation: "today"; claimTimeSpendResidual: boolean; terminalState: AttemptState; refundedUnusedBudget: boolean } {
  if (!input.posted || !input.claimed) throw new Error("today escrow fixture requires post then claim");
  const terminalState: AttemptState = input.raceLost ? "rejected" : input.delivered && input.settled ? "delivered" : "pending";
  return { generation: "today", claimTimeSpendResidual: input.claimed && !input.delivered, terminalState, refundedUnusedBudget: input.refunded };
}
