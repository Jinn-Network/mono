// SPDX-License-Identifier: MIT

// Supply policy, and nothing else (design §8, D6: production never posts; posting never derives).
// Pure by construction: the plan is the replay unit, so every value the sealed Submission depends
// on -- deadline, closeAt, maxClaims, requester -- is decided here and carried, never read from a
// host clock at execution time.
import { postingEscrowValueWei } from "@jinn-network/marketplace-binding";
import { PREFIXED_SHA256_PATTERN } from "./digest.js";
import { compareCodeUnitStrings } from "./order.js";
import type {
  PostingPlan,
  PostingPlanEntry,
  PostingPolicy,
  PostingPoolEntry,
  PostingSkip,
} from "./types.js";

function offsetIso(base: string, seconds: number): string {
  const parsed = Date.parse(base);
  if (Number.isNaN(parsed)) {
    throw new Error(`policy.now must be an RFC 3339 timestamp with an offset, got ${base}`);
  }
  return new Date(parsed + seconds * 1_000).toISOString();
}

/**
 * Both policy digest lists are membership-tested by exact string equality against `sha256:`-
 * prefixed entry digests, so a list written in any other form matches nothing and the guard it was
 * written for silently disarms: an excluded entry posts and its escrow is spent, and an
 * already-posted entry is posted and escrowed a second time. Bare hex is the realistic mistake —
 * it is the in-toto DigestSet form this stack writes elsewhere by law (program §5 contract 6) — so
 * the list is validated rather than trusted, and a non-canonical entry fails the plan closed
 * instead of quietly dropping out of the comparison.
 */
function digestSet(
  values: readonly string[] | undefined,
  field: string,
): ReadonlySet<string> {
  const digests = new Set<string>();
  for (const value of values ?? []) {
    if (!PREFIXED_SHA256_PATTERN.test(value)) {
      throw new Error(
        `policy.${field} entry ${JSON.stringify(value)} is not a sha256:-prefixed lower-case `
          + "64-hex digest -- it would match no pool entry, so the batch would post and escrow the "
          + "entry this list was written to hold back",
      );
    }
    digests.add(value);
  }
  return digests;
}

/**
 * Selects and orders the entries this batch posts.
 *
 * @param pool the materialized pool listing (finding F-C5-2: the caller reads `SupplyPool.list()`
 * and passes the result; a pure function cannot await a store).
 */
export function planPosting(
  pool: readonly PostingPoolEntry[],
  policy: PostingPolicy,
): PostingPlan {
  if (!Number.isInteger(policy.batchLimit) || policy.batchLimit < 1) {
    throw new RangeError(`batchLimit must be a positive integer, got ${String(policy.batchLimit)}`);
  }
  if (!Number.isInteger(policy.deadlineSeconds) || policy.deadlineSeconds < 1) {
    throw new RangeError(`deadlineSeconds must be a positive integer, got ${String(policy.deadlineSeconds)}`);
  }
  const deadline = offsetIso(policy.now, policy.deadlineSeconds);
  const closeAt = policy.closeAtSeconds === undefined
    ? undefined
    : offsetIso(policy.now, policy.closeAtSeconds);

  const excluded = digestSet(policy.excludedTaskDigests, "excludedTaskDigests");
  const posted = digestSet(policy.postedTaskDigests, "postedTaskDigests");
  const skipped: PostingSkip[] = [];
  const eligible: { readonly entry: PostingPoolEntry; readonly repost: boolean }[] = [];

  for (const entry of pool) {
    if (excluded.has(entry.taskDigest)) {
      skipped.push({ taskDigest: entry.taskDigest, reason: "excluded" });
      continue;
    }
    if (!entry.evaluationSpecPublic) {
      skipped.push({ taskDigest: entry.taskDigest, reason: "evaluation-not-public" });
      continue;
    }
    const repost = posted.has(entry.taskDigest);
    if (repost && policy.repostPosted !== true) {
      skipped.push({ taskDigest: entry.taskDigest, reason: "already-posted" });
      continue;
    }
    eligible.push({ entry, repost });
  }

  // Never-posted first; within a group, code-unit order by digest so two hosts plan one batch.
  eligible.sort((left, right) => {
    if (left.repost !== right.repost) return left.repost ? 1 : -1;
    return compareCodeUnitStrings(left.entry.taskDigest, right.entry.taskDigest);
  });

  const entries: PostingPlanEntry[] = [];
  for (const candidate of eligible) {
    if (entries.length >= policy.batchLimit) {
      skipped.push({ taskDigest: candidate.entry.taskDigest, reason: "batch-limit" });
      continue;
    }
    entries.push({
      taskDigest: candidate.entry.taskDigest,
      deadline,
      ...(closeAt === undefined ? {} : { closeAt }),
      maxClaims: policy.terms.maxClaims,
      escrowValueWei: postingEscrowValueWei(policy.terms),
      repost: candidate.repost,
    });
  }

  return {
    createdAt: policy.now,
    creatorSafe: policy.creatorSafe,
    requester: policy.requester,
    terms: policy.terms,
    approval: policy.autoPost === true ? "auto" : "explicit",
    entries,
    totalEscrowValueWei: entries.reduce((total, planned) => total + planned.escrowValueWei, 0n),
    skipped,
  };
}
