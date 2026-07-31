// SPDX-License-Identifier: MIT

// The dispatch Submission a planned entry posts under. Every field is a function of the plan and
// the entry -- no clock read, no random identifier -- because the broadcast-intent WAL is keyed on
// `(creatorSafe, taskCidDigest, submissionDigest)`: a Submission that differed between two runs of
// one plan would key a second intent and pay for a second post.
import {
  ADMISSION_RECEIPT_ANNOTATION_URI,
  assertMaxClaimsAgreement,
} from "@jinn-network/marketplace-binding";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  sealSubmission,
  sha256Hex,
} from "@jinn-network/task-execution-protocol";
import type { PostingPlan, PostingPlanEntry, PostingPoolEntry } from "./types.js";

/** Namespace for the identifiers derived below; part of the byte-stability contract. */
export const POSTING_SUBMISSION_NAMESPACE = "jinn:task-posting:submission:v1" as const;

function bareHex(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

/** 32 hex characters of a digest, shaped as a URN UUID (§8's `submission` identifier form). */
function urnUuidFromHex(hex: string): string {
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
    + `-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * v1 posts public-specification evaluation legs only (design §8, D5). Grant hosting, minting, and
 * redemption are non-goals (§12), so this package has no code path that populates
 * `capabilityGrants` -- and refuses the entry that would need one rather than posting it with the
 * private material silently dropped.
 */
export function assertPublicSpecEvaluationLeg(entry: PostingPoolEntry): void {
  if (entry.evaluationSpecPublic !== true) {
    throw new Error(
      `${entry.taskDigest} declares a non-public evaluation specification; v1 posts `
        + "public-specification evaluation legs only (design §8, D5)",
    );
  }
}

export function buildDispatchSubmission(
  entry: PostingPoolEntry,
  planEntry: PostingPlanEntry,
  plan: PostingPlan,
): Uint8Array {
  assertPublicSpecEvaluationLeg(entry);

  const taskHex = sha256Hex(entry.taskBytes);
  if (taskHex !== bareHex(entry.taskDigest)) {
    throw new Error(
      `pool entry ${entry.taskDigest} does not hash to its own bytes (sha256:${taskHex}) `
        + "-- refusing to seal a Submission against a mismatched pair",
    );
  }
  if (planEntry.maxClaims !== plan.terms.maxClaims) {
    throw new Error(
      `plan entry maxClaims (${planEntry.maxClaims}) disagrees with the plan's terms `
        + `(${plan.terms.maxClaims})`,
    );
  }
  assertMaxClaimsAgreement(planEntry.maxClaims, plan.terms.maxClaims);

  const seed = sha256Hex(new TextEncoder().encode(
    `${POSTING_SUBMISSION_NAMESPACE}|${entry.taskDigest}|${plan.requester}|${planEntry.deadline}`
      + `|${planEntry.closeAt ?? ""}|${planEntry.maxClaims}`,
  ));

  return sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: urnUuidFromHex(seed),
    task: { digest: { sha256: taskHex } },
    requester: plan.requester,
    idempotencyKey: `${POSTING_SUBMISSION_NAMESPACE}:${entry.taskDigest}:${planEntry.deadline}`,
    nonce: seed.slice(0, 32),
    deadline: planEntry.deadline,
    ...(planEntry.closeAt === undefined ? {} : { closeAt: planEntry.closeAt }),
    attempts: { maxTotal: planEntry.maxClaims },
    annotations: {
      [ADMISSION_RECEIPT_ANNOTATION_URI]: {
        name: "admission-receipt",
        digest: { sha256: bareHex(entry.admissionReceiptDigest) },
        ...(entry.admissionReceiptUri === undefined ? {} : { uri: entry.admissionReceiptUri }),
      },
    },
  });
}
