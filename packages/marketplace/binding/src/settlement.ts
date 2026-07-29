// SPDX-License-Identifier: MIT

import type {
  AttemptState,
  DeliveryRecord,
} from "@jinn-network/task-execution-protocol";
import type { Hex } from "viem";
import type { MarketplaceChainConfig } from "./addresses.js";
import {
  checkDeliveryCorrespondence,
  DeliveryAdmissionError,
  inspectDelivery,
} from "./delivery.js";
import { ZeroEvidenceHashError } from "./venue/digest.js";
import type { IpfsPinPort } from "./venue/ipfs.js";

export interface SettlementAttempt {
  readonly requestId: Hex;
  readonly expectedDispatchContextDigest: `sha256:${string}`;
  /**
   * When present, the injected verifier must prove equality with the resolved Execution
   * Evidence's evaluationSpecification digest. Absence is the only case where not-applicable is
   * accepted.
   */
  readonly taskEvaluationDigest?: `sha256:${string}`;
}

type VerifiedCheck = { readonly status: "verified" };

export type ExecutorBindingCheck =
  | VerifiedCheck
  | {
      readonly status: "missing" | "invalid";
      readonly detail: string;
    };

export type DispatchBindingCheck =
  | VerifiedCheck
  | {
      readonly status: "missing" | "failed";
      readonly detail: string;
    };

export type EvaluationSpecificationCheck =
  | VerifiedCheck
  | { readonly status: "not-applicable" }
  | {
      readonly status: "missing" | "failed";
      readonly detail: string;
    };

/**
 * A verifier cannot collapse settlement-grade verification to one boolean: each mandatory check
 * is reported independently, and the binding refuses absent checks. Its implementation owns the
 * injected trust/binding resolvers and referenced-evidence resolver.
 */
export interface SettlementGradeVerification {
  readonly executorBinding: ExecutorBindingCheck;
  readonly dispatchBinding: DispatchBindingCheck;
  readonly evaluationSpecification: EvaluationSpecificationCheck;
}

export interface SettlementGradeVerificationInput {
  readonly attempt: SettlementAttempt;
  readonly delivery: DeliveryRecord;
  /** Exact fetched bytes; verifier implementations use these as the DSSE payload identity. */
  readonly deliveryBytes: Uint8Array;
  readonly deliveryDigest: `sha256:${string}`;
  readonly config: MarketplaceChainConfig;
}

export interface TodayDeliveryFacts {
  readonly generation: "today";
  /** Join key shared by the Mech Deliver and router facts. */
  readonly requestId: Hex;
  /** sha256 raw-CID digest from the Mech Deliver event. */
  readonly sha256CidDigest: `sha256:${string}`;
  /** keccak evidence hash recorded by the today-generation router. */
  readonly keccakEvidenceHash: Hex;
}

export interface RevisedDeliveryFacts {
  readonly generation: "revised";
  readonly requestId: Hex;
  /** Revised contracts anchor only the exact Delivery's sha256 digest. */
  readonly sha256Digest: `sha256:${string}`;
}

export type DeliveryChainFacts = TodayDeliveryFacts | RevisedDeliveryFacts;

export interface SettlementPorts {
  readonly pin: IpfsPinPort["pin"];
  readonly verifySettlementGrade: (
    input: SettlementGradeVerificationInput,
  ) => Promise<SettlementGradeVerification>;
  readonly readDeliveryFacts: (input: {
    readonly requestId: Hex;
    readonly config: MarketplaceChainConfig;
  }) => Promise<DeliveryChainFacts>;
  readonly claimSolutionDelivery: (input: {
    readonly requestId: Hex;
    readonly solutionDigest: Hex;
  }) => Promise<{
    readonly status:
      | "settled"
      | "already-settled"
      | "rejected"
      | "delivered-unsettled";
  }>;
}

export type SettlementGateFailure =
  | {
      readonly settled: false;
      readonly state: "rejected";
      readonly kind:
        | "invalid-delivery"
        | "noncanonical-delivery"
        | "missing-execution-ids"
        | "missing-evidence-records"
        | "executor-signature-invalid"
        | "dispatch-binding-failed"
        | "evaluation-specification-mismatch";
      readonly detail: string;
    }
  | {
      readonly settled: false;
      readonly state: "rejected";
      readonly kind: "zero-evidence-hash";
      readonly hash: Hex;
    }
  | {
      readonly settled: false;
      readonly state: "rejected";
      readonly kind: "request-id-mismatch";
      readonly expectedRequestId: Hex;
      readonly actualRequestId: Hex;
    }
  | {
      readonly settled: false;
      readonly state: "rejected";
      readonly kind: "chain-facts-generation-mismatch";
      readonly expectedGeneration: "today" | "revised";
      readonly actualGeneration: "today" | "revised";
    }
  | {
      readonly settled: false;
      readonly state: "rejected";
      readonly kind: "digest-divergence";
      readonly generation: "today";
      readonly asserted: {
        readonly sha256Digest: `sha256:${string}`;
        readonly keccakEvidenceHash: Hex;
      };
      readonly onChain: {
        readonly sha256CidDigest: `sha256:${string}`;
        readonly keccak: Hex;
      };
    }
  | {
      readonly settled: false;
      readonly state: "rejected";
      readonly kind: "digest-divergence";
      readonly generation: "revised";
      readonly asserted: {
        readonly sha256Digest: `sha256:${string}`;
      };
      readonly onChain: {
        readonly sha256Digest: `sha256:${string}`;
      };
    };

export type SettlementResult =
  | { readonly settled: true; readonly state: "delivered" }
  | { readonly settled: false; readonly state: AttemptState }
  | SettlementGateFailure;

export function mapRaceLoss(
  chainOutcome: "rejected" | "delivered-unsettled",
): AttemptState {
  return chainOutcome === "rejected" ? "rejected" : "delivered";
}

function verificationFailure(
  attempt: SettlementAttempt,
  verification: SettlementGradeVerification,
): SettlementGateFailure | undefined {
  if (verification.executorBinding.status !== "verified") {
    return {
      settled: false,
      state: "rejected",
      kind: "executor-signature-invalid",
      detail: verification.executorBinding.detail,
    };
  }
  if (verification.dispatchBinding.status !== "verified") {
    return {
      settled: false,
      state: "rejected",
      kind: "dispatch-binding-failed",
      detail: verification.dispatchBinding.detail,
    };
  }
  if (
    verification.evaluationSpecification.status === "missing"
    || verification.evaluationSpecification.status === "failed"
  ) {
    return {
      settled: false,
      state: "rejected",
      kind: "evaluation-specification-mismatch",
      detail: verification.evaluationSpecification.detail,
    };
  }
  if (
    verification.evaluationSpecification.status === "not-applicable"
    && attempt.taskEvaluationDigest !== undefined
  ) {
    return {
      settled: false,
      state: "rejected",
      kind: "evaluation-specification-mismatch",
      detail: "Task requires evaluationSpecification digest equality",
    };
  }
  return undefined;
}

function chainFactsFailure(
  attempt: SettlementAttempt,
  config: MarketplaceChainConfig,
  delivery: {
    readonly sha256Digest: `sha256:${string}`;
    readonly keccakEvidenceHash: Hex;
  },
  facts: DeliveryChainFacts,
): SettlementGateFailure | undefined {
  if (facts.generation !== config.generation) {
    return {
      settled: false,
      state: "rejected",
      kind: "chain-facts-generation-mismatch",
      expectedGeneration: config.generation,
      actualGeneration: facts.generation,
    };
  }
  if (facts.requestId !== attempt.requestId) {
    return {
      settled: false,
      state: "rejected",
      kind: "request-id-mismatch",
      expectedRequestId: attempt.requestId,
      actualRequestId: facts.requestId,
    };
  }

  if (facts.generation === "today") {
    if (facts.keccakEvidenceHash === `0x${"0".repeat(64)}`) {
      return {
        settled: false,
        state: "rejected",
        kind: "zero-evidence-hash",
        hash: facts.keccakEvidenceHash,
      };
    }
    const correspondence = checkDeliveryCorrespondence({
      sha256Digest: delivery.sha256Digest,
      keccakEvidenceHash: delivery.keccakEvidenceHash,
      onChainSha256CidDigest: facts.sha256CidDigest,
      onChainKeccak: facts.keccakEvidenceHash,
    });
    if (!correspondence.ok) {
      return {
        settled: false,
        state: "rejected",
        kind: "digest-divergence",
        generation: "today",
        asserted: correspondence.asserted,
        onChain: correspondence.onChain,
      };
    }
    return undefined;
  }

  if (facts.sha256Digest !== delivery.sha256Digest) {
    return {
      settled: false,
      state: "rejected",
      kind: "digest-divergence",
      generation: "revised",
      asserted: { sha256Digest: delivery.sha256Digest },
      onChain: { sha256Digest: facts.sha256Digest },
    };
  }
  return undefined;
}

/**
 * Settlement is reachable only after exact-byte admission, executor/dispatch/evaluation
 * verification, and generation-specific on-chain correspondence all succeed. Every failure
 * before that point is read-only: no pin and no claim transaction.
 */
export async function settleDelivery(
  attempt: SettlementAttempt,
  sealedDeliveryBytes: Uint8Array,
  config: MarketplaceChainConfig,
  ports: SettlementPorts,
): Promise<SettlementResult> {
  let delivery: ReturnType<typeof inspectDelivery>;
  try {
    delivery = inspectDelivery(sealedDeliveryBytes);
  } catch (error) {
    if (error instanceof DeliveryAdmissionError) {
      return {
        settled: false,
        state: "rejected",
        kind: error.kind,
        detail: error.detail,
      };
    }
    if (error instanceof ZeroEvidenceHashError) {
      return {
        settled: false,
        state: "rejected",
        kind: "zero-evidence-hash",
        hash: `0x${"0".repeat(64)}`,
      };
    }
    throw error;
  }

  const verification = await ports.verifySettlementGrade({
    attempt,
    delivery: delivery.delivery,
    deliveryBytes: sealedDeliveryBytes,
    deliveryDigest: delivery.sha256Digest,
    config,
  });
  const rejectedVerification = verificationFailure(attempt, verification);
  if (rejectedVerification !== undefined) return rejectedVerification;

  const facts = await ports.readDeliveryFacts({
    requestId: attempt.requestId,
    config,
  });
  const rejectedFacts = chainFactsFailure(attempt, config, delivery, facts);
  if (rejectedFacts !== undefined) return rejectedFacts;

  await ports.pin(sealedDeliveryBytes);
  const solutionDigest = config.generation === "today"
    ? delivery.keccakEvidenceHash
    : `0x${delivery.sha256Digest.slice("sha256:".length)}` as Hex;
  const result = await ports.claimSolutionDelivery({
    requestId: attempt.requestId,
    solutionDigest,
  });
  if (result.status === "settled" || result.status === "already-settled") {
    return { settled: true, state: "delivered" };
  }
  return {
    settled: false,
    state: mapRaceLoss(result.status),
  };
}
