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
  readonly claimTask: (input: {
    taskId: bigint;
    priorityMech: Address;
    /** Durable product operation identity. Native callers always provide this value. */
    operationId?: string;
  }) => Promise<{
    attemptIndex: number;
    requestId?: Hex;
    txHash: Hex;
    blockNumber?: bigint;
    blockHash?: Hex;
  }>;
}

interface ClaimSuccessBase {
  readonly ok: true;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly attemptUri: AttemptUri;
  readonly txHash: Hex;
  readonly dispatchContext: DispatchContext;
}

export type ClaimAttemptResult =
  | { ok: false; kind: "pre-claim-rejected"; reason: string }
  | (ClaimSuccessBase & {
      readonly generation: "today";
      readonly requestId: Hex;
    })
  | (ClaimSuccessBase & {
      readonly generation: "revised";
    });

/** Today claims bind requestId; revised claims bind only monotonic task-attempt identity. */
export async function claimAttempt(taskId: bigint, config: MarketplaceChainConfig, ports: ClaimPorts): Promise<ClaimAttemptResult> {
  const capability = await ports.capabilityMatch();
  if (!capability.ok) return { ok: false, kind: "pre-claim-rejected", reason: capability.reason };
  const preflight = await ports.preflight?.() ?? { ok: true };
  if (!preflight.ok) return { ok: false, kind: "pre-claim-rejected", reason: preflight.reason };
  const receipt = await ports.claimTask({ taskId, priorityMech: ports.priorityMech });
  const attemptUri = deriveMarketplaceAttemptUri({ chainId: config.chainId, coordinator: config.taskCoordinator, taskId, attemptIndex: receipt.attemptIndex });
  const base = {
    ok: true as const,
    taskId,
    attemptIndex: receipt.attemptIndex,
    attemptUri,
    txHash: receipt.txHash,
    dispatchContext: {
      taskDigest: ports.taskDigest,
      submission: ports.submission,
      nonce: ports.nonce,
      attempt: attemptUri,
    },
  };
  if (config.generation === "revised") {
    if (receipt.requestId !== undefined) {
      throw new Error("revised claimTask must not return a requestId");
    }
    return { ...base, generation: "revised" };
  }
  if (receipt.requestId === undefined) {
    throw new Error("today claimTask must return a requestId");
  }
  return { ...base, generation: "today", requestId: receipt.requestId };
}

/** Correlation annotation carried by the later `attempt-engaged` projection. */
export function dispatchContextDescriptor(
  claim: Extract<ClaimAttemptResult, { ok: true }>,
): {
  readonly attempt: AttemptUri;
  readonly engagement: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly kind: "solution";
  };
  readonly txHash: Hex;
  readonly requestId?: Hex;
} {
  return {
    attempt: claim.attemptUri,
    engagement: {
      taskId: claim.taskId,
      attemptIndex: claim.attemptIndex,
      kind: "solution",
    },
    txHash: claim.txHash,
    ...(claim.generation === "today" ? { requestId: claim.requestId } : {}),
  };
}
