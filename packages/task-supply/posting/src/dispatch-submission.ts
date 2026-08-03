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
  SubmissionRecordSchema,
  TASK_EXECUTION_PROTOCOL_URI,
  sealSubmission,
  sha256Hex,
} from "@jinn-network/task-execution-protocol";
import { PREFIXED_SHA256_PATTERN } from "./digest.js";
import type { PostingPlan, PostingPlanEntry, PostingPoolEntry } from "./types.js";

/** Namespace for the identifiers derived below; part of the byte-stability contract. */
export const POSTING_SUBMISSION_NAMESPACE = "jinn:task-posting:submission:v1" as const;

/**
 * Record-body digests are `sha256:`-prefixed; in-toto DigestSet values are bare hex (program §5
 * contract 6). This is the only conversion in this package that lands inside a document a
 * requester pays to post, and nothing downstream re-checks it: TEP's `DigestMap` requires only
 * non-empty keys, and the evaluation leg checks only that the admission-receipt descriptor is
 * present and named. An unchecked `.slice()` here would seal `""`, `sha256:aaa...`, `AAA...`, or
 * `zz` into an escrowed task and every later gate would still pass.
 */
function bareHex(digest: string, field: string): string {
  if (!PREFIXED_SHA256_PATTERN.test(digest)) {
    throw new Error(
      `${field} ${JSON.stringify(digest)} is not a sha256:-prefixed lower-case 64-hex digest `
        + "-- refusing to seal it into a Submission that is about to be posted and escrowed",
    );
  }
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

/**
 * Reads `attempts.maxTotal` back out of the bytes that were just sealed and holds it against the
 * terms the escrow was computed from (finding F-C5-1's disposition: "half B seals
 * `attempts.maxTotal` explicitly **and re-parses its own sealed bytes to assert agreement**").
 *
 * Comparing the plan's two in-memory numbers is a tautology. The gate that matters is over the
 * bytes, because the requester backend takes the escrow multiplier from the sealed document
 * (`submission.attempts?.maxTotal ?? 1`): a sealing layer that dropped, renamed, or coerced the
 * field would send `(solution + verdict) x 1` to the chain while the surfaced plan and its log
 * line said N. `assertMaxClaimsAgreement` throws on `undefined` precisely to make that fallback
 * unreachable from here.
 */
export function assertSealedMaxClaimsAgreement(
  submissionBytes: Uint8Array,
  termsMaxClaims: number,
): void {
  const parsed = SubmissionRecordSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(submissionBytes)),
  );
  assertMaxClaimsAgreement(parsed.attempts?.maxTotal, termsMaxClaims);
}

export function buildDispatchSubmission(
  entry: PostingPoolEntry,
  planEntry: PostingPlanEntry,
  plan: PostingPlan,
): Uint8Array {
  assertPublicSpecEvaluationLeg(entry);

  const receiptHex = bareHex(entry.admissionReceiptDigest, "admissionReceiptDigest");
  const taskHex = sha256Hex(entry.taskBytes);
  if (taskHex !== bareHex(entry.taskDigest, "taskDigest")) {
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
  const seed = sha256Hex(new TextEncoder().encode(
    `${POSTING_SUBMISSION_NAMESPACE}|${entry.taskDigest}|${plan.requester}|${planEntry.deadline}`
      + `|${planEntry.closeAt ?? ""}|${planEntry.maxClaims}`,
  ));

  const submissionBytes = sealSubmission({
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
        digest: { sha256: receiptHex },
        ...(entry.admissionReceiptUri === undefined ? {} : { uri: entry.admissionReceiptUri }),
      },
    },
  });

  assertSealedMaxClaimsAgreement(submissionBytes, plan.terms.maxClaims);
  return submissionBytes;
}
