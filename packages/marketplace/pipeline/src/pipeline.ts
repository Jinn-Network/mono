// SPDX-License-Identifier: MIT

import type { AttemptUri, TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import {
  documentDigest,
  serializeCanonicalJson,
  type AttemptState,
  type DispatchContext,
} from "@jinn-network/task-execution-protocol";
import type { Hex } from "viem";
import {
  claimAttempt,
  convergeDelivery,
  settleDelivery,
  type ClaimPorts,
  type IpfsPinPort,
  type MarketplaceChainConfig,
  type SettlementPorts,
  type SettlementResult,
} from "@jinn-network/marketplace-binding";
import { evaluateClaimPredicate } from "./claim-predicate.js";
import { checkCaps } from "./caps.js";
import { buildEngagement } from "./engage.js";
import { resolveWiringEntry, wiringHonorsPinning } from "./execution-wiring.js";
import { verifyPreclaim } from "./preclaim.js";
import type {
  ClaimPredicate,
  ExecutionWiringEntry,
  OperatorCaps,
  SubmissionFacts,
} from "./types.js";

export type FinalityAwaitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "reorged" | "failed" };

/** Required injected port: gate expensive execution on finalized claim facts (design §8, N2). */
export interface FinalityPort {
  awaitFinalized(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly claimTxHash: Hex;
  }): Promise<FinalityAwaitResult>;
}

export type DeliveryWaitResult =
  | { readonly ok: true; readonly deliveryBytes: Uint8Array }
  | {
      readonly ok: false;
      readonly kind: "timeout" | "cancelled" | "backend-terminal";
      readonly state?: AttemptState;
    };

/** Cancel/timeout-aware delivery wait — the library owns no poll timer policy. */
export interface DeliveryWaitPort {
  waitForDelivery(input: {
    readonly attemptUri: AttemptUri;
    readonly backend: TaskExecutionBackend;
    readonly signal?: AbortSignal;
  }): Promise<DeliveryWaitResult>;
}

export interface ReleaseAttemptPort {
  releaseAttempt(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
  }): Promise<void | { readonly ok: false; readonly kind: "unsupported" }>;
}

export interface PipelinePorts {
  readonly claim: ClaimPorts;
  readonly finality: FinalityPort;
  readonly deliveryWait: DeliveryWaitPort;
  readonly settlement: SettlementPorts;
  readonly ipfs: IpfsPinPort;
  /** Host-owned generation-specific venue release — required on every post-claim failure path. */
  readonly release: ReleaseAttemptPort;
}

export interface PipelineConfig {
  readonly chain: MarketplaceChainConfig;
  readonly predicate: ClaimPredicate;
  readonly caps: OperatorCaps;
  readonly wiring: readonly ExecutionWiringEntry[];
  readonly priorityMech: ClaimPorts["priorityMech"];
}

export type PipelineRunOutcome =
  | {
      readonly kind: "not-claimed";
      readonly reason:
        | "predicate-declined"
        | "caps-exceeded"
        | "pinning-mismatch"
        | "wiring-missing"
        | "profile-mismatch"
        | "unsupported-requirement"
        | "preflight-unavailable"
        | "preflight-not-ready";
    }
  | { readonly kind: "claim-refused"; readonly reason: string }
  | { readonly kind: "finality-failed"; readonly finalityKind: "reorged" | "failed"; readonly released: boolean }
  | { readonly kind: "submit-rejected"; readonly detail: string; readonly released: boolean }
  | { readonly kind: "delivery-wait-failed"; readonly waitKind: "timeout" | "cancelled" | "backend-terminal"; readonly state?: AttemptState; readonly released: boolean }
  | { readonly kind: "settlement-failed"; readonly result: SettlementResult; readonly released: boolean }
  | { readonly kind: "race-lost"; readonly state: AttemptState }
  | { readonly kind: "delivered"; readonly state: AttemptState };

export interface PipelineRunInput {
  readonly facts: SubmissionFacts;
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
}

function dispatchContextDigest(dispatchContext: DispatchContext): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson(dispatchContext as Parameters<typeof serializeCanonicalJson>[0]));
}

async function promptRelease(
  ports: PipelinePorts,
  taskId: bigint,
  attemptIndex: number,
): Promise<boolean> {
  const result = await ports.release.releaseAttempt({ taskId, attemptIndex });
  return result === undefined;
}

/**
 * Operator loop composing binding venue verbs with an embedded backend peer (§6.2, §7.18):
 * claim → finalized gate → two-party submit → wait → converge → settle.
 */
export async function runPipeline(
  input: PipelineRunInput,
  config: PipelineConfig,
  backend: TaskExecutionBackend,
  ports: PipelinePorts,
): Promise<PipelineRunOutcome> {
  const capabilities = await backend.capabilities();
  if (!evaluateClaimPredicate(config.predicate, input.facts, capabilities, config.caps)) {
    return { kind: "not-claimed", reason: "predicate-declined" };
  }
  if (!checkCaps(input.facts.intendedSpendWei, input.facts.intendedAiUnits, config.caps)) {
    return { kind: "not-claimed", reason: "caps-exceeded" };
  }
  const wiring = resolveWiringEntry(input.facts.workKind, config.wiring);
  if (wiring === undefined) {
    return { kind: "not-claimed", reason: "wiring-missing" };
  }
  if (!wiringHonorsPinning(input.facts, wiring)) {
    return { kind: "not-claimed", reason: "pinning-mismatch" };
  }

  const preclaim = await verifyPreclaim(input.facts, backend, capabilities);
  if (!preclaim.ok) {
    return { kind: "not-claimed", reason: preclaim.reason };
  }

  const claim = await claimAttempt(input.facts.taskId, config.chain, {
    ...ports.claim,
    taskDigest: input.facts.taskDigest,
    submission: input.facts.submission,
    nonce: input.facts.nonce,
    priorityMech: config.priorityMech,
  });
  if (!claim.ok) {
    return { kind: "claim-refused", reason: claim.reason };
  }

  const finality = await ports.finality.awaitFinalized({
    taskId: input.facts.taskId,
    attemptIndex: claim.attemptIndex,
    claimTxHash: claim.txHash,
  });
  if (!finality.ok) {
    const released = await promptRelease(ports, input.facts.taskId, claim.attemptIndex);
    return { kind: "finality-failed", finalityKind: finality.kind, released };
  }

  const engagement = buildEngagement({
    attemptUri: claim.attemptUri,
    dispatchContext: claim.dispatchContext,
  });
  const submitAck = await backend.submit(input.taskBytes, input.submissionBytes, engagement);
  if (!submitAck.accepted) {
    const released = await promptRelease(ports, input.facts.taskId, claim.attemptIndex);
    return { kind: "submit-rejected", detail: submitAck.error.message, released };
  }

  const deliveryWait = await ports.deliveryWait.waitForDelivery({
    attemptUri: claim.attemptUri,
    backend,
  });
  if (!deliveryWait.ok) {
    const released = await promptRelease(ports, input.facts.taskId, claim.attemptIndex);
    return {
      kind: "delivery-wait-failed",
      waitKind: deliveryWait.kind,
      state: deliveryWait.state,
      released,
    };
  }

  await convergeDelivery(deliveryWait.deliveryBytes, ports.ipfs);

  const settlement = await settleDelivery(
    {
      requestId: claim.requestId,
      expectedDispatchContextDigest: dispatchContextDigest(claim.dispatchContext),
    },
    deliveryWait.deliveryBytes,
    config.chain,
    ports.settlement,
  );
  if (!settlement.settled) {
    if (!("kind" in settlement)) {
      return { kind: "race-lost", state: settlement.state };
    }
    const released = await promptRelease(ports, input.facts.taskId, claim.attemptIndex);
    return { kind: "settlement-failed", result: settlement, released };
  }

  return { kind: "delivered", state: settlement.state };
}
