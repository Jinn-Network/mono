// SPDX-License-Identifier: MIT

import type { DispatchContext } from "@jinn-network/task-execution-protocol";
import type { Address, Hex } from "viem";
import type { AttemptUri } from "@jinn-network/task-execution-backend";
import type { MarketplaceChainConfig } from "./addresses.js";
import { deriveMarketplaceAttemptUri } from "./attempt-uri.js";

export type PreClaimResult = { ok: true } | { ok: false; reason: string };
export interface ClaimPorts {
  readonly taskDigest: `sha256:${string}`;
  readonly submission: `urn:uuid:${string}`;
  readonly nonce: string;
  readonly priorityMech: Address;
  readonly capabilityMatch: () => Promise<PreClaimResult>;
  readonly preflight?: () => Promise<PreClaimResult>;
  readonly claimTask: (input: { taskId: bigint; priorityMech: Address }) => Promise<{ attemptIndex: number; requestId: Hex; txHash: Hex }>;
}
export type ClaimAttemptResult =
  | { ok: false; kind: "pre-claim-rejected"; reason: string }
  | { ok: true; attemptIndex: number; attemptUri: AttemptUri; requestId: Hex; txHash: Hex; dispatchContext: DispatchContext };

/** Today-mode spends the Mech request at claim; revised-mode reservation-not-spend is M7 work. */
export async function claimAttempt(taskId: bigint, config: MarketplaceChainConfig, ports: ClaimPorts): Promise<ClaimAttemptResult> {
  const capability = await ports.capabilityMatch();
  if (!capability.ok) return { ok: false, kind: "pre-claim-rejected", reason: capability.reason };
  const preflight = await ports.preflight?.() ?? { ok: true };
  if (!preflight.ok) return { ok: false, kind: "pre-claim-rejected", reason: preflight.reason };
  const receipt = await ports.claimTask({ taskId, priorityMech: ports.priorityMech });
  const attemptUri = deriveMarketplaceAttemptUri({ chainId: config.chainId, coordinator: config.taskCoordinator, taskId, attemptIndex: receipt.attemptIndex });
  return { ok: true, ...receipt, attemptUri, dispatchContext: { taskDigest: ports.taskDigest, submission: ports.submission, nonce: ports.nonce, attempt: attemptUri } };
}

/** Correlation annotation carried by the later `attempt-engaged` projection. */
export function dispatchContextDescriptor(attemptUri: AttemptUri, requestId: Hex, txHash: Hex): { attempt: AttemptUri; requestId: Hex; txHash: Hex } {
  return { attempt: attemptUri, requestId, txHash };
}
