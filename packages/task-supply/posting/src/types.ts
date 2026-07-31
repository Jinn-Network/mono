// SPDX-License-Identifier: MIT

import type { DefaultPostingTerms } from "@jinn-network/marketplace-binding";

/**
 * One admitted, sealed pair as this application needs it. Structurally what C4's `SupplyPool`
 * listing yields; declared here because §3.1 makes this package usable by "any requester with
 * sealed pairs from any source", not only by C4's pool.
 *
 * `admissionReceiptDigest` is required: the dispatch Submission must carry the admission-receipt
 * descriptor, or the evaluation leg derived from it later is refused (binding §7.39; plan finding
 * F-C5-4).
 */
export interface PostingPoolEntry {
  readonly taskDigest: `sha256:${string}`;
  readonly taskBytes: Uint8Array;
  readonly evaluationSpecDigest: `sha256:${string}`;
  readonly admissionReceiptDigest: `sha256:${string}`;
  readonly admissionReceiptUri?: string;
  /** v1 posts public-specification evaluation legs only (design §8, D5); false is refused. */
  readonly evaluationSpecPublic: boolean;
}

export type PostingSkipReason =
  | "excluded"
  | "already-posted"
  | "batch-limit"
  | "evaluation-not-public";

export interface PostingSkip {
  readonly taskDigest: `sha256:${string}`;
  readonly reason: PostingSkipReason;
}

/**
 * Supply policy. `now` is an input, not a clock read: the sealed Submission is a function of the
 * plan, so a plan built twice from the same inputs yields byte-identical bytes and therefore the
 * same broadcast-intent key. A hidden clock would turn every replay into a new post.
 */
export interface PostingPolicy {
  readonly terms: DefaultPostingTerms;
  readonly creatorSafe: `0x${string}`;
  /** The requester of record recorded in every Submission this plan seals. */
  readonly requester: string;
  /** RFC 3339 with an explicit offset. */
  readonly now: string;
  readonly deadlineSeconds: number;
  readonly closeAtSeconds?: number;
  readonly batchLimit: number;
  readonly excludedTaskDigests?: readonly string[];
  /** Digests already posted by this requester; never-posted entries always plan first. */
  readonly postedTaskDigests?: readonly string[];
  /** Default false: an already-posted entry is dropped, not merely deprioritized. */
  readonly repostPosted?: boolean;
  /** Opt-in standing approval. The plan still renders and still logs its terms and escrow. */
  readonly autoPost?: boolean;
}

export interface PostingPlanEntry {
  readonly taskDigest: `sha256:${string}`;
  readonly deadline: string;
  readonly closeAt?: string;
  readonly maxClaims: number;
  readonly escrowValueWei: bigint;
  /** True when this digest appears in `postedTaskDigests` and reposting was allowed. */
  readonly repost: boolean;
}

export interface PostingPlan {
  readonly createdAt: string;
  readonly creatorSafe: `0x${string}`;
  readonly requester: string;
  readonly terms: DefaultPostingTerms;
  readonly approval: "explicit" | "auto";
  readonly entries: readonly PostingPlanEntry[];
  readonly totalEscrowValueWei: bigint;
  readonly skipped: readonly PostingSkip[];
}
