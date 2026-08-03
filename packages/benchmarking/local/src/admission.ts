// SPDX-License-Identifier: MIT

import type {
  AdmissionEvidencePort,
  IntegrityTier,
  InScopeCell,
} from "@jinn-network/benchmarking-run";

/**
 * The task-admission facts the integrity tier is copied from (benchmarking design §8.4).
 * Never self-declared by the cell, never inferred from a delivery.
 */
export interface LocalAdmissionReceipt {
  /** Admission established approximately zero replay variance for the EvaluationSpec. */
  readonly zeroReplayVariance: boolean;
  /** The EvaluationSpec needs capabilities outside the venue (network, external services). */
  readonly externalCapabilities: boolean;
}

/**
 * `re-derivable` only where an admission receipt shows ~zero replay variance and no external
 * capabilities; otherwise `attested-only`, including whenever no receipt exists. The
 * conservative default is the whole point — a tier is never launderable upward.
 */
export function integrityTierFromReceipt(
  receipt: LocalAdmissionReceipt | undefined,
): IntegrityTier {
  if (receipt === undefined) return "attested-only";
  return receipt.zeroReplayVariance && !receipt.externalCapabilities
    ? "re-derivable"
    : "attested-only";
}

export interface LocalAdmissionEvidenceInput {
  /** Admission receipt lookup keyed by cell. An unknown cell has no receipt. */
  readonly receiptFor: (
    cell: Pick<InScopeCell, "cellKey" | "taskDigest" | "evaluationSpecDigest">,
  ) => LocalAdmissionReceipt | undefined | Promise<LocalAdmissionReceipt | undefined>;
}

/** Local-venue `AdmissionEvidencePort`. Absent input degrades to `attested-only`. */
export function localAdmissionEvidence(
  input?: LocalAdmissionEvidenceInput,
): AdmissionEvidencePort {
  return {
    async tierFor(cell) {
      if (input === undefined) return "attested-only";
      return integrityTierFromReceipt(await input.receiptFor(cell));
    },
  };
}
