// SPDX-License-Identifier: Apache-2.0
import { createContributionReceiptFingerprint } from "./identities.js";
import { EvidenceContributionError } from "./errors.js";
import { deriveContributionAggregateStatus, type ContributionRequestState } from "./state.js";
import type { ContributionStore } from "./store.js";
import type {
  ContributionOperationOptions,
  ContributionReceipt,
  ContributionRequestId,
} from "./types.js";
import { toDestinationOutcomes } from "./read-model.js";

function fail(): never {
  throw new EvidenceContributionError("STORE_CORRUPT");
}

/**
 * Retention eligibility only -- Contribution reports live record and
 * artifact references but never deletes them (design §17.2). Declined,
 * withheld, deactivated, or completed requests may release staging
 * retention once their durable outcome is settled; every other status
 * (including `attention-required`, where a retry is still possible)
 * remains `required-for-recovery`.
 */
function computeStagingRetention(
  status: ReturnType<typeof deriveContributionAggregateStatus>,
): ContributionReceipt["stagingRetention"] {
  switch (status) {
    case "declined":
    case "withheld":
    case "deactivated":
    case "completed":
      return "eligible-for-host-cleanup";
    default:
      return "required-for-recovery";
  }
}

/**
 * Deterministically construct the current private operational receipt from
 * durable request state (design §9.5). Pure: the same state always
 * produces the same receipt.
 */
export function createContributionReceipt(
  state: ContributionRequestState,
): ContributionReceipt {
  const status = deriveContributionAggregateStatus(state);
  const preparation = state.preparation;
  return {
    schemaVersion: 1,
    requestId: state.requestId,
    status,
    source: state.proposal.source.record,
    policyDecision: state.proposal.policyDecision,
    ...(preparation.status === "preview-ready"
      ? {
        previewFingerprint: preparation.disclosure.previewFingerprint,
        preparedRecord: preparation.disclosure.manifest.preparedRecord,
        artifacts: preparation.disclosure.manifest.artifacts,
      }
      : {}),
    ...(preparation.status === "review-required"
      ? { reviewReference: preparation.reviewReference }
      : {}),
    ...(preparation.status === "withheld"
      ? { withheldReasons: preparation.reasons }
      : {}),
    ...(preparation.status === "declined"
      ? { declinedReasonCode: preparation.reasonCode }
      : {}),
    destinations: toDestinationOutcomes(state.destinations),
    stagingRetention: computeStagingRetention(status),
    generatedAt: state.updatedAt,
  };
}

/**
 * Append the current receipt to durable history if -- and only if -- it
 * differs from the most recently appended entry. Called at the final CAS
 * write of every command that changes an authorization, Publication,
 * decline, review, withholding, or deactivation outcome (design §9.5 /
 * Task 9). Pure; the caller performs the actual store write.
 */
export function appendCurrentContributionReceipt(
  state: ContributionRequestState,
): ContributionRequestState {
  const receipt = createContributionReceipt(state);
  const receiptFingerprint = createContributionReceiptFingerprint(receipt);
  const last = state.receipts[state.receipts.length - 1];
  if (last !== undefined && last.receiptFingerprint === receiptFingerprint) {
    return state;
  }
  return {
    ...state,
    receipts: [...state.receipts, { receipt, receiptFingerprint }],
  };
}

/**
 * Return the durable current-or-final receipt for a request: the most
 * recently appended entry if one exists (fails closed with `STORE_CORRUPT`
 * if it does not self-verify against its stored fingerprint), otherwise a
 * freshly derived receipt for a request that has not yet reached any
 * append-worthy transition (e.g. still `proposed`).
 */
export async function readContributionReceipt(
  requestId: ContributionRequestId,
  dependencies: { readonly store: ContributionStore },
  options?: ContributionOperationOptions,
): Promise<ContributionReceipt> {
  const versioned = await dependencies.store.loadRequest(requestId, options);
  if (versioned === null) throw new EvidenceContributionError("INVALID_INPUT");
  const entries = versioned.value.receipts;
  const latest = entries[entries.length - 1];
  if (latest === undefined) {
    return createContributionReceipt(versioned.value);
  }
  if (createContributionReceiptFingerprint(latest.receipt) !== latest.receiptFingerprint) {
    fail();
  }
  return latest.receipt;
}
