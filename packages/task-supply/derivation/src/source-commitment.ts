// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes } from "./canonical.js";
import { documentDigest, type Sha256Digest } from "./digest.js";
import { DerivationError } from "./errors.js";

/**
 * Version tag carried INSIDE the hashed pre-image, so a future rule cannot produce a
 * value that a v1 consumer would mistake for a v1 commitment.
 */
export const SOURCE_COMMITMENT_RULE = "network.jinn.source-commitment/1" as const;

/** The upstream item a candidate was imported from (design §7.2, payload lineage). */
export interface UpstreamIdentity {
  readonly dataset: string;
  readonly revision: string;
  readonly instanceId: string;
}

const encoder = new TextEncoder();

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) {
    throw new DerivationError("invalid-input", `${field} must be a non-empty string.`);
  }
  return value;
}

/** sha256 of the statement's UTF-8 bytes, verbatim — no trimming, no normalization. */
export function statementDigest(statement: string): Sha256Digest {
  return documentDigest(encoder.encode(requireNonEmpty(statement, "statement")));
}

/**
 * The exact bytes hashed by {@link computeSourceCommitment}. Exported so a third party can
 * recompute a commitment from published fields without reimplementing the rule.
 */
export function sourceCommitmentPreImage(
  upstream: UpstreamIdentity,
  statement: string,
): Uint8Array {
  return canonicalJsonBytes({
    dataset: requireNonEmpty(upstream.dataset, "upstream.dataset"),
    instanceId: requireNonEmpty(upstream.instanceId, "upstream.instanceId"),
    revision: requireNonEmpty(upstream.revision, "upstream.revision"),
    rule: SOURCE_COMMITMENT_RULE,
    statementDigest: statementDigest(statement),
  });
}

/**
 * `provenance.sourceCommitment` for an imported task (design §7.2). Commits to the
 * upstream item's identity AND to the exact statement text taken from it: an upstream row
 * edited in place produces a different commitment rather than silently reusing this one.
 */
export function computeSourceCommitment(
  upstream: UpstreamIdentity,
  statement: string,
): Sha256Digest {
  return documentDigest(sourceCommitmentPreImage(upstream, statement));
}
